import { Bytes, RemuxError, U32_MAX, box, fullBox, rescaleUp } from "./bytes";
import { boxes, findChild, fullBoxReader } from "./boxes";
import { SampleTable } from "./tables";
import type { Fragment, PositionalWriter, TrackInit } from "./types";

const MOVIE_TIMESCALE = 1000;
const MDAT_HEADER_SIZE = 16;

interface EditEntry {
  duration: number;
  mediaTime: number;
  rate: number;
}

function sampleEntryType(stsd: Uint8Array): string {
  return String.fromCharCode(...stsd.subarray(20, 24));
}

export function buildFtyp(tracks: TrackInit[]): Uint8Array {
  const entries = tracks.map((t) => sampleEntryType(t.boxes.stsd));
  const brands = ["isom", "iso2"];
  if (entries.some((e) => e === "avc1" || e === "avc3")) brands.push("avc1");
  if (entries.includes("av01")) brands.push("av01");
  brands.push("mp41");
  const b = new Bytes().fourcc("isom").u32(0x200);
  for (const brand of brands) b.fourcc(brand);
  return box("ftyp", b.done());
}

function readEdits(edts: Uint8Array): EditEntry[] {
  const outer = boxes(edts).next().value;
  if (!outer) throw new RemuxError("empty edts box");
  const elst = findChild(edts, outer, "elst");
  if (!elst) return [];
  const { version, r } = fullBoxReader(edts, elst);
  const count = r.u32();
  const entries: EditEntry[] = [];
  for (let i = 0; i < count; i++) {
    const duration = version === 1 ? r.u64n() : r.u32();
    const mediaTime = version === 1 ? Number(BigInt.asIntN(64, r.u64())) : r.i32();
    entries.push({ duration, mediaTime, rate: r.u32() });
  }
  return entries;
}

/**
 * Translate source edits into the output timeline: segment durations move to the output movie
 * timescale, a zero duration (a fragmented file's "until the end") becomes the track's media
 * duration, and media times follow the output's rebasing of the first decode time to 0.
 * The media duration is not reduced by media_time: composition offsets shift the presentation
 * by the same amount, so the presented span is still the full media duration.
 */
function outputEdits(t: TrackInit, table: SampleTable): EditEntry[] | undefined {
  if (!t.boxes.edts) return undefined;
  const start = Number(table.startDts);
  return readEdits(t.boxes.edts).map((e) => ({
    duration:
      e.duration === 0
        ? rescaleUp(table.duration, t.timescale, MOVIE_TIMESCALE)
        : rescaleUp(e.duration, t.movieTimescale, MOVIE_TIMESCALE),
    mediaTime: e.mediaTime < 0 ? e.mediaTime : Math.max(0, e.mediaTime - start),
    rate: e.rate,
  }));
}

function edtsBox(entries: EditEntry[]): Uint8Array {
  const wide = entries.some((e) => e.duration > U32_MAX || e.mediaTime > 0x7fffffff);
  const b = new Bytes().u32(entries.length);
  for (const e of entries) {
    if (wide) b.u64(e.duration).u64(BigInt.asUintN(64, BigInt(e.mediaTime)));
    else b.u32(e.duration).i32(e.mediaTime);
    b.u32(e.rate);
  }
  return box("edts", fullBox("elst", wide ? 1 : 0, 0, b.done()));
}

/** Copy a tkhd/mdhd-style box, overwriting the fields at the version-dependent offsets. */
function patchHeader(src: Uint8Array, what: string, patch: (view: DataView, version: number) => void): Uint8Array {
  const out = src.slice();
  const view = new DataView(out.buffer);
  const version = out[8];
  if (version !== 0 && version !== 1) throw new RemuxError(`unsupported ${what} version ${version}`);
  patch(view, version);
  return out;
}

function setDuration(view: DataView, at: number, version: number, value: number, what: string): void {
  if (version === 1) view.setBigUint64(at, BigInt(value));
  else if (value > U32_MAX) throw new RemuxError(`${what} duration does not fit a version 0 box`);
  else view.setUint32(at, value);
}

function tkhdBox(src: Uint8Array, trackId: number, duration: number): Uint8Array {
  return patchHeader(src, "tkhd", (view, v) => {
    const body = 12;
    view.setUint32(body + (v === 1 ? 16 : 8), trackId);
    setDuration(view, body + (v === 1 ? 24 : 16), v, duration, "tkhd");
  });
}

function mdhdBox(src: Uint8Array, duration: number): Uint8Array {
  return patchHeader(src, "mdhd", (view, v) => {
    setDuration(view, 12 + (v === 1 ? 20 : 12), v, duration, "mdhd");
  });
}

function mvhdBox(duration: number, nextTrackId: number): Uint8Array {
  const wide = duration > U32_MAX;
  const b = new Bytes();
  if (wide) b.u64(0).u64(0).u32(MOVIE_TIMESCALE).u64(duration);
  else b.u32(0).u32(0).u32(MOVIE_TIMESCALE).u32(duration);
  b.u32(0x00010000).u16(0x0100).zeros(10);
  for (const v of [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]) b.u32(v);
  b.zeros(24).u32(nextTrackId);
  return fullBox("mvhd", wide ? 1 : 0, 0, b.done());
}

/**
 * Streams samples into one mdat and writes a non-fragmented moov at the end.
 * Layout: ftyp, mdat (64-bit size, patched in finish), moov.
 */
export class Mp4Writer {
  private readonly tables: SampleTable[];
  private mdatStart = 0;
  private pos = 0;

  constructor(
    private readonly out: PositionalWriter,
    private readonly tracks: TrackInit[],
  ) {
    this.tables = tracks.map((t) => new SampleTable(t.handler === "soun"));
  }

  async start(): Promise<void> {
    const ftyp = buildFtyp(this.tracks);
    this.mdatStart = ftyp.length;
    const header = new Bytes().u32(1).fourcc("mdat").u64(0).done();
    await this.out.write(ftyp, 0);
    await this.out.write(header, this.mdatStart);
    this.pos = this.mdatStart + MDAT_HEADER_SIZE;
  }

  async writeFragment(track: number, f: Fragment): Promise<void> {
    if (f.samples.length === 0) return;
    const table = this.tables[track];
    if (!table) throw new RemuxError(`no track ${track}`);
    table.add(f, this.pos);
    await this.out.write(f.payload, this.pos);
    this.pos += f.payload.length;
  }

  async finish(): Promise<void> {
    const moov = this.buildMoov();
    await this.out.write(moov, this.pos);
    await this.out.write(new Bytes().u64(this.pos - this.mdatStart).done(), this.mdatStart + 8);
    await this.out.close();
  }

  private buildMoov(): Uint8Array {
    const traks: Uint8Array[] = [];
    let movieDuration = 0;
    this.tracks.forEach((t, i) => {
      const table = this.tables[i]!;
      if (table.sampleCount === 0) throw new RemuxError(`track ${i + 1} has no samples`);
      const edits = outputEdits(t, table);
      const duration = edits
        ? edits.reduce((n, e) => n + e.duration, 0)
        : rescaleUp(table.duration, t.timescale, MOVIE_TIMESCALE);
      movieDuration = Math.max(movieDuration, duration);
      const stbl = box("stbl", t.boxes.stsd, ...table.boxes());
      const minf = box("minf", t.boxes.mediaHeader, t.boxes.dinf, stbl);
      const mdia = box("mdia", mdhdBox(t.boxes.mdhd, table.duration), t.boxes.hdlr, minf);
      traks.push(box("trak", tkhdBox(t.boxes.tkhd, i + 1, duration), ...(edits ? [edtsBox(edits)] : []), mdia));
    });
    return box("moov", mvhdBox(movieDuration, this.tracks.length + 1), ...traks);
  }
}
