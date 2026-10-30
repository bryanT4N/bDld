import { Reader, RemuxError } from "./bytes";

export interface Box {
  type: string;
  start: number;
  /** First byte after the header. */
  body: number;
  end: number;
}

/** Iterate the boxes laid out back to back in buf[start, end). */
export function* boxes(buf: Uint8Array, start = 0, end = buf.length): Generator<Box> {
  let pos = start;
  while (pos < end) {
    const r = new Reader(buf, pos, end, `box header at byte ${pos}`);
    let size = r.u32();
    const type = r.fourcc();
    if (size === 1) size = r.u64n();
    else if (size === 0) size = end - pos;
    if (size < r.pos - pos || pos + size > end) {
      throw new RemuxError(`box "${type}" at byte ${pos} has invalid size ${size}`);
    }
    yield { type, start: pos, body: r.pos, end: pos + size };
    pos += size;
  }
}

export function children(buf: Uint8Array, parent: Box, type: string): Box[] {
  return [...boxes(buf, parent.body, parent.end)].filter((b) => b.type === type);
}

export function findChild(buf: Uint8Array, parent: Box, type: string): Box | undefined {
  for (const b of boxes(buf, parent.body, parent.end)) if (b.type === type) return b;
  return undefined;
}

export function requireChild(buf: Uint8Array, parent: Box, type: string): Box {
  const b = findChild(buf, parent, type);
  if (!b) throw new RemuxError(`"${parent.type}" box has no "${type}" box`);
  return b;
}

/** Reader positioned after a full box's version and flags. */
export function fullBoxReader(buf: Uint8Array, b: Box): { version: number; flags: number; r: Reader } {
  const r = new Reader(buf, b.body, b.end, `"${b.type}" box`);
  const version = r.u8();
  const flags = r.u24();
  return { version, flags, r };
}

export function slice(buf: Uint8Array, b: Box): Uint8Array {
  return buf.slice(b.start, b.end);
}
