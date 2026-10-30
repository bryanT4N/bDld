import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Worker } from "playwright-core";
import { chromiumPath, dist, tempDir } from "./env";

export interface Harness {
  ctx: BrowserContext;
  sw: Worker;
  extensionId: string;
  downloadsDir: string;
  close(): Promise<void>;
}

/** Loads dist/, or the unpacked extension in BDLD_EXTENSION_DIR (e.g. an extracted release zip). */
export async function launchExtension(extraArgs: string[] = []): Promise<Harness> {
  const extension = process.env.BDLD_EXTENSION_DIR ?? dist;
  const profile = tempDir("bdld-profile-");
  const downloadsDir = tempDir("bdld-downloads-");
  fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
  fs.writeFileSync(
    path.join(profile, "Default", "Preferences"),
    JSON.stringify({ download: { default_directory: downloadsDir, prompt_for_download: false, directory_upgrade: true } }),
  );
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: chromiumPath(),
    headless: false,
    acceptDownloads: true,
    downloadsPath: downloadsDir,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, ...extraArgs],
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 15_000 }));
  // Playwright's download handling renames files (to GUIDs, or after the blob URL), which would
  // hide the name chrome.downloads chose; "default" restores the browser's own handling, and the
  // profile preference above points it at downloadsDir.
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
  const extensionId = new URL(sw.url()).host;
  return {
    ctx,
    sw,
    extensionId,
    downloadsDir,
    async close() {
      await ctx.close();
      fs.rmSync(profile, { recursive: true, force: true });
      fs.rmSync(downloadsDir, { recursive: true, force: true });
    },
  };
}
