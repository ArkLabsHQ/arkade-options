import { cpSync, createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
mkdirSync(dist, { recursive: true });

const publish = () => {
  mkdirSync(path.join(dist, "viz"), { recursive: true });
  cpSync(path.join(root, "app/index.html"), path.join(dist, "index.html"));
  cpSync(path.join(root, "app/desk.css"), path.join(dist, "desk.css"));
  cpSync(path.join(root, "viz/index.html"), path.join(dist, "viz/index.html"));
  writeFileSync(path.join(dist, ".nojekyll"), "");
};

const ctx = await esbuild.context({
  entryPoints: [path.join(root, "app/desk.js")],
  bundle: true,
  format: "esm",
  outfile: path.join(dist, "app.js"),
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
  plugins: [
    {
      name: "copy-html",
      setup(build) {
        build.onEnd(() => publish());
      },
    },
  ],
});
await ctx.watch();
publish();

const port = Number(process.env.PORT || 4173);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
};
http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    rel = rel.replace(/^\//, "");
    const file = path.join(dist, rel);
    if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`options http://127.0.0.1:${port}`);
  });
