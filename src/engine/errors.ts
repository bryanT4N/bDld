import { RemuxError } from "../remux";
import type { FailureReason, TaskPhase } from "../shared/types";

export class TaskError extends Error {
  constructor(
    readonly reason: FailureReason,
    message: string,
  ) {
    super(message);
  }
}

export function failureOf(e: unknown): Extract<TaskPhase, { phase: "failed" }> {
  if (e instanceof TaskError) return { phase: "failed", reason: e.reason, message: e.message };
  if (e instanceof RemuxError) return { phase: "failed", reason: "remux", message: `视频数据无法解析：${e.message}` };
  if (e instanceof DOMException && e.name === "QuotaExceededError") {
    return { phase: "failed", reason: "storage-full", message: "磁盘空间不足" };
  }
  return { phase: "failed", reason: "internal", message: e instanceof Error ? e.message : String(e) };
}
