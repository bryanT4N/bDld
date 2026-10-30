import type { Chosen, DownloadTask, ProbeResult, VideoInfo } from "./types";

/** Handled by the service worker: everything from the popup, plus `save` from the engine. */
export type SwRequest =
  | { to: "sw"; type: "probe"; tabId: number }
  | { to: "sw"; type: "start"; video: VideoInfo; chosen: Chosen }
  | { to: "sw"; type: "tasks" }
  | { to: "sw"; type: "cancel"; taskId: string }
  | { to: "sw"; type: "show"; downloadId: number }
  | { to: "sw"; type: "save"; taskId: string; url: string; fileName: string };

/** Service worker → offscreen engine. */
export type EngineRequest =
  | { to: "engine"; type: "start"; video: VideoInfo; chosen: Chosen }
  | { to: "engine"; type: "tasks" }
  | { to: "engine"; type: "cancel"; taskId: string }
  | { to: "engine"; type: "download-changed"; downloadId: number; outcome: DownloadOutcome }
  | { to: "engine"; type: "records" };

export type DownloadOutcome = { state: "complete" } | { state: "interrupted"; error: string };

export type SaveResult = { ok: true; downloadId: number } | { ok: false; error: string };

/** One media response as the engine saw it, kept for diagnostics and the e2e check. */
export interface MediaResponseRecord {
  taskId: string;
  host: string;
  range: string;
  status: number;
  contentType: string;
  at: number;
}

export interface Responses {
  sw: {
    probe: ProbeResult;
    start: DownloadTask;
    tasks: DownloadTask[];
    cancel: null;
    show: null;
    save: SaveResult;
  };
  engine: {
    start: DownloadTask;
    tasks: DownloadTask[];
    cancel: null;
    "download-changed": null;
    records: MediaResponseRecord[];
  };
}

/** Engine → every extension page (service worker for the badge, popup for display). */
export interface TasksChanged {
  to: "all";
  type: "tasks-changed";
  tasks: DownloadTask[];
}

type Request = SwRequest | EngineRequest;
type ResponseOf<R extends Request> = R extends { to: infer T extends keyof Responses; type: infer K }
  ? K extends keyof Responses[T]
    ? Responses[T][K]
    : never
  : never;

export async function send<R extends Request>(message: R): Promise<ResponseOf<R>> {
  return (await chrome.runtime.sendMessage(message)) as ResponseOf<R>;
}

export function isTasksChanged(message: unknown): message is TasksChanged {
  return (message as TasksChanged | undefined)?.type === "tasks-changed";
}

/** Runtime messages only come from this extension's own pages, so routing on `to` is enough. */
export function addressedTo<T extends "sw" | "engine">(message: unknown, to: T): message is Extract<Request, { to: T }> {
  return (message as { to?: unknown } | undefined)?.to === to;
}
