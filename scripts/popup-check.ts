import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { root } from "./lib/env";
import { BVID, CID2, openVideoTab, startFakeSite } from "./lib/fake-site";
import { mediaPair } from "./lib/fixtures";

const out = path.join(root, ".cache", "popup-check");
const pair = mediaPair();
const site = await startFakeSite({
  dir: out,
  title: "【测试】一个很长很长的视频标题，用来检查弹出窗口里两行截断的效果是否正常",
  durationSec: 156,
  videos: [{ qn: 16, codec: "avc", fmt: 100023, height: 360, file: pair.video }],
  audio: { id: 30216, file: pair.audio },
  mode: "slow",
});
const { server, apiCalls } = site;
const videoData = { title: site.title };
const h = await site.launch();

const ok = (msg: string) => console.log(`ok   ${msg}`);
try {
  const videoTab = await openVideoTab(h);
  const home = await h.ctx.newPage();
  await home.goto("https://www.bilibili.com/");
  const homeTab = await h.sw.evaluate(async () => (await chrome.tabs.query({ url: "https://www.bilibili.com/" }))[0]!.id!);
  const tabIds = { video: videoTab, home: homeTab };

  const popup = await h.ctx.newPage();
  await popup.setViewportSize({ width: 340, height: 420 });

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

  const part2Tab = await openVideoTab(h, "?p=2");
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
