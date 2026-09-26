import { ArkAddress, RestIndexerProvider } from "@arkade-os/sdk";

import { ARK_URL } from "../../protocol/constants.ts";
import { bytesToHex } from "../../protocol/hex.ts";
import { classifyIntent, psbtView, type CoinView, type IntentPhase, type TxOutput } from "../../protocol/intent-state.ts";

export type WatchRow = {
  address: string;
  writerAddress?: string;
  collateral: bigint;
  premium: bigint;
  deadline: number;
  since?: number;
};

export type PhaseUpdate = {
  address: string;
  phase: IntentPhase;
  refundable: boolean;
};

const indexer = new RestIndexerProvider(ARK_URL);
const vtxoReads = new Map<string, Promise<{ txid: string; value: number; spentBy: string; createdAt: Date }[]>>();

function scriptOf(address: string): string {
  return bytesToHex(ArkAddress.decode(address).pkScript);
}

function writerCoins(script: string) {
  let job = vtxoReads.get(script);
  if (!job) {
    job = indexer.getVtxos({ scripts: [script] }).then((page) => page.vtxos.map((coin) => ({
      txid: coin.txid,
      value: coin.value,
      spentBy: coin.spentBy || "",
      createdAt: coin.createdAt,
    })));
    vtxoReads.set(script, job);
    void job.finally(() => vtxoReads.delete(script));
  }
  return job;
}

async function payoutEvidence(writerScript: string, intentScript: string, since: number): Promise<{ coins: CoinView[]; spends: Record<string, TxOutput[]> }> {
  const coins = await writerCoins(writerScript);
  const floor = since > 0 ? since - 30 : 0;
  const recent = coins.filter((coin) => {
    const created = coin.createdAt instanceof Date ? Math.floor(coin.createdAt.getTime() / 1000) : 0;
    if (floor > 0) return created >= floor;
    return !coin.spentBy;
  }).sort((a, b) => (b.createdAt?.getTime?.() ?? 0) - (a.createdAt?.getTime?.() ?? 0));
  const ids = [...new Set(recent.map((coin) => coin.txid))].slice(0, 16);
  const raws: string[] = [];
  for (let i = 0; i < ids.length; i += 8) {
    const page = await indexer.getVirtualTxs(ids.slice(i, i + 8));
    raws.push(...page.txs);
  }
  const found: CoinView[] = [];
  const spends: Record<string, TxOutput[]> = {};
  raws.forEach((raw, index) => {
    if (!raw) return;
    let view;
    try {
      view = psbtView(raw);
    } catch {
      return;
    }
    const input = view.inputs.find((item) => item.script.toLowerCase() === intentScript);
    if (!input) return;
    const id = `payout-${index}`;
    found.push({ value: input.amount, spent: true, spentBy: id });
    spends[id] = view.outputs;
  });
  return { coins: found, spends };
}

export async function readIntent(row: WatchRow, now = Math.floor(Date.now() / 1000)): Promise<Omit<PhaseUpdate, "address">> {
  const intentScript = scriptOf(row.address).toLowerCase();
  const writerScript = row.writerAddress ? scriptOf(row.writerAddress) : "";
  const [live, spent] = await Promise.all([
    indexer.getVtxos({ scripts: [intentScript], spendableOnly: true }),
    indexer.getVtxos({ scripts: [intentScript], spentOnly: true }),
  ]);
  const coins: CoinView[] = [...live.vtxos, ...spent.vtxos].map((coin) => ({
    value: BigInt(coin.value),
    spent: Boolean(coin.spentBy),
    spentBy: coin.arkTxId || coin.spentBy || "",
  }));
  const ids = [...new Set(coins.flatMap((coin) => coin.spent && coin.spentBy ? [coin.spentBy] : []))];
  const spends: Record<string, TxOutput[]> = {};
  if (ids.length && writerScript) {
    const page = await indexer.getVirtualTxs(ids);
    ids.forEach((id, index) => {
      const raw = page.txs[index];
      if (!raw) return;
      try {
        spends[id] = psbtView(raw).outputs;
      } catch {
        // A checkpoint id is not the payout. The writer coins below still count.
      }
    });
  }
  const seen = classifyIntent({
    coins,
    spends,
    collateral: row.collateral,
    premium: row.premium,
    writerScript,
    now,
    deadline: row.deadline,
  });
  const settled = seen.phase === "filled" || seen.phase === "refunded" || seen.phase === "funded" || seen.refundable;
  if (settled || !writerScript) return seen;
  const extra = await payoutEvidence(writerScript, intentScript, row.since ?? 0);
  if (!extra.coins.length) return seen;
  return classifyIntent({
    coins: [...coins, ...extra.coins],
    spends: { ...spends, ...extra.spends },
    collateral: row.collateral,
    premium: row.premium,
    writerScript,
    now,
    deadline: row.deadline,
  });
}

function addRow(owners: Map<string, WatchRow[]>, script: string, row: WatchRow) {
  const list = owners.get(script) ?? [];
  if (!list.includes(row)) list.push(row);
  owners.set(script, list);
}

export async function watchIntents(
  rows: WatchRow[],
  onUpdate: (update: PhaseUpdate) => void,
  signal: AbortSignal,
): Promise<void> {
  if (!rows.length || signal.aborted) return;
  const owners = new Map<string, WatchRow[]>();
  for (const row of rows) {
    addRow(owners, scriptOf(row.address), row);
    if (row.writerAddress) addRow(owners, scriptOf(row.writerAddress), row);
  }
  const publish = async (scripts?: string[]) => {
    const todo = scripts
      ? [...new Set(scripts.flatMap((script) => owners.get(script) ?? []))]
      : rows;
    await Promise.all(todo.map(async (row) => {
      if (signal.aborted) return;
      const phase = await readIntent(row);
      if (!signal.aborted) onUpdate({ address: row.address, ...phase });
    }));
  };
  await publish();
  const id = await indexer.subscribeForScripts([...owners.keys()]);
  try {
    for await (const event of indexer.getSubscription(id, signal)) {
      if (signal.aborted) break;
      const touched = new Set<string>();
      for (const script of event.scripts ?? []) {
        if (owners.has(script)) touched.add(script);
      }
      for (const coin of [...event.newVtxos, ...event.spentVtxos, ...event.sweptVtxos]) {
        if (owners.has(coin.script)) touched.add(coin.script);
      }
      if (touched.size) await publish([...touched]);
    }
  } finally {
    await indexer.unsubscribeForScripts(id).catch(() => undefined);
  }
}
