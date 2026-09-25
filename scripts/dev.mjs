import { cpSync, createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const page = path.join(dist, "app");
mkdirSync(page, { recursive: true });

const publish = () => {
  for (const stale of ["app.js", "app.js.map", "desk.css"]) {
    rmSync(path.join(dist, stale), { force: true });
  }
  cpSync(path.join(root, "app/index.html"), path.join(page, "index.html"));
  cpSync(path.join(root, "app/desk.css"), path.join(page, "desk.css"));
  writeFileSync(path.join(dist, ".nojekyll"), "");
  writeFileSync(
    path.join(dist, "index.html"),
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0; url=app/">
  <title>Arkade Options</title>
  <script>location.replace("app/")</script>
</head>
<body><p><a href="app/">Arkade Options</a></p></body>
</html>
`,
  );
};

const ctx = await esbuild.context({
  entryPoints: [path.join(root, "app/desk.js")],
  bundle: true,
  format: "esm",
  outfile: path.join(page, "app.js"),
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
    if (url.pathname === "/app") {
      res.writeHead(302, { location: "/app/" });
      res.end();
      return;
    }
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
