import { asset } from "@arkade-os/sdk";

/** The asset id as the vault script compares it: display txid reversed, plus the group index. */
export type BeaconId = { txid: Uint8Array; gidx: bigint };

export function scriptTxid(id: asset.AssetId): Uint8Array {
  return Uint8Array.from(id.txid).reverse();
}

export function beaconIdOf(id: asset.AssetId): BeaconId {
  return { txid: scriptTxid(id), gidx: BigInt(id.groupIndex) };
}
