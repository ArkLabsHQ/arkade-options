import { ArkAddress, RestIndexerProvider } from "@arkade-os/sdk";

import { ARK_URL } from "../../protocol/constants.ts";
import { bytesToHex } from "../../protocol/hex.ts";
import { classifyIntent, psbtView, type CoinView, type IntentPhase, type TxOutput } from "../../protocol/intent-state.ts";
import { intentCoins, onContractEvent } from "./fund.ts";

export type WatchRow = {
  address: string;
  writerAddress?: string;
  collateral: bigint;
  premium: bigint;
  deadline: number;
  since?: number;
  /** Register this intent with the contract manager. Returns its pkScript. */
  register?: () => Promise<string>;
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
  const managed = await intentCoins(intentScript);
  let coins: CoinView[];
  if (managed) {
    coins = managed;
  } else {
    const [live, spent] = await Promise.all([
      indexer.getVtxos({ scripts: [intentScript], spendableOnly: true }),
      indexer.getVtxos({ scripts: [intentScript], spentOnly: true }),
    ]);
    coins = [...live.vtxos, ...spent.vtxos].map((coin) => ({
      value: BigInt(coin.value),
      spent: Boolean(coin.spentBy),
      spentBy: coin.arkTxId || coin.spentBy || "",
    }));
  }
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

let generation = 0;
let hooking: Promise<void> | null = null;
let owners = new Map<string, WatchRow[]>();
let listener: ((update: PhaseUpdate) => void) | null = null;

async function publish(rows: WatchRow[], gen: number) {
  await Promise.all(rows.map(async (row) => {
    if (gen !== generation) return;
    try {
      const phase = await readIntent(row);
      if (gen === generation) listener?.({ address: row.address, ...phase });
    } catch {
      // The manager's subscription retries. This row stays as it was.
    }
  }));
}

function hook(): Promise<void> {
  if (!hooking) {
    hooking = onContractEvent((event) => {
      if (event.type !== "vtxo_received" && event.type !== "vtxo_spent") return;
      const rows = owners.get(event.contractScript);
      if (rows?.length) void publish(rows, generation);
    }).then(() => undefined);
    hooking.catch(() => {
      hooking = null;
    });
  }
  return hooking;
}

export async function watchIntents(
  rows: WatchRow[],
  onUpdate: (update: PhaseUpdate) => void,
  signal: AbortSignal,
): Promise<void> {
  if (!rows.length || signal.aborted) return;
  const gen = ++generation;
  listener = onUpdate;
  owners = new Map();
  for (const row of rows) addRow(owners, scriptOf(row.address), row);
  await hook();
  if (gen !== generation || signal.aborted) return;
  let failed = false;
  for (const row of rows) {
    if (!row.register) continue;
    try {
      const script = await row.register();
      if (gen !== generation || signal.aborted) return;
      if (script) addRow(owners, script, row);
    } catch (err) {
      failed = true;
      console.error(err);
    }
  }
  if (gen !== generation || signal.aborted) return;
  await publish(rows, gen);
  if (failed) throw new Error("contract register failed");
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
