import fs from "node:fs";
import { chromium, type BrowserContext, type Worker } from "playwright-core";
import { chromiumPath, dist, tempDir } from "./env";

export interface Harness {
  ctx: BrowserContext;
  sw: Worker;
  extensionId: string;
  downloadsDir: string;
  close(): Promise<void>;
}

export async function launchExtension(): Promise<Harness> {
  const profile = tempDir("bdld-profile-");
  const downloadsDir = tempDir("bdld-downloads-");
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: chromiumPath(),
    headless: false,
    acceptDownloads: true,
    downloadsPath: downloadsDir,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 15_000 }));
  const extensionId = new URL(sw.url()).host;
  return {
    ctx,
    sw,
    extensionId,
    downloadsDir,
    async close() {
      await ctx.close();
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}
