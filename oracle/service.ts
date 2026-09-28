import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { schnorr } from "@noble/curves/secp256k1.js";
import { asset, ArkAddress, SingleKey, Transaction, type CSVMultisigTapscript, type EmulatorProvider } from "@arkade-os/sdk";
import { base64 } from "@scure/base";

import { fixing, oraclePreimage, sliceError, windows } from "../app/settle-math.js";
import { beaconIdOf, bindBeacon, decodeState, genesisOutputs, nextState, priceValue, publishDigest, statePacketOf } from "../protocol/beacon.ts";
import { EXIT, PRICE_MAX } from "../protocol/constants.ts";
import { buildAttest, submit, type AttestSlice } from "../protocol/cospend.ts";
import { bytesToHex, hexToBytes } from "../protocol/hex.ts";
import { loadStore, saveStore, type StoredPrint } from "./store.ts";

/**
 * Oracle desk. The process never stores a private key. ORACLE_KEY, when
 * configured, stays in memory and signs only sha256(ctrlTxid || nextState).
 */

const DOMAIN = new TextEncoder().encode("BTCUSD-FIX");
const THRESHOLD = 3n;
const KEY_LAG = 60n;
const READ_FEE = 100n;
// About a year of daily expiries at three prints each. The oldest print of that oracle goes first.
const PRINTS_PER_ORACLE = 1_000;
const CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; frame-ancestors 'none'";
const here = path.dirname(fileURLToPath(import.meta.url));

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type HeldCoin = {
  txid: string;
  vout: number;
  value: number | bigint;
  isSpent?: boolean;
  assets?: readonly { assetId: string; amount: bigint | number }[];
};

export type OracleWallet = {
  assetManager: {
    issue(params: { amount: bigint }): Promise<{ arkTxId: string; assetId: string }>;
  };
  getAddress(): Promise<string>;
  getVtxos(): Promise<HeldCoin[]>;
  buildAndSubmitOffchainTx(
    inputs: HeldCoin[],
    outputs: { script: Uint8Array; amount: bigint }[],
  ): Promise<{ arkTxid: string; signedCheckpointTxs: string[] }>;
  arkServerPublicKey: Uint8Array;
  serverUnrollScript: CSVMultisigTapscript.Type;
};

export type OracleIndexer = {
  getVtxos(opts: { scripts: string[]; spendableOnly?: boolean }): Promise<{ vtxos: HeldCoin[] }>;
  getVirtualTxs(txids: string[]): Promise<{ txs: string[] }>;
};

export type OracleDeps = {
  dataDir: string;
  port?: number;
  host?: string;
  adminToken?: string;
  oracleKey?: Uint8Array;
  emulatorKey: Uint8Array;
  wallet?: OracleWallet;
  indexer?: OracleIndexer;
  emulator?: Pick<EmulatorProvider, "submitTx">;
  now?: () => number;
};

function printHash(price: bigint, time: bigint): Uint8Array {
  return new Uint8Array(createHash("sha256").update(oraclePreimage(price, time)).digest());
}

function authorized(header: string | undefined, token: string): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const left = createHash("sha256").update(presented).digest();
  const right = createHash("sha256").update(token).digest();
  return timingSafeEqual(left, right);
}

function readBody(req: http.IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        if (!failed) {
          failed = true;
          req.pause();
          reject(new HttpError(413, "body too large"));
        }
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text) as unknown);
      } catch {
        reject(new HttpError(400, "json"));
      }
    });
    req.on("error", (err) => {
      if (!failed) reject(err);
    });
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "json");
  return value as Record<string, unknown>;
}

function exact(body: Record<string, unknown>, keys: readonly string[]) {
  const got = Object.keys(body);
  if (got.length !== keys.length || got.some((key) => !keys.includes(key))) throw new HttpError(400, "unknown field");
}

function whole(value: unknown, label: string): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
  throw new HttpError(400, label);
}

function hexField(value: unknown, bytes: number, label: string): string {
  const width = bytes * 2;
  if (typeof value !== "string" || !new RegExp(`^[0-9a-fA-F]{${width}}$`).test(value)) throw new HttpError(400, label);
  return value.toLowerCase();
}

function pickSlice(prints: readonly StoredPrint[], pubkeys: readonly string[], lo: bigint, hi: bigint): StoredPrint[] | null {
  const eligible = prints
    .filter((print) => {
      const time = BigInt(print.time);
      const price = BigInt(print.price);
      return time > 0n && price > 0n && price <= PRICE_MAX && time <= hi && time >= lo - 60n;
    })
    .sort((a, b) => a.time - b.time || a.pubkey.localeCompare(b.pubkey));
  const byIndex = new Map<number, StoredPrint[]>();
  for (const print of eligible) {
    const index = pubkeys.indexOf(print.pubkey);
    if (index < 0) continue;
    const list = byIndex.get(index) ?? [];
    list.push(print);
    byIndex.set(index, list);
  }
  const indexes = [...byIndex.keys()].sort((a, b) => a - b);
  for (let i = 0; i < indexes.length; i += 1) {
    for (let j = i + 1; j < indexes.length; j += 1) {
      for (let k = j + 1; k < indexes.length; k += 1) {
        const group = [indexes[i]!, indexes[j]!, indexes[k]!];
        for (const a of byIndex.get(group[0]!)!) {
          for (const b of byIndex.get(group[1]!)!) {
            for (const c of byIndex.get(group[2]!)!) {
              const chosen = [a, b, c];
              if (sliceError(chosen.map((print) => BigInt(print.time)), lo, hi) === null) return chosen;
            }
          }
        }
      }
    }
  }
  return null;
}

export async function createOracle(deps: OracleDeps) {
  if (deps.oracleKey && deps.oracleKey.length !== 32) throw new Error("ORACLE_KEY must be 32 bytes");
  if (deps.emulatorKey.length !== 33) throw new Error("emulator key must be 33 bytes");
  const adminPk = deps.oracleKey ? await SingleKey.fromHex(bytesToHex(deps.oracleKey)).xOnlyPublicKey() : null;
  const store = await loadStore(deps.dataDir);
  let publishing = false;
  const now = () => deps.now?.() ?? Math.floor(Date.now() / 1000);

  function requireAdmin(req: http.IncomingMessage) {
    if (!deps.adminToken) throw new HttpError(404, "disabled");
    if (!authorized(req.headers.authorization, deps.adminToken)) throw new HttpError(401, "unauthorized");
  }

  async function bound() {
    if (!store.pubkeys || !store.assetId || !deps.wallet || !adminPk) return null;
    const id = asset.AssetId.fromString(store.assetId);
    return bindBeacon({
      id: beaconIdOf(id),
      signers: store.pubkeys.map((pubkey) => hexToBytes(pubkey)),
      threshold: THRESHOLD,
      domain: DOMAIN,
      keyLag: KEY_LAG,
      readFee: READ_FEE,
      adminPk,
      exit: EXIT,
      serverKey: deps.wallet.arkServerPublicKey,
      emulatorKey: deps.emulatorKey,
    });
  }

  async function status() {
    const id = store.assetId ? asset.AssetId.fromString(store.assetId) : null;
    const beacon = id ? beaconIdOf(id) : null;
    const script = await bound();
    return {
      pubkeys: store.pubkeys,
      assetId: store.assetId,
      issueTxid: store.issueTxid,
      deployTxid: store.deployTxid,
      wallet: deps.wallet ? await deps.wallet.getAddress() : null,
      address: script?.address ?? null,
      args: {
        ctrlTxid: beacon ? bytesToHex(beacon.txid) : null,
        threshold: Number(THRESHOLD),
        domain: bytesToHex(DOMAIN),
        keyLag: Number(KEY_LAG),
        readFee: Number(READ_FEE),
        adminPk: adminPk ? bytesToHex(adminPk) : null,
        exit: Number(EXIT),
      },
      fixings: store.fixings,
      prints: store.prints,
    };
  }

  async function save() {
    await saveStore(deps.dataDir, store);
  }

  async function setKeys(body: Record<string, unknown>) {
    exact(body, ["pubkeys"]);
    if (store.deployTxid) throw new HttpError(409, "keys locked");
    if (store.pubkeys) throw new HttpError(409, "already set");
    if (!Array.isArray(body.pubkeys) || body.pubkeys.length !== 5) throw new HttpError(400, "five pubkeys");
    const pubkeys = body.pubkeys.map((item) => hexField(item, 32, "pubkey"));
    if (new Set(pubkeys).size !== 5) throw new HttpError(400, "duplicate pubkey");
    store.pubkeys = pubkeys;
    await save();
    return { pubkeys };
  }

  async function issue() {
    if (!store.pubkeys) throw new HttpError(400, "keys first");
    if (store.assetId) throw new HttpError(409, "already issued");
    if (!deps.wallet || !deps.oracleKey) throw new HttpError(400, "ORACLE_KEY is required");
    const issued = await deps.wallet.assetManager.issue({ amount: 1n });
    store.assetId = issued.assetId;
    store.issueTxid = issued.arkTxId;
    await save();
    return { assetId: issued.assetId, txid: issued.arkTxId };
  }

  async function deploy() {
    if (!store.pubkeys) throw new HttpError(400, "keys first");
    if (!store.assetId || !store.issueTxid) throw new HttpError(400, "issue first");
    if (store.deployTxid) throw new HttpError(409, "already deployed");
    if (!deps.wallet || !deps.oracleKey) throw new HttpError(400, "ORACLE_KEY is required");
    const script = await bound();
    if (!script) throw new HttpError(400, "ORACLE_KEY is required");
    const coins = await deps.wallet.getVtxos();
    const holding = coins.filter((coin) => !coin.isSpent && coin.assets?.some((item) => item.assetId === store.assetId && BigInt(item.amount) === 1n));
    if (holding.length !== 1) throw new HttpError(400, "issued coin");
    const coin = holding[0]!;
    const changeScript = ArkAddress.decode(await deps.wallet.getAddress()).pkScript;
    const outputs = genesisOutputs(coin, asset.AssetId.fromString(store.assetId), script.pkScript, changeScript);
    const submitted = await deps.wallet.buildAndSubmitOffchainTx([coin], outputs);
    store.deployTxid = submitted.arkTxid;
    await save();
    return { txid: submitted.arkTxid, address: script.address };
  }

  async function addPrint(body: Record<string, unknown>) {
    exact(body, ["pubkey", "price", "time", "sig"]);
    if (!store.deployTxid) throw new HttpError(409, "not deployed");
    if (!store.pubkeys) throw new HttpError(400, "keys first");
    const pubkey = hexField(body.pubkey, 32, "pubkey");
    if (!store.pubkeys.includes(pubkey)) throw new HttpError(400, "unknown pubkey");
    const price = whole(body.price, "price");
    const time = whole(body.time, "time");
    if (price <= 0n || price > PRICE_MAX) throw new HttpError(400, "price");
    if (time <= 0n) throw new HttpError(400, "time");
    if (!Number.isSafeInteger(Number(time))) throw new HttpError(400, "time");
    const stamp = Number(time);
    if (stamp > now()) throw new HttpError(400, "future timestamp");
    if (store.prints.some((print) => print.pubkey === pubkey && print.time === stamp)) throw new HttpError(409, "duplicate print");
    const sig = hexField(body.sig, 64, "sig");
    let ok = false;
    try {
      ok = schnorr.verify(hexToBytes(sig), printHash(price, time), hexToBytes(pubkey));
    } catch {
      ok = false;
    }
    if (!ok) throw new HttpError(400, "bad sig");
    store.prints.push({ pubkey, price: price.toString(), time: stamp, sig });
    const mine = store.prints.filter((item) => item.pubkey === pubkey);
    if (mine.length > PRINTS_PER_ORACLE) {
      const oldest = mine.reduce((a, b) => (a.time <= b.time ? a : b));
      store.prints.splice(store.prints.indexOf(oldest), 1);
    }
    await save();
    return { ok: true };
  }

  async function publish(body: Record<string, unknown>) {
    exact(body, ["expiry"]);
    if (!deps.oracleKey || !adminPk) throw new HttpError(400, "ORACLE_KEY is required");
    if (!store.deployTxid || !store.pubkeys || !store.assetId) throw new HttpError(409, "not deployed");
    if (publishing) throw new HttpError(409, "publish in progress");
    publishing = true;
    try {
      const expiry = whole(body.expiry, "expiry");
      if (expiry <= 1800n) throw new HttpError(400, "key");
      if (!Number.isSafeInteger(Number(expiry))) throw new HttpError(400, "expiry");
      const expiryN = Number(expiry);
      if (BigInt(now()) < expiry + KEY_LAG) throw new HttpError(400, "before key time");
      if (!deps.wallet || !deps.indexer || !deps.emulator) throw new HttpError(400, "indexer required");
      const script = await bound();
      if (!script) throw new HttpError(400, "ORACLE_KEY is required");
      const found = await deps.indexer.getVtxos({ scripts: [bytesToHex(script.pkScript)], spendableOnly: true });
      const coin = found.vtxos.find((vtxo) => vtxo.assets?.some((item) => item.assetId === store.assetId && BigInt(item.amount) === 1n));
      if (!coin) throw new HttpError(400, "beacon coin");
      const fetched = await deps.indexer.getVirtualTxs([coin.txid]);
      const prev = fetched.txs.map((raw) => Transaction.fromPSBT(base64.decode(raw))).find((tx) => tx.id === coin.txid);
      if (!prev) throw new HttpError(400, "creating tx missing");
      const state = statePacketOf(prev);
      if (decodeState(state).slots.some((slot) => slot.key === expiry)) throw new HttpError(409, "already a fixing");
      const names = ["open", "mid", "close"] as const;
      const bounds = windows(expiry);
      const chosen: StoredPrint[][] = [];
      for (const name of names) {
        const slice = pickSlice(store.prints, store.pubkeys, bounds[name][0], bounds[name][1]);
        if (!slice) throw new HttpError(400, `incomplete ${name}`);
        chosen.push(slice);
      }
      const slices = chosen.map((slice): AttestSlice => ({
        price: slice.map((print) => BigInt(print.price)),
        time: slice.map((print) => BigInt(print.time)),
        who: slice.map((print) => BigInt(store.pubkeys!.indexOf(print.pubkey))),
        sig: slice.map((print) => hexToBytes(print.sig)),
      }));
      const fixed = fixing(expiry, slices);
      if (fixed.error || fixed.twap == null) throw new HttpError(400, fixed.error ?? "twap");
      const next = nextState(state, expiry, priceValue(fixed.twap));
      const id = beaconIdOf(asset.AssetId.fromString(store.assetId));
      const opSig = await SingleKey.fromHex(bytesToHex(deps.oracleKey)).signSchnorrDeterministic(publishDigest(id.txid, next));
      const built = buildAttest({
        beacon: {
          script: script.script,
          coin: { txid: coin.txid, vout: coin.vout, value: coin.value, prevTx: prev.toBytes(true, true) },
          state,
          id: asset.AssetId.fromString(store.assetId),
        },
        key: expiry,
        slices: [slices[0]!, slices[1]!, slices[2]!],
        opSig,
        next,
        checkpoint: deps.wallet.serverUnrollScript,
      });
      const submitted = await submit(built, deps.emulator as EmulatorProvider);
      store.fixings.push({ expiry: expiryN, twap: fixed.twap.toString(), txid: submitted.txid });
      await save();
      return { txid: submitted.txid, expiry: expiryN, twap: fixed.twap.toString() };
    } finally {
      publishing = false;
    }
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = req.url?.split("?")[0] ?? "/";
    try {
      if (req.method === "GET" && url === "/") return sendFile(res, "index.html", "text/html; charset=utf-8");
      if (req.method === "GET" && url === "/page.js") return sendFile(res, "page.js", "text/javascript; charset=utf-8");
      if (req.method === "GET" && url === "/page.css") return sendFile(res, "page.css", "text/css; charset=utf-8");
      if (req.method === "GET" && url === "/api/status") return sendJson(res, 200, await status());
      if (req.method === "POST" && (url === "/api/keys" || url === "/api/issue" || url === "/api/deploy")) {
        requireAdmin(req);
        const body = asRecord(await readBody(req, 4096));
        if (url === "/api/keys") return sendJson(res, 200, await setKeys(body));
        exact(body, []);
        if (url === "/api/issue") return sendJson(res, 200, await issue());
        return sendJson(res, 200, await deploy());
      }
      if (req.method === "POST" && url === "/api/prints") {
        return sendJson(res, 200, await addPrint(asRecord(await readBody(req, 4096))));
      }
      if (req.method === "POST" && url === "/api/publish") {
        requireAdmin(req);
        return sendJson(res, 200, await publish(asRecord(await readBody(req, 4096))));
      }
      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      const statusCode = err instanceof HttpError ? err.status : 500;
      const message = err instanceof HttpError ? err.message : "error";
      if (!res.headersSent) sendJson(res, statusCode, { error: message });
      if (statusCode === 413) req.destroy();
    }
  }

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(deps.port ?? 0, deps.host ?? "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function send(res: http.ServerResponse, status: number, body: string | Buffer, type: string) {
  res.writeHead(status, {
    "content-type": type,
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  send(res, status, JSON.stringify(body), "application/json; charset=utf-8");
}

async function sendFile(res: http.ServerResponse, name: string, type: string) {
  try {
    send(res, 200, await readFile(path.join(here, name)), type);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") sendJson(res, 404, { error: "not found" });
    else throw err;
  }
}
