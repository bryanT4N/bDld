import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { boxes } from "../src/remux/boxes";
import { buildFileName } from "../src/shared/filename";
import type { MediaResponseRecord } from "../src/shared/messages";
import type { DownloadTask } from "../src/shared/types";
import { launchExtension } from "./lib/browser";
import { root, run, tool } from "./lib/env";

// One public video, one page load and one download per run. Bilibili's CDN is sensitive to
// traffic, so nothing here retries; a block response is reported as it came.
const BVID = "BV1LF4izVEnQ";
const EXPECTED_SECONDS = 156;
const out = path.join(root, ".cache", "e2e");
fs.mkdirSync(out, { recursive: true });

const h = await launchExtension();
const ok = (msg: string) => console.log(`ok   ${msg}`);
let failed = false;
try {
  const tab = await h.ctx.newPage();
  await tab.goto(`https://www.bilibili.com/video/${BVID}/`, { waitUntil: "domcontentloaded" });
  await tab.waitForFunction(() => Boolean((window as { player?: { getManifest?(): unknown } }).player?.getManifest?.()), null, {
    timeout: 60_000,
  });

  const popup = await h.ctx.newPage();
  await popup.setViewportSize({ width: 340, height: 460 });
  await popup.goto(`chrome-extension://${h.extensionId}/popup.html`);
  const tabId = await popup.evaluate(async () => (await chrome.tabs.query({ url: "https://www.bilibili.com/video/*" }))[0]!.id!);

  const playurlCalls: string[] = [];
  tab.on("request", (r) => {
    if (r.url().includes("/x/player/wbi/playurl")) playurlCalls.push(r.url());
  });

  await popup.goto(`chrome-extension://${h.extensionId}/popup.html?tab=${tabId}`);
  await popup.locator("select").waitFor();
  const defaultOption = await popup.locator("select option:checked").innerText();
  await popup.screenshot({ path: path.join(out, "1-ready.png") });
  const source = await popup.locator("main").getAttribute("data-source");
  const callParams = playurlCalls.map((u) => [...new URL(u).searchParams.keys()].sort().join(","));
  ok(`popup default quality: ${defaultOption}; play URLs from ${source}; page playurl requests meanwhile: ${callParams.length ? callParams.join(" | ") : "none"}`);

  const started = Date.now();
  await popup.getByRole("button", { name: "下载", exact: true }).click();
  await popup.getByText(/^(已保存|已取消)$|失败|错误|不是视频|过期|不足|无法/).first().waitFor({ timeout: 10 * 60_000 });
  await popup.screenshot({ path: path.join(out, "2-finished.png") });

  const tasks = (await popup.evaluate(() => chrome.runtime.sendMessage({ to: "sw", type: "tasks" }))) as DownloadTask[];
  const task = tasks.at(-1)!;
  const records = ((await popup.evaluate(() => chrome.runtime.sendMessage({ to: "engine", type: "records" }))) as MediaResponseRecord[]).filter(
    (r) => r.taskId === task.id,
  );
  for (const r of records) console.log(`     ${r.status} ${r.contentType} ${r.host} ${r.range}`);
  if (task.state.phase !== "done") throw new Error(`task ended as ${JSON.stringify(task.state)}`);
  ok(`video "${task.video.title}" by ${task.video.owner}, ${task.video.durationSec}s, loggedIn=${task.video.loggedIn}`);
  ok(`downloaded ${task.chosen.video.qn}/${task.chosen.video.codec} + audio ${task.chosen.audio.id} in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  assert.ok(records.length >= 4, "expected init/index and media range requests for both streams");
  assert.ok(records.every((r) => r.status === 206 && !/html/i.test(r.contentType)), "every media response must be 206 media");
  ok(`${records.length} media responses, every one 206 (${[...new Set(records.map((r) => r.contentType))].join(", ")})`);

  const rules = await h.sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
  const rule = rules.find((r) => r.id === 1);
  assert.ok(rule, "DNR session rule 1 missing");
  assert.deepEqual(rule.condition.initiatorDomains, [h.extensionId]);
  assert.deepEqual(
    rule.action.requestHeaders?.map((x) => `${x.header}: ${x.value}`),
    ["referer: https://www.bilibili.com/", "origin: https://www.bilibili.com", "sec-fetch-site: cross-site"],
  );
  ok(`DNR session rule in place: ${rule.action.requestHeaders!.map((x) => `${x.header}=${x.value}`).join(", ")}; initiator ${h.extensionId}`);

  const file = path.join(h.downloadsDir, task.fileName);
  assert.ok(fs.existsSync(file), `${file} missing`);
  assert.equal(task.fileName, buildFileName(task.video, task.chosen.video));
  assert.match(task.fileName, new RegExp(`^[^\\\\/:*?"<>|]+ \\[${BVID}\\] [^\\\\/:*?"<>|]+\\.mp4$`));
  assert.ok([...task.fileName].length <= 150);
  ok(`file name per DESIGN 4.4: "${task.fileName}"`);

  const info = JSON.parse(
    run(tool("ffprobe"), ["-v", "error", "-of", "json", "-show_entries", "format=duration,format_name:stream=codec_type,codec_name,width,height,duration", file]),
  ) as { format: { duration: string }; streams: { codec_type: string; codec_name: string }[] };
  const types = info.streams.map((s) => s.codec_type).sort();
  assert.deepEqual(types, ["audio", "video"]);
  const duration = Number(info.format.duration);
  assert.ok(Math.abs(duration - EXPECTED_SECONDS) <= 1, `duration ${duration}`);
  const buf = fs.readFileSync(file);
  const top = [...boxes(buf)].map((b) => b.type);
  const moov = [...boxes(buf)].find((b) => b.type === "moov")!;
  const inMoov = [...boxes(buf, moov.body, moov.end)].map((b) => b.type);
  assert.deepEqual(top, ["ftyp", "mdat", "moov"]);
  assert.ok(!inMoov.includes("mvex"));
  ok(
    `ffprobe: ${info.streams.map((s) => `${s.codec_type} ${s.codec_name}`).join(", ")}; duration ${duration.toFixed(3)}s; ` +
      `${(buf.length / 1048576).toFixed(1)} MiB; boxes ${top.join(" ")} (regular MP4, moov has ${inMoov.join(" ")})`,
  );
  fs.copyFileSync(file, path.join(out, "downloaded.mp4"));
  console.log("e2e passed");
} catch (e) {
  failed = true;
  console.error(`e2e FAILED: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await h.close();
}
process.exitCode = failed ? 1 : 0;
