import { RemuxError } from "./bytes";
import { boxes, children, findChild, fullBoxReader, requireChild, slice, type Box } from "./boxes";
import type { Segment, TrackInit } from "./types";

function timescaleOf(buf: Uint8Array, b: Box): number {
  const { version, r } = fullBoxReader(buf, b);
  r.skip(version === 1 ? 16 : 8);
  const ts = r.u32();
  if (ts === 0) throw new RemuxError(`"${b.type}" timescale is 0`);
  return ts;
}

function tkhdTrackId(buf: Uint8Array, tkhd: Box): number {
  const { version, r } = fullBoxReader(buf, tkhd);
  r.skip(version === 1 ? 16 : 8);
  return r.u32();
}

/** Parse the moov of a single-track fragmented MP4 (a DASH m4s initialization segment). */
export function parseInit(buf: Uint8Array): TrackInit {
  const top = [...boxes(buf)];
  const moov = top.find((b) => b.type === "moov");
  if (!moov) throw new RemuxError("initialization segment has no moov box");
  const traks = children(buf, moov, "trak");
  if (traks.length !== 1) throw new RemuxError(`expected one track per stream, found ${traks.length}`);
  const trak = traks[0]!;

  const tkhd = requireChild(buf, trak, "tkhd");
  const trackId = tkhdTrackId(buf, tkhd);
  const mdia = requireChild(buf, trak, "mdia");
  const mdhd = requireChild(buf, mdia, "mdhd");
  const hdlr = requireChild(buf, mdia, "hdlr");
  const { r: hr } = fullBoxReader(buf, hdlr);
  hr.skip(4);
  const handler = hr.fourcc();
  if (handler !== "vide" && handler !== "soun") throw new RemuxError(`unsupported track handler "${handler}"`);
  const minf = requireChild(buf, mdia, "minf");
  const mediaHeader = requireChild(buf, minf, handler === "vide" ? "vmhd" : "smhd");
  const dinf = requireChild(buf, minf, "dinf");
  const stsd = requireChild(buf, requireChild(buf, minf, "stbl"), "stsd");
  const edts = findChild(buf, trak, "edts");

  const mvex = requireChild(buf, moov, "mvex");
  const trex = children(buf, mvex, "trex")
    .map((b) => fullBoxReader(buf, b).r)
    .map((r) => ({
      trackId: r.u32(),
      sampleDescriptionIndex: r.u32(),
      duration: r.u32(),
      size: r.u32(),
      flags: r.u32(),
    }))
    .find((t) => t.trackId === trackId);
  if (!trex) throw new RemuxError(`no trex box for track ${trackId}`);

  return {
    trackId,
    timescale: timescaleOf(buf, mdhd),
    movieTimescale: timescaleOf(buf, requireChild(buf, moov, "mvhd")),
    handler,
    boxes: {
      tkhd: slice(buf, tkhd),
      ...(edts ? { edts: slice(buf, edts) } : {}),
      mdhd: slice(buf, mdhd),
      hdlr: slice(buf, hdlr),
      mediaHeader: slice(buf, mediaHeader),
      dinf: slice(buf, dinf),
      stsd: slice(buf, stsd),
    },
    trex: {
      sampleDescriptionIndex: trex.sampleDescriptionIndex,
      duration: trex.duration,
      size: trex.size,
      flags: trex.flags,
    },
  };
}

/**
 * Parse a top-level sidx into absolute file ranges. `fileOffset` is the file position of buf[0].
 */
export function parseSidx(buf: Uint8Array, fileOffset: number): { timescale: number; segments: Segment[] } {
  const sidx = [...boxes(buf)].find((b) => b.type === "sidx");
  if (!sidx) throw new RemuxError("index has no sidx box");
  const { version, r } = fullBoxReader(buf, sidx);
  r.u32();
  const timescale = r.u32();
  if (version === 1) r.skip(8);
  else r.skip(4);
  const firstOffset = version === 1 ? r.u64n() : r.u32();
  r.skip(2);
  const count = r.u16();
  let offset = fileOffset + sidx.end + firstOffset;
  const segments: Segment[] = [];
  for (let i = 0; i < count; i++) {
    const ref = r.u32();
    if (ref & 0x80000000) throw new RemuxError("hierarchical sidx is not supported");
    const size = ref & 0x7fffffff;
    const duration = r.u32();
    r.skip(4);
    if (size === 0) throw new RemuxError(`sidx reference ${i} has size 0`);
    segments.push({ offset, size, duration });
    offset += size;
  }
  if (segments.length === 0) throw new RemuxError("sidx has no references");
  return { timescale, segments };
}
