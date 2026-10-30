import { formatBytes, formatDuration } from "../shared/format";
import { isTasksChanged, send } from "../shared/messages";
import { CODEC_NAMES, qualityOptions, type QualityOption } from "../shared/select";
import { isTerminal, type CodecPreference, type DownloadTask, type FailureReason, type ProbeResult, type VideoInfo } from "../shared/types";

const PREF_KEY = "codecPreference";
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
let pref: CodecPreference = "compat";
let selectedQn: number | undefined;
let taskSlot: HTMLElement | undefined;
let downloadButton: HTMLButtonElement | undefined;

async function currentTabId(): Promise<number | undefined> {
  const fromQuery = new URLSearchParams(location.search).get("tab");
  if (fromQuery) return Number(fromQuery);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function taskFor(video: VideoInfo): DownloadTask | undefined {
  return tasks
    .filter((t) => t.video.bvid === video.bvid && t.video.cid === video.cid)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

function options(): QualityOption[] {
  return probe?.kind === "ok" ? qualityOptions(probe.offer, pref, probe.video.durationSec) : [];
}

function render(): void {
  taskSlot = undefined;
  downloadButton = undefined;
  if (!probe) {
    app.replaceChildren(h("p", { class: "muted center" }, "正在读取视频信息…"));
    return;
  }
  if (probe.kind === "not-video-page") {
    app.replaceChildren(
      h("p", { class: "center" }, "请在 B 站视频页面使用"),
      h("p", { class: "muted center" }, "打开 www.bilibili.com/video/ 开头的页面，再点击扩展图标。"),
    );
    return;
  }
  if (probe.kind === "error") {
    app.replaceChildren(
      h("p", { class: "error" }, probe.message),
      h("button", { class: "secondary", onClick: () => void load() }, "重试"),
    );
    return;
  }

  const { video } = probe;
  const opts = options();
  if (!opts.some((o) => o.qn === selectedQn)) selectedQn = opts[0]?.qn;
  const select = h(
    "select",
    { "aria-label": "清晰度", onChange: (e) => (selectedQn = Number((e.target as HTMLSelectElement).value)) },
    ...opts.map((o) =>
      h(
        "option",
        { value: String(o.qn), selected: o.qn === selectedQn },
        `${o.label} · ${CODEC_NAMES[o.video.codec]} · 约 ${formatBytes(o.approxBytes)}`,
      ),
    ),
  );
  const prefButton = (value: CodecPreference, label: string) =>
    h("button", { type: "button", "aria-pressed": String(pref === value), onClick: () => void setPref(value) }, label);

  taskSlot = h("section", { class: "task" });
  downloadButton = h("button", { class: "primary", onClick: () => void download() }, "下载");
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
    h("label", { class: "field" }, h("span", {}, "清晰度"), select),
    h("div", { class: "field" }, h("span", {}, "编码"), h("div", { class: "segmented", role: "group", "aria-label": "编码" }, prefButton("compat", "兼容优先"), prefButton("size", "体积优先"))),
    h("p", { class: "hint" }, pref === "compat" ? "优先 AVC，几乎所有播放器都能打开" : "优先 AV1，文件更小，需要较新的播放器"),
    ...(video.loggedIn ? [] : [h("p", { class: "login" }, "登录后可下载更高清晰度")]),
    taskSlot,
    downloadButton,
  );
  renderTask();
}

function renderTask(): void {
  if (!taskSlot || !downloadButton || probe?.kind !== "ok") return;
  const task = taskFor(probe.video);
  const busy = task !== undefined && !isTerminal(task.state);
  downloadButton.disabled = busy;
  downloadButton.textContent = task?.state.phase === "done" ? "再次下载" : "下载";
  const others = tasks.filter((t) => t !== task && !isTerminal(t.state)).length;
  const cancel = task && h("button", { class: "secondary", onClick: () => void send({ to: "sw", type: "cancel", taskId: task.id }) }, "取消");
  const bar = (fraction?: number) =>
    h("div", { class: fraction === undefined ? "bar indeterminate" : "bar" }, h("div", fraction === undefined ? {} : { style: `width:${(fraction * 100).toFixed(1)}%` }));
  const line = (text: string, cls = "", action?: Child) => h("div", { class: "status" }, h("p", { class: cls }, text), action);

  const parts: Child[] = [];
  const s = task?.state;
  switch (s?.phase) {
    case undefined:
      if (others) parts.push(h("p", { class: "detail" }, "其他视频正在下载，新任务会排在后面"));
      break;
    case "queued":
      parts.push(line("排队中，等待前面的任务完成", "", cancel));
      break;
    case "preparing":
      parts.push(line("正在准备…", "", cancel), bar());
      break;
    case "downloading": {
      const fraction = s.totalBytes ? s.doneBytes / s.totalBytes : 0;
      const remaining = s.bytesPerSec > 0 ? ` · 剩余 ${formatDuration((s.totalBytes - s.doneBytes) / s.bytesPerSec)}` : "";
      parts.push(
        line(`下载中 ${Math.floor(fraction * 100)}%`, "", cancel),
        bar(fraction),
        h("p", { class: "detail" }, `${formatBytes(s.doneBytes)} / ${formatBytes(s.totalBytes)} · ${formatBytes(s.bytesPerSec)}/s${remaining}`),
      );
      break;
    }
    case "finalizing":
      parts.push(line("正在生成 MP4…"), bar());
      break;
    case "saving":
      parts.push(line("正在保存到下载文件夹…"), bar());
      break;
    case "done":
      parts.push(
        line("已保存", "done", h("button", { class: "secondary", onClick: () => chrome.runtime.sendMessage({ to: "sw", type: "show", downloadId: s.downloadId }) }, "在文件夹中显示")),
        h("p", { class: "detail" }, s.fileName),
      );
      break;
    case "failed":
      parts.push(line(FAILURE_TEXT[s.reason], "error"), h("p", { class: "detail" }, s.message));
      break;
    case "canceled":
      parts.push(line("已取消", "muted"));
      break;
  }
  taskSlot.replaceChildren(...parts.filter((p): p is Node | string => Boolean(p)));
  taskSlot.hidden = parts.length === 0;
}

async function setPref(value: CodecPreference): Promise<void> {
  pref = value;
  await chrome.storage.sync.set({ [PREF_KEY]: value });
  render();
}

async function download(): Promise<void> {
  if (probe?.kind !== "ok" || tabId === undefined) return;
  if (Date.now() - probe.offer.fetchedAt > OFFER_MAX_AGE_MS) {
    probe = await send({ to: "sw", type: "probe", tabId });
    render();
    if (probe.kind !== "ok") return;
  }
  const choice = options().find((o) => o.qn === selectedQn);
  if (!choice) return;
  downloadButton?.setAttribute("disabled", "");
  const task = await send({ to: "sw", type: "start", video: probe.video, chosen: { video: choice.video, audio: choice.audio } });
  if (!tasks.some((t) => t.id === task.id)) tasks = [...tasks, task];
  renderTask();
}

async function load(): Promise<void> {
  probe = undefined;
  render();
  tabId = await currentTabId();
  probe = tabId === undefined ? { kind: "not-video-page" } : await send({ to: "sw", type: "probe", tabId });
  render();
}

chrome.runtime.onMessage.addListener((msg: unknown) => {
  if (!isTasksChanged(msg)) return false;
  tasks = msg.tasks;
  renderTask();
  return false;
});

async function main(): Promise<void> {
  const stored = await chrome.storage.sync.get(PREF_KEY);
  if (stored[PREF_KEY] === "size") pref = "size";
  tasks = await send({ to: "sw", type: "tasks" });
  await load();
}

void main();
