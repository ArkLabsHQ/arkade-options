import { arkade, DefaultVtxo, type ArkTxInput } from "@arkade-os/sdk";

import { DUST_SATS } from "../protocol/constants.ts";
import { bindContracts, type Terms } from "../protocol/contracts.ts";
import { bytesToHex } from "../protocol/hex.ts";
import { intentProgram } from "../protocol/programs.ts";
import type { QuoteRow } from "./book.ts";

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
 * No coin by the deadline expires the quote. The seller cancels that coin.
 */
export async function fillQuote(opts: {
  client: Client;
  termsFor: (row: QuoteRow) => Terms;
  deskScript: DefaultVtxo.Script;
  row: QuoteRow;
  now: number;
}): Promise<{ result: FillResult; txid?: string }> {
  const bound = bindContracts(opts.termsFor(opts.row));
  const intent = opts.client.contract(intentProgram(), bound.intent);
  const coins = await intent.getUtxos();
  const collateral = BigInt(opts.row.collateral);
  const premium = BigInt(opts.row.premium);
  const coin = coins.find((item) => BigInt(item.value) >= collateral);
  if (!coin) return { result: opts.now >= opts.row.deadline ? "expired" : "waiting" };
  if (opts.now >= opts.row.deadline) return { result: "expired" };

  if (!opts.client.indexer) throw new Error("indexer missing");
  const desk = await opts.client.indexer.getVtxos({
    scripts: [bytesToHex(opts.deskScript.pkScript)],
    spendableOnly: true,
  });
  const picked = selectFloat(desk.vtxos, premium);
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
  return { result: "filled", txid: sent.txid };
}
