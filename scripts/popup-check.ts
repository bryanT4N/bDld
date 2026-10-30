import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { DownloadTask } from "../src/shared/types";
import { root } from "./lib/env";
import { BVID, CID2, openVideoTab, startFakeSite } from "./lib/fake-site";
import { mediaPair } from "./lib/fixtures";

const out = path.join(root, ".cache", "popup-check");
const pair = mediaPair();
const site = await startFakeSite({
  dir: out,
  title: "【测试】一个很长很长的视频标题，用来检查弹出窗口里两行截断的效果是否正常",
  durationSec: 156,
  videos: [
    { qn: 32, codec: "avc", fmt: 30032, height: 480, file: pair.video },
    { qn: 32, codec: "hevc", fmt: 30033, height: 480, file: pair.video },
    { qn: 16, codec: "avc", fmt: 30016, height: 360, file: pair.video },
  ],
  audio: { id: 30216, file: pair.audio },
  mode: "slow",
  player: { nowQ: 32, realQ: 32, playingFmt: 30033 },
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
  const checked = () => popup.locator(".choice summary, p.choice").first().innerText();
  const expand = async () => {
    if (!(await popup.locator("select").isVisible())) await popup.locator(".choice summary").click();
    await popup.locator("select").waitFor();
  };
  await popup.setViewportSize({ width: 340, height: 420 });

  await popup.goto(`chrome-extension://${h.extensionId}/popup.html?tab=${tabIds.home}`);
  await popup.getByText("请在 B 站视频页面使用").waitFor();
  await popup.screenshot({ path: path.join(out, "1-not-video-page.png") });
  ok("non-video tab shows the not-a-video-page state");

  await popup.goto(`chrome-extension://${h.extensionId}/popup.html?tab=${tabIds.video}`);
  await popup.locator(".choice").waitFor();
  const text = await popup.locator("main").innerText();
  for (const s of ["【测试】", "UP：测试 UP 主", "480P 清晰 · HEVC · 约 8.5 MB", "登录后可下载更高清晰度"]) {
    assert.ok(text.includes(s), `popup should show "${s}":\n${text}`);
  }
  assert.equal(await popup.locator("main").getAttribute("data-source"), "playinfo");
  assert.equal(await popup.locator("main").getAttribute("data-playing"), "player-stream");
  assert.ok(!(await popup.locator("select").isVisible()), "choices stay collapsed until the summary is opened");
  assert.ok(!text.includes("优先"), text);
  ok("default is the stream the page player is playing (480P HEVC, not the compatibility-first AVC)");
  ok("video tab: probe via executeScript(MAIN) + __playinfo__ rendered title, UP, quality with size, codec setting, login hint");

  await popup.screenshot({ path: path.join(out, "2-ready-collapsed.png") });
  await expand();
  await popup.screenshot({ path: path.join(out, "2b-ready-expanded.png") });
  await popup.getByRole("button", { name: "AVC", exact: true }).click();
  assert.match(await checked(), /^480P 清晰 · AVC · 约/);
  await popup.locator("select").selectOption("16");
  assert.match(await checked(), /^360P 流畅 · AVC · 约/);
  assert.deepEqual(await popup.getByRole("button", { name: /^(AVC|HEVC|AV1)$/ }).allInnerTexts(), ["AVC"]);
  await popup.locator("select").selectOption("32");
  await popup.getByRole("button", { name: "HEVC", exact: true }).click();
  assert.match(await checked(), /^480P 清晰 · HEVC · 约/);
  await popup.locator("select").selectOption("16");
  ok("codec choice offers only the codecs at the selected quality and keeps the codec across quality changes when offered");

  await popup.getByRole("button", { name: "下载", exact: true }).click();
  const progressLine = /^[1-9]\d?% · [\d.]+\/[\d.]+ MB · [\d.]+ (KB|MB)\/s · 剩余 \d+:\d\d$/;
  await popup.locator(".action .status p").filter({ hasText: progressLine }).waitFor({ timeout: 60_000 });
  await popup.screenshot({ path: path.join(out, "3-downloading.png") });
  const during = await popup.locator(".action").innerText();
  assert.equal(await popup.getByRole("button", { name: "下载", exact: true }).count(), 0, during);
  assert.equal(await popup.getByRole("button", { name: "取消" }).count(), 1, during);
  assert.ok(!during.includes("下载中"), during);
  ok(`one status line "${during.split("\n")[0]}" with a single 取消 and no 下载 button`);
  ok("progress bar with percent, size, speed and time left while running");

  await popup.reload();
  await popup.getByText(/^\d+% · |正在生成|正在保存|已保存/).first().waitFor();
  assert.match(await checked(), /^360P 流畅 · AVC · 约/, "reopened popup must show the task's choice, not the 480P HEVC default");
  assert.equal(await popup.locator("details.choice").count(), 0, "no disclosure while the task runs");
  await popup.screenshot({ path: path.join(out, "3b-reopened-during-download.png") });
  ok("reopened popup keeps the running task's 360P AVC (not the player default 480P HEVC) and locks the choice");
  const elsewhere = await h.ctx.newPage();
  await elsewhere.setViewportSize({ width: 340, height: 420 });
  await elsewhere.goto(`chrome-extension://${h.extensionId}/popup.html?tab=${tabIds.home}`);
  await elsewhere.getByText(/^\d+% · |正在生成|正在保存|已保存/).first().waitFor();
  assert.ok((await elsewhere.locator("main").innerText()).includes("【测试】"));
  await elsewhere.close();
  ok("popup opened on a non-video tab shows the running download from the engine");
  ok("reopened popup shows the running task from the engine");

  await popup.getByText("已保存").waitFor({ timeout: 120_000 });
  await popup.screenshot({ path: path.join(out, "4-done.png") });
  assert.equal(await popup.locator("details.choice").count(), 1, "choices reopen as soon as the task finishes");
  const finished = (await popup.evaluate(() => chrome.runtime.sendMessage({ to: "sw", type: "tasks" }))) as DownloadTask[];
  const fileName = finished.at(-1)!.fileName;
  const after = await popup.locator(".action").innerText();
  assert.equal(await popup.getByRole("button", { name: "下载", exact: true }).count(), 0, after);
  assert.equal(await popup.getByRole("button", { name: "取消" }).count(), 0, after);
  assert.equal(fileName, `${videoData.title} [${BVID}] 360P 流畅.mp4`);
  await popup.reload();
  await popup.getByText("已保存").waitFor();
  assert.match(await checked(), /^360P 流畅 · AVC · 约/, "a finished task's choice is kept after reopening");
  assert.equal(await popup.locator("details.choice").count(), 1, "choices can be opened again after completion");
  await expand();
  await popup.locator("select").selectOption("32");
  assert.equal(await popup.getByRole("button", { name: "下载", exact: true }).count(), 1);
  assert.equal(await popup.getByRole("button", { name: "在文件夹中显示" }).count(), 0);
  await popup.locator("select").selectOption("16");
  assert.equal(await popup.getByRole("button", { name: "下载", exact: true }).count(), 0);
  ok("after completion a different choice offers 下载 again, never both actions");
  assert.ok(fs.existsSync(path.join(h.downloadsDir, fileName)), "file in the downloads folder");
  assert.ok(await popup.getByRole("button", { name: "在文件夹中显示" }).isVisible());
  ok(`done state shows "${fileName}" and 在文件夹中显示; file exists in the downloads folder`);

  fs.rmSync(path.join(h.downloadsDir, fileName));
  await popup.reload();
  const deletedAt = Date.now();
  await popup.getByRole("button", { name: "下载", exact: true }).waitFor();
  console.log(`     deletion noticed ${((Date.now() - deletedAt) / 1000).toFixed(1)} s after reopening`);
  assert.equal(await popup.getByText("已保存").count(), 0);
  assert.match(await checked(), /^480P 清晰 · HEVC · 约/, "with the file gone the default follows the player again");
  ok("file deleted from the downloads folder: reopened popup shows 下载 with the player's 480P HEVC");

  await popup.getByRole("button", { name: "下载", exact: true }).click();
  await popup.getByText(/^\d+% · /).first().waitFor({ timeout: 60_000 });
  await popup.getByText("已保存").waitFor({ timeout: 120_000 });
  await popup.reload();
  await popup.getByText("已保存").waitFor();
  assert.ok(await popup.getByRole("button", { name: "在文件夹中显示" }).isVisible());
  assert.equal(await popup.getByRole("button", { name: "重新下载" }).count(), 1);
  assert.equal(await popup.getByRole("button", { name: "下载", exact: true }).count(), 0);
  assert.equal(await popup.getByRole("button", { name: "取消" }).count(), 0);
  await popup.screenshot({ path: path.join(out, "4b-done-with-redownload.png") });
  ok("file kept: reopened popup shows 已保存 with 在文件夹中显示 and 重新下载");

  await popup.getByRole("button", { name: "重新下载" }).click();
  await popup.getByText(/^\d+% · /).first().waitFor({ timeout: 60_000 });
  await popup.getByText("已保存").waitFor({ timeout: 120_000 });
  const base = `${videoData.title} [${BVID}] 480P 清晰`;
  for (const name of [`${base}.mp4`, `${base} (1).mp4`]) {
    assert.ok(fs.existsSync(path.join(h.downloadsDir, name)), `${name} missing; folder has ${fs.readdirSync(h.downloadsDir).join(", ")}`);
  }
  ok(`重新下载 saved a second file without overwriting: "${base} (1).mp4"`);
  const kept = ((await popup.evaluate(() => chrome.runtime.sendMessage({ to: "sw", type: "tasks" }))) as DownloadTask[]).filter(
    (t) => t.video.cid === 2,
  );
  assert.equal(kept.length, 1, JSON.stringify(kept.map((t) => t.state.phase)));
  ok("engine keeps only the latest finished task for the video");

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
  await popup.locator(".choice").waitFor();
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
