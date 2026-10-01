import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  arkade,
  asset,
  networks,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  SingleKey,
  Wallet,
} from "@arkade-os/sdk";

import { beaconIdOf } from "../protocol/beacon.ts";
import { fillQuote } from "../desk/fill.ts";
import type { QuoteRow } from "../desk/book.ts";
import { ARK_URL, BEACON_READ_FEE, EMULATOR_URL } from "../protocol/constants.ts";
import { bindContracts, payoutVtxo } from "../protocol/contracts.ts";
import { bytesToHex, hexToBytes, xOnly } from "../protocol/hex.ts";
import { intentProgram } from "../protocol/programs.ts";
import { openSqliteStorage } from "../protocol/sqlite-storage.ts";
import { createOracle, type OracleWallet } from "../oracle/service.ts";
import { settleQuote } from "../settle/vault.ts";

/**
 * Broadcast one covered call and settle it from a simulated price.
 *
 *   pnpm roundtrip:live
 *   ROUNDTRIP_NETWORK=regtest pnpm roundtrip:live
 *
 * Mutinynet keys stay in data/roundtrip-live. Regtest keys stay in
 * data/roundtrip-regtest. A regtest run uses the local nigiri arkd and asks
 * `nigiri faucet` for coins. Mutinynet asks the Arkade faucet, then a
 * GitHub-authenticated on-chain board when FAUCET_JWT is set.
 */

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const REGTEST = process.env.ROUNDTRIP_NETWORK === "regtest";
const DIR = path.join(ROOT, "data", REGTEST ? "roundtrip-regtest" : "roundtrip-live");
const KEYS = path.join(DIR, "keys.json");
const COLLATERAL = 20_000n;
const PREMIUM = 1_000n;
const STRIKE = 9_700_000n;
const PRICE = 10_000_000n;
const ADMIN = "roundtrip-live";
const FAUCET = "https://faucet.mutinynet.arkade.sh/faucet";
const PUBLIC_FAUCET = "https://faucet.mutinynet.com";
const exec = promisify(execFile);
const arkUrl = process.env.ARK_URL ?? (REGTEST ? "http://127.0.0.1:7070" : ARK_URL);
const emulatorUrl = process.env.EMULATOR_URL ?? (REGTEST ? "http://127.0.0.1:7073" : EMULATOR_URL);
const esploraUrl = process.env.ESPLORA_URL ?? (REGTEST ? "http://127.0.0.1:3000" : undefined);
const network = REGTEST ? networks.regtest : networks.mutinynet;

type Keys = { oracle: string; desk: string; writer: string };

async function keys(): Promise<Keys> {
  await mkdir(DIR, { recursive: true });
  try {
    return JSON.parse(await readFile(KEYS, "utf8")) as Keys;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const fresh = {
      oracle: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
      desk: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
      writer: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    };
    await writeFile(KEYS, JSON.stringify(fresh), { mode: 0o600 });
    return fresh;
  }
}

async function openWallet(name: string, secret: string) {
  const storage = await openSqliteStorage(DIR, `${name}.sqlite`);
  const identity = SingleKey.fromHex(secret);
  const wallet = await Wallet.create({
    identity,
    arkServerUrl: arkUrl,
    indexerUrl: arkUrl,
    esploraUrl,
    settlementConfig: false,
    storage: {
      walletRepository: storage.walletRepository,
      contractRepository: storage.contractRepository,
    },
  });
  return { identity, wallet, storage };
}

async function balance(wallet: Wallet): Promise<bigint> {
  const coins = await wallet.getVtxos();
  return coins.filter((coin) => !coin.isSpent).reduce((sum, coin) => sum + BigInt(coin.value), 0n);
}

async function faucet(address: string, amount: number) {
  const res = await fetch(FAUCET, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, amount }),
  });
  const text = await res.text();
  console.log("faucet", address.slice(0, 20), res.status, text.slice(0, 180));
  return res.ok;
}

async function publicFaucet(pathName: string, body: unknown, token: string) {
  const res = await fetch(PUBLIC_FAUCET + pathName, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log("public faucet", pathName, res.status, text.slice(0, 200));
  return res.ok;
}

async function boardOnchain(wallet: Wallet, token: string) {
  const boarding = await wallet.getBoardingAddress();
  console.log("boarding", boarding);
  const poured = await publicFaucet("/api/onchain", { address: boarding, sats: 200_000 }, token);
  if (!poured) throw new Error("onchain faucet refused");
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    const bal = await wallet.getBalance();
    console.log("boarding", bal.boarding.confirmed, bal.boarding.unconfirmed, "available", bal.available);
    if (bal.boarding.confirmed >= 50_000 || bal.available >= 50_000) break;
    if (attempt === 40) throw new Error("boarding utxo not confirmed");
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  if ((await balance(wallet)) >= 50_000n) return;
  const txid = await wallet.settle();
  console.log("boarded", txid);
}

async function waitBalance(label: string, wallet: Wallet, min: bigint) {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const have = await balance(wallet);
    console.log(label, have.toString(), "want", min.toString());
    if (have >= min) return have;
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }
  throw new Error(`${label} still unfunded`);
}

async function post(url: string, pathName: string, body: unknown) {
  const res = await fetch(url + pathName, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` },
    body: JSON.stringify(body),
  });
  const json = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error(`${pathName} ${res.status} ${json.error ?? ""}`);
  return json;
}

async function connect(identity: SingleKey, emulatorPubkey: string) {
  return arkade.Arkade.connect({
    arkade: new RestArkProvider(arkUrl),
    indexer: new RestIndexerProvider(arkUrl),
    emulator: new RestEmulatorProvider(emulatorUrl),
    emulatorPubkey,
    identity,
    network,
  });
}

async function serverExit(): Promise<bigint> {
  const info = await new RestArkProvider(arkUrl).getInfo();
  return BigInt(info.unilateralExitDelay);
}

async function emulatorPubkey(): Promise<string> {
  const res = await fetch(emulatorUrl + "/v1/info");
  const body = await res.json() as { signerPubkey?: string };
  if (!res.ok || !body.signerPubkey) throw new Error("emulator info");
  return body.signerPubkey;
}

const saved = await keys();
const oracle = await openWallet("oracle", saved.oracle);
const desk = await openWallet("desk", saved.desk);
const writer = await openWallet("writer", saved.writer);

const oracleAddress = await oracle.wallet.getAddress();
const deskAddress = await desk.wallet.getAddress();
const writerAddress = await writer.wallet.getAddress();
console.log("oracle", oracleAddress);
console.log("desk", deskAddress);
console.log("writer", writerAddress);

const oracleHave = await balance(oracle.wallet);
const deskHave = await balance(desk.wallet);
const writerHave = await balance(writer.wallet);
console.log("balances", oracleHave.toString(), deskHave.toString(), writerHave.toString());

if (REGTEST && writerHave < 50_000n) {
  const poured = await exec("sudo", ["nigiri", "faucet", "--ark", writerAddress, "0.002"], { timeout: 180_000 });
  console.log("nigiri", (poured.stdout + poured.stderr).trim().slice(0, 300));
  await waitBalance("writer", writer.wallet, 50_000n);
}

if (!REGTEST && writerHave < 50_000n) {
  const jwt = process.env.FAUCET_JWT ?? "";
  let poured = false;
  if (jwt) {
    poured = await publicFaucet("/api/arkade", { address: writerAddress, sats: 100_000 }, jwt);
    if (!poured) {
      try {
        await boardOnchain(writer.wallet, jwt);
        poured = true;
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
      }
    }
  }
  if (!poured) poured = await faucet(writerAddress, 100_000);
  if (!poured && writerHave === 0n && (await balance(writer.wallet)) === 0n) {
    console.error("fund the writer address, then re-run pnpm roundtrip:live");
    process.exit(2);
  }
  try {
    await waitBalance("writer", writer.wallet, 50_000n);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    console.error("fund the writer address, then re-run pnpm roundtrip:live");
    process.exit(2);
  }
}

if ((await balance(oracle.wallet)) < 20_000n) {
  const sent = await writer.wallet.send({ recipients: [{ address: oracleAddress, amount: 20_000 }] });
  console.log("to oracle", sent);
  await waitBalance("oracle", oracle.wallet, 15_000n);
}
if ((await balance(desk.wallet)) < 5_000n) {
  const sent = await writer.wallet.send({ recipients: [{ address: deskAddress, amount: 10_000 }] });
  console.log("to desk", sent);
  await waitBalance("desk", desk.wallet, 5_000n);
}

const exit = await serverExit();
const coSigner = await emulatorPubkey();
console.log("server", arkUrl, "exit", exit.toString(), "emulator", coSigner);

const oracleService = await createOracle({
  dataDir: DIR,
  adminToken: ADMIN,
  oracleKey: hexToBytes(saved.oracle),
  emulatorKey: hexToBytes(coSigner),
  wallet: oracle.wallet as unknown as OracleWallet,
  indexer: new RestIndexerProvider(arkUrl),
  emulator: new RestEmulatorProvider(emulatorUrl),
  exit,
  sampleEveryMs: undefined,
});

console.log("oracle http", oracleService.url);
const status = await (await fetch(oracleService.url + "/api/status")).json() as { issueTxid?: string | null; deployTxid?: string | null; address?: string | null };
let issueTxid = status.issueTxid ?? "";
if (!issueTxid) {
  const issued = await post(oracleService.url, "/api/issue", {});
  issueTxid = String(issued.txid);
  console.log("issued", issueTxid);
}
if (!status.deployTxid) {
  const deployed = await post(oracleService.url, "/api/deploy", {});
  console.log("deployed", deployed.txid, deployed.address);
}

const deskClient = await connect(desk.identity, coSigner);
const writerClient = await connect(writer.identity, coSigner);
if (!deskClient.emulatorKey || !writerClient.emulatorKey || !deskClient.emulator || !writerClient.indexer) {
  throw new Error("emulator missing");
}

const now = Math.floor(Date.now() / 1000);
const expiry = now - 600;
const deadline = now + 600;
const writerPk = await writer.identity.xOnlyPublicKey();
const holderPk = await desk.identity.xOnlyPublicKey();
const beacon = beaconIdOf(asset.AssetId.create(issueTxid, 0));
const shared = {
  kind: 0 as const,
  strike: STRIKE,
  collateral: COLLATERAL,
  premium: PREMIUM,
  expiry: BigInt(expiry),
  exit,
  writerPk,
  holderPk,
  beacon,
  readFee: BEACON_READ_FEE,
  serverKey: deskClient.serverKey,
  emulatorKey: deskClient.emulatorKey,
};
const bound = bindContracts({ ...shared, deadline: BigInt(deadline) });
const deskScript = payoutVtxo(holderPk, deskClient.serverKey, exit);
const deskScriptAddress = deskScript.address(network.hrp, xOnly(deskClient.serverKey)).encode();
if (deskScriptAddress !== deskAddress) {
  console.log("desk script address", deskScriptAddress);
}

console.log("intent", bound.intentAddress);
const funded = await writer.wallet.send({ recipients: [{ address: bound.intentAddress, amount: Number(COLLATERAL) }] });
console.log("collateral", funded);

const intent = deskClient.contract(intentProgram(), bound.intent);
for (let attempt = 1; attempt <= 30; attempt += 1) {
  const coins = await intent.getUtxos();
  if (coins.some((coin) => BigInt(coin.value) >= COLLATERAL)) break;
  if (attempt === 30) throw new Error("intent not indexed");
  await new Promise((resolve) => setTimeout(resolve, 4_000));
}

const row: QuoteRow = {
  rfqId: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
  collateral: COLLATERAL.toString(),
  premium: PREMIUM.toString(),
  kind: 0,
  strike: STRIKE.toString(),
  expiry,
  deadline,
  validUntil: now + 30,
  exit: Number(exit),
  writerPubkey: bytesToHex(writerPk),
  writerPkScript: bytesToHex(bound.writerPkScript),
  holderPubkey: bytesToHex(holderPk),
  beaconTxid: issueTxid,
  beaconGidx: 0,
  intentAddress: bound.intentAddress,
  vaultAddress: bound.vaultAddress,
  status: "open",
  createdAt: now,
  clientPubkey: bytesToHex(writerPk),
};
const filled = await fillQuote({
  client: deskClient,
  deskScript,
  row,
  now,
  ark: deskClient.arkProvider as RestArkProvider,
  termsFor: (item) => ({ ...shared, deadline: BigInt(item.deadline) }),
});
console.log("fill", filled.result, filled.txid ?? "");
if (filled.result !== "filled" || !filled.txid) throw new Error(`fill ${filled.result}`);

const sampleTime = expiry + 30;
await post(oracleService.url, "/api/samples", { price: PRICE.toString(), time: sampleTime });
const published = await post(oracleService.url, "/api/publish", { expiry });
console.log("published", published.txid, published.price);

const oracleStatus = await (await fetch(oracleService.url + "/api/status")).json();
const { parseOracleBeacon } = await import("../settle/oracle.ts");
const parsed = parseOracleBeacon(oracleStatus, issueTxid, 0);
if (!parsed.ok) throw new Error(parsed.error);
let settled: Awaited<ReturnType<typeof settleQuote>> | undefined;
for (let attempt = 1; attempt <= 15; attempt += 1) {
  settled = await settleQuote({
    chain: writerClient.indexer!,
    serverKey: writerClient.serverKey,
    emulatorKey: writerClient.emulatorKey,
    emulator: writerClient.emulator,
    checkpoint: writerClient.checkpoint,
    fillTxid: filled.txid,
    terms: { ...shared, deadline: BigInt(deadline) },
    beacon: parsed.beacon,
    now: Math.floor(Date.now() / 1000),
  });
  console.log("settled", attempt, JSON.stringify(settled, (_key, value) => typeof value === "bigint" ? value.toString() : value));
  if (settled.result === "settled") break;
  if (settled.result !== "unfixed" && settled.result !== "waiting") break;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
if (!settled || settled.result !== "settled") throw new Error(`settle ${settled?.result ?? "missing"}`);
process.exit(0);
