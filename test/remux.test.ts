import { describe, expect, it } from "vitest";
import { Bytes, Reader, RemuxError, box, fullBox, rescaleUp } from "../src/remux/bytes";
import { boxes } from "../src/remux/boxes";
import { parseFragments } from "../src/remux/fragment";
import { parseInit, parseSidx } from "../src/remux/init";
import { interleave } from "../src/remux/interleave";
import { planRanges } from "../src/remux/plan";
import { SampleTable } from "../src/remux/tables";
import type { Fragment, PositionalWriter } from "../src/remux/types";
import { Mp4Writer } from "../src/remux/writer";
import { concat, find, mdat, moof, ramp, tfdt, tfhd, traf, trackInit, trun, u32s, words } from "./mp4";

describe("bytes", () => {
  it("grows the builder across many writes", () => {
    const b = new Bytes();
    for (let i = 0; i < 1000; i++) b.u32(i).bytes(new Uint8Array([7]));
    const out = b.done();
    expect(out.length).toBe(5000);
    expect(new DataView(out.buffer).getUint32(4995)).toBe(999);
  });

  it("rejects reads past the end with a named error", () => {
    const r = new Reader(new Uint8Array(3), 0, 3, "test box");
    expect(() => r.u32()).toThrow(new RemuxError("test box is truncated"));
  });

  it("rescales rounding up without float error", () => {
    expect(rescaleUp(1920, 16000, 1000)).toBe(120);
    expect(rescaleUp(1, 3, 1000)).toBe(334);
    expect(rescaleUp(2 ** 40 + 1, 1, 1)).toBe(2 ** 40 + 1);
  });
});

describe("boxes", () => {
  it("handles 64-bit and to-end sizes", () => {
    const large = new Bytes().u32(1).fourcc("free").u64(20).u32(0).done();
    const toEnd = new Bytes().u32(0).fourcc("mdat").u32(42).done();
    const list = [...boxes(concat(large, toEnd))];
    expect(list.map((b) => [b.type, b.body, b.end])).toEqual([
      ["free", 16, 20],
      ["mdat", 28, 32],
    ]);
  });

  it("rejects a size beyond the buffer", () => {
    const bad = new Bytes().u32(100).fourcc("moof").done();
    expect(() => [...boxes(bad)]).toThrow(/invalid size 100/);
  });
});

describe("parseFragments", () => {
  const init = trackInit({ trex: { sampleDescriptionIndex: 1, duration: 40, size: 3, flags: 0x10000 } });

  /** moof + mdat where trun data_offset points at the mdat payload. */
  function pair(trafFor: (dataOffset: number) => Uint8Array, payload: Uint8Array) {
    const probe = moof(trafFor(0));
    const m = moof(trafFor(probe.length + 8));
    return concat(m, mdat(payload));
  }

  it("uses tfhd defaults when trun carries no per-sample fields", () => {
    const buf = pair(
      (off) => traf(tfhd(0x020038, 9, { duration: 512, size: 2, flags: 0x2000000 }), tfdt(1, 1000), trun(0x1, [{}, {}, {}], { dataOffset: off })),
      ramp(6),
    );
    const [f] = parseFragments(buf, init, 0);
    expect(f!.baseDecodeTime).toBe(1000n);
    expect(f!.samples).toEqual(Array(3).fill({ duration: 512, size: 2, flags: 0x2000000, cto: 0 }));
    expect([...f!.payload]).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("falls back to trex defaults and reads sample-description-index (Bilibili 0x02002a/0x201)", () => {
    const buf = pair(
      (off) => traf(tfhd(0x02002a, 9, { sdi: 2, duration: 1024, flags: 0x2000000 }), tfdt(0, 7), trun(0x201, [{ size: 4 }, { size: 1 }], { dataOffset: off })),
      ramp(5),
    );
    const [f] = parseFragments(buf, init, 0);
    expect(f!.sampleDescriptionIndex).toBe(2);
    expect(f!.baseDecodeTime).toBe(7n);
    expect(f!.samples.map((s) => [s.duration, s.size, s.flags])).toEqual([
      [1024, 4, 0x2000000],
      [1024, 1, 0x2000000],
    ]);
  });

  it("reads per-sample size, composition offsets and first-sample flags (video 0xa05)", () => {
    const samples = [
      { size: 2, cto: 1024 },
      { size: 1, cto: -512 },
      { size: 1, cto: 0 },
    ];
    const buf = pair(
      (off) => traf(tfhd(0x020000, 9, {}), tfdt(1, 0), trun(0xa05, samples, { dataOffset: off, firstFlags: 0x2000000, version: 1 })),
      ramp(4),
    );
    const [f] = parseFragments(buf, init, 0);
    expect(f!.samples.map((s) => [s.size, s.cto, s.flags, s.duration])).toEqual([
      [2, 1024, 0x2000000, 40],
      [1, -512, 0x10000, 40],
      [1, 0, 0x10000, 40],
    ]);
  });

  it("resolves base-data-offset as an absolute file position", () => {
    const fileOffset = 10_000;
    const probeLen = moof(traf(tfhd(0x1, 9, { base: 0 }), tfdt(0, 0), trun(0x0, [{}]))).length;
    const buf = concat(moof(traf(tfhd(0x1, 9, { base: fileOffset + probeLen + 8 }), tfdt(0, 0), trun(0x0, [{}]))), mdat(ramp(3, 50)));
    const [f] = parseFragments(buf, init, fileOffset);
    expect([...f!.payload]).toEqual([50, 51, 52]);
  });

  it("continues a second trun where the first ended and skips other tracks", () => {
    const other = traf(tfhd(0x020000, 3, {}), tfdt(0, 0), trun(0x0, [{}]));
    const mine = (off: number) => traf(tfhd(0x020008, 9, { duration: 10 }), tfdt(0, 0), trun(0x201, [{ size: 2 }], { dataOffset: off }), trun(0x200, [{ size: 1 }]));
    const head = moof(other, mine(0));
    const buf = concat(moof(other, mine(head.length + 8)), mdat(ramp(3, 9)));
    const frags = parseFragments(buf, init, 0);
    expect(frags).toHaveLength(1);
    expect(frags[0]!.samples.map((s) => s.size)).toEqual([2, 1]);
    expect([...frags[0]!.payload]).toEqual([9, 10, 11]);
  });

  it("rejects sample data outside the downloaded bytes", () => {
    const buf = concat(moof(traf(tfhd(0x020000, 9, {}), tfdt(0, 0), trun(0x1, [{}], { dataOffset: 4096 }))), mdat(ramp(3)));
    expect(() => parseFragments(buf, init, 0)).toThrow(/outside the downloaded range/);
  });

  it("requires tfdt", () => {
    const buf = concat(moof(traf(tfhd(0x020000, 9, {}), trun(0x0, [{}]))), mdat(ramp(3)));
    expect(() => parseFragments(buf, init, 0)).toThrow(/no tfdt/);
  });
});

describe("parseInit and parseSidx", () => {
  const t = trackInit();
  const trak = box("trak", t.boxes.tkhd, box("mdia", t.boxes.mdhd, t.boxes.hdlr, box("minf", t.boxes.mediaHeader, t.boxes.dinf, box("stbl", t.boxes.stsd))));
  const mvhd = fullBox("mvhd", 0, 0, concat(u32s(0, 0, 600, 0), new Uint8Array(80)));
  const trex = fullBox("trex", 0, 0, u32s(9, 1, 0, 0, 0x10000));
  const mvex = box("mvex", trex);

  it("extracts the track and its trex by track_ID", () => {
    const parsed = parseInit(box("moov", mvhd, trak, mvex));
    expect(parsed.trackId).toBe(9);
    expect(parsed.timescale).toBe(1000);
    expect(parsed.movieTimescale).toBe(600);
    expect(parsed.handler).toBe("vide");
    expect(parsed.trex.flags).toBe(0x10000);
    expect(parsed.boxes.stsd).toEqual(t.boxes.stsd);
    expect(parsed.boxes.edts).toBeUndefined();
  });

  it("rejects multi-track inits", () => {
    expect(() => parseInit(box("moov", mvhd, trak, trak, mvex))).toThrow(/one track per stream, found 2/);
  });

  it("maps sidx v0 and v1 references to absolute ranges", () => {
    const refs = u32s(100, 5000, 0x90000000, 200, 5000, 0x90000000);
    const v0 = fullBox("sidx", 0, 0, concat(u32s(1, 1000, 0, 16), new Uint8Array([0, 0, 0, 2]), refs));
    const v1 = fullBox("sidx", 1, 0, concat(u32s(1, 1000), new Bytes().u64(0).u64(16).done(), new Uint8Array([0, 0, 0, 2]), refs));
    for (const sidx of [v0, v1]) {
      const head = concat(new Uint8Array(40), sidx);
      const { timescale, segments } = parseSidx(head.subarray(40), 40);
      expect(timescale).toBe(1000);
      expect(segments).toEqual([
        { offset: 40 + sidx.length + 16, size: 100, duration: 5000 },
        { offset: 40 + sidx.length + 116, size: 200, duration: 5000 },
      ]);
    }
  });
});

describe("planRanges", () => {
  it("groups whole consecutive segments up to the target", () => {
    const segs = [100, 100, 100, 250, 50].reduce<{ offset: number; size: number; duration: number }[]>((acc, size) => {
      const last = acc[acc.length - 1];
      acc.push({ offset: last ? last.offset + last.size : 1000, size, duration: 1 });
      return acc;
    }, []);
    expect(planRanges(segs, 300)).toEqual([
      { first: 1000, last: 1299 },
      { first: 1300, last: 1599 },
    ]);
    expect(planRanges([{ offset: 0, size: 900, duration: 1 }], 300)).toEqual([{ first: 0, last: 899 }]);
  });

  it("never bridges a gap", () => {
    expect(planRanges([{ offset: 0, size: 10, duration: 1 }, { offset: 20, size: 10, duration: 1 }], 1000)).toEqual([
      { first: 0, last: 9 },
      { first: 20, last: 29 },
    ]);
  });
});

function memoryWriter(): PositionalWriter & { bytes(): Uint8Array; closed: boolean } {
  let data = new Uint8Array(0);
  const w = {
    closed: false,
    async write(chunk: Uint8Array, position = data.length) {
      if (position + chunk.length > data.length) {
        const next = new Uint8Array(position + chunk.length);
        next.set(data);
        data = next;
      }
      data.set(chunk, position);
    },
    async close() {
      w.closed = true;
    },
    bytes: () => data,
  };
  return w;
}

const frag = (t: number, samples: Partial<Fragment["samples"][number]>[], sdi = 1): Fragment => ({
  baseDecodeTime: BigInt(t),
  sampleDescriptionIndex: sdi,
  samples: samples.map((s) => ({ duration: 10, size: 1, flags: 0, cto: 0, ...s })),
  payload: ramp(samples.reduce((n, s) => n + (s.size ?? 1), 0)),
});

describe("Mp4Writer", () => {
  async function write(tracks = [trackInit()], frags: [number, Fragment][]) {
    const out = memoryWriter();
    const w = new Mp4Writer(out, tracks);
    await w.start();
    for (const [track, f] of frags) await w.writeFragment(track, f);
    await w.finish();
    return out;
  }

  it("lays out ftyp, a 64-bit mdat and a trailing moov", async () => {
    const out = await write(undefined, [[0, frag(0, [{ size: 3 }, { size: 2 }])]]);
    const buf = out.bytes();
    expect([...boxes(buf)].map((b) => b.type)).toEqual(["ftyp", "mdat", "moov"]);
    const mdatBox = find(buf, "mdat")!;
    expect(new DataView(buf.buffer).getUint32(mdatBox.start)).toBe(1);
    expect(mdatBox.end - mdatBox.start).toBe(16 + 5);
    expect(String.fromCharCode(...buf.subarray(8, 12))).toBe("isom");
    expect(String.fromCharCode(...buf.subarray(16, 32))).toBe("isomiso2avc1mp41");
    expect(find(buf, "moov/mvex")).toBeUndefined();
    expect(out.closed).toBe(true);
  });

  it("builds run-length tables, folds a decode-time gap and renumbers the track", async () => {
    const buf = (
      await write(undefined, [
        [0, frag(100, [{ flags: 0x2000000 }, { flags: 0x1010000 }, { flags: 0x1010000 }])],
        [0, frag(135, [{ flags: 0x2000000, size: 2 }], 2)],
      ])
    ).bytes();
    const stbl = "moov/trak/mdia/minf/stbl";
    expect(words(buf, find(buf, `${stbl}/stts`)!)).toEqual([3, 2, 10, 1, 15, 1, 10]);
    expect(words(buf, find(buf, `${stbl}/stss`)!)).toEqual([2, 1, 4]);
    expect(find(buf, `${stbl}/ctts`)).toBeUndefined();
    expect(words(buf, find(buf, `${stbl}/stsz`)!)).toEqual([0, 4, 1, 1, 1, 2]);
    expect(words(buf, find(buf, `${stbl}/stsc`)!)).toEqual([2, 1, 3, 1, 2, 1, 2]);
    const [count, first, second] = words(buf, find(buf, `${stbl}/stco`)!);
    expect(count).toBe(2);
    expect(second! - first!).toBe(3);
    const tkhd = find(buf, "moov/trak/tkhd")!;
    expect(new DataView(buf.buffer).getUint32(tkhd.body + 12)).toBe(1);
    const mdhd = find(buf, "moov/trak/mdia/mdhd")!;
    expect(new DataView(buf.buffer).getUint32(mdhd.body + 16)).toBe(45);
  });

  it("writes ctts version 1 only when an offset is negative", async () => {
    const pos = (await write(undefined, [[0, frag(0, [{ cto: 20 }, { cto: 0 }])]])).bytes();
    const neg = (await write(undefined, [[0, frag(0, [{ cto: 10 }, { cto: -10 }])]])).bytes();
    const ctts = (b: Uint8Array) => find(b, "moov/trak/mdia/minf/stbl/ctts")!;
    expect(pos[ctts(pos).body]).toBe(0);
    expect(words(pos, ctts(pos))).toEqual([2, 1, 20, 1, 0]);
    expect(neg[ctts(neg).body]).toBe(1);
    expect(words(neg, ctts(neg)).map((w) => w | 0)).toEqual([2, 1, 10, 1, -10]);
  });

  it("omits stss for audio and when every video sample is sync", async () => {
    const audio = trackInit({ handler: "soun" });
    const a = (await write([audio], [[0, frag(0, [{ flags: 0x10000 }])]])).bytes();
    expect(find(a, "moov/trak/mdia/minf/stbl/stss")).toBeUndefined();
    const v = (await write(undefined, [[0, frag(0, [{}, {}])]])).bytes();
    expect(find(v, "moov/trak/mdia/minf/stbl/stss")).toBeUndefined();
  });

  it("keeps elst media_time and fills a zero segment_duration with the media duration", async () => {
    const elst = fullBox("elst", 0, 0, u32s(1, 0, 1920, 0x10000));
    const t = trackInit({ timescale: 16000, movieTimescale: 1000, boxes: { ...trackInit().boxes, edts: box("edts", elst) } });
    const buf = (await write([t], [[0, frag(0, Array(400).fill({ duration: 640 }))]])).bytes();
    expect(words(buf, find(buf, "moov/trak/edts/elst")!)).toEqual([1, 16000, 1920, 0x10000]);
    const tkhd = find(buf, "moov/trak/tkhd")!;
    expect(new DataView(buf.buffer).getUint32(tkhd.body + 20)).toBe(16000);
  });
});

describe("SampleTable", () => {
  it("switches to co64 past 4 GiB", () => {
    const t = new SampleTable(true);
    t.add(frag(0, [{}]), 100);
    t.add(frag(10, [{}]), 2 ** 32 + 5);
    const co64 = t.boxes().find((b) => String.fromCharCode(...b.subarray(4, 8)) === "co64")!;
    const view = new DataView(co64.buffer);
    expect(view.getUint32(12)).toBe(2);
    expect(view.getBigUint64(16)).toBe(100n);
    expect(view.getBigUint64(24)).toBe(2n ** 32n + 5n);
  });

  it("rejects overlapping fragments", () => {
    const t = new SampleTable(true);
    t.add(frag(0, [{}, {}]), 0);
    expect(() => t.add(frag(5, [{}]), 2)).toThrow(/overlap/);
  });
});

describe("interleave", () => {
  it("writes the fragment that starts earlier in seconds first", async () => {
    const order: string[] = [];
    const writer = { writeFragment: async (track: number, f: Fragment) => void order.push(`${track}@${f.baseDecodeTime}`) };
    async function* src(times: number[]) {
      for (const t of times) yield frag(t, [{}]);
    }
    await interleave(writer as unknown as Mp4Writer, [
      { timescale: 16000, fragments: src([0, 80000, 160000]) },
      { timescale: 44100, fragments: src([0, 110250, 330750]) },
    ]);
    expect(order).toEqual(["0@0", "1@0", "1@110250", "0@80000", "1@330750", "0@160000"]);
  });
});
