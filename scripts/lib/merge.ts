import fs from "node:fs";
import { Mp4Writer, interleave, parseFragments, parseInit, parseSidx, planRanges } from "../../src/remux";
import type { Fragment, PositionalWriter, TrackInit } from "../../src/remux";
import { boxes } from "../../src/remux/boxes";

/** Byte ranges of the initialization segment and the sidx, as playurl's segment_base reports them. */
export function locateHead(file: string): { initRange: [number, number]; indexRange: [number, number] } {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(Math.min(1 << 20, fs.fstatSync(fd).size));
    fs.readSync(fd, head, 0, head.length, 0);
    const top = [...topLevel(head)];
    const moov = top.find((b) => b.type === "moov");
    const sidx = top.find((b) => b.type === "sidx");
    if (!moov || !sidx) throw new Error(`${file}: no moov or sidx in the first MiB`);
    return { initRange: [0, moov.end - 1], indexRange: [sidx.start, sidx.end - 1] };
  } finally {
    fs.closeSync(fd);
  }
}

function* topLevel(head: Uint8Array) {
  for (const b of boxes(head)) {
    yield b;
    if (b.type === "sidx") return;
  }
}

function readRange(fd: number, first: number, last: number): Uint8Array {
  const buf = Buffer.alloc(last - first + 1);
  fs.readSync(fd, buf, 0, buf.length, first);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
}

/** Read one m4s the way the download engine does: head, then sidx-planned ranges. */
function openStream(file: string): { init: TrackInit; fragments: AsyncGenerator<Fragment>; close(): void } {
  const fd = fs.openSync(file, "r");
  const { indexRange } = locateHead(file);
  const head = readRange(fd, 0, indexRange[1]);
  const init = parseInit(head);
  const { segments } = parseSidx(head, 0);
  async function* fragments() {
    for (const r of planRanges(segments)) {
      yield* parseFragments(readRange(fd, r.first, r.last), init, r.first);
    }
  }
  return { init, fragments: fragments(), close: () => fs.closeSync(fd) };
}

export function fileWriter(path: string): PositionalWriter {
  const fd = fs.openSync(path, "w");
  return {
    async write(data, position) {
      fs.writeSync(fd, data, 0, data.length, position ?? null);
    },
    async close() {
      fs.closeSync(fd);
    },
  };
}

export async function mergeFiles(video: string, audio: string, out: string): Promise<void> {
  const streams = [openStream(video), openStream(audio)];
  try {
    const writer = new Mp4Writer(fileWriter(out), streams.map((s) => s.init));
    await writer.start();
    await interleave(
      writer,
      streams.map((s) => ({ timescale: s.init.timescale, fragments: s.fragments })),
    );
    await writer.finish();
  } finally {
    for (const s of streams) s.close();
  }
}
