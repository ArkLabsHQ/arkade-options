import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { schnorr } from "@noble/curves/secp256k1.js";
import { ArkAddress, asset, CSVMultisigTapscript, Extension, networks, SingleKey, Transaction } from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";

import { oraclePreimage } from "../app/settle-math.js";
import { beaconIdOf, bindBeacon, genesisState, nextState, priceValue, publishDigest, statePacketOf } from "../protocol/beacon.ts";
import { EXIT } from "../protocol/constants.ts";
import { statePacket } from "../protocol/cospend.ts";
import { bytesToHex } from "../protocol/hex.ts";
import { createOracle, type HeldCoin, type OracleDeps, type OracleWallet } from "./service.ts";

const CHECKPOINT_HEX = "03080040b27520dfcaec558c7e78cf3e38b898ba8a43cfb5727266bae32c5c5b3aeb32c558aa0bac";

spawnSync("pnpm", ["-s", "oracle:page"], { cwd: path.resolve(import.meta.dirname, ".."), stdio: "inherit" });

function secret(byte: number): Uint8Array {
  return Uint8Array.from(hex.decode(byte.toString(16).padStart(2, "0").repeat(32)));
}

function signed(byte: number, price: bigint, time: bigint) {
  const key = secret(byte);
  const msg = createHash("sha256").update(oraclePreimage(price, time)).digest();
  return {
    pubkey: hex.encode(schnorr.getPublicKey(key)),
    price: price.toString(),
    time: Number(time),
    sig: hex.encode(schnorr.sign(msg, key)),
  };
}

async function boot(extra: Partial<OracleDeps> & { adminToken?: string } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "oracle-"));
  const serverKey = await SingleKey.fromHex(hex.encode(secret(1))).xOnlyPublicKey();
  const emulatorKey = await SingleKey.fromHex(hex.encode(secret(2))).compressedPublicKey();
  const recorded: { outputs?: { script: Uint8Array; amount: bigint }[]; issue?: { amount: bigint } } = {};
  let assetId = "";
  const issueTxid = "ee".repeat(32);
  const other = asset.AssetId.create("ab".repeat(32), 1);
  const wallet: OracleWallet = {
    assetManager: {
      async issue(params) {
        recorded.issue = params;
        assetId = asset.AssetId.create(issueTxid, 0).toString();
        return { arkTxId: issueTxid, assetId };
      },
    },
    async getAddress() {
      return new ArkAddress(serverKey, new Uint8Array(32).fill(4), networks.mutinynet.hrp).encode();
    },
    async getVtxos() {
      const coin: HeldCoin = {
        txid: issueTxid,
        vout: 0,
        value: 10_000,
        assets: [
          { assetId, amount: 1n },
          { assetId: other.toString(), amount: 5n },
        ],
      };
      return [coin];
    },
    async buildAndSubmitOffchainTx(_inputs, outputs) {
      recorded.outputs = outputs;
      return { arkTxid: "dd".repeat(32), signedCheckpointTxs: [] };
    },
    arkServerPublicKey: serverKey,
    serverUnrollScript: CSVMultisigTapscript.decode(hex.decode(CHECKPOINT_HEX)),
  };
  let creating: Transaction | undefined;
  const submitted: string[] = [];
  const oracle = await createOracle({
    dataDir: dir,
    adminToken: "test-token",
    oracleKey: secret(9),
    emulatorKey,
    wallet,
    indexer: {
      async getVtxos(opts) {
        const script = hex.decode(opts.scripts[0]!);
        const last = submitted.at(-1);
        if (last) {
          creating = Transaction.fromPSBT(base64.decode(last));
        } else {
          creating = new Transaction({ version: 3, allowUnknownOutputs: true });
          creating.addInput({ txid: new Uint8Array(32).fill(8), index: 1 });
          creating.addOutput({ script, amount: 330n });
          creating.addOutput(Extension.create([statePacket(genesisState())]).txOut());
        }
        const dust = { txid: "11".repeat(32), vout: 0, value: 1 };
        return { vtxos: [dust, { txid: creating.id, vout: 0, value: 330, assets: [{ assetId, amount: 1n }] }] };
      },
      async getVirtualTxs(txids) {
        if (!creating || txids[0] !== creating.id) return { txs: [] };
        return { txs: [base64.encode(creating.toPSBT())] };
      },
    },
    emulator: {
      async submitTx(arkTx) {
        submitted.push(arkTx);
        return { signedArkTx: arkTx };
      },
    },
    now: () => 1_700_000_000 + 60,
    ...extra,
  });
  return { oracle, dir, recorded, submitted, serverKey, emulatorKey, other, wallet, close: async () => { await oracle.close(); await rm(dir, { recursive: true, force: true }); } };
}

async function call(url: string, pathName: string, body?: unknown, token?: string) {
  const res = await fetch(url + pathName, {
    method: body === undefined && pathName.startsWith("/api/") && pathName !== "/api/status" ? "POST" : body === undefined ? "GET" : "POST",
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) as Record<string, unknown> : {}, text };
}

test("status, admin order, deploy change, and a print that becomes a fixing", async () => {
  const ctx = await boot();
  try {
    const home = await fetch(ctx.oracle.url + "/");
    assert.equal(home.headers.get("content-security-policy"), "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; frame-ancestors 'none'");
    assert.equal(home.headers.get("access-control-allow-origin"), null);
    const html = await home.text();
    assert.match(html, /src="\/page\.js"/);
    assert.doesNotMatch(html, /<script(?![^>]*src=)/);
    assert.equal((await fetch(ctx.oracle.url + "/page.js")).status, 200);
    assert.equal((await fetch(ctx.oracle.url + "/page.css")).status, 200);

    const open = await call(ctx.oracle.url, "/api/status");
    assert.equal(open.status, 200);
    assert.equal(JSON.stringify(open.json).includes(hex.encode(secret(9))), false);
    assert.equal((open.json.args as { threshold: number }).threshold, 3);
    assert.equal((open.json.args as { domain: string }).domain, hex.encode(new TextEncoder().encode("BTCUSD-FIX")));
    assert.equal((open.json.args as { keyLag: number }).keyLag, 60);
    assert.equal((open.json.args as { readFee: number }).readFee, 100);
    assert.equal((open.json.args as { exit: number }).exit, 2048);
    assert.equal((open.json.args as { adminPk: string }).adminPk, hex.encode(schnorr.getPublicKey(secret(9))));
    assert.match(String(open.json.wallet), /^tark1/);
    assert.equal(open.json.balance, "10000");

    assert.equal((await call(ctx.oracle.url, "/api/issue", {}, "nope")).status, 401);
    assert.equal((await call(ctx.oracle.url, "/api/issue", {})).status, 401);
    assert.equal((await call(ctx.oracle.url, "/api/issue", {}, "test-token")).status, 400);

    const pubkeys = [11, 12, 13, 14, 15].map((byte) => hex.encode(schnorr.getPublicKey(secret(byte))));
    assert.equal((await call(ctx.oracle.url, "/api/keys", { pubkeys }, "test-token")).status, 200);
    assert.equal((await call(ctx.oracle.url, "/api/keys", { pubkeys }, "test-token")).status, 409);
    assert.equal((await call(ctx.oracle.url, "/api/deploy", {}, "test-token")).status, 400);

    const issued = await call(ctx.oracle.url, "/api/issue", {}, "test-token");
    assert.equal(issued.status, 200);
    assert.deepEqual(ctx.recorded.issue, { amount: 1n });
    assert.equal((await call(ctx.oracle.url, "/api/issue", {}, "test-token")).status, 409);

    const earlyPrint = signed(11, 10_000_000n, 1_700_000_000n - 1780n);
    assert.equal((await call(ctx.oracle.url, "/api/prints", earlyPrint)).status, 409);

    const deployed = await call(ctx.oracle.url, "/api/deploy", {}, "test-token");
    assert.equal(deployed.status, 200);
    assert.equal((await call(ctx.oracle.url, "/api/keys", { pubkeys }, "test-token")).status, 409);
    const outputs = ctx.recorded.outputs!;
    assert.equal(outputs[0]!.amount, 330n);
    assert.equal(outputs[1]!.amount, 9_670n);
    const groups = Extension.fromBytes(outputs[2]!.script).getAssetPacket()!.groups;
    assert.equal(groups[0]!.outputs[0]!.vout, 0);
    assert.equal(groups[1]!.outputs[0]!.vout, 1);
    assert.equal(groups[1]!.assetId!.toString(), ctx.other.toString());

    const status = await call(ctx.oracle.url, "/api/status");
    assert.equal(status.json.issueTxid, "ee".repeat(32));
    assert.equal((status.json.args as { ctrlTxid: string }).ctrlTxid, bytesToHex(beaconIdOf(asset.AssetId.create("ee".repeat(32), 0)).txid));
    const bound = bindBeacon({
      id: beaconIdOf(asset.AssetId.create("ee".repeat(32), 0)),
      signers: pubkeys.map((item) => hex.decode(item)),
      threshold: 3n,
      domain: new TextEncoder().encode("BTCUSD-FIX"),
      keyLag: 60n,
      readFee: 100n,
      adminPk: schnorr.getPublicKey(secret(9)),
      exit: EXIT,
      serverKey: ctx.serverKey,
      emulatorKey: ctx.emulatorKey,
    });
    assert.equal(status.json.address, bound.address);

    assert.equal((await call(ctx.oracle.url, "/api/prints", { ...earlyPrint, extra: 1 })).status, 400);
    assert.equal((await call(ctx.oracle.url, "/api/prints", { ...earlyPrint, time: 1_700_000_000 + 120 })).status, 400);
    assert.equal((await call(ctx.oracle.url, "/api/prints", { ...earlyPrint, pubkey: "00".repeat(32) })).status, 400);
    const bad = { ...earlyPrint, sig: "11".repeat(64) };
    assert.equal((await call(ctx.oracle.url, "/api/prints", bad)).status, 400);
    const huge = await fetch(ctx.oracle.url + "/api/prints", { method: "POST", body: "x".repeat(5000), headers: { "content-type": "application/json" } });
    assert.equal(huge.status, 413);

    const expiry = 1_700_000_000n;
    const prints = [
      ...[0, 1, 2].map((i) => signed(11 + i, 10_000_000n, expiry - 1780n + BigInt(i))),
      ...[0, 1, 2].map((i) => signed(12 + i, 10_000_000n, expiry - 940n + BigInt(i))),
      ...[0, 1, 2].map((i) => signed(13 + i, 10_000_000n, expiry + 10n + BigInt(i))),
    ];
    for (const print of prints) assert.equal((await call(ctx.oracle.url, "/api/prints", print)).status, 200);
    assert.equal((await call(ctx.oracle.url, "/api/prints", prints[0]!)).status, 409);

    const disabled = await boot({ adminToken: undefined, now: () => Number(expiry + 60n) });
    assert.equal((await call(disabled.oracle.url, "/api/keys", { pubkeys }, "test-token")).status, 404);
    await disabled.close();

    assert.equal((await call(ctx.oracle.url, "/api/publish", { expiry: Number(expiry) })).status, 401);
    const incomplete = await call(ctx.oracle.url, "/api/publish", { expiry: Number(expiry - 86_400n) }, "test-token");
    assert.equal(incomplete.status, 400);
    const tooSoon = await createOracle({
      dataDir: ctx.dir,
      adminToken: "test-token",
      oracleKey: secret(9),
      emulatorKey: ctx.emulatorKey,
      now: () => Number(expiry + 59n),
    });
    const early = await call(tooSoon.url, "/api/publish", { expiry: Number(expiry) }, "test-token");
    assert.equal(early.status, 400);
    await tooSoon.close();

    const published = await call(ctx.oracle.url, "/api/publish", { expiry: Number(expiry) }, "test-token");
    assert.equal(published.status, 200, JSON.stringify(published.json));
    assert.equal(published.json.twap, "10000000");
    assert.equal(ctx.submitted.length, 1);
    const again = await call(ctx.oracle.url, "/api/publish", { expiry: Number(expiry) }, "test-token");
    assert.equal(again.status, 409);
    const after = await call(ctx.oracle.url, "/api/status");
    assert.deepEqual(after.json.fixings, [{ expiry: Number(expiry), twap: "10000000", txid: published.json.txid }]);
    const tx = Transaction.fromPSBT(base64.decode(ctx.submitted[0]!));
    const next = nextState(genesisState(), expiry, priceValue(10_000_000n));
    assert.deepEqual(statePacketOf(tx), next);
    const witness = Extension.fromTx(tx).getEmulatorPacket()!.entries[0]!.witness!;
    assert.equal(witness[0], 38);
    assert.equal(witness[1], 64);
    const op = publishDigest(beaconIdOf(asset.AssetId.create("ee".repeat(32), 0)).txid, next);
    assert.equal(schnorr.verify(witness.subarray(2, 66), op, schnorr.getPublicKey(secret(9))), true);
  } finally {
    await ctx.close();
  }
});

test("issue refuses an empty wallet with fund wallet", async () => {
  const ctx = await boot();
  ctx.wallet.getVtxos = async () => [];
  try {
    const pubkeys = [11, 12, 13, 14, 15].map((byte) => hex.encode(schnorr.getPublicKey(secret(byte))));
    assert.equal((await call(ctx.oracle.url, "/api/keys", { pubkeys }, "test-token")).status, 200);
    const status = await call(ctx.oracle.url, "/api/status");
    assert.equal(status.json.balance, "0");
    const issued = await call(ctx.oracle.url, "/api/issue", {}, "test-token");
    assert.equal(issued.status, 400);
    assert.equal(issued.json.error, "fund wallet");
  } finally {
    await ctx.close();
  }
});

test("recover finalizes pending and can adopt an issued unit", async () => {
  const ctx = await boot();
  const finalized: string[] = [];
  let state: { settings?: { hasPendingTx?: boolean } } | null = null;
  const issuedId = asset.AssetId.create("ee".repeat(32), 0).toString();
  ctx.wallet.walletRepository = {
    async getWalletState() {
      return state;
    },
    async saveWalletState(next) {
      state = next;
    },
  };
  ctx.wallet.finalizePendingTxs = async () => {
    finalized.push("aa".repeat(32));
    return { finalized: ["aa".repeat(32)], pending: ["aa".repeat(32)] };
  };
  ctx.wallet.getVtxos = async () => [
    { txid: "ee".repeat(32), vout: 0, value: 10_000, assets: [{ assetId: issuedId, amount: 1n }] },
  ];
  try {
    const first = await call(ctx.oracle.url, "/api/recover", {}, "test-token");
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.deepEqual(finalized, ["aa".repeat(32)]);
    assert.equal(state?.settings?.hasPendingTx, true);
    assert.equal((first.json.adopted as { txid: string }).txid, "ee".repeat(32));
    const status = await call(ctx.oracle.url, "/api/status");
    assert.equal(status.json.issueTxid, "ee".repeat(32));
    assert.equal(status.json.assetId, issuedId);
  } finally {
    await ctx.close();
  }
});
