import { createHash } from "node:crypto";

import { arkade, asset, Extension, Transaction } from "@arkade-os/sdk";

import { EXIT } from "./constants.ts";
import { addressOf, directPayout, payoutVtxo } from "./contracts.ts";
import { bytesToHex, xOnly } from "./hex.ts";
import { beaconProgram, beaconVaultProgram } from "./programs.ts";

/**
 * AttestationBeacon state and bindings. Layout and digests follow
 * contracts/attestation_beacon.ark; contracts/beacon.md explains them.
 */

export const STATE_TYPE = 32;
export const STATE_SIZE = 329;
export const SLOT_COUNT = 8;
export const SLOT_SIZE = 40;
export const SLOTS_AT = 9;
export const SLOT_OFFSETS = Array.from({ length: SLOT_COUNT }, (_, i) => SLOTS_AT + SLOT_SIZE * i);
export const SIGNER_COUNT = 5;

export type Slot = { key: bigint; value: Uint8Array };
export type BeaconState = { version: number; round: bigint; slots: Slot[] };

/** `num2bin(value, size)`: little-endian sign-magnitude, so the top bit must stay clear. */
export function num2bin(value: bigint, size: number): Uint8Array {
  if (value < 0n) throw new Error("num2bin: negative");
  if (value >= 1n << BigInt(size * 8 - 1)) throw new Error(`num2bin: ${value} does not fit ${size} bytes`);
  const out = new Uint8Array(size);
  let rest = value;
  for (let i = 0; i < size; i++) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

export function bin2num(bytes: Uint8Array): bigint {
  if (bytes.length === 0) return 0n;
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    value = (value << 8n) | BigInt(i === bytes.length - 1 ? bytes[i]! & 0x7f : bytes[i]!);
  }
  return bytes[bytes.length - 1]! & 0x80 ? -value : value;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function sha256(...parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(createHash("sha256").update(concat(...parts)).digest());
}

export function encodeState(state: BeaconState): Uint8Array {
  if (state.slots.length !== SLOT_COUNT) throw new Error(`state needs ${SLOT_COUNT} slots`);
  const parts = [Uint8Array.of(state.version), num2bin(state.round, 8)];
  for (const slot of state.slots) {
    if (slot.value.length !== 32) throw new Error("slot value must be 32 bytes");
    parts.push(num2bin(slot.key, 8), slot.value);
  }
  return concat(...parts);
}

export function decodeState(bytes: Uint8Array): BeaconState {
  if (bytes.length !== STATE_SIZE) throw new Error(`state is ${bytes.length} bytes, want ${STATE_SIZE}`);
  return {
    version: bytes[0]!,
    round: bin2num(bytes.subarray(1, 9)),
    slots: SLOT_OFFSETS.map((at) => ({
      key: bin2num(bytes.subarray(at, at + 8)),
      value: bytes.slice(at + 8, at + SLOT_SIZE),
    })),
  };
}

export function genesisState(): Uint8Array {
  return encodeState({
    version: 1,
    round: 0n,
    slots: Array.from({ length: SLOT_COUNT }, () => ({ key: 0n, value: new Uint8Array(32) })),
  });
}

/** The packet `attest` requires after `prev`: round + 1, the new slot first, the oldest slot dropped. */
export function nextState(prev: Uint8Array, key: bigint, value: Uint8Array): Uint8Array {
  const state = decodeState(prev);
  if (key <= 0n) throw new Error("key must be positive");
  if (state.slots.some((slot) => slot.key === key)) throw new Error(`key ${key} is already in a slot`);
  return encodeState({
    version: 1,
    round: state.round + 1n,
    slots: [{ key, value }, ...state.slots.slice(0, SLOT_COUNT - 1)],
  });
}

/** The value of the newest slot whose key matches, as the vault reads it. */
export function findFixing(stateBytes: Uint8Array, key: bigint): Uint8Array | undefined {
  return decodeState(stateBytes).slots.find((slot) => slot.key === key)?.value;
}

/** Price in cents in the first 8 bytes, then 24 bytes of the evidence hash. */
export function priceValue(cents: bigint, evidence?: Uint8Array): Uint8Array {
  const value = new Uint8Array(32);
  value.set(num2bin(cents, 8), 0);
  if (evidence) value.set(sha256(evidence).subarray(0, 24), 8);
  return value;
}

export function priceOf(value: Uint8Array): bigint {
  return bin2num(value.subarray(0, 8));
}

export type BeaconId = { txid: Uint8Array; gidx: bigint };

/** The asset id as the script compares it: serialization order, the display txid reversed. */
export function scriptTxid(id: asset.AssetId): Uint8Array {
  return Uint8Array.from(id.txid).reverse();
}

export function beaconIdOf(id: asset.AssetId): BeaconId {
  return { txid: scriptTxid(id), gidx: BigInt(id.groupIndex) };
}

function idBytes(id: BeaconId): Uint8Array {
  return concat(id.txid, num2bin(id.gidx, 4));
}

export function attestDigest(domain: Uint8Array, id: BeaconId, key: bigint, value: Uint8Array): Uint8Array {
  return sha256(domain, idBytes(id), num2bin(key, 8), value);
}

export function migrateDigest(domain: Uint8Array, id: BeaconId, round: bigint, next: Uint8Array): Uint8Array {
  return sha256(domain, new TextEncoder().encode("migrate"), idBytes(id), num2bin(round, 8), next);
}

export type BeaconArgs = {
  id: BeaconId;
  signers: readonly Uint8Array[];
  threshold: bigint;
  domain: Uint8Array;
  keyLag: bigint;
  readFee: bigint;
  adminPk: Uint8Array;
  exit?: bigint;
  serverKey: Uint8Array;
  emulatorKey: Uint8Array;
};

export type Bound = {
  address: string;
  pkScript: Uint8Array;
  program: Uint8Array;
  args: Record<string, bigint | Uint8Array>;
  script: arkade.ArkadeProgramScript;
};

function checkCommittee(signers: readonly Uint8Array[], threshold: bigint) {
  if (signers.length !== SIGNER_COUNT) throw new Error(`${SIGNER_COUNT} signers`);
  if (threshold < 1n || threshold > BigInt(SIGNER_COUNT)) throw new Error("threshold must be 1..5");
  const seen = new Set(signers.map((key) => bytesToHex(xOnly(key))));
  if (seen.size !== SIGNER_COUNT) throw new Error("duplicate signer");
}

export function beaconArgs(input: BeaconArgs): Record<string, bigint | Uint8Array> {
  checkCommittee(input.signers, input.threshold);
  if (input.emulatorKey.length !== 33) throw new Error("emulator key must be 33 bytes");
  const args: Record<string, bigint | Uint8Array> = {
    ctrlTxid: input.id.txid,
    ctrlGidx: input.id.gidx,
    threshold: input.threshold,
    domain: input.domain,
    keyLag: input.keyLag,
    readFee: input.readFee,
    adminPk: xOnly(input.adminPk),
    exit: input.exit ?? EXIT,
    server: xOnly(input.serverKey),
  };
  input.signers.forEach((key, index) => {
    args[`signers.${index}`] = xOnly(key);
  });
  return args;
}

export function bindBeacon(input: BeaconArgs): Bound {
  const args = beaconArgs(input);
  const serverKey = xOnly(input.serverKey);
  const script = new arkade.ArkadeProgramScript(beaconProgram(), args, {
    serverKey,
    emulatorKey: input.emulatorKey,
  });
  return {
    address: addressOf(script, serverKey),
    pkScript: script.pkScript,
    program: script.tweakedPublicKey,
    args,
    script,
  };
}

export type BeaconVaultTerms = {
  kind: 0 | 1;
  strike: bigint;
  collateral: bigint;
  expiry: bigint;
  exit?: bigint;
  writerPk: Uint8Array;
  /** Taproot output key of the writer's Arkade address. Settlement pays this key. */
  payoutKey?: Uint8Array;
  holderPk: Uint8Array;
  beacon: BeaconId;
  serverKey: Uint8Array;
  emulatorKey: Uint8Array;
};

export type BoundVault = Bound & {
  writerPkScript: Uint8Array;
  holderPkScript: Uint8Array;
  writerProgram: Uint8Array;
  holderProgram: Uint8Array;
};

export function bindBeaconVault(terms: BeaconVaultTerms): BoundVault {
  if (terms.emulatorKey.length !== 33) throw new Error("emulator key must be 33 bytes");
  const serverKey = xOnly(terms.serverKey);
  const writerPk = xOnly(terms.writerPk);
  const holderPk = xOnly(terms.holderPk);
  const exit = terms.exit ?? EXIT;
  const writer = terms.payoutKey ? directPayout(terms.payoutKey) : payoutVtxo(writerPk, serverKey, exit);
  const holder = payoutVtxo(holderPk, serverKey, exit);
  const args: Record<string, bigint | Uint8Array> = {
    kind: BigInt(terms.kind),
    writerPk,
    holderPk,
    writerScript: writer.tweakedPublicKey,
    holderScript: holder.tweakedPublicKey,
    strike: terms.strike,
    collateral: terms.collateral,
    expiry: terms.expiry,
    beaconTxid: terms.beacon.txid,
    beaconGidx: terms.beacon.gidx,
    exit,
    server: serverKey,
  };
  const script = new arkade.ArkadeProgramScript(beaconVaultProgram(), args, {
    serverKey,
    emulatorKey: terms.emulatorKey,
  });
  return {
    address: addressOf(script, serverKey),
    pkScript: script.pkScript,
    program: script.tweakedPublicKey,
    args,
    script,
    writerPkScript: writer.pkScript,
    holderPkScript: holder.pkScript,
    writerProgram: writer.tweakedPublicKey,
    holderProgram: holder.tweakedPublicKey,
  };
}

export type Genesis = {
  /** The Arkade transaction that issued the identity asset. */
  tx: Transaction;
  gidx: number;
  beaconPkScript: Uint8Array;
  signers: readonly Uint8Array[];
  threshold: bigint;
};

/**
 * The checks a consumer runs once before committing to a beacon's asset id:
 * an uncontrolled issuance of exactly one unit, paid to the beacon script, in
 * a transaction whose state packet is the genesis. Returns the asset id.
 */
export function verifyGenesis(genesis: Genesis): asset.AssetId {
  checkCommittee(genesis.signers, genesis.threshold);
  const extension = Extension.fromTx(genesis.tx);
  const packet = extension.getAssetPacket();
  if (!packet) throw new Error("genesis has no asset packet");
  const group = packet.groups[genesis.gidx];
  if (!group) throw new Error(`genesis has no asset group ${genesis.gidx}`);
  if (!group.isIssuance()) throw new Error("group is not an issuance");
  if (group.controlAsset) throw new Error("identity asset has a control asset");
  if (group.inputs.length !== 0) throw new Error("issuance has inputs");
  if (group.outputs.length !== 1 || BigInt(group.outputs[0]!.amount) !== 1n) throw new Error("supply is not 1");
  const output = genesis.tx.getOutput(group.outputs[0]!.vout);
  if (!output?.script || bytesToHex(output.script) !== bytesToHex(genesis.beaconPkScript)) {
    throw new Error("unit is not on the beacon script");
  }
  const state = extension.getPacketByType(STATE_TYPE);
  if (!state || bytesToHex(state.serialize()) !== bytesToHex(genesisState())) {
    throw new Error("genesis state is not empty");
  }
  return asset.AssetId.create(genesis.tx.id, genesis.gidx);
}

export function statePacketOf(tx: Transaction): Uint8Array {
  const packet = Extension.fromTx(tx).getPacketByType(STATE_TYPE);
  if (!packet) throw new Error("state packet missing");
  return packet.serialize();
}
