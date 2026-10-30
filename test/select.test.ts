import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration } from "../src/shared/format";
import { bestAudio, qualityOptions } from "../src/shared/select";
import type { AudioStream, PlayOffer, VideoCodec, VideoStream } from "../src/shared/types";

const v = (qn: number, codec: VideoCodec, bandwidth: number, height = 1080): VideoStream => ({
  qn, codec, bandwidth, height, width: 0, frameRate: "", codecs: "", urls: ["u"], initRange: [0, 1], indexRange: [2, 3],
});
const a = (id: number, bandwidth: number, codecs = "mp4a.40.2"): AudioStream => ({
  id, bandwidth, codecs, urls: ["u"], initRange: [0, 1], indexRange: [2, 3],
});

const offer: PlayOffer = {
  videos: [v(64, "av1", 300_000, 720), v(80, "hevc", 800_000), v(80, "avc", 1_600_000), v(80, "av1", 600_000), v(64, "avc", 700_000, 720)],
  audios: [a(30216, 64_000), a(30280, 192_000), a(30250, 900_000, "ec-3")],
  fetchedAt: 0,
  source: "playinfo",
};

describe("qualityOptions", () => {
  it("lists qualities highest first with the compatibility-first codec", () => {
    const opts = qualityOptions(offer, "compat", 100);
    expect(opts.map((o) => [o.qn, o.label, o.video.codec])).toEqual([
      [80, "1080P 高清", "avc"],
      [64, "720P 高清", "avc"],
    ]);
    expect(opts[0]!.audio.id).toBe(30280);
    expect(opts[0]!.approxBytes).toBe(((1_600_000 + 192_000) * 100) / 8);
  });

  it("prefers AV1, then HEVC for the size-first setting", () => {
    expect(qualityOptions(offer, "size", 1).map((o) => o.video.codec)).toEqual(["av1", "av1"]);
    const noAv1 = { ...offer, videos: offer.videos.filter((x) => x.codec !== "av1") };
    expect(qualityOptions(noAv1, "size", 1).map((o) => o.video.codec)).toEqual(["hevc", "avc"]);
  });

  it("picks the best AAC track and ignores others when AAC exists", () => {
    expect(bestAudio(offer.audios).id).toBe(30280);
    expect(bestAudio([a(1, 5, "flac"), a(2, 9, "ec-3")]).id).toBe(2);
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
