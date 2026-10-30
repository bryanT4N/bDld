import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import type { DownloadTask } from "../src/shared/types";
import { root } from "./lib/env";
import { openVideoTab, startFakeSite } from "./lib/fake-site";
import { largeVideo, syntheticAudio } from "./lib/fixtures";

// Measures a long download across a popup close and reopen: the server's bytes per second
// (what the network actually carried) next to the speed the popup displays.
const RATE = Number(process.env.RATE ?? 1.5 * 1024 * 1024);
const CLOSE_AT = 20;
const REOPEN_AT = 80;
const END_AT = Number(process.env.END_AT ?? 125);

const dir = path.join(root, ".cache", "speed-check");
const fixtures = path.join(root, ".cache", "fixtures");
const site = await startFakeSite({
  dir,
  title: "测速视频",
  durationSec: 180,
  videos: [{ qn: 64, codec: "avc", fmt: 30064, height: 720, file: largeVideo(fixtures, 180, 8) }],
  audio: { id: 30280, file: syntheticAudio(fixtures, 180) },
  mode: "paced",
  pacedBytesPerSec: RATE,
  pacedFirstByteDelayMs: Number(process.env.TTFB_MS ?? 0),
  player: { nowQ: 64, realQ: 64, playingFmt: 30064 },
});
const h = await site.launch();
const rows: string[] = [];
try {
  const tabId = await openVideoTab(h);
  const popupUrl = `chrome-extension://${h.extensionId}/popup.html?tab=${tabId}`;
  let popup: Page | undefined = await h.ctx.newPage();
  await popup.setViewportSize({ width: 340, height: 460 });
  await popup.goto(popupUrl);
  await popup.getByRole("button", { name: "下载", exact: true }).click();

  const t0 = Date.now();
  let lastBytes = site.server.sentBytes();
  for (let second = 1; second <= END_AT; second++) {
    await new Promise((r) => setTimeout(r, t0 + second * 1000 - Date.now()));
    const bytes = site.server.sentBytes();
    const serverRate = (bytes - lastBytes) / 1024;
    lastBytes = bytes;
    let shown = "(popup closed)";
    if (popup) shown = (await popup.locator(".action").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    rows.push(`${String(second).padStart(4)}s  server ${serverRate.toFixed(0).padStart(6)} KB/s  popup: ${shown}`);
    console.log(rows.at(-1));
    if (second === CLOSE_AT) {
      await popup!.close();
      popup = undefined;
    }
    if (second === REOPEN_AT) {
      popup = await h.ctx.newPage();
      await popup.setViewportSize({ width: 340, height: 460 });
      await popup.goto(popupUrl);
      await popup.screenshot({ path: path.join(dir, "reopen.png") });
    }
  }
  const tasks = (await h.sw.evaluate(() => chrome.runtime.sendMessage({ to: "engine", type: "tasks" }))) as DownloadTask[];
  console.log(`final engine state: ${JSON.stringify(tasks.at(-1)?.state)}`);
} finally {
  fs.writeFileSync(path.join(dir, "speed-log.txt"), rows.join("\n"));
  await h.close();
  await site.server.close();
}
