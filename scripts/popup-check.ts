import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { iconPng } from "./lib/icon.mjs";
import { launchExtension } from "./lib/browser";
import { root, run } from "./lib/env";
import { mediaPair } from "./lib/fixtures";
import { startMediaServer } from "./lib/media-server";
import { locateHead } from "./lib/merge";

const out = path.join(root, ".cache", "popup-check");
fs.mkdirSync(out, { recursive: true });

function openssl(): string {
  if (process.env.OPENSSL) return process.env.OPENSSL;
  const git = "C:/Program Files/Git/mingw64/bin/openssl.exe";
  return fs.existsSync(git) ? git : "openssl";
}

const key = path.join(out, "key.pem");
const cert = path.join(out, "cert.pem");
const config = path.join(out, "openssl.cnf");
fs.writeFileSync(config, "[req]\ndistinguished_name = dn\n[dn]\n");
run(openssl(), ["req", "-x509", "-config", config, "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=bdld-test"]);

const BVID = "BV1LF4izVEnQ";
const CID = 2;
const pair = mediaPair();
const videoName = `${CID}-1-100023.m4s`;
const audioName = `${CID}-1-30216.m4s`;
const deadline = Math.floor(Date.now() / 1000) + 7200;
const media = (mode: string, name: string) => `https://upos-sz-mirrorcosov.bilivideo.com/${mode}/${name}?deadline=${deadline}`;
const range = ([a, b]: [number, number]) => `${a}-${b}`;
const bandwidth = (file: string) => Math.round((fs.statSync(file).size * 8) / 156);
const vHead = locateHead(pair.video);
const aHead = locateHead(pair.audio);

const playinfo = {
  code: 0,
  data: {
    dash: {
      video: [
        {
          id: 16, baseUrl: media("slow", videoName), backupUrl: [media("media", videoName)], bandwidth: bandwidth(pair.video),
          codecs: "avc1.64001E", width: 640, height: 360, frameRate: "25", codecid: 7,
          segment_base: { initialization: range(vHead.initRange), index_range: range(vHead.indexRange) },
        },
      ],
      audio: [
        {
          id: 30216, baseUrl: media("slow", audioName), backupUrl: [], bandwidth: bandwidth(pair.audio), codecs: "mp4a.40.2",
          segment_base: { initialization: range(aHead.initRange), index_range: range(aHead.indexRange) },
        },
      ],
    },
  },
};
const videoData = {
  bvid: BVID, aid: 1, cid: CID, title: "【测试】一个很长很长的视频标题，用来检查弹出窗口里两行截断的效果是否正常",
  duration: 156, pic: "https://i0.hdslb.com/bfs/archive/cover.png", owner: { name: "测试 UP 主" },
  pages: [{ cid: CID, page: 1, part: "P1", duration: 156 }],
};
const videoPage = `<!doctype html><meta charset="utf-8"><title>fake video page</title><script>
window.__INITIAL_STATE__ = ${JSON.stringify({ videoData })};
window.__playinfo__ = ${JSON.stringify(playinfo)};
window.player = { getManifest: () => ({ bvid: "${BVID}", cid: ${CID}, p: 1 }), getSession: () => "s" };
</script><h1>fake video page</h1>`;

const server = await startMediaServer(
  { [videoName]: pair.video, [audioName]: pair.audio },
  {
    tls: { key: fs.readFileSync(key, "utf8"), cert: fs.readFileSync(cert, "utf8") },
    handle(req, res, url) {
      const host = req.headers.host ?? "";
      if (host === "i0.hdslb.com") {
        res.writeHead(200, { "Content-Type": "image/png" }).end(iconPng(224));
        return true;
      }
      if (host === "api.bilibili.com") {
        res.writeHead(500).end();
        return true;
      }
      if (host !== "www.bilibili.com") return false;
      const html = url.pathname.startsWith("/video/") ? videoPage : "<!doctype html><title>home</title><h1>home</h1>";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
      return true;
    },
  },
);
const hosts = ["www.bilibili.com", "api.bilibili.com", "upos-sz-mirrorcosov.bilivideo.com", "i0.hdslb.com"];
const h = await launchExtension([
  `--host-resolver-rules=${hosts.map((x) => `MAP ${x} 127.0.0.1:${server.port}`).join(", ")}`,
  "--ignore-certificate-errors",
]);

const ok = (msg: string) => console.log(`ok   ${msg}`);
try {
  const tab = await h.ctx.newPage();
  await tab.goto(`https://www.bilibili.com/video/${BVID}/`);
  const home = await h.ctx.newPage();
  await home.goto("https://www.bilibili.com/");

  const popup = await h.ctx.newPage();
  await popup.setViewportSize({ width: 340, height: 420 });
  await popup.goto(`chrome-extension://${h.extensionId}/popup.html`);
  const tabIds = await popup.evaluate(async () => {
    const [video] = await chrome.tabs.query({ url: "https://www.bilibili.com/video/*" });
    const [home] = await chrome.tabs.query({ url: "https://www.bilibili.com/" });
    return { video: video!.id!, home: home!.id! };
  });

  await popup.goto(`chrome-extension://${h.extensionId}/popup.html?tab=${tabIds.home}`);
  await popup.getByText("请在 B 站视频页面使用").waitFor();
  await popup.screenshot({ path: path.join(out, "1-not-video-page.png") });
  ok("non-video tab shows the not-a-video-page state");

  await popup.goto(`chrome-extension://${h.extensionId}/popup.html?tab=${tabIds.video}`);
  await popup.locator("select").waitFor();
  const text = await popup.locator("main").innerText();
  for (const s of ["【测试】", "UP：测试 UP 主", "360P 流畅 · AVC · 约", "兼容优先", "体积优先", "登录后可下载更高清晰度"]) {
    assert.ok(text.includes(s), `popup should show "${s}":\n${text}`);
  }
  await popup.screenshot({ path: path.join(out, "2-ready.png") });
  ok("video tab: probe via executeScript(MAIN) + __playinfo__ rendered title, UP, quality with size, codec setting, login hint");

  await popup.getByRole("button", { name: "体积优先" }).click();
  assert.equal(await popup.evaluate(() => chrome.storage.sync.get("codecPreference").then((r) => r.codecPreference)), "size");
  await popup.getByText("优先 AV1").waitFor();
  await popup.getByRole("button", { name: "兼容优先" }).click();
  ok("codec preference toggles and is stored in chrome.storage.sync");

  await popup.getByRole("button", { name: "下载", exact: true }).click();
  await popup.getByText(/下载中 [1-9]\d?%/).waitFor({ timeout: 60_000 });
  await popup.getByText(/剩余/).waitFor({ timeout: 30_000 });
  await popup.screenshot({ path: path.join(out, "3-downloading.png") });
  assert.ok(await popup.getByRole("button", { name: "下载", exact: true }).isDisabled());
  ok("progress with percent, speed and remaining time; download button disabled while running");

  await popup.reload();
  await popup.getByText(/下载中|正在生成|正在保存|已保存/).first().waitFor();
  ok("reopened popup shows the running task from the engine");

  await popup.getByText("已保存").waitFor({ timeout: 120_000 });
  await popup.screenshot({ path: path.join(out, "4-done.png") });
  const fileName = await popup.locator(".detail").innerText();
  assert.equal(fileName, `${videoData.title} [${BVID}] 360P 流畅.mp4`);
  assert.ok(fs.existsSync(path.join(h.downloadsDir, fileName)), "file in the downloads folder");
  assert.ok(await popup.getByRole("button", { name: "在文件夹中显示" }).isVisible());
  ok(`done state shows "${fileName}" and 在文件夹中显示; file exists in the downloads folder`);

  const mediaRequests = server.requests.filter((r) => r.host.startsWith("upos-"));
  assert.ok(mediaRequests.length > 0);
  for (const r of mediaRequests) {
    assert.equal(r.headers.referer, "https://www.bilibili.com/");
    assert.equal(r.headers.origin, "https://www.bilibili.com");
    assert.equal(r.headers["sec-fetch-site"], "cross-site");
    assert.equal(r.headers["sec-fetch-mode"], "cors");
    assert.equal(r.headers.cookie, undefined);
    assert.match(r.range, /^bytes=\d+-\d+$/);
  }
  ok(`all ${mediaRequests.length} media requests carried Referer/Origin www.bilibili.com, Sec-Fetch-Site cross-site, no cookies, explicit byte ranges`);
  const pageRequests = server.requests.filter((r) => r.host === "api.bilibili.com");
  assert.equal(pageRequests.length, 0, "matching __playinfo__ must not trigger a playurl request");
  ok("no playurl request when __playinfo__ belongs to the current cid");
  console.log(`popup check passed; screenshots in ${out}`);
} finally {
  await h.close();
  await server.close();
}
