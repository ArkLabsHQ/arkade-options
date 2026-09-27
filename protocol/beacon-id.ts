import { asset } from "@arkade-os/sdk";

/** The asset id as the vault script compares it: display txid reversed, plus the group index. */
export type BeaconId = { txid: Uint8Array; gidx: bigint };

export function beaconIdOf(id: asset.AssetId): BeaconId {
  return { txid: Uint8Array.from(id.txid).reverse(), gidx: BigInt(id.groupIndex) };
}
