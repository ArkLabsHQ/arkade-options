import assert from "node:assert/strict";

import { arkade } from "@arkade-os/sdk";

import { artifactLine, intentProgram, rawIntentProgram, rawVaultProgram, vaultProgram } from "./program.ts";

function onlySecondsDiffers(raw: ReturnType<typeof rawVaultProgram>, spent: ReturnType<typeof vaultProgram>) {
  const csv = raw.functions.unilateral?.tapscript?.csv;
  if (csv?.type !== "blocks" || csv.value !== "$exit") {
    throw new Error("compiler artifact unilateral CSV is not a block older(exit)");
  }
  const spentCsv = spent.functions.unilateral?.tapscript?.csv;
  if (spentCsv?.type !== "seconds" || spentCsv.value !== "$exit") {
    throw new Error("spent program did not switch that CSV to seconds");
  }
  const back = {
    ...spent,
    functions: {
      ...spent.functions,
      unilateral: {
        ...spent.functions.unilateral,
        tapscript: {
          ...spent.functions.unilateral.tapscript,
          csv: { type: "blocks" as const, value: "$exit" },
        },
      },
    },
  };
  assert.deepEqual(back, raw);
}

onlySecondsDiffers(rawVaultProgram(), vaultProgram());
onlySecondsDiffers(rawIntentProgram(), intentProgram());

const key = (fill: number) => new Uint8Array(32).fill(fill);
const emulatorKey = new Uint8Array(33);
emulatorKey[0] = 0x02;
emulatorKey.set(key(9), 1);

const vault = vaultProgram();
const compiledVault = new arkade.ArkadeProgramScript(
  vault,
  {
    kind: 0n,
    writerPk: key(1),
    holderPk: key(2),
    writerScript: key(3),
    holderScript: key(4),
    strike: 10_000_000n,
    collateral: 10_000_000n,
    expiry: 1_800_000_000n,
    "oracles.0": key(11),
    "oracles.1": key(12),
    "oracles.2": key(13),
    "oracles.3": key(14),
    "oracles.4": key(15),
    exit: 512n,
    server: key(7),
  },
  { serverKey: key(7), emulatorKey },
);

const vaultNames = compiledVault.compiled.map((fn) => fn.name);
if (vaultNames.join() !== "settle,close,unilateral") {
  throw new Error(`unexpected vault functions ${vaultNames.join()}`);
}
const settleAsm = vault.functions.settle?.arkadeScript?.asm ?? [];
const count = (name: string) => settleAsm.filter((token) => token === name).length;
for (const [name, n] of [
  ["CHECKSIGFROMSTACK", 9],
  ["SHA256", 9],
  ["MUL", 5],
  ["DIV", 3],
] as const) {
  if (count(name) !== n) throw new Error(`settle has ${count(name)} ${name}, expected ${n}`);
}

const intent = intentProgram();
const compiledIntent = new arkade.ArkadeProgramScript(
  intent,
  {
    userPk: key(1),
    userScript: key(3),
    solverScript: key(4),
    optionScript: key(5),
    side: 0n,
    collateral: 10_000_000n,
    premium: 50_000n,
    deadline: 1_700_000_000n,
    exit: 512n,
    server: key(7),
  },
  { serverKey: key(7), emulatorKey },
);
const intentNames = compiledIntent.compiled.map((fn) => fn.name);
if (intentNames.join() !== "finalize,cancel,unilateral") {
  throw new Error(`unexpected intent functions ${intentNames.join()}`);
}
const cancelAsm = intent.functions.cancel?.arkadeScript?.asm ?? [];
const finalizeAsm = intent.functions.finalize?.arkadeScript?.asm ?? [];
if (!cancelAsm.includes("CHECKTIME")) throw new Error("cancel is missing CHECKTIME");
if (!finalizeAsm.includes("CHECKTIME")) throw new Error("finalize is missing CHECKTIME");

const line = artifactLine();
if (!line.includes("9 oracle signatures") || !line.includes("30-second clock")) {
  throw new Error(line);
}

console.log("option programs load through programFromArtifact");
