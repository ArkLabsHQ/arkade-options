import path from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

const dir = path.dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [path.join(dir, "page.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: path.join(dir, "page.js"),
  logLevel: "silent",
});
