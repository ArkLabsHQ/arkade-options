import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fixtureJson } from "../protocol/beacon-fixture.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "contracts/vm/testdata/settle.json");
writeFileSync(file, await fixtureJson());
console.log(file);
