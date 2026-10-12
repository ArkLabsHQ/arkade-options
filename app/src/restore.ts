import { asset } from "@arkade-os/sdk";

import { beaconIdOf } from "../../protocol/beacon-id.ts";
import { bindContracts, type Terms } from "../../protocol/contracts.ts";
import { bytesToHex, hexToBytes, xOnly } from "../../protocol/hex.ts";
import { operatorSession, readOutpoint } from "./fund.ts";
import { vaultProgram } from "./program.ts";

/** Creating tx of the sample vault. The collateral coin is vout 1. */
export const SAMPLE_VAULT_TXID = "4b46f8dafd536990a134a60e909293d0cc164dfd64e377ae0f361526c9536768";

const TXID = /^[0-9a-f]{64}$/;

export type VaultCoin = {
  isSpent?: boolean;
  spentBy?: string;
  arkTxId?: string;
};

export type RestoreInput = {
  txid: string;
  vout: number;
  kind: 0 | 1;
  strike: bigint;
  expiry: bigint;
  collateral: bigint;
  writerPk: Uint8Array;
  holderPk: Uint8Array;
  beaconTxidHex: string;
  beaconGidx: number;
  exit: bigint;
  readFee: bigint;
  serverKey: Uint8Array;
  emulatorKey: Uint8Array;
};

export type RestoreFields = {
  outpoint: string;
  kind: number;
  strike: string;
  expiry: string;
  collateral: string;
  writerPk: string;
  holderPk: string;
  beaconTxid: string;
  beaconGidx: string;
  exit: string;
  readFee: string;
};

export type RestoredVault = {
  id: string;
  kind: 0 | 1;
  strike: bigint;
  expiry: bigint;
  collateral: bigint;
  premiumSats: bigint;
  status: "filled" | "settled";
  settleTxid: string;
  closeTxid: string;
  vaultAddress: string;
  holderPkHex: string;
  beaconTxid: string;
  beaconGidx: number;
  exit: number;
  writerScript: string;
  restored: true;
  days: number;
  tenorSec: number;
  premiumUsd: number;
  solver: string;
  address: string;
  deadline: number;
  createdAt: number;
  apy: null;
  apyFrozen: true;
};

function hexId(value: string | undefined): string {
  const id = (value ?? "").trim().toLowerCase();
  return TXID.test(id) ? id : "";
}

/** isSpent false is an open vault. A spentBy value, or isSpent, is settled. */
export function coinSettled(coin: VaultCoin): boolean {
  return coin.isSpent === true || Boolean((coin.spentBy ?? "").trim()) || Boolean((coin.arkTxId ?? "").trim());
}

/** The positions screen links the Ark transaction. The checkpoint id is the fallback. */
export function settlementTxid(coin: VaultCoin): string {
  return hexId(coin.arkTxId) || hexId(coin.spentBy);
}

function whole(raw: string, label: string): bigint {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) throw new Error(`${label} must be a whole number.`);
  return BigInt(text);
}

function pubkey(raw: string, label: string): Uint8Array {
  const text = raw.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]+$/.test(text) || text.length % 2 !== 0) throw new Error(`${label} must be hex.`);
  const bytes = hexToBytes(text);
  if (bytes.length !== 32 && bytes.length !== 33) throw new Error(`${label} must be 32 or 33 bytes.`);
  return xOnly(bytes);
}

export function parseOutpoint(raw: string): { txid: string; vout: number } {
  const match = /^([0-9a-f]{64}):(\d+)$/.exec(raw.trim().toLowerCase());
  if (!match) throw new Error("Outpoint must be txid:vout.");
  const vout = Number(match[2]);
  if (!Number.isSafeInteger(vout)) throw new Error("Outpoint must be txid:vout.");
  return { txid: match[1], vout };
}

export function parseRestoreFields(fields: RestoreFields): Omit<RestoreInput, "serverKey" | "emulatorKey"> {
  const outpoint = parseOutpoint(fields.outpoint);
  if (fields.kind !== 0 && fields.kind !== 1) throw new Error("Choose a covered call or a limited put.");
  const beaconTxidHex = fields.beaconTxid.trim().toLowerCase().replace(/^0x/, "");
  if (!TXID.test(beaconTxidHex)) throw new Error("Beacon txid must be 32 bytes of hex.");
  const beaconGidx = whole(fields.beaconGidx, "Beacon output");
  if (beaconGidx > 65535n) throw new Error("Beacon output must be from 0 to 65535.");
  const exit = whole(fields.exit, "Exit");
  if (exit <= 0n || exit > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Exit must be a whole number of seconds.");
  return {
    ...outpoint,
    kind: fields.kind,
    strike: whole(fields.strike, "Strike"),
    expiry: whole(fields.expiry, "Expiry"),
    collateral: whole(fields.collateral, "Collateral"),
    writerPk: pubkey(fields.writerPk, "Writer public key"),
    holderPk: pubkey(fields.holderPk, "Holder public key"),
    beaconTxidHex,
    beaconGidx: Number(beaconGidx),
    exit,
    readFee: whole(fields.readFee, "Read fee"),
  };
}

function bindRestore(input: RestoreInput) {
  const terms: Terms = {
    kind: input.kind,
    strike: input.strike,
    collateral: input.collateral,
    premium: 0n,
    expiry: input.expiry,
    deadline: 0n,
    exit: input.exit,
    writerPk: input.writerPk,
    // confirm() pays the writer's taproot key. That key is the vault's writerScript.
    payoutKey: input.writerPk,
    holderPk: input.holderPk,
    beacon: beaconIdOf(asset.AssetId.create(input.beaconTxidHex, input.beaconGidx)),
    readFee: input.readFee,
    serverKey: input.serverKey,
    emulatorKey: input.emulatorKey,
  };
  return bindContracts(terms);
}

export function restoreFromCoin(input: RestoreInput, coin: VaultCoin): RestoredVault {
  const bound = bindRestore(input);
  const settled = coinSettled(coin);
  return {
    id: `restore:${input.txid}:${input.vout}`,
    kind: input.kind,
    strike: input.strike,
    expiry: input.expiry,
    collateral: input.collateral,
    premiumSats: 0n,
    status: settled ? "settled" : "filled",
    settleTxid: settled ? settlementTxid(coin) : "",
    closeTxid: input.txid,
    vaultAddress: bound.vaultAddress,
    holderPkHex: bytesToHex(input.holderPk),
    beaconTxid: input.beaconTxidHex,
    beaconGidx: input.beaconGidx,
    exit: Number(input.exit),
    writerScript: bytesToHex(bound.writerPkScript),
    restored: true,
    days: 0,
    tenorSec: 0,
    premiumUsd: 0,
    solver: "",
    address: "",
    deadline: 0,
    createdAt: 0,
    apy: null,
    apyFrozen: true,
  };
}

/**
 * Register the vault from the artifact and the constructor args, then read the
 * indexer coin at the outpoint. ContractManager has no register method, so the
 * spend flag comes from that coin rather than refreshVtxos.
 */
export async function restoreVault(fields: RestoreFields): Promise<RestoredVault> {
  const parsed = parseRestoreFields(fields);
  const { client } = await operatorSession();
  if (!client.emulatorKey) throw new Error("The emulator key is missing.");
  const input: RestoreInput = {
    ...parsed,
    serverKey: client.serverKey,
    emulatorKey: client.emulatorKey,
  };
  const bound = bindRestore(input);
  const vault = client.contract(vaultProgram(), bound.vault);
  if (vault.address !== bound.vaultAddress) {
    throw new Error("The contract address does not match the local derivation.");
  }
  await vault.register();
  const coin = await readOutpoint(input.txid, input.vout);
  if (!coin) throw new Error("The indexer has no coin at that outpoint.");
  return restoreFromCoin(input, coin);
}
