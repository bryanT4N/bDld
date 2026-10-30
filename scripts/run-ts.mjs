import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.resolve(process.argv[2]);
const outfile = path.join(root, ".cache", `${path.basename(entry, ".ts")}.mjs`);

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  sourcemap: "inline",
  logLevel: "warning",
});
process.argv.splice(1, 2, outfile);
await import(pathToFileURL(outfile).href);
