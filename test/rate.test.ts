import { describe, expect, it } from "vitest";
import { RateMeter } from "../src/engine/rate";

describe("RateMeter", () => {
  it("measures steady throughput over the window", () => {
    const m = new RateMeter(0);
    for (let t = 0; t < 10_000; t += 100) m.add(100_000, t);
    expect(m.rate(10_000)).toBeCloseTo(1_000_000, -4);
  });

  it("uses the elapsed time before a full window has passed", () => {
    const m = new RateMeter(0);
    m.add(500_000, 100);
    expect(m.rate(1000)).toBe(500_000);
  });

  it("falls during a stall instead of freezing, and drops nothing when data resumes", () => {
    const m = new RateMeter(0);
    for (let t = 0; t < 10_000; t += 100) m.add(100_000, t);
    expect(m.rate(15_000)).toBeCloseTo(500_000, -5);
    expect(m.rate(20_500)).toBe(0);
    m.add(100_000, 20_500);
    m.add(100_000, 20_600);
    expect(m.rate(20_700)).toBe(20_000);
  });
});
