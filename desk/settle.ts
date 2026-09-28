import { arkade, asset, DefaultVtxo, Transaction, type CSVMultisigTapscript, type EmulatorProvider, type Identity } from "@arkade-os/sdk";
import { base64 } from "@scure/base";

import { holderPayoff, settlementOutputs } from "../app/settle-math.js";
import { beaconIdOf, bin2num, bindBeacon, decodeState, statePacketOf } from "../protocol/beacon.ts";
import { PRICE_MAX } from "../protocol/constants.ts";
import { bindContracts, type Terms } from "../protocol/contracts.ts";
import { buildSettle, submit, type SignedSpend } from "../protocol/cospend.ts";
import { bytesToHex } from "../protocol/hex.ts";
import { vaultProgram } from "../protocol/programs.ts";
import { hasBeacon, type QuoteRow } from "./book.ts";
import type { BeaconSpec } from "./oracle.ts";

export type ChainCoin = {
  txid: string;
  vout: number;
  value: number | bigint;
  isSpent?: boolean;
  isUnrolled?: boolean;
  spentBy?: string;
  arkTxId?: string;
  settledBy?: string;
  assets?: readonly { assetId: string; amount: bigint | number }[];
};

export type Chain = {
  getVtxos(opts: { scripts: string[]; spendableOnly?: boolean; spentOnly?: boolean }): Promise<{ vtxos: ChainCoin[] }>;
  getVirtualTxs(txids: string[]): Promise<{ txs: string[] }>;
};

export type SettleOutcome =
  | { result: "waiting"; reason: "early" | "vault" | "beacon" }
  | { result: "unfixed" }
  | { result: "short" }
  | { result: "mismatch" }
  | { result: "settled"; txid: string; fee?: { txid: string; vout: number } };

type FeeCoin = { txid: string; vout: number; value: number | bigint };

/**
 * Filled vaults whose expiry has been reached and which have not been spent yet.
 * Oldest expiry first, so a later fixing is not left sitting behind an earlier one.
 */
export function duePositions(rows: readonly QuoteRow[], now: number): QuoteRow[] {
  return rows
    .filter((row) => row.status === "filled" && Boolean(row.fillTxid) && !row.settleTxid && hasBeacon(row) && row.expiry <= now)
    .sort((a, b) => a.expiry - b.expiry || a.rfqId.localeCompare(b.rfqId));
}

/** The price the vault reads: the first 8 bytes of the newest slot whose key is `expiry`. */
export function slotPrice(state: Uint8Array, expiry: bigint): bigint | null {
  let decoded;
  try {
    decoded = decodeState(state);
  } catch {
    return null;
  }
  if (decoded.version !== 1) return null;
  const slot = decoded.slots.find((item) => item.key === expiry);
  if (!slot) return null;
  const price = bin2num(slot.value.subarray(0, 8));
  if (price <= 0n || price > PRICE_MAX) return null;
  return price;
}

/** Payout outputs after the beacon continuation. Amounts sum to the locked coin. */
export function settlePayouts(input: {
  kind: 0 | 1;
  price: bigint;
  strike: bigint;
  collateral: bigint;
  locked: bigint;
  holderScript: Uint8Array;
  writerScript: Uint8Array;
}): { payouts: { script: Uint8Array; amount: bigint }[] } | { error: string } {
  if (input.locked < input.collateral) return { error: "underfunded" };
  const ph = holderPayoff(input.kind, input.price, input.strike, input.collateral);
  if (ph > input.collateral) return { error: "holder overpaid" };
  const split = settlementOutputs(ph, input.locked);
  if (split.mode === "split") {
    return {
      payouts: [
        { script: input.holderScript, amount: split.holder },
        { script: input.writerScript, amount: split.writer },
      ],
    };
  }
  if (split.mode === "writer") return { payouts: [{ script: input.writerScript, amount: split.writer }] };
  return { payouts: [{ script: input.holderScript, amount: split.holder }] };
}

function spent(coin: ChainCoin): boolean {
  return Boolean(coin.isSpent) || Boolean(coin.spentBy) || Boolean(coin.isUnrolled);
}

function spendTxid(coin: ChainCoin | undefined): string {
  if (!coin) return "";
  return coin.arkTxId || coin.spentBy || (coin.isUnrolled ? coin.settledBy || "unrolled" : "");
}

function holdsUnit(coin: ChainCoin, assetId: string): boolean {
  const want = assetId.toLowerCase();
  return (coin.assets ?? []).some((item) => item.assetId.toLowerCase() === want && BigInt(item.amount) === 1n);
}

function txOf(raw: string | undefined, id: string): Transaction | undefined {
  if (!raw) return undefined;
  try {
    const tx = Transaction.fromPSBT(base64.decode(raw));
    return tx.id === id ? tx : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Settle one vault. The price is the fixing in the beacon coin's state packet,
 * which is what `OptionVault.settle` reads. One beacon coin means one settle
 * at a time; the caller refetches the coin for the next vault.
 */
export async function settleQuote(env: {
  chain: Chain;
  serverKey: Uint8Array;
  emulatorKey: Uint8Array;
  emulator: Pick<EmulatorProvider, "submitTx">;
  checkpoint: CSVMultisigTapscript.Type;
  identity?: Identity;
  row: QuoteRow;
  terms: Terms;
  beacon: BeaconSpec;
  now: number;
  feeCoins?: readonly FeeCoin[];
  feeScript?: DefaultVtxo.Script;
}): Promise<SettleOutcome> {
  if (env.now < Number(env.terms.expiry)) return { result: "waiting", reason: "early" };
  const id = asset.AssetId.fromString(env.beacon.assetId);
  const beaconId = beaconIdOf(id);
  if (bytesToHex(beaconId.txid) !== bytesToHex(env.terms.beacon.txid) || beaconId.gidx !== env.terms.beacon.gidx) {
    return { result: "mismatch" };
  }

  const bound = bindContracts(env.terms);
  const vaultScript = bytesToHex(bound.vaultPkScript);
  const live = await env.chain.getVtxos({ scripts: [vaultScript], spendableOnly: true });
  const page = live.vtxos ?? [];
  const vaults = page.filter((coin) => !spent(coin) && BigInt(coin.value) >= env.terms.collateral);
  if (!vaults.length) {
    const unrolled = spendTxid(page.find((coin) => coin.isUnrolled));
    if (unrolled) return { result: "settled", txid: unrolled };
    const history = await env.chain.getVtxos({ scripts: [vaultScript], spentOnly: true });
    const prior = history.vtxos ?? [];
    const gone = spendTxid(prior.find((coin) => coin.txid === env.row.fillTxid) ?? prior.find((coin) => spent(coin)));
    if (gone) return { result: "settled", txid: gone };
    return { result: "waiting", reason: "vault" };
  }
  const vaultCoin = vaults.find((coin) => coin.txid === env.row.fillTxid) ?? vaults[0]!;

  const beaconBound = bindBeacon({
    id: beaconId,
    signers: env.beacon.signers,
    threshold: env.beacon.threshold,
    domain: env.beacon.domain,
    keyLag: env.beacon.keyLag,
    readFee: env.beacon.readFee,
    minValue: env.beacon.minValue,
    adminPk: env.beacon.adminPk,
    exit: env.beacon.exit,
    serverKey: env.serverKey,
    emulatorKey: env.emulatorKey,
  });
  if (beaconBound.address !== env.beacon.address) return { result: "mismatch" };

  const found = await env.chain.getVtxos({ scripts: [bytesToHex(beaconBound.pkScript)], spendableOnly: true });
  const beaconCoin = (found.vtxos ?? []).find((coin) => !spent(coin) && holdsUnit(coin, env.beacon.assetId));
  if (!beaconCoin) return { result: "waiting", reason: "beacon" };

  let feeCoin: FeeCoin | undefined;
  if (env.beacon.readFee > 0n) {
    feeCoin = (env.feeCoins ?? []).find((coin) => BigInt(coin.value) === env.beacon.readFee);
    if (!feeCoin || !env.feeScript || !env.identity) return { result: "short" };
  }

  const ids = [vaultCoin.txid, beaconCoin.txid];
  if (feeCoin) ids.push(feeCoin.txid);
  const raws = await env.chain.getVirtualTxs(ids);
  const txs = raws.txs ?? [];
  const vaultPrev = txOf(txs[0], vaultCoin.txid);
  const beaconPrev = txOf(txs[1], beaconCoin.txid);
  if (!vaultPrev) return { result: "waiting", reason: "vault" };
  if (!beaconPrev) return { result: "waiting", reason: "beacon" };
  let state: Uint8Array;
  try {
    state = statePacketOf(beaconPrev);
  } catch {
    return { result: "waiting", reason: "beacon" };
  }
  const price = slotPrice(state, env.terms.expiry);
  if (price == null) return { result: "unfixed" };

  const locked = BigInt(vaultCoin.value);
  const payout = settlePayouts({
    kind: env.terms.kind,
    price,
    strike: env.terms.strike,
    collateral: env.terms.collateral,
    locked,
    holderScript: bound.holderPkScript,
    writerScript: bound.writerPkScript,
  });
  if ("error" in payout) throw new Error(payout.error);

  let fee: SignedSpend | undefined;
  if (feeCoin && env.feeScript) {
    const feePrev = txOf(txs[2], feeCoin.txid);
    if (!feePrev) return { result: "waiting", reason: "vault" };
    fee = {
      coin: { txid: feeCoin.txid, vout: feeCoin.vout, value: feeCoin.value, prevTx: feePrev.toBytes(true, true) },
      tapLeafScript: env.feeScript.forfeit(),
      tapTree: env.feeScript.encode(),
    };
  }

  const script = new arkade.ArkadeProgramScript(vaultProgram(), bound.vault, {
    serverKey: env.serverKey,
    emulatorKey: env.emulatorKey,
  });
  const built = buildSettle({
    vault: {
      script,
      coin: { txid: vaultCoin.txid, vout: vaultCoin.vout, value: vaultCoin.value, prevTx: vaultPrev.toBytes(true, true) },
    },
    beacon: {
      script: beaconBound.script,
      coin: { txid: beaconCoin.txid, vout: beaconCoin.vout, value: beaconCoin.value, prevTx: beaconPrev.toBytes(true, true) },
      state,
      id,
    },
    readFee: env.beacon.readFee,
    payouts: payout.payouts,
    fee,
    checkpoint: env.checkpoint,
  });
  const submitted = await submit(built, env.emulator as EmulatorProvider, env.identity);
  return {
    result: "settled",
    txid: submitted.txid,
    fee: feeCoin ? { txid: feeCoin.txid, vout: feeCoin.vout } : undefined,
  };
}
