import { asset } from "@arkade-os/sdk";

import { beaconIdOf } from "../protocol/beacon-id.ts";
import { directPayoutKey, type Terms } from "../protocol/contracts.ts";
import { bytesToHex, hexToBytes } from "../protocol/hex.ts";

/**
 * A filled vault published by a desk. The settler rebuilds the contract from
 * these fields. It does not read the desk's book.
 */
export type WatchPosition = {
  id: string;
  rfqId: string;
  kind: 0 | 1;
  collateral: bigint;
  strike: bigint;
  expiry: number;
  exit: bigint;
  writerPk: Uint8Array;
  holderPk: Uint8Array;
  payoutKey?: Uint8Array;
  beaconTxid: string;
  beaconGidx: number;
  vaultAddress: string;
  fillTxid?: string;
};

const HEX64 = /^[0-9a-fA-F]{64}$/;
const SCRIPT = /^51[0-9a-fA-F]{66}$/;

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hex32(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !HEX64.test(value)) return null;
  return hexToBytes(value);
}

function amount(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return BigInt(value);
  return null;
}

function whole(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
  return null;
}

function one(value: unknown, origin: string): WatchPosition | null {
  const row = record(value);
  if (!row || row.status !== "filled") return null;
  const rfqId = typeof row.rfqId === "string" && HEX64.test(row.rfqId) ? row.rfqId.toLowerCase() : "";
  if (!rfqId) return null;
  if (row.kind !== 0 && row.kind !== 1) return null;
  const collateral = amount(row.collateral);
  const strike = amount(row.strike);
  const expiry = whole(row.expiry);
  const exit = whole(row.exit);
  if (collateral == null || strike == null || expiry == null || exit == null) return null;
  if (!Number.isSafeInteger(Number(expiry)) || !Number.isSafeInteger(Number(exit))) return null;
  const writerPk = hex32(row.writerPubkey);
  const holderPk = hex32(row.holderPubkey);
  if (!writerPk || !holderPk) return null;
  if (typeof row.writerPkScript !== "string" || !SCRIPT.test(row.writerPkScript)) return null;
  const beaconTxid = typeof row.beaconTxid === "string" ? row.beaconTxid.toLowerCase() : "";
  if (!HEX64.test(beaconTxid)) return null;
  const gidx = whole(row.beaconGidx);
  if (gidx == null || gidx > 65_535n) return null;
  if (typeof row.vaultAddress !== "string" || !row.vaultAddress.startsWith("tark1")) return null;
  const fillTxid = typeof row.fillTxid === "string" && HEX64.test(row.fillTxid) ? row.fillTxid.toLowerCase() : undefined;
  return {
    id: `${origin}/${rfqId}`,
    rfqId,
    kind: row.kind,
    collateral,
    strike,
    expiry: Number(expiry),
    exit,
    writerPk,
    holderPk,
    payoutKey: directPayoutKey(bytesToHex(writerPk), row.writerPkScript.toLowerCase()),
    beaconTxid,
    beaconGidx: Number(gidx),
    vaultAddress: row.vaultAddress,
    fillTxid,
  };
}

/** Filled quotes from one desk status body. Incomplete rows are skipped. */
export function positionsFromDesk(body: unknown, origin: string): WatchPosition[] {
  const root = record(body);
  if (!root || !Array.isArray(root.quotes)) return [];
  const positions: WatchPosition[] = [];
  for (const item of root.quotes) {
    const position = one(item, origin);
    if (position) positions.push(position);
  }
  return positions;
}

/** Filled vaults at expiry that this bot has not already progressed. Oldest first. */
export function duePositions<T extends { id: string; expiry: number }>(
  rows: readonly T[],
  now: number,
  done: ReadonlySet<string>,
): T[] {
  return rows
    .filter((row) => row.expiry <= now && !done.has(row.id))
    .sort((a, b) => a.expiry - b.expiry || a.id.localeCompare(b.id));
}

export function termsFor(position: WatchPosition, serverKey: Uint8Array, emulatorKey: Uint8Array): Terms {
  return {
    kind: position.kind,
    strike: position.strike,
    collateral: position.collateral,
    premium: 0n,
    expiry: BigInt(position.expiry),
    deadline: BigInt(position.expiry),
    exit: position.exit,
    writerPk: position.writerPk,
    payoutKey: position.payoutKey,
    holderPk: position.holderPk,
    beacon: beaconIdOf(asset.AssetId.create(position.beaconTxid, position.beaconGidx)),
    serverKey,
    emulatorKey,
  };
}
