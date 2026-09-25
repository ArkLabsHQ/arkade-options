import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "dist", "check.mjs");

await esbuild.build({
  entryPoints: [path.join(root, "app/src/check.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
  packages: "external",
  logLevel: "silent",
});

const result = spawnSync(process.execPath, [outfile], { stdio: "inherit" });
process.exit(result.status ?? 1);
