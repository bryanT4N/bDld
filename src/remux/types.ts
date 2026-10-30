export interface TrackInit {
  /** track_ID in the source file; tfhd boxes are matched against it. */
  trackId: number;
  /** mdhd timescale. */
  timescale: number;
  /** Source mvhd timescale, the unit of the source elst segment_duration. */
  movieTimescale: number;
  handler: "vide" | "soun";
  boxes: {
    tkhd: Uint8Array;
    edts?: Uint8Array;
    mdhd: Uint8Array;
    hdlr: Uint8Array;
    mediaHeader: Uint8Array;
    dinf: Uint8Array;
    stsd: Uint8Array;
  };
  trex: { sampleDescriptionIndex: number; duration: number; size: number; flags: number };
}

export interface Sample {
  duration: number;
  size: number;
  flags: number;
  cto: number;
}

export interface Fragment {
  baseDecodeTime: bigint;
  sampleDescriptionIndex: number;
  samples: Sample[];
  /** Bytes of all samples, in order and contiguous. */
  payload: Uint8Array;
}

/** One sidx reference: a moof+mdat run addressed by absolute file offset. */
export interface Segment {
  offset: number;
  size: number;
  duration: number;
}

export interface PositionalWriter {
  write(data: Uint8Array, position?: number): Promise<void>;
  close(): Promise<void>;
}
