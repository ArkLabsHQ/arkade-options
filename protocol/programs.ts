import { arkade } from "@arkade-os/sdk";

import swapArtifact from "../contracts/non_interactive_swap.artifact.json" with { type: "json" };
import intentArtifact from "../contracts/option_intent.artifact.json" with { type: "json" };
import vaultArtifact from "../contracts/option_vault.artifact.json" with { type: "json" };

// The median returns compile to OP_PUT (replace a stack item). The emulator
// assigns it 0xbb. This SDK build's table stops before that opcode.
const ops = arkade.ARKADE_OPS as Record<string, number>;
const op = arkade.ARKADE_OP as Record<string, number>;
if (!Object.hasOwn(ops, "PUT")) {
  ops.PUT = 0xbb;
  op.PUT = 0xbb;
}

/**
 * The programs the desk spends.
 *
 * `contracts/*.artifact.json` are the arkadec output. Callers load them with
 * `arkade.programFromArtifact`. Nothing compiles the `.ark` sources at runtime.
 *
 * `older(exit)` is emitted as a block CSV. Public arkd rejects that on an exit
 * leaf, so the spent program sets the BIP68 seconds bit on the same `$exit`
 * integer. Nothing else in the artifact is edited.
 */
function secondsExit(artifact: arkade.ContractArtifact): ReturnType<typeof arkade.programFromArtifact> {
  const program = arkade.programFromArtifact(artifact);
  const unilateral = program.functions.unilateral;
  const csv = unilateral?.tapscript?.csv;
  if (!unilateral?.tapscript || csv?.type !== "blocks" || csv.value !== "$exit") {
    throw new Error(`${program.name} unilateral leaf is not the block CSV arkadec emits for older(exit)`);
  }
  return {
    ...program,
    functions: {
      ...program.functions,
      unilateral: {
        ...unilateral,
        tapscript: {
          ...unilateral.tapscript,
          csv: { type: "seconds", value: csv.value },
        },
      },
    },
  };
}

export function vaultProgram() {
  return secondsExit(vaultArtifact as arkade.ContractArtifact);
}

export function intentProgram() {
  return secondsExit(intentArtifact as arkade.ContractArtifact);
}

/**
 * The compiler's NonInteractiveSwap, the pattern OptionIntent copies. Its
 * `swap` path compares output 0 against `new SingleSig(makerPk, exit)`, which
 * arkadec emits as the `vtxo_SingleSig_makerPk_exit` parameter: the 32-byte
 * witness program of that SingleSig, built by the caller.
 */
export function swapProgram() {
  return secondsExit(swapArtifact as arkade.ContractArtifact);
}

export function rawVaultProgram() {
  return arkade.programFromArtifact(vaultArtifact as arkade.ContractArtifact);
}

export function rawIntentProgram() {
  return arkade.programFromArtifact(intentArtifact as arkade.ContractArtifact);
}

export function rawSwapProgram() {
  return arkade.programFromArtifact(swapArtifact as arkade.ContractArtifact);
}

function count(asm: readonly unknown[] | undefined, name: string) {
  return (asm ?? []).filter((token) => token === name).length;
}

/** One line for the page, taken from the loaded programs rather than the raw JSON. */
export function artifactLine() {
  const vault = vaultProgram();
  const intent = intentProgram();
  const settle = vault.functions.settle?.arkadeScript?.asm;
  const finalize = intent.functions.finalize?.arkadeScript?.asm ?? [];
  const sigs = count(settle, "CHECKSIGFROMSTACK");
  const hashes = count(settle, "SHA256");
  const muls = count(settle, "MUL");
  const divs = count(settle, "DIV");
  const clock = finalize.includes("CHECKTIME") ? "gates the fill on the 30-second clock." : "is loaded.";
  return `OptionVault settle · ${sigs} oracle signatures · ${muls} multiplies · ${divs} divides · ${hashes} hashes. OptionIntent ${clock}`;
}
