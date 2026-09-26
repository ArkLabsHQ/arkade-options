import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

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

mkdirSync(path.join(dist, "viz"), { recursive: true });
cpSync(path.join(root, "app/index.html"), path.join(dist, "index.html"));
cpSync(path.join(root, "app/desk.css"), path.join(dist, "desk.css"));
cpSync(path.join(root, "viz/index.html"), path.join(dist, "viz/index.html"));
writeFileSync(path.join(dist, ".nojekyll"), "");
writeFileSync(path.join(dist, "CNAME"), "arkade.trade\n");
