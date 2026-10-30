import fs from "node:fs";
import path from "node:path";
import { signWbi } from "../../src/probe/wbi";
import type { VideoCodec } from "../../src/shared/types";
import { launchExtension, type Harness } from "./browser";
import { run } from "./env";
import { coverPng } from "./icon.mjs";
import { startMediaServer } from "./media-server";
import { locateHead } from "./merge";

export const BVID = "BV1LF4izVEnQ";
export const CID = 2;
export const CID2 = 3;
const CDN = "upos-sz-mirrorcosov.bilivideo.com";
const WBI_KEYS = { imgKey: "7cd084941338484aae1ad9425b84077c", subKey: "4932caff0ff746eab6f01bf08b70ac45" };
const CODEC_IDS: Record<VideoCodec, number> = { avc: 7, hevc: 12, av1: 13 };
const CODEC_STRINGS: Record<VideoCodec, string> = { avc: "avc1.64001F", hevc: "hev1.1.6.L120.90", av1: "av01.0.04M.08" };

export interface FakeVideo {
  qn: number;
  codec: VideoCodec;
  /** Format id in the media file name, `{cid}-1-{fmt}.m4s`. */
  fmt: number;
  height: number;
  file: string;
  /** bit/s reported in the offer; derived from the file size when omitted. */
  bandwidth?: number;
}

export interface FakeSiteOptions {
  dir: string;
  title: string;
  owner?: string;
  /** Sets the DedeUserID cookie on the main video page. */
  loggedIn?: boolean;
  durationSec: number;
  videos: FakeVideo[];
  audio: { id: number; file: string };
  /** media-server path mode for the primary URLs. */
  mode: "media" | "slow" | "paced";
  pacedBytesPerSec?: number;
  pacedFirstByteDelayMs?: number;
  /** What the page player reports: getQuality() and the format id of getMediaInfo().playUrl. */
  player?: { nowQ: number; realQ: number; playingFmt?: number };
}

export interface ApiCall {
  url: URL;
  cookie: string;
  signatureValid: boolean;
}

function openssl(): string {
  if (process.env.OPENSSL) return process.env.OPENSSL;
  const git = "C:/Program Files/Git/mingw64/bin/openssl.exe";
  return fs.existsSync(git) ? git : "openssl";
}

function selfSignedCert(dir: string): { key: string; cert: string } {
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  const config = path.join(dir, "openssl.cnf");
  fs.writeFileSync(config, "[req]\ndistinguished_name = dn\n[dn]\n");
  run(openssl(), ["req", "-x509", "-config", config, "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=bdld-test"]);
  return { key: fs.readFileSync(key, "utf8"), cert: fs.readFileSync(cert, "utf8") };
}

/**
 * An offline stand-in for www.bilibili.com, api.bilibili.com, the media CDN and the cover host,
 * reached through Chromium's host resolver rules so the extension runs unmodified.
 */
export async function startFakeSite(o: FakeSiteOptions) {
  fs.mkdirSync(o.dir, { recursive: true });
  const deadline = Math.floor(Date.now() / 1000) + 7200;
  const url = (mode: string, name: string) => `https://${CDN}/${mode}/${name}?deadline=${deadline}`;
  const range = ([a, b]: [number, number]) => `${a}-${b}`;
  const bandwidth = (file: string) => Math.round((fs.statSync(file).size * 8) / o.durationSec);
  const files: Record<string, string> = {};

  const video = o.videos.map((v) => {
    const name = `${CID}-1-${v.fmt}.m4s`;
    files[name] = v.file;
    const head = locateHead(v.file);
    return {
      id: v.qn, baseUrl: url(o.mode, name), backupUrl: [url("media", name)], bandwidth: v.bandwidth ?? bandwidth(v.file),
      codecs: CODEC_STRINGS[v.codec], width: Math.round((v.height * 16) / 9), height: v.height, frameRate: "25",
      codecid: CODEC_IDS[v.codec], segment_base: { initialization: range(head.initRange), index_range: range(head.indexRange) },
    };
  });
  const audioName = `${CID}-1-${o.audio.id}.m4s`;
  files[audioName] = o.audio.file;
  const aHead = locateHead(o.audio.file);
  const playinfo = {
    code: 0,
    data: {
      dash: {
        video,
        audio: [
          {
            id: o.audio.id, baseUrl: url(o.mode, audioName), backupUrl: [], bandwidth: bandwidth(o.audio.file), codecs: "mp4a.40.2",
            segment_base: { initialization: range(aHead.initRange), index_range: range(aHead.indexRange) },
          },
        ],
      },
    },
  };
  const videoData = {
    bvid: BVID, aid: 1, cid: CID, title: o.title, duration: o.durationSec,
    pic: "https://i0.hdslb.com/bfs/archive/cover.png", owner: { name: o.owner ?? "测试 UP 主" },
    pages: [{ cid: CID, page: 1, part: "P1", duration: o.durationSec }],
  };
  const playing = o.player?.playingFmt !== undefined ? url(o.mode, `${CID}-1-${o.player.playingFmt}.m4s`) : undefined;
  const playerJs = (cid: number, p: number, session: string) => `window.player = {
  getManifest: () => ({ bvid: "${BVID}", cid: ${cid}, p: ${p} }),
  getSession: () => "${session}",
  ${o.player ? `getQuality: () => ({ nowQ: ${o.player.nowQ}, realQ: ${o.player.realQ} }),` : ""}
  ${playing ? `getMediaInfo: () => ({ playUrl: ${JSON.stringify(playing)} }),` : ""}
};`;
  const videoPage = `<!doctype html><meta charset="utf-8"><title>fake video page</title><script>
window.__INITIAL_STATE__ = ${JSON.stringify({ videoData })};
window.__playinfo__ = ${JSON.stringify(playinfo)};
${playerJs(CID, 1, "s")}
${o.loggedIn ? 'document.cookie = "DedeUserID=42; domain=.bilibili.com; path=/; secure";' : ""}
</script><h1>fake video page</h1>`;

  // Part 2 after in-site navigation: __playinfo__ still describes part 1, so the probe must call
  // playurl, signed with the page's WBI keys and sent with the page's cookies.
  const part2Data = { ...videoData, pages: [...videoData.pages, { cid: CID2, page: 2, part: "第二部分", duration: o.durationSec }] };
  const part2Page = `<!doctype html><meta charset="utf-8"><title>fake video page p2</title><script>
window.__INITIAL_STATE__ = ${JSON.stringify({ videoData: part2Data })};
window.__playinfo__ = ${JSON.stringify(playinfo)};
${playerJs(CID2, 2, "session-2")}
localStorage.setItem("wbi_img_urls", "https://i0.hdslb.com/bfs/wbi/${WBI_KEYS.imgKey}.png-https://i0.hdslb.com/bfs/wbi/${WBI_KEYS.subKey}.png");
document.cookie = "DedeUserID=42; domain=.bilibili.com; path=/; secure";
</script><h1>fake video page p2</h1>`;

  const apiCalls: ApiCall[] = [];
  const server = await startMediaServer(files, {
    tls: selfSignedCert(o.dir),
    pacedBytesPerSec: o.pacedBytesPerSec,
    pacedFirstByteDelayMs: o.pacedFirstByteDelayMs,
    handle(req, res, u) {
      const host = req.headers.host ?? "";
      if (host === "i0.hdslb.com") {
        res.writeHead(200, { "Content-Type": "image/png" }).end(coverPng(320, 200));
        return true;
      }
      if (host === "api.bilibili.com") {
        const params = Object.fromEntries([...u.searchParams].filter(([k]) => k !== "wts" && k !== "w_rid"));
        const resigned = signWbi(params, WBI_KEYS, Number(u.searchParams.get("wts")));
        apiCalls.push({ url: u, cookie: req.headers.cookie ?? "", signatureValid: resigned === u.search.slice(1) });
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "https://www.bilibili.com",
          "Access-Control-Allow-Credentials": "true",
        });
        res.end(JSON.stringify(playinfo));
        return true;
      }
      if (host !== "www.bilibili.com") return false;
      const html = !u.pathname.startsWith("/video/")
        ? "<!doctype html><title>home</title><h1>home</h1>"
        : u.searchParams.get("p") === "2"
          ? part2Page
          : videoPage;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
      return true;
    },
  });

  const hosts = ["www.bilibili.com", "api.bilibili.com", CDN, "i0.hdslb.com"];
  return {
    server,
    apiCalls,
    title: o.title,
    launch: (options: { deviceScaleFactor?: number } = {}): Promise<Harness> =>
      launchExtension(
        [
        `--host-resolver-rules=${hosts.map((x) => `MAP ${x} 127.0.0.1:${server.port}`).join(", ")}`,
        "--ignore-certificate-errors",
        ],
        options,
      ),
  };
}

/** Open the fake video page and return its tab id. */
export async function openVideoTab(h: Harness, query = ""): Promise<number> {
  const tab = await h.ctx.newPage();
  await tab.goto(`https://www.bilibili.com/video/${BVID}/${query}`);
  return h.sw.evaluate(async (q) => {
    const tabs = await chrome.tabs.query({ url: "https://www.bilibili.com/video/*" });
    return tabs.find((t) => (q ? t.url?.includes(q) : !t.url?.includes("?")))!.id!;
  }, query);
}
