import type { AudioStream, Playing, PlayOffer, Selection, VideoCodec, VideoStream } from "./types";

/** Compatibility first: the order used when nothing says which codec to take. */
const CODEC_ORDER: VideoCodec[] = ["avc", "hevc", "av1"];

export const CODEC_NAMES: Record<VideoCodec, string> = { avc: "AVC", hevc: "HEVC", av1: "AV1" };

/** The highest-bitrate AAC track, or the highest-bitrate track if none is AAC. */
export function bestAudio(audios: AudioStream[]): AudioStream {
  const aac = audios.filter((a) => a.codecs.startsWith("mp4a"));
  return [...(aac.length ? aac : audios)].sort((a, b) => b.bandwidth - a.bandwidth)[0]!;
}

/** Offered qualities, highest first. */
export function qualities(offer: PlayOffer): number[] {
  return [...new Set(offer.videos.map((v) => v.qn))].sort((a, b) => b - a);
}

/** Codecs offered at a quality, compatibility first. */
export function codecsAt(offer: PlayOffer, qn: number): VideoCodec[] {
  return CODEC_ORDER.filter((c) => offer.videos.some((v) => v.qn === qn && v.codec === c));
}

export function streamFor(offer: PlayOffer, sel: Selection): VideoStream | undefined {
  return offer.videos.find((v) => v.qn === sel.qn && v.codec === sel.codec);
}

/** The selection at `qn`, keeping `codec` when that quality offers it. */
export function atQuality(offer: PlayOffer, qn: number, codec?: VideoCodec): Selection {
  const codecs = codecsAt(offer, qn);
  return { qn, codec: codec && codecs.includes(codec) ? codec : codecs[0]! };
}

/** What the player is playing when known; otherwise the highest quality with the most compatible codec. */
export function defaultSelection(offer: PlayOffer, playing: Playing): Selection {
  if (playing.via === "player-stream" && streamFor(offer, playing)) return { qn: playing.qn, codec: playing.codec };
  if (playing.via === "player-quality" && codecsAt(offer, playing.qn).length) return atQuality(offer, playing.qn);
  return atQuality(offer, qualities(offer)[0]!);
}

export function approxBytes(video: VideoStream, audio: AudioStream, durationSec: number): number {
  return Math.round(((video.bandwidth + audio.bandwidth) * durationSec) / 8);
}
