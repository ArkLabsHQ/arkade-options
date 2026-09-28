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

type Indexer = Pick<IndexerProvider, "getVtxos" | "getVirtualTxs">;

type Coin = { txid: string; vout: number; value: number; arkTxId?: string };

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

function prevTxid(tx: Transaction, index: number): string {
  const raw = tx.getInput(index).txid;
  if (!(raw instanceof Uint8Array) || raw.length !== 32) throw new Error("ark input missing txid");
  return bytesToHex(raw);
}

/** Arkd lists a pending spend only when the vtxo row carries ArkTxid. The indexer already has it. */
async function finalizeFromIndexer(opts: {
  ark: PendingArk;
  indexer: Indexer;
  identity: Identity;
  deskScript: Script;
}, coins: Coin[]): Promise<string[]> {
  const ids = [...new Set(coins.map((coin) => coin.arkTxId).filter((id): id is string => !!id))];
  if (!ids.length) {
    console.error("finalize indexer has no ark tx for", coins.length, "coins");
    return [];
  }
  const page = await opts.indexer.getVirtualTxs(ids);
  const finalized: string[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    const arkTxid = ids[i]!;
    const raw = page.txs[i];
    if (!raw) {
      console.error("finalize virtual tx missing", arkTxid);
      continue;
    }
    try {
      const arkTx = Transaction.fromPSBT(base64.decode(raw));
      if (arkTx.id !== arkTxid) throw new Error(`virtual tx ${arkTxid} came back as ${arkTx.id}`);
      const checkpointIds: string[] = [];
      for (let input = 0; input < arkTx.inputsLength; input += 1) checkpointIds.push(prevTxid(arkTx, input));
      const fetched = await opts.indexer.getVirtualTxs(checkpointIds);
      const checkpoints = await Promise.all(checkpointIds.map(async (id, index) => {
        const checkpoint = fetched.txs[index];
        if (!checkpoint) throw new Error(`checkpoint ${id} missing`);
        const parsed = Transaction.fromPSBT(base64.decode(checkpoint));
        if (parsed.id !== id) throw new Error(`checkpoint ${id} came back as ${parsed.id}`);
        return cosignCheckpoint(opts.identity, opts.deskScript.pkScript, checkpoint);
      }));
      await opts.ark.finalizeTx(arkTxid, checkpoints);
      finalized.push(arkTxid);
    } catch (err) {
      console.error("finalize", arkTxid, err instanceof Error ? err.message : err);
    }
  }
  return finalized;
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
  if (finalized.length || pending?.length) return finalized;
  console.error("finalize no pending txs for", coins.length, "coins");
  return finalizeFromIndexer(opts, coins);
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
