import { addressedTo, isTasksChanged, send, type DownloadOutcome, type Responses, type SwRequest } from "../shared/messages";
import type { DownloadTask } from "../shared/types";

const HEADER_RULE_ID = 1;
const OFFSCREEN_URL = "offscreen.html";

/** Make this extension's own CDN requests carry the player's Referer, Origin and Sec-Fetch-Site. */
async function ensureHeaderRule(): Promise<void> {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [HEADER_RULE_ID],
    addRules: [
      {
        id: HEADER_RULE_ID,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          requestHeaders: [
            { header: "referer", operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: "https://www.bilibili.com/" },
            { header: "origin", operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: "https://www.bilibili.com" },
            { header: "sec-fetch-site", operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: "cross-site" },
          ],
        },
        condition: {
          requestDomains: ["bilivideo.com", "bilivideo.cn", "akamaized.net"],
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
        },
      },
    ],
  });
}

async function engineExists(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

let creating: Promise<void> | undefined;

async function ensureEngine(): Promise<void> {
  if (await engineExists()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: "Download and merge the video into a file, then hand it to chrome.downloads as a blob URL.",
    })
    .finally(() => (creating = undefined));
  await creating;
}

function updateBadge(tasks: DownloadTask[]): void {
  const active = tasks.find((t) => ["preparing", "downloading", "finalizing", "saving"].includes(t.state.phase));
  let text = "";
  if (active?.state.phase === "downloading" && active.state.totalBytes > 0) {
    text = `${Math.floor((active.state.doneBytes / active.state.totalBytes) * 100)}%`;
  } else if (active) {
    text = "…";
  }
  void chrome.action.setBadgeBackgroundColor({ color: "#fb7299" });
  void chrome.action.setBadgeText({ text });
}

async function handle(msg: SwRequest): Promise<Responses["sw"][SwRequest["type"]]> {
  switch (msg.type) {
    case "probe":
      return { kind: "error", message: "尚未实现" };
    case "start":
      await ensureHeaderRule();
      await ensureEngine();
      return send({ to: "engine", type: "start", video: msg.video, chosen: msg.chosen });
    case "tasks":
      if (!(await engineExists())) return [];
      return send({ to: "engine", type: "tasks" });
    case "cancel":
      if (await engineExists()) await send({ to: "engine", type: "cancel", taskId: msg.taskId });
      return null;
    case "show":
      chrome.downloads.show(msg.downloadId);
      return null;
    case "save":
      try {
        const downloadId = await chrome.downloads.download({ url: msg.url, filename: msg.fileName, conflictAction: "uniquify" });
        return { ok: true, downloadId };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
  }
}

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (isTasksChanged(msg)) {
    updateBadge(msg.tasks);
    return false;
  }
  if (!addressedTo(msg, "sw")) return false;
  handle(msg).then(sendResponse, (e: unknown) => {
    console.error(e);
    sendResponse(null);
  });
  return true;
});

chrome.downloads.onChanged.addListener(async (delta) => {
  const state = delta.state?.current;
  if (state !== "complete" && state !== "interrupted") return;
  if (!(await engineExists())) return;
  const outcome: DownloadOutcome =
    state === "complete" ? { state } : { state, error: delta.error?.current ?? "UNKNOWN" };
  await send({ to: "engine", type: "download-changed", downloadId: delta.id, outcome });
});
