import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const legacy = path.join(dist, "app");

await esbuild.build({
  entryPoints: [path.join(root, "app/desk.js")],
  bundle: true,
  format: "esm",
  outfile: path.join(dist, "app.js"),
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
});

mkdirSync(legacy, { recursive: true });
cpSync(path.join(root, "app/index.html"), path.join(dist, "index.html"));
cpSync(path.join(root, "app/desk.css"), path.join(dist, "desk.css"));
writeFileSync(path.join(dist, ".nojekyll"), "");
writeFileSync(
  path.join(legacy, "index.html"),
  `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0; url=../">
  <link rel="canonical" href="../">
  <title>Arkade Options</title>
  <script>location.replace("../")</script>
</head>
<body><p><a href="../">Arkade Options</a></p></body>
</html>
`,
);
