import { addressedTo, send, type EngineRequest, type Responses } from "../shared/messages";
import { Engine } from "./engine";
import { createTempFile, removeAllTempFiles } from "./opfs";

const ready = removeAllTempFiles();

const engine = new Engine({
  createTempFile,
  save: (taskId, url, fileName) => send({ to: "sw", type: "save", taskId, url, fileName }),
  notify: (tasks) => {
    chrome.runtime.sendMessage({ to: "all", type: "tasks-changed", tasks }).catch(() => {});
  },
});

function handle(msg: EngineRequest): Responses["engine"][EngineRequest["type"]] {
  switch (msg.type) {
    case "start":
      return engine.start(msg.video, msg.chosen);
    case "tasks":
      return engine.list();
    case "cancel":
      engine.cancel(msg.taskId);
      return null;
    case "download-changed":
      engine.downloadChanged(msg.downloadId, msg.outcome);
      return null;
    case "records":
      return engine.responseRecords();
  }
}

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (!addressedTo(msg, "engine")) return false;
  ready.then(() => sendResponse(handle(msg)));
  return true;
});
