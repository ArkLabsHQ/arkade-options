import { asset } from "@arkade-os/sdk";

import { beaconIdOf } from "../protocol/beacon-id.ts";
import { directPayoutKey, type Terms } from "../protocol/contracts.ts";
import { hexToBytes } from "../protocol/hex.ts";
import { parsePosition } from "../protocol/messages.ts";

/**
 * A filled vault announced on Nostr. The settler rebuilds the contract from
 * these fields. It does not read a desk book or a desk URL.
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

/** One public position event. Incomplete or sealed RFQ payloads are skipped. */
export function positionFromAnnouncement(body: unknown): WatchPosition | null {
  const row = parsePosition(body);
  if (!row) return null;
  return {
    id: row.rfq_id,
    rfqId: row.rfq_id,
    kind: row.kind,
    collateral: BigInt(row.collateral),
    strike: BigInt(row.strike),
    expiry: row.expiry,
    exit: BigInt(row.exit),
    writerPk: hexToBytes(row.writer_pubkey),
    holderPk: hexToBytes(row.holder_pubkey),
    payoutKey: directPayoutKey(row.writer_pubkey, row.writer_pk_script),
    beaconTxid: row.beacon_txid,
    beaconGidx: row.beacon_gidx,
    vaultAddress: row.vault_address,
    fillTxid: row.fill_txid,
  };
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
