import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zip } from "./lib/zip.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function list(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? list(path.join(dir, e.name)) : [path.join(dir, e.name)]))
    .sort();
}

const files = list(dist);
if (!files.includes(path.join(dist, "manifest.json"))) throw new Error("dist/manifest.json missing; run the build first");
const entries = files.map((file) => ({
  name: path.relative(dist, file).split(path.sep).join("/"),
  data: fs.readFileSync(file),
}));
const out = path.join(root, "release", `bDld-${version}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, zip(entries));
console.log(`wrote ${path.relative(root, out)} (${entries.length} files, ${fs.statSync(out).size} bytes)`);
