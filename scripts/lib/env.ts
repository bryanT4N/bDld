import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const root = path.resolve(import.meta.dirname ?? ".", "..");
export const dist = path.join(root, "dist");

/** Resolve an ffmpeg tool from FFMPEG_DIR (e.g. ...\WinGet\Packages\yt-dlp.FFmpeg_...\bin), else PATH. */
export function tool(name: "ffmpeg" | "ffprobe"): string {
  const dir = process.env.FFMPEG_DIR;
  if (dir) {
    const exe = path.join(dir, process.platform === "win32" ? `${name}.exe` : name);
    if (!fs.existsSync(exe)) throw new Error(`${exe} not found (FFMPEG_DIR)`);
    return exe;
  }
  return name;
}

export function run(exe: string, args: string[]): string {
  return execFileSync(exe, args, { encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] });
}

/** Chromium build that honours --load-extension; CHROMIUM_PATH overrides the Playwright default. */
export function chromiumPath(): string {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = path.join(process.env.LOCALAPPDATA ?? os.homedir(), "ms-playwright");
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort() : [];
  for (const d of dirs.reverse()) {
    const exe = path.join(base, d, "chrome-win64", "chrome.exe");
    if (fs.existsSync(exe)) return exe;
  }
  throw new Error("Chromium not found; set CHROMIUM_PATH");
}

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
