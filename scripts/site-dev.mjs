// Local preview of the landing page exactly as deployed: site/ served
// statically, /api/public/* proxied to the engine (like vercel.json).
//   node scripts/site-dev.mjs   -> http://127.0.0.1:4500
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { createLocalServer } from "../src/server.mjs";

const engine = createLocalServer({ port: 0 });
await new Promise((r) => engine.listen(0, "127.0.0.1", r));
engine.loadPublicCases();
const ENGINE = engine.address().port;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".txt": "text/plain; charset=utf-8",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".vtt": "text/vtt",
};
const site = new URL("../site/", import.meta.url);
http
  .createServer(async (req, res) => {
    if (req.url.startsWith("/api/public/")) {
      const up = http.request(
        {
          host: "127.0.0.1",
          port: ENGINE,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (r) => {
          res.writeHead(r.statusCode, r.headers);
          r.pipe(res);
        },
      );
      req.pipe(up);
      return;
    }
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path.endsWith("/")) path += "index.html";
    if (!extname(path)) path += ".html";
    if (path.includes("..")) return res.writeHead(400).end();
    try {
      const body = await readFile(new URL("." + path, site));
      res.writeHead(200, {
        "Content-Type": TYPES[extname(path)] ?? "application/octet-stream",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end("Not found");
    }
  })
  .listen(Number(process.env.SITE_PORT || 4500), "127.0.0.1", () =>
    console.log("site on http://127.0.0.1:" + (process.env.SITE_PORT || 4500)),
  );
