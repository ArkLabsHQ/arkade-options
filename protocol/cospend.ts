import {
  arkade,
  asset,
  buildOffchainTx,
  ConditionWitness,
  EmulatorPacket,
  Extension,
  P2A,
  PrevArkTxField,
  setArkPsbtField,
  Transaction,
  UnknownPacket,
  type ArkTxInput,
  type CSVMultisigTapscript,
  type EmulatorProvider,
  type ExtensionPacket,
  type Identity,
} from "@arkade-os/sdk";
import { base64 } from "@scure/base";

import { STATE_TYPE } from "./beacon.ts";
import { bytesToHex } from "./hex.ts";

/**
 * Arkade transactions with more than one covenant input.
 *
 * The SDK's ArkadeTransactionBuilder spends one covenant coin plus coins the
 * identity signs. A beacon read spends two covenants: the consumer at input 0
 * and the beacon at input 1, each with its own emulator entry. This module
 * assembles that shape from the SDK's primitives: one checkpoint per input
 * through buildOffchainTx, the previous Arkade transaction on every input,
 * and one extension output carrying the asset packet, the beacon state, and
 * the emulator packet, ahead of the anchor.
 */

export type Coin = { txid: string; vout: number; value: number | bigint; prevTx: Uint8Array };

export type CovenantSpend = {
  script: arkade.ArkadeProgramScript;
  fn: string;
  /** Call arguments by their flattened names, e.g. `key`, `value`, `sigs.0`. */
  callArgs?: Record<string, bigint | Uint8Array>;
  coin: Coin;
};

/** A coin the identity signs: a DefaultVtxo or any script with a forfeit leaf. */
export type SignedSpend = {
  coin: Coin;
  tapLeafScript: ArkTxInput["tapLeafScript"];
  tapTree: Uint8Array;
};

export type Spend = CovenantSpend | SignedSpend;

export type Built = {
  arkTx: Transaction;
  checkpoints: Transaction[];
  /** Inputs the identity has to sign. */
  signIndexes: number[];
};

function isCovenant(spend: Spend): spend is CovenantSpend {
  return "script" in spend;
}

function compactSize(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  return Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
}

/** The witness stack as the emulator packet carries it: item count, then each item length-prefixed. */
export function encodeWitness(items: Uint8Array[]): Uint8Array {
  const parts = [compactSize(items.length)];
  for (const item of items) parts.push(compactSize(item.length), item);
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function anchorIndex(tx: Transaction): number {
  for (let i = tx.outputsLength - 1; i >= 0; i--) {
    const script = tx.getOutput(i)?.script;
    if (script && bytesToHex(script) === bytesToHex(P2A.script)) return i;
  }
  throw new Error("anchor output missing");
}

/** Insert the extension ahead of the anchor, as the SDK's builder does. */
export function attachExtension(tx: Transaction, packets: ExtensionPacket[]) {
  const out = Extension.create(packets).txOut();
  const anchor = anchorIndex(tx);
  const last = tx.getOutput(anchor);
  tx.updateOutput(anchor, { script: out.script, amount: out.amount });
  tx.addOutput({ script: last!.script!, amount: last!.amount ?? 0n });
}

export function build(spends: Spend[], outputs: { script: Uint8Array; amount: bigint }[], packets: ExtensionPacket[], checkpoint: CSVMultisigTapscript.Type): Built {
  const inputs: ArkTxInput[] = [];
  const entries: { vin: number; script: Uint8Array; witness: Uint8Array }[] = [];
  const conditions = new Map<number, Uint8Array[]>();
  const signIndexes: number[] = [];
  spends.forEach((spend, vin) => {
    if (!isCovenant(spend)) {
      inputs.push({ txid: spend.coin.txid, vout: spend.coin.vout, value: Number(spend.coin.value), tapLeafScript: spend.tapLeafScript, tapTree: spend.tapTree });
      signIndexes.push(vin);
      return;
    }
    const fn = spend.script.functionByName(spend.fn);
    if (!fn) throw new Error(`${spend.script.program.name}.${spend.fn} not found`);
    if (!fn.arkadeScript) throw new Error(`${spend.fn} is not a covenant`);
    const callArgs = spend.callArgs ?? {};
    const stack = (fn.def.arkadeScript?.witness ?? []).map((ref) => arkade.witnessRefToBytes(ref, callArgs, spend.script.args));
    const condition = (fn.def.tapscript.witness ?? []).map((ref) => arkade.witnessRefToBytes(ref, callArgs, spend.script.args));
    inputs.push({ txid: spend.coin.txid, vout: spend.coin.vout, value: Number(spend.coin.value), tapLeafScript: fn.tapLeafScript, tapTree: spend.script.encode() });
    entries.push({ vin, script: fn.arkadeScript, witness: encodeWitness(stack) });
    if (condition.length > 0) conditions.set(vin, condition);
  });
  const { arkTx, checkpoints } = buildOffchainTx(inputs, outputs, checkpoint);
  spends.forEach((spend, vin) => {
    setArkPsbtField(arkTx, vin, PrevArkTxField, spend.coin.prevTx);
    const condition = conditions.get(vin);
    if (condition) {
      setArkPsbtField(arkTx, vin, ConditionWitness, condition);
      setArkPsbtField(checkpoints[vin]!, 0, ConditionWitness, condition);
    }
  });
  attachExtension(arkTx, [...packets, EmulatorPacket.create(entries)]);
  return { arkTx, checkpoints, signIndexes };
}

/** One identity unit moving from input `vin` to output `vout`. */
export function unitTransfer(id: asset.AssetId, vin: number, vout: number): asset.Packet {
  return asset.Packet.create([
    asset.AssetGroup.create(id, null, [asset.AssetInput.create(vin, 1n)], [asset.AssetOutput.create(vout, 1n)], []),
  ]);
}

export function statePacket(state: Uint8Array): ExtensionPacket {
  return new UnknownPacket(STATE_TYPE, state);
}

export type BeaconCoin = {
  script: arkade.ArkadeProgramScript;
  coin: Coin;
  /** The state packet of the transaction that created the coin. */
  state: Uint8Array;
  id: asset.AssetId;
};

/**
 * Settle a beacon vault: the vault at input 0, the beacon at input 1 through
 * `read`, an optional fee coin the identity signs at input 2. Output 0 continues
 * the beacon with the read fee added; payouts follow.
 */
export function buildSettle(input: {
  vault: { script: arkade.ArkadeProgramScript; coin: Coin };
  beacon: BeaconCoin;
  readFee: bigint;
  payouts: { script: Uint8Array; amount: bigint }[];
  fee?: SignedSpend;
  checkpoint: CSVMultisigTapscript.Type;
}): Built {
  const spends: Spend[] = [
    { script: input.vault.script, fn: "settle", coin: input.vault.coin },
    { script: input.beacon.script, fn: "read", callArgs: { selfIndex: 1n }, coin: input.beacon.coin },
  ];
  if (input.readFee > 0n) {
    if (!input.fee) throw new Error("a fee coin is required when readFee > 0");
    if (BigInt(input.fee.coin.value) !== input.readFee) throw new Error("fee coin must equal readFee");
    spends.push(input.fee);
  }
  const outputs = [
    { script: input.beacon.script.pkScript, amount: BigInt(input.beacon.coin.value) + input.readFee },
    ...input.payouts,
  ];
  return build(spends, outputs, [unitTransfer(input.beacon.id, 1, 0), statePacket(input.beacon.state)], input.checkpoint);
}

/** Publish a fixing: the beacon at input 0, continued at output 0 with the next state. */
export function buildAttest(input: {
  beacon: BeaconCoin;
  key: bigint;
  value: Uint8Array;
  /** Five signatures in signer order; an absent signer is an empty array. */
  sigs: readonly Uint8Array[];
  next: Uint8Array;
  checkpoint: CSVMultisigTapscript.Type;
}): Built {
  if (input.sigs.length !== 5) throw new Error("five signature slots");
  const callArgs: Record<string, bigint | Uint8Array> = { key: input.key, value: input.value };
  input.sigs.forEach((sig, i) => {
    callArgs[`sigs.${i}`] = sig;
  });
  return build(
    [{ script: input.beacon.script, fn: "attest", callArgs, coin: input.beacon.coin }],
    [{ script: input.beacon.script.pkScript, amount: BigInt(input.beacon.coin.value) }],
    [unitTransfer(input.beacon.id, 0, 0), statePacket(input.next)],
    input.checkpoint,
  );
}

/** Move the unit to a new program: the beacon at input 0, `next` at output 0, state unchanged. */
export function buildMigrate(input: {
  beacon: BeaconCoin;
  next: Uint8Array;
  nextPkScript: Uint8Array;
  sigs: readonly Uint8Array[];
  checkpoint: CSVMultisigTapscript.Type;
}): Built {
  if (input.sigs.length !== 5) throw new Error("five signature slots");
  const callArgs: Record<string, bigint | Uint8Array> = { next: input.next };
  input.sigs.forEach((sig, i) => {
    callArgs[`sigs.${i}`] = sig;
  });
  return build(
    [{ script: input.beacon.script, fn: "migrate", callArgs, coin: input.beacon.coin }],
    [{ script: input.nextPkScript, amount: BigInt(input.beacon.coin.value) }],
    [unitTransfer(input.beacon.id, 0, 0), statePacket(input.beacon.state)],
    input.checkpoint,
  );
}

/** Sign the identity's inputs and submit to the emulator. */
export async function submit(built: Built, emulator: EmulatorProvider, identity?: Identity): Promise<{ txid: string; signedArkTx: string }> {
  let arkTx = built.arkTx;
  let checkpoints = built.checkpoints;
  if (built.signIndexes.length > 0) {
    if (!identity) throw new Error("an identity is required to sign the fee coin");
    arkTx = await identity.sign(arkTx, built.signIndexes);
    checkpoints = await Promise.all(checkpoints.map((cp, i) => (built.signIndexes.includes(i) ? identity.sign(cp, [0]) : Promise.resolve(cp))));
  }
  const res = await emulator.submitTx(base64.encode(arkTx.toPSBT()), checkpoints.map((cp) => base64.encode(cp.toPSBT())));
  return { txid: Transaction.fromPSBT(base64.decode(res.signedArkTx)).id, signedArkTx: res.signedArkTx };
}
