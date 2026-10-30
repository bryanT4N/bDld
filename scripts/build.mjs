import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { iconPng } from "./lib/icon.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");
const dist = path.join(root, "dist");

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, "icons"), { recursive: true });

const common = {
  bundle: true,
  target: "chrome116",
  charset: "utf8",
  legalComments: "none",
  logLevel: "warning",
};

await build({
  ...common,
  format: "iife",
  entryPoints: {
    sw: path.join(src, "background/sw.ts"),
    offscreen: path.join(src, "engine/offscreen.ts"),
    popup: path.join(src, "popup/popup.ts"),
  },
  outdir: dist,
});

// executeScript({ files }) returns the completion value of the script, so the probe
// is wrapped in an expression whose value is the probe's promise.
const probe = await build({
  ...common,
  format: "esm",
  entryPoints: [path.join(src, "probe/page.ts")],
  write: false,
});
const probeCode = probe.outputFiles[0].text;
const exportLine = /export\s*\{\s*probePage\s*\};\s*$/;
if (!exportLine.test(probeCode)) throw new Error("probe bundle must end with `export { probePage };`");
fs.writeFileSync(
  path.join(dist, "probe.js"),
  `(() => {\n"use strict";\n${probeCode.replace(exportLine, "")}return probePage();\n})();\n`,
);

const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(src, "manifest.json"), "utf8"));
fs.writeFileSync(path.join(dist, "manifest.json"), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);

for (const file of ["popup/popup.html", "popup/popup.css", "engine/offscreen.html"]) {
  fs.copyFileSync(path.join(src, file), path.join(dist, path.basename(file)));
}
for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(dist, "icons", `${size}.png`), iconPng(size));
}

console.log(`built ${path.relative(root, dist)}`);
