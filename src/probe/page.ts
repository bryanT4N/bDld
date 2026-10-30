import { signWbi, wbiKeysFrom } from "./wbi";

/**
 * What the page hands back across executeScript. Everything inside `raw` is page data and is
 * validated by normalizeProbe in the service worker.
 */
export type RawProbe =
  | { kind: "not-video-page" }
  | { kind: "error"; message: string }
  | {
      kind: "raw";
      videoData: unknown;
      manifest: unknown;
      play: unknown;
      source: "playinfo" | "playurl";
      loggedIn: boolean;
      fetchedAt: number;
    };

interface PageWindow {
  __INITIAL_STATE__?: { videoData?: unknown };
  __playinfo__?: { data?: { dash?: { video?: { baseUrl?: string; base_url?: string }[] } } };
  player?: { getManifest?(): { bvid?: string; cid?: number | string; p?: number } | undefined; getSession?(): string };
}

function playinfoCid(w: PageWindow): number | undefined {
  const first = w.__playinfo__?.data?.dash?.video?.[0];
  const url = first?.baseUrl ?? first?.base_url;
  const m = url ? /\/(\d+)-\d+-\d+\.m4s/.exec(new URL(url).pathname) : null;
  return m ? Number(m[1]) : undefined;
}

/** Runs in the video page's MAIN world; must not modify the page. */
export async function probePage(): Promise<RawProbe> {
  if (!/^\/video\/(BV[0-9A-Za-z]+|av\d+)/i.test(location.pathname)) return { kind: "not-video-page" };
  const w = window as unknown as PageWindow;
  const videoData = w.__INITIAL_STATE__?.videoData;
  if (!videoData) return { kind: "error", message: "页面还没有加载完，请稍后再试" };
  const manifest = w.player?.getManifest?.();
  if (!manifest?.cid || !manifest.bvid) return { kind: "error", message: "播放器还没有准备好，请稍后再试" };
  const loggedIn = /(?:^|;\s*)DedeUserID=\d+/.test(document.cookie);
  const base = { kind: "raw" as const, videoData, manifest, loggedIn, fetchedAt: Date.now() };

  if (w.__playinfo__?.data && playinfoCid(w) === Number(manifest.cid)) {
    return { ...base, play: w.__playinfo__.data, source: "playinfo" };
  }

  const keys = wbiKeysFrom(localStorage.getItem("wbi_img_urls") ?? "");
  if (!keys) return { kind: "error", message: "缺少接口签名信息，请刷新页面后再试" };
  const params: Record<string, string | number> = {
    bvid: manifest.bvid,
    cid: manifest.cid,
    qn: 127,
    fnval: 4048,
    fnver: 0,
    fourk: 1,
  };
  const session = w.player?.getSession?.();
  if (session) params.session = session;
  const url = `https://api.bilibili.com/x/player/wbi/playurl?${signWbi(params, keys, Math.round(Date.now() / 1000))}`;
  let body: { code?: number; message?: string; data?: unknown };
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return { kind: "error", message: `获取播放地址失败（HTTP ${res.status}）` };
    body = await res.json();
  } catch (e) {
    return { kind: "error", message: `获取播放地址失败：${(e as Error).message}` };
  }
  if (body.code !== 0 || !body.data) {
    return { kind: "error", message: `获取播放地址失败（${body.code} ${body.message ?? ""}）`.trim() };
  }
  return { ...base, play: body.data, source: "playurl" };
}
