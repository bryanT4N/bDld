import { Bytes, RemuxError, U32_MAX, fullBox } from "./bytes";
import type { Fragment } from "./types";

class U32List {
  private data = new Uint32Array(1024);
  length = 0;
  push(v: number): void {
    if (this.length === this.data.length) {
      const next = new Uint32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
  get(i: number): number {
    return this.data[i]!;
  }
  set(i: number, v: number): void {
    this.data[i] = v;
  }
}

const SAMPLE_IS_NON_SYNC = 0x10000;
const DEPENDS_ON_MASK = 0x3000000;
const DEPENDS_ON_OTHERS = 0x1000000;

function isSync(flags: number): boolean {
  return (flags & SAMPLE_IS_NON_SYNC) === 0 && (flags & DEPENDS_ON_MASK) !== DEPENDS_ON_OTHERS;
}

/** Per-track sample table accumulated while samples are written to mdat. */
export class SampleTable {
  private durations = new U32List();
  private sizes = new U32List();
  private ctos = new U32List();
  private syncNumbers = new U32List();
  private chunkOffsets: number[] = [];
  private chunkCounts = new U32List();
  private chunkDescriptions = new U32List();
  private firstDts: bigint | undefined;
  private endDts = 0n;
  private hasCto = false;
  private hasNegativeCto = false;

  constructor(private readonly allSync: boolean) {}

  get sampleCount(): number {
    return this.sizes.length;
  }

  /** Decode time of the first sample, which the output timeline starts at. */
  get startDts(): bigint {
    return this.firstDts ?? 0n;
  }

  /** Media duration from the first sample's decode time to the end of the last sample. */
  get duration(): number {
    return Number(this.endDts - this.startDts);
  }

  add(f: Fragment, offset: number): void {
    if (this.firstDts === undefined) {
      this.firstDts = f.baseDecodeTime;
      this.endDts = f.baseDecodeTime;
    } else if (f.baseDecodeTime !== this.endDts) {
      // stts carries no absolute times, so a gap or overlap between fragments is folded
      // into the previous sample's duration, as a remuxer deriving durations from dts does.
      const last = this.durations.length - 1;
      const adjusted = this.durations.get(last) + Number(f.baseDecodeTime - this.endDts);
      if (adjusted < 0) throw new RemuxError("fragment decode times overlap");
      this.durations.set(last, adjusted);
    }
    let dts = f.baseDecodeTime;
    for (const s of f.samples) {
      this.durations.push(s.duration);
      this.sizes.push(s.size);
      this.ctos.push(s.cto >>> 0);
      if (s.cto !== 0) this.hasCto = true;
      if (s.cto < 0) this.hasNegativeCto = true;
      if (!this.allSync && isSync(s.flags)) this.syncNumbers.push(this.sizes.length);
      dts += BigInt(s.duration);
    }
    this.endDts = dts;
    this.chunkOffsets.push(offset);
    this.chunkCounts.push(f.samples.length);
    this.chunkDescriptions.push(f.sampleDescriptionIndex);
  }

  boxes(): Uint8Array[] {
    const n = this.sampleCount;
    const out = [this.stts(n)];
    if (this.hasCto) out.push(this.ctts(n));
    if (!this.allSync && this.syncNumbers.length < n) out.push(this.stss());
    out.push(this.stsz(n), this.stsc(), this.stco());
    return out;
  }

  private runs(list: U32List, n: number): [number, number][] {
    const runs: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const v = list.get(i);
      const last = runs[runs.length - 1];
      if (last && last[1] === v) last[0]++;
      else runs.push([1, v]);
    }
    return runs;
  }

  private stts(n: number): Uint8Array {
    const runs = this.runs(this.durations, n);
    const b = new Bytes().u32(runs.length);
    for (const [count, delta] of runs) b.u32(count).u32(delta);
    return fullBox("stts", 0, 0, b.done());
  }

  private ctts(n: number): Uint8Array {
    const runs = this.runs(this.ctos, n);
    const b = new Bytes().u32(runs.length);
    for (const [count, offset] of runs) b.u32(count).u32(offset);
    return fullBox("ctts", this.hasNegativeCto ? 1 : 0, 0, b.done());
  }

  private stss(): Uint8Array {
    const b = new Bytes().u32(this.syncNumbers.length);
    for (let i = 0; i < this.syncNumbers.length; i++) b.u32(this.syncNumbers.get(i));
    return fullBox("stss", 0, 0, b.done());
  }

  private stsz(n: number): Uint8Array {
    const first = n > 0 ? this.sizes.get(0) : 0;
    let constant = n > 0;
    for (let i = 1; i < n && constant; i++) constant = this.sizes.get(i) === first;
    const b = new Bytes().u32(constant ? first : 0).u32(n);
    if (!constant) for (let i = 0; i < n; i++) b.u32(this.sizes.get(i));
    return fullBox("stsz", 0, 0, b.done());
  }

  private stsc(): Uint8Array {
    const entries: [number, number, number][] = [];
    for (let i = 0; i < this.chunkOffsets.length; i++) {
      const count = this.chunkCounts.get(i);
      const desc = this.chunkDescriptions.get(i);
      const last = entries[entries.length - 1];
      if (!last || last[1] !== count || last[2] !== desc) entries.push([i + 1, count, desc]);
    }
    const b = new Bytes().u32(entries.length);
    for (const [first, count, desc] of entries) b.u32(first).u32(count).u32(desc);
    return fullBox("stsc", 0, 0, b.done());
  }

  private stco(): Uint8Array {
    const wide = this.chunkOffsets.some((o) => o > U32_MAX);
    const b = new Bytes().u32(this.chunkOffsets.length);
    for (const o of this.chunkOffsets) {
      if (wide) b.u64(o);
      else b.u32(o);
    }
    return fullBox(wide ? "co64" : "stco", 0, 0, b.done());
  }
}
