import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { root } from "./lib/env";
import { openVideoTab, startFakeSite } from "./lib/fake-site";
import { largeVideo, mediaPair, syntheticAudio } from "./lib/fixtures";

// Release screenshots from the offline fake site: neutral title, owner and cover, so no
// Bilibili content appears. Writes the README image to docs/images and the store listing images to docs/store.
const images = path.join(root, "docs", "images");
const store = path.join(root, "docs", "store");
fs.mkdirSync(images, { recursive: true });
fs.mkdirSync(store, { recursive: true });

const fixtures = path.join(root, ".cache", "fixtures");
const small = mediaPair().video;
const M = 1_000_000;
const site = await startFakeSite({
  dir: path.join(root, ".cache", "screenshots"),
  title: "示例视频标题",
  owner: "示例 UP 主",
  loggedIn: true,
  durationSec: 180,
  videos: [
    { qn: 80, codec: "avc", fmt: 30080, height: 1080, file: largeVideo(fixtures, 180, 8) },
    { qn: 80, codec: "hevc", fmt: 30077, height: 1080, file: small, bandwidth: 4.6 * M },
    { qn: 64, codec: "avc", fmt: 30064, height: 720, file: small, bandwidth: 3.2 * M },
    { qn: 64, codec: "hevc", fmt: 30066, height: 720, file: small, bandwidth: 1.9 * M },
    { qn: 32, codec: "avc", fmt: 30032, height: 480, file: small, bandwidth: 1.1 * M },
    { qn: 16, codec: "avc", fmt: 30016, height: 360, file: small, bandwidth: 0.6 * M },
  ],
  audio: { id: 30280, file: syntheticAudio(fixtures, 180) },
  mode: "paced",
  pacedBytesPerSec: 3 * 1024 * 1024,
  player: { nowQ: 80, realQ: 80, playingFmt: 30080 },
});
const h = await site.launch({ deviceScaleFactor: 2 });

const shots: Record<string, Buffer> = {};
async function capture(popup: Page, name: string): Promise<void> {
  shots[name] = await popup.locator("main").screenshot();
  if (name !== "downloading") return;
  // GitHub strips CSS from READMEs, so the rounded card has to be baked into the PNG.
  const style = await popup.addStyleTag({
    content: "html,body{background:transparent!important} main{background:var(--bg);border:1px solid var(--line);border-radius:12px}",
  });
  await popup.locator("main").screenshot({ path: path.join(images, `popup-${name}.png`), omitBackground: true });
  await style.evaluate((el) => (el as Element).remove());
  console.log(`docs/images/popup-${name}.png`);
}

const STORE_SHOTS: [string, string, string][] = [
  ["ready", "保存正在观看的视频", "默认选择播放器当前的清晰度与编码，显示预计大小。"],
  ["expanded", "改选清晰度与编码", "展开后可选择其他清晰度与编码。"],
  ["downloading", "显示下载进度", "显示进度、速度与剩余时间。关闭窗口不影响下载。"],
  ["done", "保存为标准 MP4", "文件进入浏览器的下载列表，可在文件夹中显示。"],
];

const page = (body: string, css: string) => `<!doctype html><meta charset="utf-8"><style>
* { box-sizing: border-box; margin: 0; }
body { font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif; color: #18191c; }
${css}</style>${body}`;

try {
  const tabId = await openVideoTab(h);
  const popup = await h.ctx.newPage();
  await popup.setViewportSize({ width: 340, height: 480 });
  await popup.goto(`chrome-extension://${h.extensionId}/popup.html?tab=${tabId}`);
  await popup.locator("details.choice").waitFor();
  await popup.locator(".cover").evaluate((img: HTMLImageElement) => img.decode());
  await capture(popup, "ready");
  await popup.locator(".choice summary").click();
  await popup.locator("select").waitFor();
  await capture(popup, "expanded");
  await popup.locator(".choice summary").click();
  await popup.getByRole("button", { name: "下载", exact: true }).click();
  await popup.waitForFunction(() => {
    const m = /^(\d+)% · .* 剩余/.exec(document.querySelector(".action .status p")?.textContent ?? "");
    return m !== null && Number(m[1]) >= 30;
  }, null, { timeout: 120_000 });
  await capture(popup, "downloading");
  await popup.getByText("已保存").waitFor({ timeout: 180_000 });
  await capture(popup, "done");

  const canvas = await h.ctx.newPage();
  await canvas.setViewportSize({ width: 1280, height: 800 });
  for (const [i, [name, title, text]] of STORE_SHOTS.entries()) {
    await canvas.setContent(
      page(
        `<main><section><h1>${title}</h1><p>${text}</p></section><img src="data:image/png;base64,${shots[name]!.toString("base64")}"></main>`,
        `main { width: 1280px; height: 800px; display: flex; align-items: center; justify-content: space-between;
          padding: 0 120px; background: #f4f5f7; }
        h1 { font-size: 44px; font-weight: 700; margin-bottom: 20px; }
        p { font-size: 22px; line-height: 1.6; color: #61666d; max-width: 600px; }
        img { width: 476px; border-radius: 12px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.16); background: #fff; }`,
      ),
    );
    await canvas.screenshot({ path: path.join(store, `screenshot-${i + 1}-${name}.png`), scale: "css" });
    console.log(`docs/store/screenshot-${i + 1}-${name}.png`);
  }

  fs.copyFileSync(path.join(root, "dist", "icons", "128.png"), path.join(store, "icon-128.png"));
  const icon = fs.readFileSync(path.join(root, "dist", "icons", "128.png")).toString("base64");
  await canvas.setViewportSize({ width: 440, height: 280 });
  await canvas.setContent(
    page(
      `<main><img src="data:image/png;base64,${icon}"><div><h1>bDld</h1><p>B站视频离线缓存工具</p></div></main>`,
      `main { width: 440px; height: 280px; display: flex; align-items: center; gap: 28px; padding: 0 44px; background: #fff0f4; }
      img { width: 112px; height: 112px; }
      h1 { font-size: 44px; font-weight: 700; }
      p { font-size: 20px; color: #61666d; margin-top: 6px; }`,
    ),
  );
  await canvas.screenshot({ path: path.join(store, "promo-440x280.png"), scale: "css" });
  console.log("docs/store/icon-128.png, docs/store/promo-440x280.png");
} finally {
  await h.close();
  await site.server.close();
}
