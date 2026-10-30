import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { signWbi } from "../src/probe/wbi";
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

// Part 2 of the same video after in-site navigation: __playinfo__ still describes part 1, so the
// probe must call playurl, signed with the page's WBI keys and sent with the page's cookies.
const CID2 = 3;
const WBI_KEYS = { imgKey: "7cd084941338484aae1ad9425b84077c", subKey: "4932caff0ff746eab6f01bf08b70ac45" };
const part2Data = { ...videoData, pages: [...videoData.pages, { cid: CID2, page: 2, part: "第二部分", duration: 156 }] };
const part2Page = `<!doctype html><meta charset="utf-8"><title>fake video page p2</title><script>
window.__INITIAL_STATE__ = ${JSON.stringify({ videoData: part2Data })};
window.__playinfo__ = ${JSON.stringify(playinfo)};
window.player = { getManifest: () => ({ bvid: "${BVID}", cid: ${CID2}, p: 2 }), getSession: () => "session-2" };
localStorage.setItem("wbi_img_urls", "https://i0.hdslb.com/bfs/wbi/${WBI_KEYS.imgKey}.png-https://i0.hdslb.com/bfs/wbi/${WBI_KEYS.subKey}.png");
document.cookie = "DedeUserID=42; domain=.bilibili.com; path=/; secure";
</script><h1>fake video page p2</h1>`;
const apiCalls: { url: URL; cookie: string; signatureValid: boolean }[] = [];

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
        const params = Object.fromEntries([...url.searchParams].filter(([k]) => k !== "wts" && k !== "w_rid"));
        const resigned = signWbi(params, WBI_KEYS, Number(url.searchParams.get("wts")));
        apiCalls.push({ url, cookie: req.headers.cookie ?? "", signatureValid: resigned === url.search.slice(1) });
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "https://www.bilibili.com",
          "Access-Control-Allow-Credentials": "true",
        });
        res.end(JSON.stringify(playinfo));
        return true;
      }
      if (host !== "www.bilibili.com") return false;
      const html = !url.pathname.startsWith("/video/")
        ? "<!doctype html><title>home</title><h1>home</h1>"
        : url.searchParams.get("p") === "2"
          ? part2Page
          : videoPage;
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
  assert.equal(await popup.locator("main").getAttribute("data-source"), "playinfo");
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

  const part2 = await h.ctx.newPage();
  await part2.goto(`https://www.bilibili.com/video/${BVID}/?p=2`);
  const part2Tab = await popup.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: "https://www.bilibili.com/video/*" });
    return tabs.find((t) => t.url?.includes("p=2"))!.id!;
  });
  await popup.goto(`chrome-extension://${h.extensionId}/popup.html?tab=${part2Tab}`);
  await popup.locator("select").waitFor();
  assert.equal(await popup.locator("main").getAttribute("data-source"), "playurl");
  const part2Text = await popup.locator("main").innerText();
  assert.ok(part2Text.includes("P2 第二部分"), part2Text);
  assert.ok(!part2Text.includes("登录后可下载更高清晰度"), "logged-in page must not show the login hint");
  await popup.screenshot({ path: path.join(out, "5-part2-playurl.png") });
  assert.equal(apiCalls.length, 1);
  const call = apiCalls[0]!;
  assert.equal(call.url.pathname, "/x/player/wbi/playurl");
  assert.ok(call.signatureValid, `w_rid does not verify: ${call.url.search}`);
  const sent = Object.fromEntries(call.url.searchParams);
  assert.deepEqual(
    { bvid: sent.bvid, cid: sent.cid, qn: sent.qn, fnval: sent.fnval, fnver: sent.fnver, fourk: sent.fourk, session: sent.session },
    { bvid: BVID, cid: String(CID2), qn: "127", fnval: "4048", fnver: "0", fourk: "1", session: "session-2" },
  );
  assert.ok(!("try_look" in sent));
  assert.match(call.cookie, /DedeUserID=42/);
  ok(`stale __playinfo__ (other cid) -> one WBI-signed playurl call (w_rid verifies) with the page's cookies; part title and logged-in state shown`);
  console.log(`popup check passed; screenshots in ${out}`);
} finally {
  await h.close();
  await server.close();
}
