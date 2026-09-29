import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { asset, ArkAddress, SingleKey, Transaction, type CSVMultisigTapscript, type EmulatorProvider } from "@arkade-os/sdk";
import { base64 } from "@scure/base";

import { beaconIdOf, bindBeacon, decodeState, genesisOutputs, nextState, priceValue, sampleDigest, statePacketOf } from "../protocol/beacon.ts";
import { BEACON_READ_FEE, EXIT, PRICE_MAX } from "../protocol/constants.ts";
import { buildAttest, submit } from "../protocol/cospend.ts";
import { bytesToHex } from "../protocol/hex.ts";
import { loadStore, saveStore, type StoredSample } from "./store.ts";

/**
 * One-key oracle. ORACLE_KEY stays in memory. It signs each BTCUSD sample and
 * publishes the stored sample for an expiry. The secret is never on a request.
 */

const DOMAIN = new TextEncoder().encode("BTCUSD-FIX");
const KEY_LAG = 60n;
const READ_FEE = BEACON_READ_FEE;
const SAMPLE_CAP = 20_000;
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
  finalizePendingTxs?(vtxos?: HeldCoin[]): Promise<{ finalized: string[]; pending: string[] }>;
  walletRepository?: {
    getWalletState(): Promise<{ settings?: { hasPendingTx?: boolean } } | null>;
    saveWalletState(state: { settings?: { hasPendingTx?: boolean } }): Promise<void>;
  };
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
  /** BTCUSD in cents. The sampler stores one sample per call. */
  quote?: () => Promise<bigint | null>;
  /** How often to sample. Unset means the process only records prices it is given. */
  sampleEveryMs?: number;
  now?: () => number;
};

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
    if (!store.assetId || !deps.wallet || !adminPk) return null;
    const id = asset.AssetId.fromString(store.assetId);
    return bindBeacon({
      id: beaconIdOf(id),
      domain: DOMAIN,
      keyLag: KEY_LAG,
      readFee: READ_FEE,
      adminPk,
      exit: EXIT,
      serverKey: deps.wallet.arkServerPublicKey,
      emulatorKey: deps.emulatorKey,
    });
  }

  async function walletBalance(): Promise<bigint | null> {
    if (!deps.wallet) return null;
    const coins = await deps.wallet.getVtxos();
    return coins.filter((coin) => !coin.isSpent).reduce((sum, coin) => sum + BigInt(coin.value), 0n);
  }

  async function status() {
    const id = store.assetId ? asset.AssetId.fromString(store.assetId) : null;
    const beacon = id ? beaconIdOf(id) : null;
    const script = await bound();
    const balance = await walletBalance();
    const latest = store.samples.reduce<StoredSample | null>((best, sample) => (!best || sample.time >= best.time ? sample : best), null);
    return {
      assetId: store.assetId,
      issueTxid: store.issueTxid,
      deployTxid: store.deployTxid,
      wallet: deps.wallet ? await deps.wallet.getAddress() : null,
      balance: balance == null ? null : balance.toString(),
      address: script?.address ?? null,
      args: {
        ctrlTxid: beacon ? bytesToHex(beacon.txid) : null,
        domain: bytesToHex(DOMAIN),
        keyLag: Number(KEY_LAG),
        readFee: Number(READ_FEE),
        adminPk: adminPk ? bytesToHex(adminPk) : null,
        exit: Number(EXIT),
      },
      fixings: store.fixings,
      samples: store.samples.length,
      latest,
    };
  }

  async function save() {
    await saveStore(deps.dataDir, store);
  }

  function asHttp(err: unknown, fallback: string): HttpError {
    if (err instanceof HttpError) return err;
    const message = err instanceof Error ? err.message : fallback;
    if (/insufficient funds/i.test(message)) return new HttpError(400, "fund wallet");
    return new HttpError(500, message.slice(0, 200) || fallback);
  }

  async function markPending() {
    const repo = deps.wallet?.walletRepository;
    if (!repo) return;
    const state = (await repo.getWalletState()) ?? {};
    await repo.saveWalletState({
      ...state,
      settings: { ...state.settings, hasPendingTx: true },
    });
  }

  /** Finish submitTx that never got finalizeTx, and adopt an issued unit if the store is empty. */
  async function recover() {
    if (!deps.wallet?.finalizePendingTxs) throw new HttpError(400, "wallet required");
    await markPending();
    let finalized: string[] = [];
    let pending: string[] = [];
    try {
      ({ finalized, pending } = await deps.wallet.finalizePendingTxs());
    } catch (err) {
      throw asHttp(err, "recover failed");
    }
    let adopted: { assetId: string; txid: string } | null = null;
    if (!store.assetId) {
      const coins = await deps.wallet.getVtxos();
      for (const coin of coins.filter((item) => !item.isSpent)) {
        const unit = coin.assets?.find((item) => BigInt(item.amount) === 1n && typeof item.assetId === "string" && item.assetId.length >= 64);
        if (!unit) continue;
        try {
          const id = asset.AssetId.fromString(unit.assetId);
          store.assetId = unit.assetId;
          store.issueTxid = bytesToHex(id.txid);
          await save();
          adopted = { assetId: store.assetId, txid: store.issueTxid };
          break;
        } catch {
          // skip unparseable asset ids
        }
      }
    }
    return { finalized, pending, adopted, balance: (await walletBalance())?.toString() ?? null };
  }

  async function issue() {
    if (store.assetId) throw new HttpError(409, "already issued");
    if (!deps.wallet || !deps.oracleKey) throw new HttpError(400, "ORACLE_KEY is required");
    if (deps.wallet.finalizePendingTxs) {
      try {
        const recovered = await recover();
        if (store.assetId) return { assetId: store.assetId, txid: store.issueTxid!, recovered };
      } catch {
        // continue to a fresh issue when nothing is pending
      }
    }
    const balance = await walletBalance();
    if (balance == null || balance < 330n) throw new HttpError(400, "fund wallet");
    let issued: { assetId: string; arkTxId: string };
    try {
      await markPending();
      issued = await deps.wallet.assetManager.issue({ amount: 1n });
    } catch (err) {
      if (deps.wallet.finalizePendingTxs) {
        try {
          const recovered = await recover();
          if (store.assetId) return { assetId: store.assetId, txid: store.issueTxid!, recovered };
        } catch {
          // keep the original issue error
        }
      }
      throw asHttp(err, "issue failed");
    }
    store.assetId = issued.assetId;
    store.issueTxid = issued.arkTxId;
    await save();
    return { assetId: issued.assetId, txid: issued.arkTxId };
  }

  async function deploy() {
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

  async function recordSample(price: bigint, stamp: number) {
    if (!deps.oracleKey || !adminPk) throw new HttpError(400, "ORACLE_KEY is required");
    if (!store.assetId) throw new HttpError(409, "not issued");
    if (price <= 0n || price > PRICE_MAX) throw new HttpError(400, "price");
    if (!Number.isSafeInteger(stamp) || stamp <= 0) throw new HttpError(400, "time");
    if (stamp > now()) throw new HttpError(400, "future timestamp");
    if (store.samples.some((sample) => sample.time === stamp)) return { ok: true, time: stamp, price: price.toString(), duplicate: true };
    const id = beaconIdOf(asset.AssetId.fromString(store.assetId));
    const sig = bytesToHex(await SingleKey.fromHex(bytesToHex(deps.oracleKey)).signSchnorrDeterministic(sampleDigest(id.txid, price, BigInt(stamp))));
    store.samples.push({ price: price.toString(), time: stamp, sig });
    if (store.samples.length > SAMPLE_CAP) store.samples.splice(0, store.samples.length - SAMPLE_CAP);
    await save();
    return { ok: true, time: stamp, price: price.toString() };
  }

  function chooseSample(expiry: number): StoredSample | null {
    const hi = expiry + Number(KEY_LAG);
    const close = store.samples.filter((sample) => sample.time >= expiry && sample.time <= hi);
    const pool = close.length > 0 ? close : store.samples.filter((sample) => sample.time > 0 && sample.time <= hi);
    if (!pool.length) return null;
    return pool.reduce((best, sample) => (sample.time >= best.time ? sample : best));
  }

  function pricePage(query: URLSearchParams) {
    const from = Number(query.get("from") ?? "0");
    const to = Number(query.get("to") ?? String(now()));
    const limit = Math.min(200, Math.max(1, Number(query.get("limit") ?? "50") || 50));
    const rows = store.samples
      .filter((sample) => sample.time >= from && sample.time <= to)
      .sort((a, b) => b.time - a.time)
      .slice(0, limit);
    return { samples: rows };
  }

  async function publish(body: Record<string, unknown>) {
    exact(body, ["expiry"]);
    if (!deps.oracleKey || !adminPk) throw new HttpError(400, "ORACLE_KEY is required");
    if (!store.deployTxid || !store.assetId) throw new HttpError(409, "not deployed");
    if (publishing) throw new HttpError(409, "publish in progress");
    publishing = true;
    try {
      const expiry = whole(body.expiry, "expiry");
      if (expiry <= 1800n) throw new HttpError(400, "key");
      if (!Number.isSafeInteger(Number(expiry))) throw new HttpError(400, "expiry");
      const expiryN = Number(expiry);
      if (BigInt(now()) < expiry + KEY_LAG) throw new HttpError(400, "before key time");
      const sample = chooseSample(expiryN);
      if (!sample) throw new HttpError(400, "no sample");
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
      const price = BigInt(sample.price);
      const time = BigInt(sample.time);
      const id = beaconIdOf(asset.AssetId.fromString(store.assetId));
      const sig = await SingleKey.fromHex(bytesToHex(deps.oracleKey)).signSchnorrDeterministic(sampleDigest(id.txid, price, time));
      const next = nextState(state, expiry, priceValue(price));
      const built = buildAttest({
        beacon: {
          script: script.script,
          coin: { txid: coin.txid, vout: coin.vout, value: coin.value, prevTx: prev.toBytes(true, true) },
          state,
          id: asset.AssetId.fromString(store.assetId),
        },
        key: expiry,
        price,
        time,
        sig,
        next,
        checkpoint: deps.wallet.serverUnrollScript,
      });
      const submitted = await submit(built, deps.emulator as EmulatorProvider);
      store.fixings.push({ expiry: expiryN, price: price.toString(), txid: submitted.txid });
      await save();
      return { txid: submitted.txid, expiry: expiryN, price: price.toString(), time: sample.time };
    } finally {
      publishing = false;
    }
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const parsed = new URL(req.url ?? "/", "http://oracle");
    const url = parsed.pathname;
    try {
      if (req.method === "GET" && url === "/") return sendFile(res, "index.html", "text/html; charset=utf-8");
      if (req.method === "GET" && url === "/page.js") return sendFile(res, "page.js", "text/javascript; charset=utf-8");
      if (req.method === "GET" && url === "/page.css") return sendFile(res, "page.css", "text/css; charset=utf-8");
      if (req.method === "GET" && url === "/api/status") return sendJson(res, 200, await status());
      if (req.method === "GET" && url === "/api/prices") return sendJson(res, 200, pricePage(parsed.searchParams));
      if (req.method === "POST" && (url === "/api/issue" || url === "/api/deploy" || url === "/api/recover" || url === "/api/samples")) {
        requireAdmin(req);
        const body = asRecord(await readBody(req, 4096));
        if (url === "/api/samples") {
          exact(body, ["price"]);
          return sendJson(res, 200, await recordSample(whole(body.price, "price"), now()));
        }
        exact(body, []);
        if (url === "/api/issue") return sendJson(res, 200, await issue());
        if (url === "/api/recover") return sendJson(res, 200, await recover());
        return sendJson(res, 200, await deploy());
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
  const timer = deps.sampleEveryMs && deps.sampleEveryMs > 0
    ? setInterval(() => {
        void (async () => {
          if (!deps.quote || !store.assetId) return;
          const price = await deps.quote();
          if (price == null) return;
          await recordSample(price, now());
        })().catch((err) => {
          console.error("oracle sample", err instanceof Error ? err.message : err);
        });
      }, deps.sampleEveryMs)
    : undefined;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => {
      if (timer) clearInterval(timer);
      server.close((err) => (err ? reject(err) : resolve()));
    }),
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
