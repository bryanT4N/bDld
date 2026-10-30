import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import type { MediaResponseRecord } from "../src/shared/messages";
import type { Chosen, DownloadTask, VideoInfo } from "../src/shared/types";
import { launchExtension } from "./lib/browser";
import { root } from "./lib/env";
import { mediaPair } from "./lib/fixtures";
import { startMediaServer } from "./lib/media-server";
import { locateHead, mergeFiles } from "./lib/merge";

const pair = mediaPair();
console.log(`fixtures: ${pair.real ? "real Bilibili m4s" : "synthetic"} (${path.basename(pair.video)}, ${path.basename(pair.audio)})`);
const server = await startMediaServer({ "video.m4s": pair.video, "audio.m4s": pair.audio });
const h = await launchExtension();

const future = Math.floor(Date.now() / 1000) + 7200;
const past = Math.floor(Date.now() / 1000) - 60;
const url = (mode: string, name: string, deadline = future) => `${server.origin}/${mode}/${name}?deadline=${deadline}`;

function chosen(videoUrls: string[], audioUrls = [url("media", "audio.m4s")]): Chosen {
  return {
    video: { urls: videoUrls, bandwidth: 400_000, codecs: "avc1.64001E", ...locateHead(pair.video), qn: 16, codec: "avc", width: 640, height: 360, frameRate: "25" },
    audio: { urls: audioUrls, bandwidth: 100_000, codecs: "mp4a.40.2", ...locateHead(pair.audio), id: 30216 },
  };
}

const info = (title: string): VideoInfo => ({
  bvid: "BV1LF4izVEnQ", aid: 1, cid: 2, p: 1, title, owner: "bDld", durationSec: 156, coverUrl: "", loggedIn: false,
});

const page: Page = await h.ctx.newPage();
await page.goto(`chrome-extension://${h.extensionId}/popup.html`);
const send = <T>(msg: unknown) => page.evaluate((m) => chrome.runtime.sendMessage(m), msg) as Promise<T>;
const tasks = () => send<DownloadTask[]>({ to: "sw", type: "tasks" });
const start = (title: string, c: Chosen) => send<DownloadTask>({ to: "sw", type: "start", video: info(title), chosen: c });

async function waitFor(id: string, phases: string[], timeoutMs = 120_000): Promise<DownloadTask> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const t = (await tasks()).find((x) => x.id === id);
    if (t && phases.includes(t.state.phase)) return t;
    if (Date.now() > until) throw new Error(`task ${id} stuck in ${JSON.stringify(t?.state)}`);
    await page.waitForTimeout(200);
  }
}

const opfsEntries = () =>
  page.evaluate(async () => {
    const names: string[] = [];
    for await (const k of (await navigator.storage.getDirectory()).keys()) names.push(k);
    return names;
  });

const sha256 = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const results: string[] = [];
const ok = (msg: string) => {
  results.push(msg);
  console.log(`ok   ${msg}`);
};

try {
  await page.evaluate(async () => {
    await (await navigator.storage.getDirectory()).getFileHandle("left-over-from-crash.mp4", { create: true });
  });
  const happy = await start("引擎测试 / 正常:下载?", chosen([url("flaky", "video.m4s"), url("media", "video.m4s")]));
  assert.equal(happy.fileName, "引擎测试 正常 下载 [BV1LF4izVEnQ] 360P 流畅.mp4");
  const done = await waitFor(happy.id, ["done", "failed", "canceled"]);
  assert.equal(done.state.phase, "done", JSON.stringify(done.state));
  if (done.state.phase !== "done") throw new Error();
  const [item] = await page.evaluate((id) => chrome.downloads.search({ id }), done.state.downloadId);
  assert.ok(item && item.state === "complete" && fs.existsSync(item.filename), `download item ${JSON.stringify(item)}`);
  const expected = path.join(root, ".cache", "engine-check-expected.mp4");
  await mergeFiles(pair.video, pair.audio, expected);
  assert.equal(sha256(item.filename), sha256(expected), "downloaded file differs from the Node remux of the same inputs");
  assert.ok(!(await opfsEntries()).includes("left-over-from-crash.mp4"));
  ok("stale OPFS file from a previous session removed when the engine started");
  ok(`flaky primary URL retried on backup; download complete (${item.fileSize} bytes), byte-identical to the Node remux`);
  assert.equal(path.basename(item.filename), done.fileName);
  ok(`saved on disk as "${path.basename(item.filename)}"`);

  const records = await page.evaluate(() => chrome.runtime.sendMessage({ to: "engine", type: "records" })) as MediaResponseRecord[];
  const mine = records.filter((r) => r.taskId === happy.id);
  assert.ok(mine.length > 2 && mine.every((r) => r.status === 206), JSON.stringify(mine.slice(0, 3)));
  const ranges = mine.map((r) => r.range);
  ok(`${mine.length} media responses, all 206; ranges e.g. ${ranges.slice(0, 3).join(", ")}`);
  const dropped = server.requests.find((r) => r.path === "/flaky/video.m4s")!;
  const retried = server.requests.find((r) => r.path === "/media/video.m4s");
  assert.equal(retried?.range, dropped.range);
  ok(`dropped connection on ${dropped.path} ${dropped.range} was retried on the backup URL`);

  const blocked = await start("引擎测试 567", chosen([url("html", "video.m4s")]));
  const failed = await waitFor(blocked.id, ["done", "failed", "canceled"]);
  assert.equal(failed.state.phase, "failed");
  if (failed.state.phase !== "failed") throw new Error();
  assert.equal(failed.state.reason, "not-media");
  assert.equal(server.requests.filter((r) => r.path === "/html/video.m4s").length, 1, "a block page must not be retried");
  ok(`567 text/html fails at once as not-media without retry: "${failed.state.message}"`);

  const expired = await start("引擎测试 过期", chosen([url("forbidden", "video.m4s", past)]));
  const exp = await waitFor(expired.id, ["done", "failed", "canceled"]);
  assert.ok(exp.state.phase === "failed" && exp.state.reason === "url-expired", JSON.stringify(exp.state));
  ok(`403 after deadline fails as url-expired: "${exp.state.message}"`);

  const slow = await start("引擎测试 慢速", chosen([url("slow", "video.m4s")], [url("slow", "audio.m4s")]));
  const queued = await start("引擎测试 排队", chosen([url("media", "video.m4s")]));
  assert.equal(queued.state.phase, "queued");
  await waitFor(slow.id, ["downloading"]);
  assert.equal((await tasks()).find((t) => t.id === queued.id)?.state.phase, "queued");
  ok("second task waits in the queue while the first downloads");
  await send({ to: "sw", type: "cancel", taskId: slow.id });
  assert.equal((await waitFor(slow.id, ["done", "failed", "canceled"])).state.phase, "canceled");
  const afterCancel = await waitFor(queued.id, ["done", "failed", "canceled"]);
  assert.equal(afterCancel.state.phase, "done", JSON.stringify(afterCancel.state));
  ok("canceling the active task starts the queued one, which completes");

  assert.deepEqual(await opfsEntries(), []);
  ok("no OPFS temp files remain");

  const rules = await h.sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0]!.condition.initiatorDomains, [h.extensionId]);
  ok(`DNR session rule ${rules[0]!.id} in place, scoped to initiator ${h.extensionId}`);
  console.log(`engine check passed (${results.length} checks)`);
} finally {
  await h.close();
  await server.close();
}
