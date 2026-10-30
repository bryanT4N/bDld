import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";

export interface ServerOptions {
  tls?: { key: string; cert: string };
  /** Bytes per second per connection for /paced/. */
  pacedBytesPerSec?: number;
  /** Delay before each /paced/ response starts, like a CDN's time to first byte. */
  pacedFirstByteDelayMs?: number;
  /** Handles a request before the media routes; returns true when it responded. */
  handle?(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean;
}

export interface RecordedRequest {
  host: string;
  path: string;
  range: string;
  headers: http.IncomingHttpHeaders;
}

/**
 * Local stand-in for the media CDN, serving files by name with Range support.
 * The first path segment selects behaviour:
 *   /media/  normal 206 responses
 *   /flaky/  drops the connection of its first request, then behaves like /media/
 *   /slow/   206 responses trickled out slowly
 *   /paced/  206 responses at options.pacedBytesPerSec per connection, honouring backpressure
 *   /html/   a 567 text/html block page, like EdgeOne's
 *   /forbidden/  403
 */
export async function startMediaServer(files: Record<string, string>, options: ServerOptions = {}) {
  const requests: RecordedRequest[] = [];
  let flakyDropped = false;
  let sentBytes = 0;
  const handler: http.RequestListener = (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const range = req.headers.range ?? "";
    requests.push({ host: req.headers.host ?? "", path: url.pathname, range, headers: req.headers });
    if (options.handle?.(req, res, url)) return;
    const [, mode, name] = url.pathname.split("/");
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
    const tickMs = mode === "paced" ? 50 : 100;
    const chunkSize = mode === "paced" ? Math.max(1024, Math.round(((options.pacedBytesPerSec ?? 1 << 20) * tickMs) / 1000)) : 64 * 1024;
    const respond = (path: string) => {
      res.writeHead(206, {
        "Content-Type": "video/mp4",
        "Content-Length": last - first + 1,
        "Content-Range": `bytes ${first}-${last}/${size}`,
      });
      const stream = fs.createReadStream(path, { start: first, end: last, highWaterMark: chunkSize });
      if (mode !== "slow" && mode !== "paced") {
        stream.on("data", (chunk) => (sentBytes += chunk.length));
        return void stream.pipe(res);
      }
      stream.on("data", (chunk) => {
        stream.pause();
        sentBytes += chunk.length;
        const resume = () => setTimeout(() => stream.resume(), tickMs);
        if (res.write(chunk)) resume();
        else res.once("drain", resume);
      });
      stream.on("end", () => res.end());
      res.on("close", () => stream.destroy());
    };
    const delay = mode === "paced" ? (options.pacedFirstByteDelayMs ?? 0) : 0;
    if (delay > 0) setTimeout(() => respond(file), delay);
    else respond(file);
  };
  const server = options.tls ? https.createServer(options.tls, handler) : http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    origin: `${options.tls ? "https" : "http"}://127.0.0.1:${port}`,
    requests,
    sentBytes: () => sentBytes,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
