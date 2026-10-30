import { Bytes, box, fullBox } from "../src/remux/bytes";
import { boxes, type Box } from "../src/remux/boxes";
import type { TrackInit } from "../src/remux/types";

export const u32s = (...vs: number[]) => {
  const b = new Bytes();
  for (const v of vs) b.u32(v >>> 0);
  return b.done();
};

export function tfhd(flags: number, trackId: number, fields: { base?: number; sdi?: number; duration?: number; size?: number; flags?: number }) {
  const b = new Bytes().u32(trackId);
  if (flags & 0x1) b.u64(fields.base ?? 0);
  if (flags & 0x2) b.u32(fields.sdi ?? 1);
  if (flags & 0x8) b.u32(fields.duration ?? 0);
  if (flags & 0x10) b.u32(fields.size ?? 0);
  if (flags & 0x20) b.u32(fields.flags ?? 0);
  return fullBox("tfhd", 0, flags, b.done());
}

export function tfdt(version: 0 | 1, t: number) {
  return fullBox("tfdt", version, 0, version ? new Bytes().u64(t).done() : u32s(t));
}

export interface TrunSample {
  duration?: number;
  size?: number;
  flags?: number;
  cto?: number;
}

export function trun(flags: number, samples: TrunSample[], opts: { dataOffset?: number; firstFlags?: number; version?: 0 | 1 } = {}) {
  const b = new Bytes().u32(samples.length);
  if (flags & 0x1) b.i32(opts.dataOffset ?? 0);
  if (flags & 0x4) b.u32(opts.firstFlags ?? 0);
  for (const s of samples) {
    if (flags & 0x100) b.u32(s.duration ?? 0);
    if (flags & 0x200) b.u32(s.size ?? 0);
    if (flags & 0x400) b.u32(s.flags ?? 0);
    if (flags & 0x800) b.i32(s.cto ?? 0);
  }
  return fullBox("trun", opts.version ?? 0, flags, b.done());
}

export const traf = (...children: Uint8Array[]) => box("traf", ...children);
export const moof = (...trafs: Uint8Array[]) => box("moof", fullBox("mfhd", 0, 0, u32s(1)), ...trafs);
export const mdat = (data: Uint8Array) => box("mdat", data);

export const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** Payload bytes 0, 1, 2, ... so slices are recognisable. */
export const ramp = (n: number, from = 0) => Uint8Array.from({ length: n }, (_, i) => (from + i) & 0xff);

export function trackInit(overrides: Partial<TrackInit> = {}): TrackInit {
  const tkhd = fullBox("tkhd", 0, 3, new Bytes().u32(0).u32(0).u32(9).u32(0).u32(0).zeros(60).done());
  const mdhd = fullBox("mdhd", 0, 0, new Bytes().u32(0).u32(0).u32(1000).u32(0).u16(0x55c4).u16(0).done());
  return {
    trackId: 9,
    timescale: 1000,
    movieTimescale: 1000,
    handler: "vide",
    boxes: {
      tkhd,
      mdhd,
      hdlr: fullBox("hdlr", 0, 0, new Bytes().u32(0).fourcc("vide").zeros(12).u8(0).done()),
      mediaHeader: fullBox("vmhd", 0, 1, new Bytes().zeros(8).done()),
      dinf: box("dinf"),
      stsd: fullBox("stsd", 0, 0, concat(u32s(1), box("avc1", new Bytes().zeros(8).done()))),
    },
    trex: { sampleDescriptionIndex: 1, duration: 0, size: 0, flags: 0 },
    ...overrides,
  };
}

/** Find a box by path, e.g. "moov/trak/mdia/minf/stbl/stts". */
export function find(buf: Uint8Array, path: string, nth = 0): Box | undefined {
  const [head, ...rest] = path.split("/");
  const matches = [...boxes(buf)].filter((b) => b.type === head);
  let cur = matches[head === "trak" ? nth : 0];
  for (const part of rest) {
    if (!cur) return undefined;
    const kids: Box[] = [...boxes(buf, cur.body, cur.end)].filter((b) => b.type === part);
    cur = kids[part === "trak" ? nth : 0];
  }
  return cur;
}

/** The u32 words of a full box body after version/flags. */
export function words(buf: Uint8Array, b: Box): number[] {
  const view = new DataView(buf.buffer, buf.byteOffset);
  const out: number[] = [];
  for (let at = b.body + 4; at + 4 <= b.end; at += 4) out.push(view.getUint32(at));
  return out;
}
