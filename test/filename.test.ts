import { describe, expect, it } from "vitest";
import { buildFileName } from "../src/shared/filename";
import type { VideoInfo, VideoStream } from "../src/shared/types";

const video = (over: Partial<VideoInfo> = {}): VideoInfo => ({
  bvid: "BV1LF4izVEnQ", aid: 1, cid: 2, p: 1, title: "标题", owner: "UP", durationSec: 1, coverUrl: "", loggedIn: true, ...over,
});
const stream = (qn: number, height = 1080) => ({ qn, height }) as VideoStream;

describe("buildFileName", () => {
  it("formats single and multi-part names", () => {
    expect(buildFileName(video(), stream(80))).toBe("标题 [BV1LF4izVEnQ] 1080P 高清.mp4");
    expect(buildFileName(video({ p: 3, partTitle: "第三集" }), stream(64, 720))).toBe(
      "标题 - P3 第三集 [BV1LF4izVEnQ] 720P 高清.mp4",
    );
  });

  it("removes Windows-illegal and control characters and trailing dots", () => {
    expect(buildFileName(video({ title: 'a\\b/c:d*e?f"g<h>i|j\u0001k...  ' }), stream(16))).toBe(
      "a b c d e f g h i j k [BV1LF4izVEnQ] 360P 流畅.mp4",
    );
  });

  it("falls back to the height for unknown quality codes", () => {
    expect(buildFileName(video(), stream(999, 1440))).toBe("标题 [BV1LF4izVEnQ] 1440P.mp4");
  });

  it("truncates the title to 150 characters, keeping BV id and quality, without splitting emoji", () => {
    const name = buildFileName(video({ title: "长".repeat(100) + "😀".repeat(100) }), stream(120));
    expect([...name].length).toBeLessThanOrEqual(150);
    expect(name.endsWith(" [BV1LF4izVEnQ] 4K 超清.mp4")).toBe(true);
    expect(name).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("does not leave a trailing dot or space before the BV id after truncation", () => {
    const tail = " [BV1LF4izVEnQ] 1080P 高清.mp4";
    const name = buildFileName(video({ title: "a".repeat(150 - tail.length - 2) + ". bcd" }), stream(80));
    expect(name).toBe(`${"a".repeat(150 - tail.length - 2)}${tail}`);
  });
});
