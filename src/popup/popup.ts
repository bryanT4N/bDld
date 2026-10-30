import { formatBytes, formatClock, formatProgress } from "../shared/format";
import { isTasksChanged, send } from "../shared/messages";
import { qualityLabel } from "../shared/quality";
import { CODEC_NAMES, approxBytes, atQuality, bestAudio, codecsAt, defaultSelection, qualities, streamFor } from "../shared/select";
import {
  isTerminal,
  type DownloadTask,
  type FailureReason,
  type Playing,
  type PlayOffer,
  type ProbeResult,
  type Selection,
  type VideoCodec,
  type VideoInfo,
  type VideoStream,
} from "../shared/types";

/** playurl addresses expire after about two hours; re-probe well before that. */
const OFFER_MAX_AGE_MS = 90 * 60 * 1000;

const FAILURE_TEXT: Record<FailureReason, string> = {
  network: "网络连接失败，请检查网络后重试",
  "url-expired": "下载地址已过期，请刷新视频页面后重新下载",
  "not-media": "服务器没有返回视频数据，请稍后再试",
  "storage-full": "磁盘空间不足，请清理后重试",
  remux: "视频数据无法处理",
  internal: "下载出错",
};

type Child = Node | string | false | undefined;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string | boolean | ((e: Event) => void)>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = String(v);
    else if (typeof v === "boolean") el.toggleAttribute(k, v);
    else if (v !== undefined) el.setAttribute(k, v);
  }
  for (const c of children) if (c !== false && c !== undefined) el.append(c);
  return el;
}

const app = document.getElementById("app")!;
let tabId: number | undefined;
let probe: ProbeResult | undefined;
let tasks: DownloadTask[] = [];
let selection: Selection | undefined;
let selectionFor: string | undefined;
/** Set while the selection is a task's choice; cleared once the user picks. */
let selectionTask: string | undefined;
let expanded = false;
/** What the full view was built for; when it changes, the view is rebuilt rather than patched. */
let rendered: string | undefined;
let actionSlot: HTMLElement | undefined;

/** The video the popup shows, with whatever is known about it so far. */
interface Subject {
  video: VideoInfo;
  offer?: PlayOffer;
  playing?: Playing;
  /** This video's latest task: active, queued or finished. */
  task?: DownloadTask;
}

async function currentTabId(): Promise<number | undefined> {
  const fromQuery = new URLSearchParams(location.search).get("tab");
  if (fromQuery) return Number(fromQuery);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

const videoKey = (v: VideoInfo) => `${v.bvid}:${v.cid}`;

/** Downloads whose file was deleted or moved, or whose download entry is gone. */
const missingFiles = new Set<number>();
const checkedFiles = new Set<number>();
let tasksSeq = 0;

/** A done task whose file no longer exists counts as never downloaded. */
const counts = (t: DownloadTask) => t.state.phase !== "done" || !missingFiles.has(t.state.downloadId);

function taskFor(video: VideoInfo): DownloadTask | undefined {
  return tasks
    .filter((t) => videoKey(t.video) === videoKey(video) && counts(t))
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

async function fileMissing(downloadId: number): Promise<boolean> {
  const [item] = await chrome.downloads.search({ id: downloadId });
  return !item || !item.exists || item.state !== "complete";
}

async function checkFiles(list: DownloadTask[]): Promise<void> {
  await Promise.all(
    list.map(async (t) => {
      if (t.state.phase !== "done" || checkedFiles.has(t.state.downloadId)) return;
      checkedFiles.add(t.state.downloadId);
      if (await fileMissing(t.state.downloadId)) missingFiles.add(t.state.downloadId);
    }),
  );
}

/**
 * search() makes Chrome re-check whether the file exists, but Chrome checks at most every few
 * seconds and reports a deletion later through downloads.onChanged. While a saved file is shown,
 * searching again keeps that check going so a deletion turns the view back to 下载.
 */
setInterval(() => {
  const task = subject()?.task;
  if (task?.state.phase === "done") void fileMissing(task.state.downloadId);
}, 2000);

/** The tab's video once probed; until then, or off a video page, the running task's video. */
function subject(): Subject | undefined {
  if (probe?.kind === "ok") return { video: probe.video, offer: probe.offer, playing: probe.playing, task: taskFor(probe.video) };
  const active = tasks.filter((t) => !isTerminal(t.state)).sort((a, b) => b.createdAt - a.createdAt)[0];
  return active && { video: active.video, task: active };
}

const viewKey = (s: Subject) => `${videoKey(s.video)}|${s.task?.id}|${s.task ? isTerminal(s.task.state) : ""}|${Boolean(s.offer)}`;

const chosenOf = (task: DownloadTask): Selection => ({ qn: task.chosen.video.qn, codec: task.chosen.video.codec });

/** A task's choice wins over any default, so reopening the popup never changes what is shown. */
function selectionOf(s: Subject): Selection | undefined {
  const key = videoKey(s.video);
  if (selectionFor !== key) {
    selectionFor = key;
    selection = undefined;
  }
  if (s.offer && selection && !streamFor(s.offer, selection)) selection = undefined;
  if (selectionTask !== undefined && s.task?.id !== selectionTask) selection = undefined;
  if (!selection) {
    selectionTask = s.task?.id;
    selection = s.task ? chosenOf(s.task) : s.offer && s.playing ? defaultSelection(s.offer, s.playing) : undefined;
  }
  return selection;
}

function message(...lines: Child[]): void {
  app.replaceChildren(...lines.filter((l): l is Node | string => Boolean(l)));
}

function render(): void {
  expanded = app.querySelector<HTMLDetailsElement>("details.choice")?.open ?? expanded;
  actionSlot = undefined;
  const s = subject();
  rendered = s && viewKey(s);
  if (!s) {
    if (!probe) return message(h("p", { class: "muted center" }, "正在读取视频信息…"));
    if (probe.kind === "error") return message(h("p", { class: "error" }, probe.message), h("button", { class: "secondary", onClick: () => void load() }, "重试"));
    return message(
      h("p", { class: "center" }, "请在 B 站视频页面使用"),
      h("p", { class: "muted center" }, "打开 www.bilibili.com/video/ 开头的页面，再点击扩展图标。"),
    );
  }

  const { video, offer, task } = s;
  if (probe?.kind === "ok") {
    app.dataset.source = probe.offer.source;
    app.dataset.playing = probe.playing.via;
  }
  const sel = selectionOf(s);
  const locked = !offer || (task !== undefined && !isTerminal(task.state));
  const audio = offer ? bestAudio(offer.audios) : task!.chosen.audio;
  const streams = offer
    ? qualities(offer).map((qn) => streamFor(offer, atQuality(offer, qn, sel?.codec))!)
    : [task!.chosen.video];
  const size = (v: VideoStream) => `约 ${formatBytes(approxBytes(v, audio, video.durationSec))}`;
  const current = streams.find((v) => v.qn === sel?.qn);
  const summary = current ? `${qualityLabel(current.qn, current.height)} · ${CODEC_NAMES[current.codec]} · ${size(current)}` : "";
  let choice: HTMLElement;
  if (locked || !offer || !sel) {
    choice = h("p", { class: "choice" }, summary);
  } else {
    const select = h(
      "select",
      {
        "aria-label": "清晰度",
        onChange: (e) => {
          selection = atQuality(offer, Number((e.target as HTMLSelectElement).value), sel.codec);
          selectionTask = undefined;
          render();
        },
      },
      ...streams.map((v) => h("option", { value: String(v.qn), selected: v.qn === sel.qn }, `${qualityLabel(v.qn, v.height)} · ${size(v)}`)),
    );
    const codecButton = (codec: VideoCodec) =>
      h(
        "button",
        {
          type: "button",
          "aria-pressed": String(sel.codec === codec),
          onClick: () => {
            selection = { qn: sel.qn, codec };
            selectionTask = undefined;
            render();
          },
        },
        CODEC_NAMES[codec],
      );
    choice = h(
      "details",
      { class: "choice", open: expanded },
      h("summary", {}, summary),
      h("div", { class: "choice-body" }, select, h("div", { class: "segmented", role: "group", "aria-label": "编码" }, ...codecsAt(offer, sel.qn).map(codecButton))),
    );
  }

  actionSlot = h("section", { class: "action" });
  const cover = h("img", { class: "cover", alt: "", referrerpolicy: "no-referrer" });
  if (video.coverUrl) cover.src = video.coverUrl;

  app.replaceChildren(
    h(
      "section",
      { class: "video" },
      cover,
      h(
        "div",
        {},
        h("p", { class: "title", title: video.title }, video.title),
        video.partTitle !== undefined && h("p", { class: "part" }, `P${video.p} ${video.partTitle}`),
        h("p", { class: "owner" }, `UP：${video.owner}`),
      ),
    ),
    choice,
    ...(video.loggedIn ? [] : [h("p", { class: "login" }, "登录后可下载更高清晰度")]),
    actionSlot,
  );
  renderAction();
}

const sameChoice = (task: DownloadTask, sel: Selection | undefined) =>
  sel !== undefined && task.chosen.video.qn === sel.qn && task.chosen.video.codec === sel.codec;

/**
 * One action area: 下载 before a download, progress with 取消 while one runs, 在文件夹中显示 once
 * this choice is saved. A different choice after a finished task offers 下载 again.
 */
function renderAction(): void {
  const subj = subject();
  if (!actionSlot || !subj) return;
  const task = subj.task;
  const bar = (fraction?: number) =>
    h("div", { class: fraction === undefined ? "bar indeterminate" : "bar" }, h("div", fraction === undefined ? {} : { style: `width:${(fraction * 100).toFixed(1)}%` }));
  const row = (text: string, control?: Child, cls = "") => h("div", { class: "status" }, h("p", { class: cls }, text), control);
  const textButton = (label: string, onClick: () => void) => h("button", { class: "link", onClick }, label);
  const cancel = () => task && textButton("取消", () => void send({ to: "sw", type: "cancel", taskId: task.id }));

  const s = task?.state;
  let parts: Child[];
  switch (s?.phase) {
    case "queued":
      parts = [row("排队中", cancel())];
      break;
    case "preparing":
      parts = [bar(), row("准备中", cancel())];
      break;
    case "downloading": {
      const fraction = s.totalBytes ? s.doneBytes / s.totalBytes : 0;
      const items = [`${Math.floor(fraction * 100)}%`, formatProgress(s.doneBytes, s.totalBytes)];
      if (s.bytesPerSec > 0) {
        items.push(`${formatBytes(s.bytesPerSec)}/s`, `剩余 ${formatClock((s.totalBytes - s.doneBytes) / s.bytesPerSec)}`);
      }
      parts = [bar(fraction), row(items.join(" · "), cancel())];
      break;
    }
    case "finalizing":
      parts = [bar(), row("正在生成文件")];
      break;
    case "saving":
      parts = [bar(), row("正在保存")];
      break;
    default:
      if (s?.phase === "done" && sameChoice(task!, selection)) {
        parts = [
          h(
            "div",
            { class: "status" },
            h("p", {}, h("span", { class: "done" }, "已保存"), " ", h("button", { class: "link", onClick: () => void download() }, "重新下载")),
            h("button", { class: "secondary", onClick: () => void send({ to: "sw", type: "show", downloadId: s.downloadId }) }, "在文件夹中显示"),
          ),
        ];
        break;
      }
      parts = [
        s?.phase === "failed" && h("p", { class: "error", title: s.message }, FAILURE_TEXT[s.reason]),
        h("button", { class: "primary", disabled: !subj.offer, onClick: () => void download() }, "下载"),
      ];
  }
  actionSlot.replaceChildren(...parts.filter((p): p is Node | string => Boolean(p)));
}

async function download(): Promise<void> {
  if (probe?.kind !== "ok" || tabId === undefined) return;
  if (Date.now() - probe.offer.fetchedAt > OFFER_MAX_AGE_MS) {
    probe = await send({ to: "sw", type: "probe", tabId });
    render();
    if (probe.kind !== "ok") return;
  }
  const video = selection && streamFor(probe.offer, selection);
  if (!video) return;
  actionSlot?.querySelector("button")?.setAttribute("disabled", "");
  const task = await send({ to: "sw", type: "start", video: probe.video, chosen: { video, audio: bestAudio(probe.offer.audios) } });
  if (!tasks.some((t) => t.id === task.id)) await onTasks([...tasks, task]);
}

async function load(): Promise<void> {
  probe = undefined;
  render();
  tabId = await currentTabId();
  probe = tabId === undefined ? { kind: "not-video-page" } : await send({ to: "sw", type: "probe", tabId });
  render();
}

/** Progress only refreshes the task area; a different video or task rebuilds the whole view. */
async function onTasks(next: DownloadTask[]): Promise<void> {
  const seq = ++tasksSeq;
  await checkFiles(next);
  if (seq !== tasksSeq) return;
  tasks = next;
  const s = subject();
  if (s && rendered === viewKey(s)) renderAction();
  else render();
}

chrome.runtime.onMessage.addListener((msg: unknown) => {
  if (isTasksChanged(msg)) void onTasks(msg.tasks);
  return false;
});

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.exists?.current !== false) return;
  missingFiles.add(delta.id);
  void onTasks(tasks);
});

chrome.downloads.onErased.addListener((id) => {
  missingFiles.add(id);
  void onTasks(tasks);
});

/** Tasks load before the probe so a video's task always decides its selection before any default. */
async function main(): Promise<void> {
  await onTasks(await send({ to: "sw", type: "tasks" }));
  await load();
}

void main();
