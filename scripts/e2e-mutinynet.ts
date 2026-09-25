import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  arkade,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  networks,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  SingleKey,
  Wallet,
} from "@arkade-os/sdk";

import { holderPayoff, oraclePreimage, settlementOutputs, twap, windows } from "../app/settle-math.js";
import { fillQuote } from "../desk/fill.ts";
import type { QuoteRow } from "../desk/book.ts";
import { ARK_URL, EMULATOR_URL, EXIT } from "../protocol/constants.ts";
import { bindContracts, bindSwap, payoutVtxo } from "../protocol/contracts.ts";
import { bytesToHex, xOnly } from "../protocol/hex.ts";
import { intentProgram, vaultProgram } from "../protocol/programs.ts";

/**
 * Happy path on Mutinynet.
 *
 *   pnpm e2e
 *     connects and prints the addresses to fund.
 *
 *   pnpm e2e -- --spend
 *     finalizes an intent that already holds collateral, cancels the second
 *     intent once its deadline has passed, and settles the vault.
 *
 *   pnpm e2e -- --live
 *     spends the writer and desk keys in data/e2e-keys.json. The writer wallet
 *     funds both intents, the desk finalizes one, the writer cancels the other,
 *     and the desk settles the vault.
 *
 * WRITER_KEY and DESK_KEY default to public test keys 1 and 2. Oracle keys are 3..7.
 */

const live = process.argv.includes("--live");
const spend = live || process.argv.includes("--spend");
const saved = live
  ? JSON.parse(await readFile(process.env.E2E_KEYS ?? "data/e2e-keys.json", "utf8")) as { writer: string; desk: string }
  : null;
const writerHex = saved?.writer ?? process.env.WRITER_KEY ?? "1".padStart(64, "0");
const deskHex = saved?.desk ?? process.env.DESK_KEY ?? "2".padStart(64, "0");
const collateral = 50_000n;
const premium = 1_000n;
const strike = 9_700_000n;
const price = 10_000_000n;

function key(n: number) {
  return SingleKey.fromHex(n.toString(16).padStart(64, "0"));
}

async function connect(identity: SingleKey) {
  return arkade.Arkade.connect({
    arkade: new RestArkProvider(ARK_URL),
    indexer: new RestIndexerProvider(ARK_URL),
    emulator: new RestEmulatorProvider(EMULATOR_URL),
    identity,
    network: networks.mutinynet,
  });
}

function btc(sats: bigint) {
  const whole = sats / 100_000_000n;
  const frac = (sats % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

const writer = SingleKey.fromHex(writerHex);
const desk = SingleKey.fromHex(deskHex);
const oracles = [3, 4, 5, 6, 7].map(key);
const writerClient = await connect(writer);
const deskClient = await connect(desk);
if (!writerClient.emulatorKey || !deskClient.emulatorKey) {
  throw new Error("emulator key missing");
}

const now = BigInt(Math.floor(Date.now() / 1000));
const expiry = now + 86_400n;
const fillDeadline = now + 600n;
const cancelDeadline = now + 30n;
const writerPk = await writer.xOnlyPublicKey();
const holderPk = await desk.xOnlyPublicKey();
const oraclePks = await Promise.all(oracles.map((item) => item.xOnlyPublicKey()));
const shared = {
  kind: 0 as const,
  strike,
  collateral,
  premium,
  expiry,
  exit: EXIT,
  writerPk,
  holderPk,
  oraclePks,
  serverKey: writerClient.serverKey,
  emulatorKey: writerClient.emulatorKey,
};

const fill = bindContracts({ ...shared, deadline: fillDeadline });
const cancel = bindContracts({ ...shared, deadline: cancelDeadline });
const serverInfo = await new RestArkProvider(ARK_URL).getInfo();
if (BigInt(serverInfo.unilateralExitDelay) !== EXIT) {
  throw new Error(`server unilateralExitDelay is ${serverInfo.unilateralExitDelay}; contracts use ${EXIT}`);
}
const deskScript = payoutVtxo(holderPk, deskClient.serverKey, EXIT);
const deskAddress = deskScript.address(networks.mutinynet.hrp, xOnly(deskClient.serverKey)).encode();
const swap = bindSwap({
  makerPk: writerPk,
  serverKey: writerClient.serverKey,
  emulatorKey: writerClient.emulatorKey,
  offerAssetIdTxid: writerPk,
  offerAssetIdGidx: 0n,
  offerAmount: 1n,
  wantAssetIdTxid: holderPk,
  wantAssetIdGidx: 0n,
  wantAmount: 1n,
  expirationTime: expiry,
  makerProgram: fill.writerProgram,
});

console.log("writer", bytesToHex(writerPk));
console.log("desk", bytesToHex(holderPk));
console.log("desk address", deskAddress, `(fund at least ${btc(premium)} BTC for the premium)`);
console.log("fill intent", fill.intentAddress, `(fund ${btc(collateral)} BTC of collateral)`);
console.log("fill vault", fill.vaultAddress);
console.log("cancel intent", cancel.intentAddress, `(fund ${btc(collateral)} BTC, refunds after ${cancelDeadline})`);
console.log("reference swap", swap.address);

if (!spend) {
  console.log("Fund those addresses, then re-run with --spend.");
  process.exit(0);
}

function row(bound: typeof fill, deadline: bigint): QuoteRow {
  return {
    rfqId: "11".repeat(32),
    collateral: collateral.toString(),
    premium: premium.toString(),
    kind: 0,
    strike: strike.toString(),
    expiry: Number(expiry),
    deadline: Number(deadline),
    validUntil: Number(now + 30n),
    exit: Number(EXIT),
    writerPubkey: bytesToHex(writerPk),
    writerPkScript: bytesToHex(bound.writerPkScript),
    holderPubkey: bytesToHex(holderPk),
    oraclePubkeys: oraclePks.map((item) => bytesToHex(item)),
    intentAddress: bound.intentAddress,
    vaultAddress: bound.vaultAddress,
    status: "open",
    createdAt: Number(now),
    clientPubkey: bytesToHex(writerPk),
  };
}

if (live) {
  const writerWallet = await Wallet.create({
    identity: writer,
    arkServerUrl: ARK_URL,
    indexerUrl: ARK_URL,
    settlementConfig: false,
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
  });
  const funded = await writerWallet.send({
    recipients: [
      { address: fill.intentAddress, amount: Number(collateral) },
      { address: cancel.intentAddress, amount: Number(collateral) },
    ],
  });
  console.log("funded", funded);
}

async function waitForCoin(label: string, read: () => Promise<{ value: number }[]>, min: bigint) {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const coins = await read();
    if (coins.some((coin) => BigInt(coin.value) >= min)) return;
    console.log(label, `not indexed yet (${attempt})`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`${label} was not indexed`);
}

if (spend) {
  const fillIntent = deskClient.contract(intentProgram(), fill.intent);
  const cancelIntent = writerClient.contract(intentProgram(), cancel.intent);
  await waitForCoin("fill intent", () => fillIntent.getUtxos(), collateral);
  await waitForCoin("cancel intent", () => cancelIntent.getUtxos(), collateral);
}

const filled = await fillQuote({
  client: deskClient,
  deskScript,
  row: row(fill, fillDeadline),
  now: Number(now),
  termsFor: (item) => ({
    kind: 0,
    strike,
    collateral,
    premium,
    expiry,
    deadline: BigInt(item.deadline),
    exit: EXIT,
    writerPk,
    holderPk,
    oraclePks,
    serverKey: deskClient.serverKey,
    emulatorKey: deskClient.emulatorKey!,
  }),
});
console.log("finalize", filled.result, filled.txid ?? "");
if (filled.result !== "filled") throw new Error(`finalize ${filled.result}`);

const cancelContract = writerClient.contract(intentProgram(), cancel.intent);
const cancelCoins = await cancelContract.getUtxos();
if (cancelCoins.length === 0) {
  console.log("cancel waiting for a coin");
} else {
  const waitMs = Math.max(0, Number(cancelDeadline) * 1000 - Date.now() + 2_000);
  if (waitMs > 0) {
    console.log(`cancel waits ${Math.ceil(waitMs / 1000)}s for the deadline`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  const coin = (await cancelContract.getUtxos())[0];
  if (!coin) {
    console.log("cancel coin already spent");
  } else {
    const sent = await cancelContract.functions.cancel().from(coin).to(cancel.writerPkScript, BigInt(coin.value)).send();
    console.log("cancel", sent.txid);
  }
}

const vault = deskClient.contract(vaultProgram(), fill.vault);
const vaultCoins = await vault.getUtxos();
const vaultCoin = vaultCoins[0];
if (!vaultCoin) {
  console.log("settle waiting for the vault");
} else {
  const locked = BigInt(vaultCoin.value);
  const slices = (["open", "mid", "close"] as const).map((name) => {
    const [lo] = windows(expiry)[name];
    return {
      price: [price, price, price],
      time: [lo, lo + 20n, lo + 40n],
      who: [0n, 1n, 2n],
    };
  });
  const medians = slices.map((slice) => slice.price[1]!);
  const ph = holderPayoff(0, twap(medians[0]!, medians[1]!, medians[2]!), strike, collateral);
  const outputs = settlementOutputs(ph, locked);
  const args: (bigint | Uint8Array)[] = [];
  for (const slice of slices) {
    const sigs = await Promise.all(slice.who.map((who, index) => signOracle(oracles[Number(who)]!, slice.price[index]!, slice.time[index]!)));
    args.push(...slice.price, ...slice.time, ...slice.who, ...sigs);
  }
  const settle = vault.functions.settle as (...input: (bigint | Uint8Array)[]) => {
    from(coin: typeof vaultCoin): {
      to(script: Uint8Array, amount: bigint): { send(): Promise<{ txid: string }> };
      to(outputs: { script: Uint8Array; amount: bigint }[]): { send(): Promise<{ txid: string }> };
    };
  };
  const builder = settle(...args).from(vaultCoin);
  const sent = outputs.mode === "split"
    ? await builder.to([
      { script: payoutVtxo(holderPk, deskClient.serverKey, EXIT).pkScript, amount: outputs.holder },
      { script: payoutVtxo(writerPk, deskClient.serverKey, EXIT).pkScript, amount: outputs.writer },
    ]).send()
    : await builder.to(
      payoutVtxo(outputs.mode === "holder" ? holderPk : writerPk, deskClient.serverKey, EXIT).pkScript,
      outputs.mode === "holder" ? outputs.holder : outputs.writer,
    ).send();
  console.log("settle", sent.txid, outputs.mode);
}

process.exit(0);

async function signOracle(oracle: SingleKey, px: bigint, time: bigint) {
  const hash = createHash("sha256").update(oraclePreimage(px, time)).digest();
  return oracle.signSchnorrDeterministic(hash);
}
