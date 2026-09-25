import { ArkAddress, RestIndexerProvider } from "@arkade-os/sdk";

import { ARK_URL } from "../../protocol/constants.ts";
import { bytesToHex } from "../../protocol/hex.ts";
import { classifyIntent, psbtOutputs, type IntentPhase } from "../../protocol/intent-state.ts";

export type WatchRow = {
  address: string;
  writerAddress?: string;
  collateral: bigint;
  premium: bigint;
  deadline: number;
};

export type PhaseUpdate = {
  address: string;
  phase: IntentPhase;
  refundable: boolean;
};

const indexer = new RestIndexerProvider(ARK_URL);

function scriptOf(address: string): string {
  return bytesToHex(ArkAddress.decode(address).pkScript);
}

export async function readIntent(row: WatchRow, now = Math.floor(Date.now() / 1000)): Promise<Omit<PhaseUpdate, "address">> {
  const intentScript = scriptOf(row.address);
  const writerScript = row.writerAddress ? scriptOf(row.writerAddress) : "";
  const [live, spent] = await Promise.all([
    indexer.getVtxos({ scripts: [intentScript], spendableOnly: true }),
    indexer.getVtxos({ scripts: [intentScript], spentOnly: true }),
  ]);
  const coins = [...live.vtxos, ...spent.vtxos].map((coin) => ({
    value: BigInt(coin.value),
    spent: Boolean(coin.spentBy),
    spentBy: coin.spentBy || "",
  }));
  const ids = [...new Set(coins.flatMap((coin) => coin.spent && coin.spentBy ? [coin.spentBy] : []))];
  const spends: Record<string, { amount: bigint; script: string }[]> = {};
  if (ids.length && writerScript) {
    const page = await indexer.getVirtualTxs(ids);
    ids.forEach((id, index) => {
      const raw = page.txs[index];
      if (raw) spends[id] = psbtOutputs(raw);
    });
  }
  return classifyIntent({
    coins,
    spends,
    collateral: row.collateral,
    premium: row.premium,
    writerScript,
    now,
    deadline: row.deadline,
  });
}

export async function watchIntents(
  rows: WatchRow[],
  onUpdate: (update: PhaseUpdate) => void,
  signal: AbortSignal,
): Promise<void> {
  if (!rows.length || signal.aborted) return;
  const scripts = new Map(rows.map((row) => [scriptOf(row.address), row]));
  const publish = async () => {
    await Promise.all(rows.map(async (row) => {
      if (signal.aborted) return;
      const phase = await readIntent(row);
      if (!signal.aborted) onUpdate({ address: row.address, ...phase });
    }));
  };
  await publish();
  const id = await indexer.subscribeForScripts([...scripts.keys()]);
  try {
    for await (const event of indexer.getSubscription(id, signal)) {
      if (signal.aborted) break;
      const touched = event.scripts?.some((script) => scripts.has(script))
        || [...event.newVtxos, ...event.spentVtxos, ...event.sweptVtxos].some((coin) => scripts.has(coin.script));
      if (touched) await publish();
    }
  } finally {
    await indexer.unsubscribeForScripts(id).catch(() => undefined);
  }
}
