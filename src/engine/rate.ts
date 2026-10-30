const WINDOW_MS = 10_000;
const BUCKET_MS = 250;

/**
 * Bytes per second over the last few seconds of wall-clock time. Periods with no data count as
 * zero, so the rate falls during a stall and recovers smoothly instead of freezing or resetting.
 */
export class RateMeter {
  private readonly buckets: { start: number; bytes: number }[] = [];

  constructor(private readonly startedAt: number) {}

  add(bytes: number, now: number): void {
    const start = now - (now % BUCKET_MS);
    const last = this.buckets[this.buckets.length - 1];
    if (last?.start === start) last.bytes += bytes;
    else this.buckets.push({ start, bytes });
    this.prune(now);
  }

  rate(now: number): number {
    this.prune(now);
    const span = Math.min(WINDOW_MS, now - this.startedAt);
    if (span <= 0) return 0;
    return (this.buckets.reduce((n, b) => n + b.bytes, 0) * 1000) / span;
  }

  private prune(now: number): void {
    while (this.buckets[0] && this.buckets[0].start + BUCKET_MS <= now - WINDOW_MS) this.buckets.shift();
  }
}
