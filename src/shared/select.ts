import { qualityLabel } from "./quality";
import type { AudioStream, CodecPreference, PlayOffer, VideoCodec, VideoStream } from "./types";

const CODEC_ORDER: Record<CodecPreference, VideoCodec[]> = {
  compat: ["avc", "hevc", "av1"],
  size: ["av1", "hevc", "avc"],
};

export const CODEC_NAMES: Record<VideoCodec, string> = { avc: "AVC", hevc: "HEVC", av1: "AV1" };

export interface QualityOption {
  qn: number;
  label: string;
  video: VideoStream;
  audio: AudioStream;
  approxBytes: number;
}

/** The highest-bitrate AAC track, or the highest-bitrate track if none is AAC. */
export function bestAudio(audios: AudioStream[]): AudioStream {
  const aac = audios.filter((a) => a.codecs.startsWith("mp4a"));
  return [...(aac.length ? aac : audios)].sort((a, b) => b.bandwidth - a.bandwidth)[0]!;
}

/** One option per quality, highest first, each with the preferred codec available at that quality. */
export function qualityOptions(offer: PlayOffer, pref: CodecPreference, durationSec: number): QualityOption[] {
  const audio = bestAudio(offer.audios);
  const order = CODEC_ORDER[pref];
  const qns = [...new Set(offer.videos.map((v) => v.qn))].sort((a, b) => b - a);
  return qns.map((qn) => {
    const video = offer.videos
      .filter((v) => v.qn === qn)
      .sort((a, b) => order.indexOf(a.codec) - order.indexOf(b.codec))[0]!;
    return {
      qn,
      label: qualityLabel(qn, video.height),
      video,
      audio,
      approxBytes: Math.round(((video.bandwidth + audio.bandwidth) * durationSec) / 8),
    };
  });
}
