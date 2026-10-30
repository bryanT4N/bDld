import type { AudioStream, Playing, ProbeResult, StreamCommon, VideoCodec, VideoInfo, VideoStream } from "../shared/types";

const MEDIA_HOSTS = ["bilivideo.com", "bilivideo.cn", "akamaized.net"];
const CODEC_IDS: Record<number, VideoCodec> = { 7: "avc", 12: "hevc", 13: "av1" };
const CODEC_PREFIXES: [string, VideoCodec][] = [
  ["avc1", "avc"],
  ["avc3", "avc"],
  ["hev1", "hevc"],
  ["hvc1", "hevc"],
  ["av01", "av1"],
];

class Invalid extends Error {}
class StalePage extends Error {}

type Obj = Record<string, unknown>;

function obj(v: unknown, what: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Invalid(`${what} 不是对象`);
  return v as Obj;
}

function str(o: Obj, key: string, what: string): string {
  const v = o[key];
  if (typeof v !== "string" || v === "") throw new Invalid(`${what}.${key} 缺失`);
  return v;
}

function int(o: Obj, key: string, what: string): number {
  const v = typeof o[key] === "string" && /^\d+$/.test(o[key] as string) ? Number(o[key]) : o[key];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Invalid(`${what}.${key} 不是有效的整数`);
  return v;
}

function either(o: Obj, a: string, b: string): unknown {
  return o[a] ?? o[b];
}

function byteRange(v: unknown, what: string): [number, number] {
  const m = typeof v === "string" ? /^(\d+)-(\d+)$/.exec(v) : null;
  if (!m) throw new Invalid(`${what} 不是字节范围`);
  const range: [number, number] = [Number(m[1]), Number(m[2])];
  if (range[0] > range[1]) throw new Invalid(`${what} 不是字节范围`);
  return range;
}

function mediaUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  try {
    const u = new URL(v);
    const allowed = MEDIA_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
    return allowed && (u.protocol === "https:" || u.protocol === "http:") ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** Common stream fields, or undefined when the stream has no URL this extension may fetch. */
function common(o: Obj, what: string): StreamCommon | undefined {
  const backups = either(o, "backupUrl", "backup_url");
  const candidates = [either(o, "baseUrl", "base_url"), ...(Array.isArray(backups) ? backups : [])];
  const urls = [...new Set(candidates.map(mediaUrl).filter((u): u is string => u !== undefined))];
  if (urls.length === 0) return undefined;
  const seg = obj(either(o, "segment_base", "SegmentBase"), `${what}.segment_base`);
  const initRange = byteRange(seg.initialization ?? seg.Initialization, `${what}.segment_base.initialization`);
  const indexRange = byteRange(either(seg, "index_range", "indexRange"), `${what}.segment_base.index_range`);
  if (initRange[0] !== 0 || indexRange[0] <= initRange[1]) throw new Invalid(`${what}.segment_base 范围无效`);
  return {
    urls,
    bandwidth: int(o, "bandwidth", what),
    codecs: str(o, "codecs", what),
    initRange,
    indexRange,
  };
}

function videoCodec(o: Obj, codecs: string): VideoCodec | undefined {
  const byId = typeof o.codecid === "number" ? CODEC_IDS[o.codecid] : undefined;
  return byId ?? CODEC_PREFIXES.find(([p]) => codecs.startsWith(p))?.[1];
}

function videoStream(v: unknown, i: number): VideoStream | undefined {
  const what = `dash.video[${i}]`;
  const o = obj(v, what);
  const c = common(o, what);
  if (!c) return undefined;
  const codec = videoCodec(o, c.codecs);
  if (!codec) return undefined;
  const frameRate = either(o, "frameRate", "frame_rate");
  return {
    ...c,
    qn: int(o, "id", what),
    codec,
    width: int(o, "width", what),
    height: int(o, "height", what),
    frameRate: typeof frameRate === "string" ? frameRate : "",
  };
}

function audioStream(v: unknown, i: number): AudioStream | undefined {
  const what = `dash.audio[${i}]`;
  const o = obj(v, what);
  const c = common(o, what);
  return c && { ...c, id: int(o, "id", what) };
}

function videoInfo(videoData: unknown, manifest: unknown, loggedIn: boolean): VideoInfo {
  const vd = obj(videoData, "videoData");
  const m = obj(manifest, "manifest");
  const bvid = str(m, "bvid", "manifest");
  if (str(vd, "bvid", "videoData") !== bvid) throw new StalePage("页面信息与正在播放的视频不一致，请刷新页面后再试");
  const cid = int(m, "cid", "manifest");
  const pages = Array.isArray(vd.pages) ? vd.pages.map((p, i) => obj(p, `videoData.pages[${i}]`)) : [];
  const page = pages.find((p) => Number(p.cid) === cid);
  const p = page ? int(page, "page", "page") : typeof m.p === "number" ? m.p : 1;
  const owner = obj(vd.owner, "videoData.owner");
  const info: VideoInfo = {
    bvid,
    aid: int(vd, "aid", "videoData"),
    cid,
    p,
    title: str(vd, "title", "videoData"),
    owner: typeof owner.name === "string" ? owner.name : "",
    durationSec: page ? int(page, "duration", "page") : int(vd, "duration", "videoData"),
    coverUrl: typeof vd.pic === "string" ? vd.pic.replace(/^http:/, "https:") : "",
    loggedIn,
  };
  if (pages.length > 1 && page && typeof page.part === "string") info.partTitle = page.part;
  return info;
}

function formatId(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    return /-(\d+)\.m4s$/.exec(new URL(url).pathname)?.[1];
  } catch {
    return undefined;
  }
}

/** Match what the player reports against the offered streams; anything unusable yields "unknown". */
function playing(player: unknown, videos: VideoStream[]): Playing {
  const p = typeof player === "object" && player !== null ? (player as Obj) : {};
  const fmt = formatId(p.playUrl);
  const exact = fmt === undefined ? undefined : videos.find((v) => v.urls.some((u) => formatId(u) === fmt));
  if (exact) return { via: "player-stream", qn: exact.qn, codec: exact.codec };
  const q = typeof p.quality === "object" && p.quality !== null ? (p.quality as Obj) : {};
  const qn = [q.realQ, q.nowQ]
    .map((v) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v))
    .find((v): v is number => typeof v === "number" && v > 0 && videos.some((s) => s.qn === v));
  return qn === undefined ? { via: "unknown" } : { via: "player-quality", qn };
}

/** Validate what the page probe returned (untrusted page data) into a ProbeResult. */
export function normalizeProbe(raw: unknown): ProbeResult {
  try {
    const r = obj(raw, "probe");
    if (r.kind === "not-video-page") return { kind: "not-video-page" };
    if (r.kind === "error") return { kind: "error", message: typeof r.message === "string" ? r.message : "未知错误" };
    if (r.kind !== "raw") throw new Invalid("无法识别页面返回的数据");
    const video = videoInfo(r.videoData, r.manifest, r.loggedIn === true);
    const play = obj(r.play, "playurl");
    if (!play.dash) return { kind: "error", message: "这个视频没有提供 DASH 格式，暂不支持" };
    const dash = obj(play.dash, "dash");
    const videos = (Array.isArray(dash.video) ? dash.video : []).map(videoStream).filter((s) => s !== undefined);
    const audios = (Array.isArray(dash.audio) ? dash.audio : []).map(audioStream).filter((s) => s !== undefined);
    if (videos.length === 0) return { kind: "error", message: "没有找到可下载的视频流" };
    if (audios.length === 0) return { kind: "error", message: "没有找到可下载的音频流" };
    return {
      kind: "ok",
      video,
      playing: playing(r.player, videos),
      offer: {
        videos,
        audios,
        fetchedAt: typeof r.fetchedAt === "number" ? r.fetchedAt : Date.now(),
        source: r.source === "playurl" ? "playurl" : "playinfo",
      },
    };
  } catch (e) {
    if (e instanceof Invalid) return { kind: "error", message: `页面数据无法识别：${e.message}` };
    if (e instanceof StalePage) return { kind: "error", message: e.message };
    throw e;
  }
}
