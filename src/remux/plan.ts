import type { Segment } from "./types";

export const TARGET_RANGE_BYTES = 4 * 1024 * 1024;

/** An inclusive byte range, as in an HTTP Range header. */
export interface ByteRange {
  first: number;
  last: number;
}

/** Group consecutive sidx segments into requests of about `target` bytes, never splitting a segment. */
export function planRanges(segments: Segment[], target = TARGET_RANGE_BYTES): ByteRange[] {
  const ranges: ByteRange[] = [];
  let current: ByteRange | undefined;
  for (const s of segments) {
    const end = s.offset + s.size - 1;
    if (current && current.last + 1 === s.offset && end - current.first + 1 <= target) {
      current.last = end;
    } else {
      current = { first: s.offset, last: end };
      ranges.push(current);
    }
  }
  return ranges;
}
