import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  arkade,
  asset,
  REGTEST_EMULATOR_PUBKEY,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  SingleKey,
} from "@arkade-os/sdk";

import { beaconIdOf } from "../protocol/beacon.ts";
import { fillQuote } from "../desk/fill.ts";
import type { QuoteRow } from "../desk/book.ts";
import { BEACON_READ_FEE, EXIT } from "../protocol/constants.ts";
import { assertServerExit, bindContracts, payoutVtxo } from "../protocol/contracts.ts";
import { bytesToHex } from "../protocol/hex.ts";
import { networkByName } from "../protocol/network.ts";
import { intentProgram, vaultProgram } from "../protocol/programs.ts";

/**
 * Option covenant on a local arkade-regtest stack (bitcoin regtest + arkd + emulator).
 *
 *   pnpm smoke:regtest
 *
 * Clones arkade-regtest if needed, starts it with `.env.regtest` (2048s exit, zero
 * intent fees), funds an intent from the seeded ark client, finalizes it, and
 * cancels a second intent after its deadline. Fails if those coins do not land.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PIN = "e639c8de978c7978944a3b7356a2060f91403036";
const ARK = process.env.ARK_URL?.trim() || "http://127.0.0.1:7070";
const EMULATOR = process.env.EMULATOR_URL?.trim() || "http://127.0.0.1:7073";
const PASSWORD = process.env.ARKD_PASSWORD?.trim() || "secret";

const collateral = 50_000n;
const premium = 1_000n;
const strike = 9_700_000n;

type Info = {
  network?: string;
  unilateralExitDelay?: string | number;
  fees?: {
    intentFee?: Record<string, string>;
    txFeeRate?: string;
  };
};

type Coin = { txid: string; vout: number; value: number };

test("option intent fills and cancels on local arkade regtest", async () => {
  const regtestDir = ensureCheckout();
  await ensureStack(regtestDir);

  const writer = SingleKey.fromHex("1".padStart(64, "0"));
  const desk = SingleKey.fromHex("2".padStart(64, "0"));
  const network = networkByName("regtest");
  const connect = (identity: SingleKey) => arkade.Arkade.connect({
    arkade: new RestArkProvider(ARK),
    indexer: new RestIndexerProvider(ARK),
    emulator: new RestEmulatorProvider(EMULATOR),
    identity,
    network,
  });
  const writerClient = await connect(writer);
  const deskClient = await connect(desk);
  assert.equal(bytesToHex(writerClient.emulatorKey!), REGTEST_EMULATOR_PUBKEY);
  await assertServerExit(ARK);

  const now = BigInt(Math.floor(Date.now() / 1000));
  const expiry = now + 86_400n;
  const writerPk = await writer.xOnlyPublicKey();
  const holderPk = await desk.xOnlyPublicKey();
  const beacon = beaconIdOf(asset.AssetId.create("11".repeat(32), 0));
  const shared = {
    kind: 0 as const,
    strike,
    collateral,
    premium,
    expiry,
    exit: EXIT,
    writerPk,
    holderPk,
    beacon,
    readFee: BEACON_READ_FEE,
    serverKey: writerClient.serverKey,
    emulatorKey: writerClient.emulatorKey!,
  };
  const fill = bindContracts({ ...shared, deadline: now + 3_600n });
  const cancel = bindContracts({ ...shared, deadline: now + 90n });
  const deskScript = payoutVtxo(holderPk, deskClient.serverKey, EXIT);
  const deskAddress = deskScript.address(network.hrp, deskClient.serverKey).encode();

  console.log("fill intent", fill.intentAddress);
  console.log("cancel intent", cancel.intentAddress);
  console.log("desk", deskAddress);

  arkSend(regtestDir, [
    { to: fill.intentAddress, amount: Number(collateral) },
    { to: cancel.intentAddress, amount: Number(collateral) },
    { to: deskAddress, amount: Number(premium) },
  ]);

  const indexer = new RestIndexerProvider(ARK);
  const fillIntent = deskClient.contract(intentProgram(), fill.intent);
  const cancelIntent = writerClient.contract(intentProgram(), cancel.intent);
  await waitFor(async () => (await fillIntent.getUtxos()).some((coin) => BigInt(coin.value) >= collateral), "fill intent");
  await waitFor(async () => (await cancelIntent.getUtxos()).some((coin) => BigInt(coin.value) >= collateral), "cancel intent");
  await waitFor(async () => (await scriptCoins(indexer, deskScript.pkScript)).some((coin) => BigInt(coin.value) >= premium), "desk float");

  const writerBefore = ids(await scriptCoins(indexer, fill.writerPkScript));
  const row = quoteRow(fill, now, Number(now + 3_600n), writerPk, holderPk);
  const filled = await fillQuote({
    client: deskClient,
    deskScript,
    row,
    now: Number(now),
    ark: deskClient.arkProvider as RestArkProvider,
    termsFor: () => ({ ...shared, deadline: now + 3_600n }),
  });
  console.log("finalize", filled.result, filled.txid ?? "");
  assert.equal(filled.result, "filled", `finalize ${filled.result}`);
  assert.match(filled.txid ?? "", /^[0-9a-f]{64}$/);

  const vault = deskClient.contract(vaultProgram(), fill.vault);
  await waitFor(async () => (await vault.getUtxos()).some((coin) => BigInt(coin.value) >= collateral), "vault");
  await waitFor(async () => fresh(await scriptCoins(indexer, fill.writerPkScript), writerBefore, premium), "premium");

  const cancelCoins = await cancelIntent.getUtxos();
  const cancelCoin = cancelCoins.find((coin) => BigInt(coin.value) >= collateral);
  assert.ok(cancelCoin, "cancel coin missing");
  const waitMs = Math.max(0, Number(cancel.intent.deadline) * 1000 - Date.now() + 2_000);
  if (waitMs > 0) {
    console.log(`cancel waits ${Math.ceil(waitMs / 1000)}s`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  const writerAtCancel = ids(await scriptCoins(indexer, cancel.writerPkScript));
  const sent = await writerClient.contract(intentProgram(), cancel.intent).functions
    .cancel()
    .from(cancelCoin)
    .to(cancel.writerPkScript, BigInt(cancelCoin.value))
    .send();
  console.log("cancel", sent.txid);
  assert.match(sent.txid, /^[0-9a-f]{64}$/);
  assert.notEqual(sent.txid, filled.txid);
  await waitFor(
    async () => fresh(await scriptCoins(indexer, cancel.writerPkScript), writerAtCancel, collateral),
    "cancel refund",
  );
});

function quoteRow(bound: ReturnType<typeof bindContracts>, now: bigint, deadline: number, writerPk: Uint8Array, holderPk: Uint8Array): QuoteRow {
  return {
    rfqId: "11".repeat(32),
    collateral: collateral.toString(),
    premium: premium.toString(),
    kind: 0,
    strike: strike.toString(),
    expiry: Number(now + 86_400n),
    deadline,
    validUntil: Number(now + 30n),
    exit: Number(EXIT),
    writerPubkey: bytesToHex(writerPk),
    writerPkScript: bytesToHex(bound.writerPkScript),
    holderPubkey: bytesToHex(holderPk),
    beaconTxid: "11".repeat(32),
    beaconGidx: 0,
    intentAddress: bound.intentAddress,
    vaultAddress: bound.vaultAddress,
    status: "open",
    createdAt: Number(now),
    clientPubkey: bytesToHex(writerPk),
  };
}

function ensureCheckout(): string {
  const dir = process.env.ARKADE_REGTEST_DIR?.trim() || path.join(ROOT, "arkade-regtest");
  if (existsSync(path.join(dir, "regtest.mjs"))) return dir;
  git(["init", dir]);
  git(["remote", "add", "origin", "https://github.com/ArkLabsHQ/arkade-regtest.git"], dir);
  git(["fetch", "--depth", "1", "origin", PIN], dir);
  git(["checkout", "--detach", "FETCH_HEAD"], dir);
  return dir;
}

async function ensureStack(regtestDir: string) {
  const docker = spawnSync("docker", ["info"], { encoding: "utf8" });
  if (docker.error || docker.status !== 0) {
    const detail = docker.error?.message || docker.stderr || docker.stdout;
    throw new Error(`docker is not usable, so arkade regtest cannot start: ${detail.trim()}`);
  }
  const info = await readInfo(ARK);
  const emulatorKey = await emulatorPubkey();
  if (info && !arkMatches(info)) {
    throw new Error(
      `arkd at ${ARK} is ${info.network ?? "unknown"} with unilateralExitDelay ${info.unilateralExitDelay}, not regtest/${EXIT}. `
      + `Stop that stack (cd arkade-regtest && node regtest.mjs clean) and rerun pnpm smoke:regtest.`,
    );
  }
  if (!arkMatches(info) || emulatorKey !== REGTEST_EMULATOR_PUBKEY) {
    console.log("starting arkade-regtest");
    const started = spawnSync("node", [
      "regtest.mjs", "start", "--profile", "emulator", "--env", path.join(ROOT, ".env.regtest"),
    ], { cwd: regtestDir, stdio: "inherit" });
    if (started.status !== 0) {
      throw new Error(`arkade-regtest start exited ${started.status}`);
    }
  }
  const ready = await readInfo(ARK);
  const readyKey = await emulatorPubkey();
  if (!arkMatches(ready)) {
    throw new Error(`arkd at ${ARK} did not come up as regtest with exit ${EXIT} and zero intent fees`);
  }
  if (readyKey !== REGTEST_EMULATOR_PUBKEY) {
    throw new Error(`emulator at ${EMULATOR} signer is ${readyKey ?? "down"}, expected ${REGTEST_EMULATOR_PUBKEY}`);
  }
  console.log("regtest", ARK, "emulator", EMULATOR, "exit", ready?.unilateralExitDelay);
}

function arkMatches(info: Info | null): boolean {
  if (!info || info.network !== "regtest") return false;
  if (BigInt(info.unilateralExitDelay ?? 0) !== EXIT) return false;
  const fee = info.fees?.intentFee ?? {};
  const values = [fee.offchainInput, fee.offchainOutput, fee.onchainInput, fee.onchainOutput, info.fees?.txFeeRate];
  return values.every((item) => item !== undefined && Number(item) === 0);
}

async function readInfo(url: string): Promise<Info | null> {
  try {
    const response = await fetch(`${url}/v1/info`);
    if (!response.ok) return null;
    return await response.json() as Info;
  } catch {
    return null;
  }
}

async function emulatorPubkey(): Promise<string | undefined> {
  const info = await readInfo(EMULATOR);
  const key = (info as { signerPubkey?: string } | null)?.signerPubkey;
  return key?.trim().toLowerCase();
}

function arkSend(regtestDir: string, receivers: { to: string; amount: number }[]) {
  const res = spawnSync("node", [
    "regtest.mjs", "ark", "send",
    "--receivers", JSON.stringify(receivers),
    "--password", PASSWORD,
  ], { cwd: regtestDir, encoding: "utf8" });
  const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
  if (res.status !== 0) throw new Error(`ark send failed (${res.status}): ${out}`);
  console.log("funded", out);
}

async function scriptCoins(indexer: RestIndexerProvider, script: Uint8Array): Promise<Coin[]> {
  const page = await indexer.getVtxos({ scripts: [bytesToHex(script)], spendableOnly: true });
  return page.vtxos ?? [];
}

function ids(coins: Coin[]): Set<string> {
  return new Set(coins.map((coin) => `${coin.txid}:${coin.vout}`));
}

function fresh(coins: Coin[], before: Set<string>, min: bigint): boolean {
  return coins.some((coin) => !before.has(`${coin.txid}:${coin.vout}`) && BigInt(coin.value) >= min);
}

async function waitFor(ready: () => Promise<boolean>, label: string) {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    if (await ready()) return;
    console.log(label, `not indexed yet (${attempt})`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`${label} was not indexed`);
}

function git(args: string[], cwd?: string) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(res.stderr || res.stdout || "").trim()}`);
  }
}
