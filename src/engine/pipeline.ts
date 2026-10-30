import { Mp4Writer, interleave, parseFragments, parseInit, parseSidx, planRanges } from "../remux";
import type { ByteRange, Fragment, TrackInit } from "../remux";
import type { StreamCommon } from "../shared/types";
import { TaskError } from "./errors";
import { fetchRange, type FetchContext } from "./fetcher";
import { freeSpace, type TempFile } from "./opfs";

interface PreparedStream {
  stream: StreamCommon;
  init: TrackInit;
  ranges: ByteRange[];
}

async function prepare(stream: StreamCommon, ctx: FetchContext): Promise<PreparedStream & { headBytes: number }> {
  const [first] = stream.initRange;
  const last = stream.indexRange[1];
  const head = await fetchRange(stream.urls, { first, last }, ctx);
  const init = parseInit(head);
  const { segments } = parseSidx(head.subarray(stream.indexRange[0] - first), stream.indexRange[0]);
  return { stream, init, ranges: planRanges(segments), headBytes: head.length };
}

/** Fragments of one stream, with the next range already in flight while this one is consumed. */
async function* fragments(p: PreparedStream, ctx: FetchContext): AsyncGenerator<Fragment> {
  const get = (r: ByteRange) => fetchRange(p.stream.urls, r, ctx);
  let pending: Promise<Uint8Array> | undefined = p.ranges[0] && get(p.ranges[0]);
  for (let i = 0; pending; i++) {
    const body = await pending;
    const nextRange = p.ranges[i + 1];
    pending = nextRange && get(nextRange);
    pending?.catch(() => {});
    yield* parseFragments(body, p.init, p.ranges[i]!.first);
  }
}

export interface PipelineHooks {
  onDownloading(totalBytes: number): void;
  onFinalizing(): void;
}

/** Download both streams and remux them into `out`. Resolves once the MP4 is complete and closed. */
export async function downloadAndRemux(
  streams: [StreamCommon, StreamCommon],
  out: TempFile,
  ctx: FetchContext,
  hooks: PipelineHooks,
): Promise<void> {
  const prepared = await Promise.all(streams.map((s) => prepare(s, ctx)));
  const mediaBytes = prepared.reduce((n, p) => n + p.ranges.reduce((m, r) => m + r.last - r.first + 1, 0), 0);
  const free = await freeSpace();
  if (free !== undefined && free < mediaBytes * 1.05) throw new TaskError("storage-full", "磁盘空间不足");
  hooks.onDownloading(mediaBytes + prepared.reduce((n, p) => n + p.headBytes, 0));

  const writer = new Mp4Writer(out.writer, prepared.map((p) => p.init));
  await writer.start();
  await interleave(
    writer,
    prepared.map((p) => ({ timescale: p.init.timescale, fragments: fragments(p, ctx) })),
  );
  hooks.onFinalizing();
  await writer.finish();
}
