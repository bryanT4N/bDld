import { qualityLabel } from "./quality";
import type { VideoInfo, VideoStream } from "./types";

const MAX_LENGTH = 150;

function clean(s: string): string {
  return s
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trimEnd(s: string): string {
  return s.replace(/[. ]+$/, "");
}

/** `{标题}[ - P{n} {分P标题}] [{BV号}] {清晰度}.mp4`, Windows-safe, at most 150 characters. */
export function buildFileName(video: VideoInfo, stream: VideoStream): string {
  const tail = ` [${clean(video.bvid)}] ${clean(qualityLabel(stream.qn, stream.height))}.mp4`;
  let head = clean(video.title);
  if (video.partTitle !== undefined) head += ` - P${video.p} ${clean(video.partTitle)}`;
  const room = MAX_LENGTH - [...tail].length;
  head = trimEnd([...head].slice(0, room).join(""));
  return `${head || video.bvid}${tail}`;
}
