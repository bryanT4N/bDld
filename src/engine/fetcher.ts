import type { MediaResponseRecord } from "../shared/messages";
import type { ByteRange } from "../remux";
import { TaskError } from "./errors";

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = 1000;

export interface FetchContext {
  taskId: string;
  signal: AbortSignal;
  onBytes(n: number): void;
  record(r: MediaResponseRecord): void;
}

function deadlineOf(url: string): number | undefined {
  const v = new URL(url).searchParams.get("deadline");
  return v && /^\d+$/.test(v) ? Number(v) * 1000 : undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

class Retryable extends Error {}

async function attempt(url: string, range: ByteRange, ctx: FetchContext): Promise<Uint8Array> {
  const header = `bytes=${range.first}-${range.last}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Range: header }, credentials: "omit", cache: "no-store", signal: ctx.signal });
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    throw new Retryable(`请求失败：${(e as Error).message}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  ctx.record({ taskId: ctx.taskId, host: new URL(url).host, range: header, status: res.status, contentType, at: Date.now() });

  const deadline = deadlineOf(url);
  if (res.status === 403 && deadline !== undefined && Date.now() > deadline) {
    throw new TaskError("url-expired", "下载地址已过期");
  }
  if (res.status !== 206 || /text\/html/i.test(contentType)) {
    await res.body?.cancel();
    throw new TaskError("not-media", `服务器返回的不是视频数据（HTTP ${res.status}${contentType ? `，${contentType}` : ""}）`);
  }
  const expected = range.last - range.first + 1;
  const contentRange = res.headers.get("content-range");
  if (contentRange !== null && !contentRange.startsWith(`bytes ${range.first}-${range.last}/`)) {
    await res.body?.cancel();
    throw new TaskError("not-media", `服务器返回的数据范围不符（${contentRange}）`);
  }

  const out = new Uint8Array(expected);
  let got = 0;
  try {
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.length > expected) throw new TaskError("not-media", "服务器返回的数据超出请求范围");
      out.set(value, got);
      got += value.length;
      ctx.onBytes(value.length);
    }
  } catch (e) {
    if (e instanceof TaskError || ctx.signal.aborted) throw e;
    ctx.onBytes(-got);
    throw new Retryable(`连接中断：${(e as Error).message}`);
  }
  if (got !== expected) {
    ctx.onBytes(-got);
    throw new Retryable(`数据不完整（${got}/${expected} 字节）`);
  }
  return out;
}

/**
 * Fetch one byte range, rotating through primary and backup URLs with exponential backoff
 * on network failures. Any response that is not media fails at once and nothing is kept.
 */
export async function fetchRange(urls: string[], range: ByteRange, ctx: FetchContext): Promise<Uint8Array> {
  let last = "";
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    if (i > 0) await sleep(BACKOFF_MS * 2 ** (i - 1), ctx.signal);
    try {
      return await attempt(urls[i % urls.length]!, range, ctx);
    } catch (e) {
      if (!(e instanceof Retryable)) throw e;
      last = e.message;
    }
  }
  throw new TaskError("network", `网络错误，已重试 ${MAX_ATTEMPTS} 次：${last}`);
}
