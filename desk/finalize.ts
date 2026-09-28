import { Intent, Transaction, type DefaultVtxo, type Identity, type IndexerProvider } from "@arkade-os/sdk";
import { base64 } from "@scure/base";

import { bytesToHex } from "../protocol/hex.ts";

type Script = DefaultVtxo.Script;

export type PendingArk = {
  getPendingTxs(intent: {
    proof: string;
    message: { type: "get-pending-tx"; expire_at: number };
  }): Promise<{ arkTxid: string; signedCheckpointTxs: string[] }[]>;
  finalizeTx(arkTxid: string, finalCheckpointTxs: string[]): Promise<void>;
};

type Indexer = Pick<IndexerProvider, "getVtxos">;

type Coin = { txid: string; vout: number; value: number };

function sameScript(left: Uint8Array | undefined, right: Uint8Array): boolean {
  return !!left && left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Add the desk signature to a checkpoint that spends the desk script. Other checkpoints pass through. */
export async function cosignCheckpoint(identity: Identity, deskScript: Uint8Array, raw: string): Promise<string> {
  const tx = Transaction.fromPSBT(base64.decode(raw));
  if (!sameScript(tx.getInput(0).witnessUtxo?.script, deskScript)) return raw;
  try {
    const signed = await identity.sign(tx, [0]);
    return base64.encode(signed.toPSBT());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The checkpoint was already signed with this key before submit.
    if (/same key/i.test(message)) return raw;
    throw err;
  }
}

async function ownershipProof(identity: Identity, desk: Script, coins: Coin[]) {
  const message = { type: "get-pending-tx" as const, expire_at: 0 };
  const proof = Intent.create(message, coins.map((coin) => ({
    txid: coin.txid,
    vout: coin.vout,
    value: coin.value,
    tapTree: desk.encode(),
    intentTapLeafScript: desk.forfeit(),
    forfeitTapLeafScript: desk.forfeit(),
  })) as Parameters<typeof Intent.create>[1], []);
  const signed = await identity.sign(proof);
  return { proof: base64.encode(signed.toPSBT()), message };
}

/** Sign and finalize ark txs that already spent the desk script but never cleared finalizeTx. */
export async function finalizeDeskSpends(opts: {
  ark: PendingArk;
  indexer: Indexer;
  identity: Identity;
  deskScript: Script;
}): Promise<string[]> {
  const page = await opts.indexer.getVtxos({
    scripts: [bytesToHex(opts.deskScript.pkScript)],
    pendingOnly: true,
  });
  const coins = (page.vtxos ?? []).filter((coin) => coin.txid && coin.isSpent !== false);
  if (!coins.length) return [];
  const intent = await ownershipProof(opts.identity, opts.deskScript, coins);
  const pending = await opts.ark.getPendingTxs(intent);
  const finalized: string[] = [];
  if (!pending?.length) {
    console.error("finalize no pending txs for", coins.length, "coins");
  }
  for (const tx of pending ?? []) {
    if (!tx?.arkTxid || !tx.signedCheckpointTxs?.length) {
      console.error("finalize bad pending tx", tx ? Object.keys(tx).join(",") : "empty");
      continue;
    }
    try {
      const checkpoints = await Promise.all(tx.signedCheckpointTxs.map((raw) => (
        cosignCheckpoint(opts.identity, opts.deskScript.pkScript, raw)
      )));
      await opts.ark.finalizeTx(tx.arkTxid, checkpoints);
      finalized.push(tx.arkTxid);
    } catch (err) {
      console.error("finalize", tx.arkTxid, err instanceof Error ? err.message : err);
    }
  }
  return finalized;
}

/** Outpoints of desk coins sitting in an unfinalized spend. */
export async function pendingOutpoints(indexer: Indexer, deskScript: Script): Promise<Set<string>> {
  const page = await indexer.getVtxos({
    scripts: [bytesToHex(deskScript.pkScript)],
    pendingOnly: true,
  });
  const ids = new Set<string>();
  for (const coin of page.vtxos ?? []) {
    if (coin.isSpent === false) continue;
    ids.add(`${coin.txid}:${coin.vout}`);
  }
  return ids;
}
