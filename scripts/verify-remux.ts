import fs from "node:fs";
import path from "node:path";
import { boxes } from "../src/remux/boxes";
import { root, run, tool } from "./lib/env";
import { REAL_FIXTURES, syntheticAudio, syntheticVideo } from "./lib/fixtures";
import { mergeFiles } from "./lib/merge";

const work = path.join(root, ".cache", "verify-remux");
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

const ffmpeg = tool("ffmpeg");
const ffprobe = tool("ffprobe");

function syntheticCases(): [string, string, string][] {
  const aac = syntheticAudio(work);
  return [
    ["synthetic AVC + AAC", syntheticVideo(work, "avc"), aac],
    ["synthetic HEVC + AAC", syntheticVideo(work, "hevc"), aac],
  ];
}

function realCases(): [string, string, string][] {
  const audio = path.join(REAL_FIXTURES, "audio-aac.m4s");
  if (!fs.existsSync(audio)) {
    console.log(`real fixtures not found in ${REAL_FIXTURES} (set BDLD_REAL_FIXTURES); skipping them`);
    return [];
  }
  return ["avc", "hevc", "av1"].map((c) => [`Bilibili ${c.toUpperCase()} + AAC`, path.join(REAL_FIXTURES, `video-${c}.m4s`), audio]);
}

interface Probe {
  streams: { index: number; codec_type: string; codec_name: string; start_time?: string; duration?: string; time_base: string }[];
  packets: Record<string, string | number>[];
}

function probe(file: string): Probe {
  return JSON.parse(
    run(ffprobe, [
      "-v", "error", "-show_data_hash", "md5", "-of", "json",
      "-show_entries",
      "stream=index,codec_type,codec_name,start_time,duration,time_base:packet=stream_index,pts,dts,duration,size,flags,data_hash",
      file,
    ]),
  ) as Probe;
}

const PACKET_FIELDS = ["pts", "dts", "duration", "size", "data_hash"] as const;
const keyframe = (p: Record<string, string | number>) => String(p.flags ?? "").includes("K");

function topLevelTypes(file: string): string[] {
  const buf = fs.readFileSync(file);
  const top = [...boxes(buf)];
  const moov = top.find((b) => b.type === "moov");
  const inMoov = moov ? [...boxes(buf, moov.body, moov.end)].map((b) => b.type) : [];
  return [...top.map((b) => b.type), ...inMoov.map((t) => `moov/${t}`)];
}

/**
 * "exact": every packet field and stream start/duration must be equal.
 * "start-shift": the same, except pts and dts may differ by one constant per stream that equals
 * the difference in stream start_time. The plain `ffmpeg -i v -i a -c copy` CLI subtracts each
 * input file's start time from its timestamps (unless -copyts); bDld keeps the source timeline,
 * as a DASH player does, because both m4s files share one timeline and shifting each to 0
 * separately could move audio against video. The "exact" run against a -copyts reference
 * proves that is the only difference.
 */
function compare(label: string, ours: string, ref: string, mode: "exact" | "start-shift"): string[] {
  const problems: string[] = [];
  const a = probe(ours);
  const b = probe(ref);
  const layout = topLevelTypes(ours);
  if (layout.includes("moof") || layout.includes("moov/mvex") || layout[0] !== "ftyp") {
    problems.push(`not a regular MP4: boxes ${layout.join(" ")}`);
  }
  if (a.streams.length !== b.streams.length) problems.push(`stream count ${a.streams.length} vs ${b.streams.length}`);
  for (const sb of b.streams) {
    const sa = a.streams.find((s) => s.codec_type === sb.codec_type);
    if (!sa) {
      problems.push(`missing ${sb.codec_type} stream`);
      continue;
    }
    const pa = a.packets.filter((p) => p.stream_index === sa.index);
    const pb = b.packets.filter((p) => p.stream_index === sb.index);
    const [num, den] = sb.time_base.split("/").map(Number) as [number, number];
    const shift =
      mode === "exact" ? 0 : Math.round(((Number(sa.start_time) - Number(sb.start_time)) * den) / num);
    const streamFields = mode === "exact" ? (["codec_name", "time_base", "start_time", "duration"] as const) : (["codec_name", "time_base", "duration"] as const);
    for (const f of streamFields) {
      if (sa[f] !== sb[f]) problems.push(`${sb.codec_type} stream ${f}: ${sa[f]} vs ffmpeg ${sb[f]}`);
    }
    if (pa.length !== pb.length) problems.push(`${sb.codec_type} packet count ${pa.length} vs ffmpeg ${pb.length}`);
    let diffs = 0;
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
      const x = pa[i]!;
      const y = pb[i]!;
      const fields: string[] = [];
      for (const f of ["pts", "dts"] as const) {
        if (Number(x[f]) - shift !== Number(y[f])) fields.push(`${f} ${x[f]} vs ${y[f]}`);
      }
      for (const f of ["duration", "size", "data_hash"] as const) {
        if (String(x[f]) !== String(y[f])) fields.push(`${f} ${x[f]} vs ${y[f]}`);
      }
      if (keyframe(x) !== keyframe(y)) fields.push(`keyframe ${keyframe(x)} vs ${keyframe(y)}`);
      if (fields.length && ++diffs <= 5) problems.push(`${sb.codec_type} packet ${i}: ${fields.join(", ")}`);
    }
    if (diffs > 5) problems.push(`${sb.codec_type}: ${diffs - 5} more differing packets`);
    console.log(
      `  [${mode}] ${sb.codec_type.padEnd(5)} ${sb.codec_name.padEnd(5)} packets ${pa.length}/${pb.length}, differing ${diffs}` +
        `${shift ? `, uniform pts/dts shift ${shift} ticks` : ""}, start ${sa.start_time}/${sb.start_time}, duration ${sa.duration}/${sb.duration}`,
    );
  }
  return problems;
}

const cases = [...syntheticCases(), ...realCases()];
let failed = 0;
for (const [label, video, audio] of cases) {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const ours = path.join(work, `${slug}.bdld.mp4`);
  await mergeFiles(video, audio, ours);
  console.log(`${label}:`);
  const problems: string[] = [];
  for (const [mode, extra] of [["start-shift", []], ["exact", ["-copyts"]]] as const) {
    const ref = path.join(work, `${slug}.ffmpeg${extra.join("")}.mp4`);
    run(ffmpeg, ["-v", "error", "-y", ...extra, "-i", video, "-i", audio, "-c", "copy", "-map", "0:v", "-map", "1:a", ref]);
    problems.push(...compare(label, ours, ref, mode).map((p) => `[${mode}] ${p}`));
  }
  if (problems.length) {
    failed++;
    for (const p of problems) console.log(`  DIFF ${p}`);
  } else {
    console.log("  match: every packet's pts, dts, duration, keyframe flag, size and md5; stream durations; regular MP4");
  }
}
console.log(failed ? `${failed} of ${cases.length} cases differ` : `all ${cases.length} cases match ffmpeg`);
process.exitCode = failed ? 1 : 0;
