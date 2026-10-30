import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration } from "../src/shared/format";
import { approxBytes, atQuality, bestAudio, codecsAt, defaultSelection, qualities } from "../src/shared/select";
import type { AudioStream, PlayOffer, VideoCodec, VideoStream } from "../src/shared/types";

const v = (qn: number, codec: VideoCodec, bandwidth: number, height = 1080): VideoStream => ({
  qn, codec, bandwidth, height, width: 0, frameRate: "", codecs: "", urls: ["u"], initRange: [0, 1], indexRange: [2, 3],
});
const a = (id: number, bandwidth: number, codecs = "mp4a.40.2"): AudioStream => ({
  id, bandwidth, codecs, urls: ["u"], initRange: [0, 1], indexRange: [2, 3],
});

const offer: PlayOffer = {
  videos: [v(64, "av1", 300_000, 720), v(80, "hevc", 800_000), v(80, "avc", 1_600_000), v(80, "av1", 600_000), v(64, "hevc", 700_000, 720)],
  audios: [a(30216, 64_000), a(30280, 192_000), a(30250, 900_000, "ec-3")],
  fetchedAt: 0,
  source: "playinfo",
};

describe("selection", () => {
  it("lists qualities highest first and codecs compatibility first", () => {
    expect(qualities(offer)).toEqual([80, 64]);
    expect(codecsAt(offer, 80)).toEqual(["avc", "hevc", "av1"]);
    expect(codecsAt(offer, 64)).toEqual(["hevc", "av1"]);
  });

  it("defaults to the exact stream the player is playing", () => {
    expect(defaultSelection(offer, { via: "player-stream", qn: 64, codec: "av1" })).toEqual({ qn: 64, codec: "av1" });
  });

  it("uses the player's quality with the most compatible codec when only the quality is known", () => {
    expect(defaultSelection(offer, { via: "player-quality", qn: 64 })).toEqual({ qn: 64, codec: "hevc" });
  });

  it("falls back to the highest quality and most compatible codec", () => {
    expect(defaultSelection(offer, { via: "unknown" })).toEqual({ qn: 80, codec: "avc" });
    expect(defaultSelection(offer, { via: "player-quality", qn: 116 })).toEqual({ qn: 80, codec: "avc" });
  });

  it("keeps the codec when changing quality if that quality offers it", () => {
    expect(atQuality(offer, 64, "av1")).toEqual({ qn: 64, codec: "av1" });
    expect(atQuality(offer, 64, "avc")).toEqual({ qn: 64, codec: "hevc" });
  });

  it("picks the best AAC track and estimates size", () => {
    expect(bestAudio(offer.audios).id).toBe(30280);
    expect(bestAudio([a(1, 5, "flac"), a(2, 9, "ec-3")]).id).toBe(2);
    expect(approxBytes(v(80, "avc", 1_600_000), a(1, 192_000), 100)).toBe(((1_600_000 + 192_000) * 100) / 8);
  });
});

describe("format", () => {
  it("formats sizes and durations in Chinese units", () => {
    expect(formatBytes(512)).toBe("1 KB");
    expect(formatBytes(3.25 * 1024 ** 2)).toBe("3.3 MB");
    expect(formatBytes(250 * 1024 ** 2)).toBe("250 MB");
    expect(formatBytes(1.5 * 1024 ** 3)).toBe("1.50 GB");
    expect(formatDuration(0.2)).toBe("1 秒");
    expect(formatDuration(80)).toBe("1 分 20 秒");
    expect(formatDuration(120)).toBe("2 分");
    expect(formatDuration(3 * 3600 + 5 * 60)).toBe("3 小时 5 分");
  });
});
