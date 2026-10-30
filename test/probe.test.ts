import { describe, expect, it } from "vitest";
import { normalizeProbe } from "../src/probe/normalize";
import playinfo from "./fixtures/probe-playinfo.json";

type Loose = Record<string, any>;
const clone = (): Loose => structuredClone(playinfo) as Loose;

describe("normalizeProbe", () => {
  it("normalizes a single-part playinfo result", () => {
    const r = normalizeProbe(playinfo);
    if (r.kind !== "ok") throw new Error(JSON.stringify(r));
    expect(r.video).toEqual({
      bvid: "BV1LF4izVEnQ",
      aid: 115442339857021,
      cid: 33291887011,
      p: 1,
      title: "测试视频：示例标题",
      owner: "示例UP主",
      durationSec: 156,
      coverUrl: "https://i2.hdslb.com/bfs/archive/0123456789abcdef.jpg",
      loggedIn: false,
    });
    expect(r.offer.source).toBe("playinfo");
    expect(r.offer.fetchedAt).toBe(1793260800000);
    expect(r.offer.videos.map((v) => [v.qn, v.codec, v.width, v.height, v.frameRate])).toEqual([
      [32, "avc", 852, 480, "25.000"],
      [32, "hevc", 852, 480, "25.000"],
      [16, "av1", 640, 360, "25.000"],
    ]);
    const avc = r.offer.videos[0]!;
    expect(avc.urls).toHaveLength(2);
    expect(avc.urls[0]).toContain("mirrorcosov.bilivideo.com");
    expect(avc.urls[1]).toContain("akamaized.net");
    expect(avc.initRange).toEqual([0, 954]);
    expect(avc.indexRange).toEqual([955, 1358]);
    expect(r.offer.audios.map((a) => [a.id, a.bandwidth, a.initRange, a.indexRange])).toEqual([
      [30216, 67133, [0, 817], [818, 1233]],
      [30280, 191000, [0, 817], [818, 1233]],
    ]);
  });

  it("records what the player is playing and how it was determined", () => {
    const withPlayer = (player: unknown) => {
      const raw = clone();
      raw.player = player;
      const r = normalizeProbe(raw);
      if (r.kind !== "ok") throw new Error(JSON.stringify(r));
      return r.playing;
    };
    const hevcUrl = "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/11/70/33291887011/33291887011-1-100110.m4s?x=1";
    expect(withPlayer({ quality: { nowQ: 16, realQ: 16 }, playUrl: hevcUrl })).toEqual({ via: "player-stream", qn: 32, codec: "hevc" });
    expect(withPlayer({ quality: { nowQ: 32, realQ: 16 }, playUrl: "https://x.bilivideo.com/2-1-99999.m4s" })).toEqual({ via: "player-quality", qn: 16 });
    expect(withPlayer({ quality: { nowQ: 32, realQ: 0 } })).toEqual({ via: "player-quality", qn: 32 });
    expect(withPlayer({ quality: { nowQ: "16", realQ: "16" } })).toEqual({ via: "player-quality", qn: 16 });
    expect(withPlayer({ quality: { nowQ: 120, realQ: 120 } })).toEqual({ via: "unknown" });
    expect(withPlayer({ quality: "x", playUrl: 42 })).toEqual({ via: "unknown" });
    expect(withPlayer(undefined)).toEqual({ via: "unknown" });
  });

  it("uses the current part of a multi-part video", () => {
    const raw = clone();
    raw.manifest = { bvid: "BV1LF4izVEnQ", cid: 222, p: 2 };
    raw.videoData.pages.push({ cid: 222, page: 2, from: "vupload", part: "第二集：结尾", duration: 61 });
    const r = normalizeProbe(raw);
    if (r.kind !== "ok") throw new Error(JSON.stringify(r));
    expect(r.video).toMatchObject({ cid: 222, p: 2, partTitle: "第二集：结尾", durationSec: 61 });
  });

  it("reports a page whose data belongs to another video", () => {
    const raw = clone();
    raw.manifest.bvid = "BV1xx411c7mD";
    expect(normalizeProbe(raw)).toEqual({ kind: "error", message: "页面信息与正在播放的视频不一致，请刷新页面后重试" });
  });

  it("rejects non-DASH and stream-less results", () => {
    const flv = clone();
    delete flv.play.dash;
    flv.play.durl = [{ url: "https://upos-sz-mirrorcosov.bilivideo.com/x.flv" }];
    expect(normalizeProbe(flv)).toMatchObject({ kind: "error", message: expect.stringContaining("DASH") });

    const noAudio = clone();
    noAudio.play.dash.audio = [];
    expect(normalizeProbe(noAudio)).toEqual({ kind: "error", message: "未找到可下载的音频流" });
  });

  it("explains malformed page data instead of throwing", () => {
    const raw = clone();
    delete raw.play.dash.video[0].SegmentBase;
    delete raw.play.dash.video[0].segment_base;
    expect(normalizeProbe(raw)).toMatchObject({ kind: "error", message: expect.stringMatching(/^页面数据无法识别：dash\.video\[0\]/) });
    expect(normalizeProbe(undefined)).toMatchObject({ kind: "error" });
  });

  it("passes probe-side outcomes through", () => {
    expect(normalizeProbe({ kind: "not-video-page" })).toEqual({ kind: "not-video-page" });
    expect(normalizeProbe({ kind: "error", message: "播放器尚未就绪，请稍后重试" })).toEqual({
      kind: "error",
      message: "播放器尚未就绪，请稍后重试",
    });
  });
});
