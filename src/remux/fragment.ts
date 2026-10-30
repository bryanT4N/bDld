import { RemuxError } from "./bytes";
import { boxes, children, findChild, fullBoxReader, requireChild, type Box } from "./boxes";
import type { Fragment, Sample, TrackInit } from "./types";

const TFHD_BASE_DATA_OFFSET = 0x1;
const TFHD_SAMPLE_DESCRIPTION_INDEX = 0x2;
const TFHD_DEFAULT_DURATION = 0x8;
const TFHD_DEFAULT_SIZE = 0x10;
const TFHD_DEFAULT_FLAGS = 0x20;
const TFHD_DEFAULT_BASE_IS_MOOF = 0x20000;

const TRUN_DATA_OFFSET = 0x1;
const TRUN_FIRST_SAMPLE_FLAGS = 0x4;
const TRUN_DURATION = 0x100;
const TRUN_SIZE = 0x200;
const TRUN_FLAGS = 0x400;
const TRUN_CTO = 0x800;

interface Tfhd {
  trackId: number;
  baseDataOffset?: number;
  defaultBaseIsMoof: boolean;
  sampleDescriptionIndex: number;
  duration: number;
  size: number;
  flags: number;
}

function parseTfhd(buf: Uint8Array, b: Box, init: TrackInit): Tfhd {
  const { flags, r } = fullBoxReader(buf, b);
  const trackId = r.u32();
  const baseDataOffset = flags & TFHD_BASE_DATA_OFFSET ? r.u64n() : undefined;
  return {
    trackId,
    ...(baseDataOffset !== undefined ? { baseDataOffset } : {}),
    defaultBaseIsMoof: (flags & TFHD_DEFAULT_BASE_IS_MOOF) !== 0,
    sampleDescriptionIndex: flags & TFHD_SAMPLE_DESCRIPTION_INDEX ? r.u32() : init.trex.sampleDescriptionIndex,
    duration: flags & TFHD_DEFAULT_DURATION ? r.u32() : init.trex.duration,
    size: flags & TFHD_DEFAULT_SIZE ? r.u32() : init.trex.size,
    flags: flags & TFHD_DEFAULT_FLAGS ? r.u32() : init.trex.flags,
  };
}

function parseTfdt(buf: Uint8Array, b: Box): bigint {
  const { version, r } = fullBoxReader(buf, b);
  return version === 1 ? r.u64() : BigInt(r.u32());
}

/**
 * Parse every moof+mdat pair in buf. `fileOffset` is the file position of buf[0], needed
 * because data offsets may be absolute (base-data-offset) or relative to the moof.
 */
export function parseFragments(buf: Uint8Array, init: TrackInit, fileOffset: number): Fragment[] {
  const out: Fragment[] = [];
  for (const moof of boxes(buf)) {
    if (moof.type !== "moof") continue;
    const trafs = children(buf, moof, "traf");
    trafs.forEach((traf, index) => {
      const tfhd = parseTfhd(buf, requireChild(buf, traf, "tfhd"), init);
      if (tfhd.trackId !== init.trackId) return;
      const tfdt = findChild(buf, traf, "tfdt");
      if (!tfdt) throw new RemuxError(`track fragment at byte ${fileOffset + traf.start} has no tfdt`);

      let base: number;
      if (tfhd.baseDataOffset !== undefined) base = tfhd.baseDataOffset - fileOffset;
      else if (tfhd.defaultBaseIsMoof || index === 0) base = moof.start;
      else throw new RemuxError("implicit data offset after another track fragment is not supported");

      const samples: Sample[] = [];
      const ranges: [number, number][] = [];
      let next = base;
      for (const trunBox of children(buf, traf, "trun")) {
        const { flags, r } = fullBoxReader(buf, trunBox);
        const count = r.u32();
        let pos = flags & TRUN_DATA_OFFSET ? base + r.i32() : next;
        const firstFlags = flags & TRUN_FIRST_SAMPLE_FLAGS ? r.u32() : undefined;
        for (let i = 0; i < count; i++) {
          const duration = flags & TRUN_DURATION ? r.u32() : tfhd.duration;
          const size = flags & TRUN_SIZE ? r.u32() : tfhd.size;
          let sampleFlags = flags & TRUN_FLAGS ? r.u32() : tfhd.flags;
          if (i === 0 && firstFlags !== undefined) sampleFlags = firstFlags;
          // Read as signed for version 0 too, like common demuxers, since some muxers write negative offsets there.
          const cto = flags & TRUN_CTO ? r.i32() : 0;
          samples.push({ duration, size, flags: sampleFlags, cto });
          if (pos < 0 || pos + size > buf.length) {
            throw new RemuxError(`sample data at byte ${fileOffset + pos} lies outside the downloaded range`);
          }
          const last = ranges[ranges.length - 1];
          if (last && last[1] === pos) last[1] = pos + size;
          else ranges.push([pos, pos + size]);
          pos += size;
        }
        next = pos;
      }
      if (samples.length === 0) return;

      const total = ranges.reduce((n, [a, b]) => n + (b - a), 0);
      const payload = new Uint8Array(total);
      let at = 0;
      for (const [a, b] of ranges) {
        payload.set(buf.subarray(a, b), at);
        at += b - a;
      }
      out.push({
        baseDecodeTime: parseTfdt(buf, tfdt),
        sampleDescriptionIndex: tfhd.sampleDescriptionIndex,
        samples,
        payload,
      });
    });
  }
  return out;
}
