import fs from "node:fs";
import path from "node:path";
import { root, run, tool } from "./env";

export const REAL_FIXTURES =
  process.env.BDLD_REAL_FIXTURES ??
  path.join(process.env.LOCALAPPDATA ?? "", "Temp/claude/d--Memorandum/e357dd80-a815-4d53-bed5-54e984a51709/scratchpad/bili-fixtures");

const FRAG = ["-movflags", "+frag_keyframe+empty_moov+default_base_moof+global_sidx"];

export function synthesize(dir: string, name: string, args: string[]): string {
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, name);
  run(tool("ffmpeg"), ["-v", "error", "-y", ...args, ...FRAG, "-f", "mp4", out]);
  return out;
}

const testsrc = (seconds: number) => ["-f", "lavfi", "-i", `testsrc=duration=${seconds}:size=320x240:rate=25`, "-pix_fmt", "yuv420p"];

export function syntheticVideo(dir: string, codec: "avc" | "hevc", seconds = 6): string {
  const enc =
    codec === "avc"
      ? ["-c:v", "libx264", "-bf", "3", "-g", "50"]
      : ["-c:v", "libx265", "-x265-params", "bframes=3:keyint=50:min-keyint=50:log-level=error", "-tag:v", "hvc1"];
  return synthesize(dir, `synth-${codec}-${seconds}s.m4s`, [...testsrc(seconds), ...enc]);
}

export function syntheticAudio(dir: string, seconds = 6): string {
  return synthesize(dir, `synth-aac-${seconds}s.m4s`, [
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}:sample_rate=48000`,
    "-c:a", "aac", "-b:a", "128k", "-frag_duration", "2000000",
  ]);
}

/** A video+audio m4s pair: the real Bilibili fixtures when present, else synthetic ones. */
export function mediaPair(): { video: string; audio: string; real: boolean } {
  const video = path.join(REAL_FIXTURES, "video-avc.m4s");
  const audio = path.join(REAL_FIXTURES, "audio-aac.m4s");
  if (fs.existsSync(video) && fs.existsSync(audio)) return { video, audio, real: true };
  const dir = path.join(root, ".cache", "fixtures");
  return { video: syntheticVideo(dir, "avc", 30), audio: syntheticAudio(dir, 30), real: false };
}
