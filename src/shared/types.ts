export type ProbeResult =
  | { kind: "not-video-page" }
  | { kind: "error"; message: string }
  | { kind: "ok"; video: VideoInfo; offer: PlayOffer; playing: Playing };

/**
 * What the page player is playing, and how that was determined: the exact stream from the
 * format id in its current media URL, only its quality, or nothing usable.
 */
export type Playing =
  | { via: "player-stream"; qn: number; codec: VideoCodec }
  | { via: "player-quality"; qn: number }
  | { via: "unknown" };

/** A choice of video quality and codec within one PlayOffer. */
export interface Selection {
  qn: number;
  codec: VideoCodec;
}

export interface VideoInfo {
  bvid: string;
  aid: number;
  cid: number;
  p: number;
  title: string;
  /** Only for multi-part videos. */
  partTitle?: string;
  owner: string;
  durationSec: number;
  coverUrl: string;
  loggedIn: boolean;
}

export interface PlayOffer {
  videos: VideoStream[];
  audios: AudioStream[];
  /** Milliseconds; used to judge whether the URLs are close to expiry. */
  fetchedAt: number;
  source: "playinfo" | "playurl";
}

export interface StreamCommon {
  /** Primary first, then backups. */
  urls: string[];
  /** bit/s, for size estimates. */
  bandwidth: number;
  codecs: string;
  initRange: [number, number];
  indexRange: [number, number];
}

export type VideoCodec = "avc" | "hevc" | "av1";

export interface VideoStream extends StreamCommon {
  qn: number;
  codec: VideoCodec;
  width: number;
  height: number;
  frameRate: string;
}

export interface AudioStream extends StreamCommon {
  id: number;
}

export type TaskPhase =
  | { phase: "queued" }
  | { phase: "preparing" }
  | { phase: "downloading"; doneBytes: number; totalBytes: number; bytesPerSec: number }
  | { phase: "finalizing" }
  | { phase: "saving"; downloadId?: number }
  | { phase: "done"; downloadId: number; fileName: string }
  | { phase: "failed"; reason: FailureReason; message: string }
  | { phase: "canceled" };

export type FailureReason = "network" | "url-expired" | "not-media" | "storage-full" | "remux" | "internal";

export interface Chosen {
  video: VideoStream;
  audio: AudioStream;
}

export interface DownloadTask {
  id: string;
  video: VideoInfo;
  chosen: Chosen;
  fileName: string;
  createdAt: number;
  state: TaskPhase;
}

export const TERMINAL_PHASES = ["done", "failed", "canceled"] as const;

export function isTerminal(state: TaskPhase): boolean {
  return (TERMINAL_PHASES as readonly string[]).includes(state.phase);
}
