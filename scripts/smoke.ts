import assert from "node:assert/strict";
import { launchExtension } from "./lib/browser";

const h = await launchExtension();
try {
  const manifest = await h.sw.evaluate(() => chrome.runtime.getManifest());
  assert.equal(manifest.name, "bDld");
  console.log(`service worker registered: ${h.sw.url()}`);
  console.log(`permissions: ${manifest.permissions?.join(", ")}`);
} finally {
  await h.close();
}
