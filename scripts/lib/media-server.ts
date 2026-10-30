import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Local stand-in for the media CDN, serving files by name with Range support.
 * Path prefixes select behaviour:
 *   /media/  normal 206 responses
 *   /flaky/  drops the connection of its first request, then behaves like /media/
 *   /slow/   206 responses trickled out slowly
 *   /html/   a 567 text/html block page, like EdgeOne's
 *   /forbidden/  403
 */
export async function startMediaServer(files: Record<string, string>) {
  const requests: { path: string; range: string }[] = [];
  let flakyDropped = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const [, mode, name] = url.pathname.split("/");
    const range = req.headers.range ?? "";
    requests.push({ path: url.pathname, range });
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length");
    const file = name ? files[name] : undefined;
    if (!file) return res.writeHead(404).end();
    if (mode === "html") return res.writeHead(567, { "Content-Type": "text/html" }).end("<html>blocked</html>");
    if (mode === "forbidden") return res.writeHead(403, { "Content-Type": "text/plain" }).end("forbidden");
    if (mode === "flaky" && !flakyDropped) {
      flakyDropped = true;
      return req.socket.destroy();
    }
    const size = fs.statSync(file).size;
    const m = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!m) return res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": size }).end(fs.readFileSync(file));
    const first = Number(m[1]);
    const last = Math.min(Number(m[2]), size - 1);
    res.writeHead(206, {
      "Content-Type": "video/mp4",
      "Content-Length": last - first + 1,
      "Content-Range": `bytes ${first}-${last}/${size}`,
    });
    const stream = fs.createReadStream(file, { start: first, end: last, highWaterMark: 64 * 1024 });
    if (mode !== "slow") return stream.pipe(res);
    stream.on("data", (chunk) => {
      stream.pause();
      res.write(chunk);
      setTimeout(() => stream.resume(), 100);
    });
    stream.on("end", () => res.end());
    res.on("close", () => stream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
