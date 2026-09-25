import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const page = path.join(dist, "app");

await esbuild.build({
  entryPoints: [path.join(root, "app/desk.js")],
  bundle: true,
  format: "esm",
  outfile: path.join(page, "app.js"),
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
});

mkdirSync(page, { recursive: true });
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
  <link rel="canonical" href="app/">
  <title>Arkade Options</title>
  <script>location.replace("app/")</script>
</head>
<body><p><a href="app/">Arkade Options</a></p></body>
</html>
`,
);
