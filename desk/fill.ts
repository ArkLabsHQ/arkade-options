import { arkade, DefaultVtxo, type ArkTxInput } from "@arkade-os/sdk";

import { DUST_SATS } from "../protocol/constants.ts";
import { bindContracts, type Terms } from "../protocol/contracts.ts";
import { bytesToHex } from "../protocol/hex.ts";
import { classifyIntent, psbtView } from "../protocol/intent-state.ts";
import { intentProgram } from "../protocol/programs.ts";
import type { QuoteRow } from "./book.ts";
import { finalizeDeskSpends, pendingOutpoints, settleEmulatorTx, type PendingArk } from "./finalize.ts";

type Client = Awaited<ReturnType<typeof arkade.Arkade.connect>>;
type Coin = { txid: string; vout: number; value: number };

function asInput(coin: Coin, script: DefaultVtxo.Script): ArkTxInput {
  return {
    txid: coin.txid,
    vout: coin.vout,
    value: coin.value,
    tapLeafScript: script.forfeit(),
    tapTree: script.encode(),
  };
}

function selectFloat(coins: Coin[], premium: bigint): Coin[] | null {
  const sorted = [...coins].sort((a, b) => a.value - b.value);
  const picked: Coin[] = [];
  let sum = 0n;
  for (const coin of sorted) {
    picked.push(coin);
    sum += BigInt(coin.value);
    const change = sum - premium;
    if (change === 0n || change > DUST_SATS) return picked;
  }
  if (sum >= premium) return picked;
  return null;
}

export type FillResult = "waiting" | "filled" | "expired" | "short";

/**
 * Happy path. Collateral on the intent is finalized: premium to the writer, collateral to the vault.
 * No live coin: recover a prior finalize from spent history before expiring past the deadline.
 * A live coin past the wall-clock deadline expires; the seller cancels that coin.
 */
export async function fillQuote(opts: {
  client: Client;
  termsFor: (row: QuoteRow) => Terms;
  deskScript: DefaultVtxo.Script;
  row: QuoteRow;
  now: number;
  /** Desk float already reported by the contract manager. Omit it and the indexer is asked once. */
  float?: Coin[];
  /**
   * Ark server that can finish a covenant spend. `send()` stops after the emulator
   * submits; without finalizeTx the premium and the desk change never become vtxos.
   */
  ark?: PendingArk;
}): Promise<{ result: FillResult; txid?: string; spent?: Coin[] }> {
  const bound = bindContracts(opts.termsFor(opts.row));
  const intent = opts.client.contract(intentProgram(), bound.intent);
  const coins = await intent.getUtxos();
  const collateral = BigInt(opts.row.collateral);
  const premium = BigInt(opts.row.premium);
  const coin = coins.find((item) => BigInt(item.value) >= collateral);
  if (!coin) {
    const intentScript = bytesToHex(intent.pkScript);
    const recovered = await recoverFilled(opts.client, bound.writerPkScript, intentScript, {
      collateral,
      premium,
      now: opts.now,
      deadline: opts.row.deadline,
    });
    if (recovered) return { result: "filled", txid: recovered };
    // Spent, but the premium vtxo is not in the indexer yet. Expiring here drops the retry.
    if (await collateralSpent(opts.client, intentScript, collateral)) return { result: "waiting" };
    return { result: opts.now >= opts.row.deadline ? "expired" : "waiting" };
  }
  if (opts.now >= opts.row.deadline) return { result: "expired" };

  const float = opts.float ?? await deskFloat(opts.client, opts.deskScript);
  const picked = selectFloat(float, premium);
  if (!picked) return { result: "short" };

  const locked = BigInt(coin.value);
  const deskSum = picked.reduce((sum, item) => sum + BigInt(item.value), 0n);
  let writerAmount = premium + (locked - collateral);
  let surplus = deskSum - premium;
  if (surplus > 0n && surplus <= DUST_SATS) {
    writerAmount += surplus;
    surplus = 0n;
  }
  const spend = intent.functions.finalize().from(coin).fund(picked.map((item) => asInput(item, opts.deskScript))).to([
    { script: bound.writerPkScript, amount: writerAmount },
    { script: bound.vaultPkScript, amount: collateral },
  ]);
  if (surplus > 0n) spend.change(opts.deskScript.pkScript);
  const sent = await spend.send();
  const identity = opts.client.identity;
  const settled = opts.ark && identity
    ? await settleEmulatorTx({
      ark: opts.ark,
      identity,
      deskScript: opts.deskScript,
      txid: sent.txid,
      signedArkTx: sent.signedArkTx,
      signedCheckpointTxs: sent.signedCheckpointTxs,
    })
    : false;
  if (!settled) {
    await finishSpend(opts, picked);
    if (await floatStillLocked(opts.client, opts.deskScript, picked)) return { result: "waiting" };
  }
  return { result: "filled", txid: sent.txid, spent: picked };
}

/**
 * The emulator submits the virtual tx and returns. Arkd still holds the server-signed
 * checkpoints until the desk signs them and calls finalizeTx. Retry while the spent
 * float is still pending; a slow indexer is not a second fill.
 */
async function finishSpend(opts: {
  client: Client;
  deskScript: DefaultVtxo.Script;
  ark?: PendingArk;
}, picked: Coin[]) {
  const indexer = opts.client.indexer;
  const identity = opts.client.identity;
  if (!opts.ark || !indexer || !identity) return;
  const want = new Set(picked.map((coin) => `${coin.txid}:${coin.vout}`));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const done = await finalizeDeskSpends({
        ark: opts.ark,
        indexer,
        identity,
        deskScript: opts.deskScript,
      });
      if (done.length) console.log("finalized", done.join(","));
    } catch (err) {
      console.error("finalize", err instanceof Error ? err.message : err);
    }
    const pending = await pendingOutpoints(indexer, opts.deskScript);
    if (![...want].some((id) => pending.has(id))) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.error("finalize still pending", [...want].join(","));
}

/** If finalize already landed but the book never saved, classify the spend as filled. */
export async function recoverFilled(
  client: Client,
  writerPkScript: Uint8Array,
  intentScriptHex: string,
  terms: { collateral: bigint; premium: bigint; now: number; deadline: number },
): Promise<string | undefined> {
  if (!client.indexer) return undefined;
  const intentScript = intentScriptHex.toLowerCase();
  const spent = await client.indexer.getVtxos({ scripts: [intentScript], spentOnly: true });
  const coins = (spent.vtxos ?? []).map((coin) => ({
    value: BigInt(coin.value),
    spent: true,
    spentBy: coin.arkTxId || coin.spentBy || "",
  })).filter((coin) => coin.spentBy);
  const ids = [...new Set(coins.map((coin) => coin.spentBy))];
  if (!ids.length) return undefined;
  const page = await client.indexer.getVirtualTxs(ids);
  const spends: Record<string, ReturnType<typeof psbtView>["outputs"]> = {};
  ids.forEach((id, index) => {
    const raw = page.txs[index];
    if (!raw) return;
    try {
      spends[id] = psbtView(raw).outputs;
    } catch {
      // Checkpoint ids are not payouts.
    }
  });
  const seen = classifyIntent({
    coins,
    spends,
    collateral: terms.collateral,
    premium: terms.premium,
    writerScript: bytesToHex(writerPkScript),
    now: terms.now,
    deadline: terms.deadline,
  });
  if (seen.phase !== "filled") return undefined;
  const txid = coins.find((coin) => spends[coin.spentBy])?.spentBy;
  if (!txid) return undefined;
  // The virtual tx can exist before arkd finalizes it. The writer has been paid
  // only once that output is a vtxo.
  const writer = bytesToHex(writerPkScript).toLowerCase();
  const payouts = await client.indexer.getVtxos({ scripts: [writer] });
  const landed = (payouts.vtxos ?? []).some((coin) => (coin.txid || "").toLowerCase() === txid.toLowerCase());
  return landed ? txid : undefined;
}

async function collateralSpent(client: Client, intentScript: string, collateral: bigint): Promise<boolean> {
  if (!client.indexer) return false;
  const spent = await client.indexer.getVtxos({ scripts: [intentScript], spentOnly: true });
  return (spent.vtxos ?? []).some((coin) => BigInt(coin.value) >= collateral);
}

/** True when a picked desk coin is still spendable or still waiting on finalize. */
async function floatStillLocked(client: Client, deskScript: DefaultVtxo.Script, picked: Coin[]): Promise<boolean> {
  if (!client.indexer) return true;
  const script = bytesToHex(deskScript.pkScript);
  const [pending, spendable] = await Promise.all([
    pendingOutpoints(client.indexer, deskScript),
    client.indexer.getVtxos({ scripts: [script], spendableOnly: true }),
  ]);
  const live = new Set((spendable.vtxos ?? []).map((coin) => `${coin.txid}:${coin.vout}`));
  return picked.some((coin) => {
    const id = `${coin.txid}:${coin.vout}`;
    return pending.has(id) || live.has(id);
  });
}

async function deskFloat(client: Client, deskScript: DefaultVtxo.Script): Promise<Coin[]> {
  if (!client.indexer) throw new Error("indexer missing");
  const desk = await client.indexer.getVtxos({
    scripts: [bytesToHex(deskScript.pkScript)],
    spendableOnly: true,
  });
  return desk.vtxos;
}
