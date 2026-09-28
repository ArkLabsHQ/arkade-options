import { asset } from "@arkade-os/sdk";

import { beaconIdOf } from "../protocol/beacon-id.ts";
import { bytesToHex } from "../protocol/hex.ts";

/**
 * The oracle's public status. Settlement needs the beacon constructor from
 * here, then reads the price from the beacon coin itself.
 */

export type BeaconSpec = {
  assetId: string;
  address: string;
  signers: Uint8Array[];
  threshold: bigint;
  domain: Uint8Array;
  keyLag: bigint;
  readFee: bigint;
  minValue: bigint;
  adminPk: Uint8Array;
  exit: bigint;
};

export type ParsedBeacon = { ok: true; beacon: BeaconSpec } | { ok: false; error: string };

const HEX = /^[0-9a-fA-F]+$/;

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hexBytes(value: unknown, size: number): Uint8Array | null {
  if (typeof value !== "string" || value.length !== size * 2 || !HEX.test(value)) return null;
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function whole(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
  return null;
}

/** Origin only. A pasted `/api/status` URL still works. */
export function oracleOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("ORACLE_URL must be an http(s) origin");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("ORACLE_URL must be an http(s) origin");
  return url.origin;
}

export async function fetchOracleStatus(origin: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(`${origin}/api/status`, { signal });
  if (!res.ok) throw new Error(`oracle status ${res.status}`);
  return await res.json();
}

/**
 * Accept the `/api/status` body when it is the beacon this desk quoted.
 * `beaconTxid` is the display txid. `gidx` is the identity asset's vout.
 */
export function parseOracleBeacon(body: unknown, beaconTxid: string, gidx: number): ParsedBeacon {
  const root = record(body);
  if (!root) return { ok: false, error: "oracle status" };
  const issue = typeof root.issueTxid === "string" ? root.issueTxid.toLowerCase() : "";
  if (issue !== beaconTxid) return { ok: false, error: "oracle beacon" };
  if (typeof root.assetId !== "string") return { ok: false, error: "oracle asset" };
  let parsed: ReturnType<typeof asset.AssetId.fromString>;
  try {
    parsed = asset.AssetId.fromString(root.assetId);
  } catch {
    return { ok: false, error: "oracle asset" };
  }
  if (bytesToHex(parsed.txid) !== beaconTxid || Number(parsed.groupIndex) !== gidx) return { ok: false, error: "oracle asset" };
  if (typeof root.address !== "string" || !root.address.startsWith("tark1")) return { ok: false, error: "oracle address" };
  if (!Array.isArray(root.pubkeys) || root.pubkeys.length !== 5) return { ok: false, error: "five pubkeys" };
  const signers: Uint8Array[] = [];
  for (const item of root.pubkeys) {
    const key = hexBytes(item, 32);
    if (!key) return { ok: false, error: "pubkey" };
    signers.push(key);
  }
  if (new Set(signers.map((key) => bytesToHex(key))).size !== 5) return { ok: false, error: "duplicate pubkey" };
  const args = record(root.args);
  if (!args) return { ok: false, error: "oracle args" };
  const ctrl = typeof args.ctrlTxid === "string" ? args.ctrlTxid.toLowerCase() : "";
  if (ctrl !== bytesToHex(beaconIdOf(parsed).txid)) return { ok: false, error: "ctrl txid" };
  const threshold = whole(args.threshold);
  const keyLag = whole(args.keyLag);
  const readFee = whole(args.readFee);
  const minValue = whole(args.minValue);
  const exit = whole(args.exit);
  const domain = typeof args.domain === "string" && args.domain.length > 0 && args.domain.length % 2 === 0 && HEX.test(args.domain)
    ? hexBytes(args.domain, args.domain.length / 2)
    : null;
  const adminPk = hexBytes(args.adminPk, 32);
  if (threshold == null || threshold < 1n || threshold > 5n) return { ok: false, error: "threshold" };
  if (keyLag == null || readFee == null || exit == null || !domain || !adminPk) return { ok: false, error: "oracle args" };
  if (minValue == null || minValue <= 300n) return { ok: false, error: "min value" };
  return {
    ok: true,
    beacon: {
      assetId: parsed.toString(),
      address: root.address,
      signers,
      threshold,
      domain,
      keyLag,
      readFee,
      minValue,
      adminPk,
      exit,
    },
  };
}
