import { buildFileName } from "../shared/filename";
import type { DownloadOutcome, MediaResponseRecord, SaveResult } from "../shared/messages";
import { isTerminal, type Chosen, type DownloadTask, type TaskPhase, type VideoInfo } from "../shared/types";
import { TaskError, failureOf } from "./errors";
import type { TempFile } from "./opfs";
import { downloadAndRemux } from "./pipeline";

const PROGRESS_INTERVAL_MS = 500;
const SPEED_WINDOW_MS = 3000;
const KEEP_FINISHED = 20;
const KEEP_RECORDS = 2000;

export interface EngineDeps {
  createTempFile(name: string): Promise<TempFile>;
  save(taskId: string, url: string, fileName: string): Promise<SaveResult>;
  notify(tasks: DownloadTask[]): void;
}

interface Run {
  task: DownloadTask;
  abort: AbortController;
  /** Set while waiting for the browser to finish saving. */
  awaitingDownload?: { id?: number; early: Map<number, DownloadOutcome>; resolve?(o: DownloadOutcome): void };
}

/** Owns every download task: one runs at a time, the rest wait in FIFO order. */
export class Engine {
  private readonly tasks: DownloadTask[] = [];
  private readonly records: MediaResponseRecord[] = [];
  private run: Run | undefined;
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: EngineDeps) {}

  list(): DownloadTask[] {
    return this.tasks;
  }

  responseRecords(): MediaResponseRecord[] {
    return this.records;
  }

  start(video: VideoInfo, chosen: Chosen): DownloadTask {
    const task: DownloadTask = {
      id: crypto.randomUUID(),
      video,
      chosen,
      fileName: buildFileName(video, chosen.video),
      createdAt: Date.now(),
      state: { phase: "queued" },
    };
    this.tasks.push(task);
    const finished = this.tasks.filter((t) => isTerminal(t.state));
    for (const old of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) {
      this.tasks.splice(this.tasks.indexOf(old), 1);
    }
    this.notify();
    void this.pump();
    return task;
  }

  cancel(taskId: string): void {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (task.state.phase === "queued") this.set(task, { phase: "canceled" });
    else if (this.run?.task === task && task.state.phase !== "saving") this.run.abort.abort();
  }

  /** Download events can arrive before the save request returns its id, so an early one is kept. */
  downloadChanged(downloadId: number, outcome: DownloadOutcome): void {
    const waiting = this.run?.awaitingDownload;
    if (!waiting) return;
    if (waiting.id === downloadId) waiting.resolve?.(outcome);
    else if (waiting.id === undefined) waiting.early.set(downloadId, outcome);
  }

  private set(task: DownloadTask, state: TaskPhase): void {
    task.state = state;
    this.notify();
  }

  private notify(throttled = false): void {
    if (throttled) {
      this.notifyTimer ??= setTimeout(() => this.notify(), PROGRESS_INTERVAL_MS);
      return;
    }
    clearTimeout(this.notifyTimer);
    this.notifyTimer = undefined;
    this.deps.notify(this.tasks);
  }

  private async pump(): Promise<void> {
    if (this.run) return;
    const next = this.tasks.find((t) => t.state.phase === "queued");
    if (!next) return;
    const run: Run = { task: next, abort: new AbortController() };
    this.run = run;
    await this.execute(run);
    this.run = undefined;
    void this.pump();
  }

  private async execute(run: Run): Promise<void> {
    const { task, abort } = run;
    let file: TempFile | undefined;
    let url: string | undefined;
    let done = 0;
    const samples: [number, number][] = [];
    try {
      this.set(task, { phase: "preparing" });
      file = await this.deps.createTempFile(`${task.id}.mp4`);
      await downloadAndRemux(
        [task.chosen.video, task.chosen.audio],
        file,
        {
          taskId: task.id,
          signal: abort.signal,
          record: (r) => {
            this.records.push(r);
            if (this.records.length > KEEP_RECORDS) this.records.shift();
          },
          onBytes: (n) => {
            done += n;
            if (task.state.phase !== "downloading") return;
            const now = Date.now();
            samples.push([now, done]);
            while (samples.length > 1 && now - samples[0]![0] > SPEED_WINDOW_MS) samples.shift();
            const [t0, d0] = samples[0]!;
            const bytesPerSec = now > t0 ? ((done - d0) * 1000) / (now - t0) : 0;
            task.state = { ...task.state, doneBytes: done, bytesPerSec };
            this.notify(true);
          },
        },
        {
          onDownloading: (totalBytes) => this.set(task, { phase: "downloading", doneBytes: done, totalBytes, bytesPerSec: 0 }),
          onFinalizing: () => this.set(task, { phase: "finalizing" }),
        },
      );
      url = URL.createObjectURL(await file.file());
      run.awaitingDownload = { early: new Map() };
      this.set(task, { phase: "saving" });
      const saved = await this.deps.save(task.id, url, task.fileName);
      if (!saved.ok) throw new TaskError("internal", `无法保存文件：${saved.error}`);
      this.set(task, { phase: "saving", downloadId: saved.downloadId });
      const outcome = await this.waitForDownload(run, saved.downloadId);
      if (outcome.state === "complete") {
        this.set(task, { phase: "done", downloadId: saved.downloadId, fileName: task.fileName });
      } else if (outcome.error === "USER_CANCELED") {
        this.set(task, { phase: "canceled" });
      } else {
        throw new TaskError("internal", `保存文件失败（${outcome.error}）`);
      }
    } catch (e) {
      this.set(task, abort.signal.aborted ? { phase: "canceled" } : failureOf(e));
      abort.abort();
    } finally {
      if (url) URL.revokeObjectURL(url);
      await file?.remove();
    }
  }

  private waitForDownload(run: Run, id: number): Promise<DownloadOutcome> {
    const waiting = run.awaitingDownload!;
    waiting.id = id;
    const early = waiting.early.get(id);
    if (early) return Promise.resolve(early);
    return new Promise((resolve) => (waiting.resolve = resolve));
  }
}
