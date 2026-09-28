import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";

import {
  arkade,
  asset,
  ContractManager,
  DefaultVtxo,
  networks,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  SingleKey,
} from "@arkade-os/sdk";

import { beaconIdOf } from "../protocol/beacon-id.ts";
import {
  ARK_URL,
  DEFAULT_RELAYS,
  EMULATOR_URL,
  EXIT,
  LOCK_S,
  PAIR,
  QUOTE_TTL_S,
} from "../protocol/constants.ts";
import { assertServerExit, bindContracts, directPayoutKey, payoutVtxo, type Terms } from "../protocol/contracts.ts";
import { bytesToHex, hexToBytes } from "../protocol/hex.ts";
import { intentProgram } from "../protocol/programs.ts";
import {
  premiumRefusal,
  requestRefusal,
  type RfqQuote,
  type RfqRequest,
  type RfqStatus,
} from "../protocol/messages.ts";
import { connectTransport, nostrPubkey, type Incoming } from "../protocol/nostr.ts";
import { deribitPremium, fetchSurface, surfaceStatus } from "../protocol/deribit.ts";
import { premiumSats } from "../protocol/pricing.ts";
import { openSqliteStorage } from "../protocol/sqlite-storage.ts";
import { Book, hasBeacon, type QuoteRow } from "./book.ts";
import { fillQuote } from "./fill.ts";
import { spotCents } from "./spot.ts";

/**
 * One process: Nostr RFQ, the quote book, and fills from the contract manager.
 *
 *   DESK_KEY        32-byte hex. Nostr pubkey and the option holder key.
 *   BEACON_TXID     required 64-hex display txid of the oracle's identity asset
 *   BEACON_GIDX     optional vout index of that asset. Default 0
 *   RELAYS          comma-separated websocket URLs
 *   ARK_URL         default Mutinynet arkd
 *   EMULATOR_URL    default Mutinynet emulator
 *   DATA_DIR        quote book. Default ./data
 *   PORT            status HTTP. Default 8788
 *   DESK_STRIKE_CAP per-strike collateral cap in sats. Default 1 BTC
 *   DESK_TOTAL_CAP  total collateral cap in sats. Default 5 BTC
 *   DESK_VOL        optional vol override. Default is the Deribit mark.
 */

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function bigintEnv(name: string, fallback: bigint): bigint {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  return BigInt(raw);
}

const deskKeyHex = required("DESK_KEY");
const secret = hexToBytes(deskKeyHex);
if (secret.length !== 32) throw new Error("DESK_KEY must be 32 bytes");

const dataDir = process.env.DATA_DIR?.trim() || "data";
const port = Number(process.env.PORT ?? "8788");
const arkUrl = process.env.ARK_URL?.trim() || ARK_URL;
const emulatorUrl = process.env.EMULATOR_URL?.trim() || EMULATOR_URL;
const relays = (process.env.RELAYS ?? DEFAULT_RELAYS.join(",")).split(",").map((item) => item.trim()).filter(Boolean);
const caps = {
  perStrike: bigintEnv("DESK_STRIKE_CAP", 100_000_000n),
  total: bigintEnv("DESK_TOTAL_CAP", 500_000_000n),
};
const volOverride = process.env.DESK_VOL?.trim() ? Number(process.env.DESK_VOL) : null;
if (volOverride != null && !(volOverride > 0 && volOverride < 5)) {
  throw new Error("DESK_VOL must be a vol between 0 and 5");
}
if (!Number.isInteger(port) || port < 1) throw new Error("PORT");

const identity = SingleKey.fromHex(deskKeyHex);
const book = await Book.open(dataDir);
const storage = await openSqliteStorage(dataDir);
const beaconDisplay = beaconFromEnv();
const indexer = new RestIndexerProvider(arkUrl);
if (typeof EventSource === "undefined") {
  throw new Error("Contract events need Node's EventSource. Start the desk with --experimental-eventsource.");
}
const contractManager = await ContractManager.create({
  indexerProvider: indexer,
  contractRepository: storage.contractRepository,
  walletRepository: storage.walletRepository,
  vtxoSyncMaxAgeMs: 60_000,
});
const client = await arkade.Arkade.connect({
  arkade: new RestArkProvider(arkUrl),
  indexer,
  emulator: new RestEmulatorProvider(emulatorUrl),
  identity,
  contractManager,
  network: networks.mutinynet,
});
if (!client.emulatorKey) throw new Error("emulator key missing");
await assertServerExit(arkUrl);

const holderPk = await identity.xOnlyPublicKey();
const deskScript: DefaultVtxo.Script = payoutVtxo(holderPk, client.serverKey, EXIT);
const address = deskScript.address(networks.mutinynet.hrp, client.serverKey).encode();
const pubkey = nostrPubkey(secret);

let balance = 0n;
let spot: { cents: bigint; sources: string[] } | null = null;
let polling = false;

function beaconFromEnv() {
  const txid = (process.env.BEACON_TXID ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txid)) {
    throw new Error("BEACON_TXID must be the 64-hex display txid of the identity asset");
  }
  const gidx = (process.env.BEACON_GIDX ?? "0").trim();
  if (!/^\d+$/.test(gidx) || Number(gidx) > 65_535) throw new Error("BEACON_GIDX must be an integer from 0 to 65535");
  return { txid, gidx: Number(gidx) };
}

function termsFor(row: QuoteRow): Terms {
  return {
    kind: row.kind,
    strike: BigInt(row.strike),
    collateral: BigInt(row.collateral),
    premium: BigInt(row.premium),
    expiry: BigInt(row.expiry),
    deadline: BigInt(row.deadline),
    exit: BigInt(row.exit),
    writerPk: hexToBytes(row.writerPubkey),
    payoutKey: directPayoutKey(row.writerPubkey, row.writerPkScript),
    holderPk: hexToBytes(row.holderPubkey),
    beacon: beaconIdOf(asset.AssetId.create(row.beaconTxid, row.beaconGidx)),
    serverKey: client.serverKey,
    emulatorKey: client.emulatorKey!,
  };
}

function quoteMessage(row: QuoteRow): RfqQuote {
  const bound = bindContracts(termsFor(row));
  return {
    v: 1,
    type: "rfq_quote",
    rfq_id: row.rfqId,
    pair: PAIR,
    from_amount: row.collateral,
    to_amount: row.premium,
    solver_pubkey: row.holderPubkey,
    valid_until: row.validUntil,
    profile: {
      holder_pubkey: row.holderPubkey,
      holder_pk_script: bytesToHex(bound.holderPkScript),
      beacon_txid: row.beaconTxid,
      beacon_gidx: row.beaconGidx,
      deadline: row.deadline,
      exit: row.exit,
      intent_address: row.intentAddress,
      vault_address: row.vaultAddress,
    },
  };
}

async function refuse(to: string, rfqId: string, reason: string) {
  await transport.publish(to, { v: 1, type: "rfq_refusal", rfq_id: rfqId, reason });
}

async function onRequest(message: RfqRequest, from: string) {
  const now = Math.floor(Date.now() / 1000);
  const existing = book.get(message.rfq_id);
  // Only replay open quotes. Expired (register-fail) and filled rows must not
  // block a retry while the old deadline is still in the future.
  if (existing && existing.status === "open" && existing.clientPubkey === from && existing.deadline > now) {
    await transport.publish(from, quoteMessage(existing));
    return;
  }
  const bad = requestRefusal(message, now);
  if (bad) {
    await refuse(from, message.rfq_id, bad);
    return;
  }
  let tick;
  try {
    tick = await spotCents();
    spot = tick;
  } catch {
    await refuse(from, message.rfq_id, "spot unavailable");
    return;
  }
  let sats: bigint;
  if (volOverride != null) {
    const years = (message.profile.expiry - now) / (365 * 24 * 60 * 60);
    sats = premiumSats({
      kind: message.profile.kind,
      spotCents: Number(tick.cents),
      strikeCents: message.profile.strike,
      years,
      collateralSats: BigInt(message.amount),
      vol: volOverride,
    }).sats;
  } else {
    let points;
    try {
      points = await fetchSurface();
    } catch {
      await refuse(from, message.rfq_id, "deribit unavailable");
      return;
    }
    const priced = deribitPremium({
      kind: message.profile.kind,
      strikeUsd: message.profile.strike / 100,
      expiry: message.profile.expiry,
      now,
      collateralSats: BigInt(message.amount),
      spotUsd: Number(tick.cents) / 100,
      points,
    });
    if (!priced) {
      await refuse(from, message.rfq_id, "deribit unavailable");
      return;
    }
    sats = priced.sats;
  }
  const dust = premiumRefusal(sats, BigInt(message.amount));
  if (dust) {
    await refuse(from, message.rfq_id, dust);
    return;
  }
  const deadline = now + LOCK_S;
  const row: QuoteRow = {
    rfqId: message.rfq_id,
    collateral: message.amount,
    premium: sats.toString(),
    kind: message.profile.kind,
    strike: String(message.profile.strike),
    expiry: message.profile.expiry,
    deadline,
    validUntil: now + QUOTE_TTL_S,
    exit: Number(EXIT),
    writerPubkey: message.profile.writer_pubkey,
    writerPkScript: message.profile.writer_pk_script,
    holderPubkey: bytesToHex(holderPk),
    beaconTxid: beaconDisplay.txid,
    beaconGidx: beaconDisplay.gidx,
    intentAddress: "",
    vaultAddress: "",
    status: "open",
    createdAt: now,
    clientPubkey: from,
  };
  const bound = bindContracts(termsFor(row));
  if (bytesToHex(bound.writerPkScript) !== message.profile.writer_pk_script) {
    await refuse(from, message.rfq_id, "writer script");
    return;
  }
  row.intentAddress = bound.intentAddress;
  row.vaultAddress = bound.vaultAddress;
  if (!book.hold(row, caps, now)) {
    await refuse(from, message.rfq_id, "exposure");
    return;
  }
  await book.save();
  try {
    await track(row);
  } catch (err) {
    console.error("register", row.rfqId, err instanceof Error ? err.message : err);
    book.mark(row.rfqId, "expired");
    await book.save();
    await refuse(from, message.rfq_id, "register");
    return;
  }
  await transport.publish(from, quoteMessage(row));
  console.log("quote", row.rfqId, row.premium, row.intentAddress);
}

async function onStatus(rfqId: string, from: string) {
  const row = book.get(rfqId);
  const message: RfqStatus = row
    ? {
      v: 1,
      type: "rfq_status",
      rfq_id: rfqId,
      status: row.status,
      ...(row.fillTxid ? { txid: row.fillTxid } : {}),
    }
    : { v: 1, type: "rfq_status", rfq_id: rfqId, status: "expired" };
  await transport.publish(from, message);
}

async function onMessage({ from, message }: Incoming) {
  try {
    if (message.type === "rfq_request") await onRequest(message, from);
    else if (message.type === "rfq_status_request") await onStatus(message.rfq_id, from);
  } catch (err) {
    console.error("rfq", err);
  }
}

const transport = connectTransport({ relays, secretKey: secret, onMessage });

type FloatCoin = { txid: string; vout: number; value: number };

const deskScriptHex = bytesToHex(deskScript.pkScript);
// ponytail: script→quote only. Scan for the reverse; add quote→script if the open book gets large.
const quoteByScript = new Map<string, string>();
const deskCoins = new Map<string, FloatCoin>();
const queued = new Set<string>();
// ponytail: one fill at a time. Per-quote locks if two quotes must settle together.
let filling = false;

function recount() {
  balance = [...deskCoins.values()].reduce((sum, coin) => sum + BigInt(coin.value), 0n);
}

function rememberDesk(event: { type: string; vtxos: FloatCoin[] }) {
  if (event.type === "vtxo_received") {
    for (const coin of event.vtxos) deskCoins.set(`${coin.txid}:${coin.vout}`, coin);
  } else if (event.type === "vtxo_spent") {
    for (const coin of event.vtxos) deskCoins.delete(`${coin.txid}:${coin.vout}`);
  }
  recount();
}

function tracked(rfqId: string): boolean {
  for (const id of quoteByScript.values()) if (id === rfqId) return true;
  return false;
}

function forgetScript(rfqId: string) {
  for (const [script, id] of quoteByScript) {
    if (id === rfqId) quoteByScript.delete(script);
  }
}

async function track(row: QuoteRow) {
  const bound = bindContracts(termsFor(row));
  const intent = client.contract(intentProgram(), bound.intent);
  const script = bytesToHex(intent.pkScript);
  if (quoteByScript.get(script) === row.rfqId) return;
  await intent.register({ label: row.rfqId });
  quoteByScript.set(script, row.rfqId);
}

function queueFill(rfqId: string) {
  queued.add(rfqId);
  void pump();
}

async function pump() {
  if (filling) return;
  filling = true;
  try {
    while (queued.size) {
      const rfqId = queued.values().next().value;
      if (!rfqId) break;
      queued.delete(rfqId);
      const row = book.get(rfqId);
      if (!row) continue;
      const unsettled = row.status === "open" || (row.status === "filled" && !row.fillTxid);
      if (!unsettled) continue;
      const now = Math.floor(Date.now() / 1000);
      try {
        const outcome = await fillQuote({
          client,
          termsFor,
          deskScript,
          row,
          now,
          float: [...deskCoins.values()],
        });
        if (outcome.result === "filled") {
          for (const coin of outcome.spent ?? []) deskCoins.delete(`${coin.txid}:${coin.vout}`);
          recount();
          book.mark(row.rfqId, "filled", outcome.txid);
          forgetScript(row.rfqId);
          try {
            await book.save();
          } catch (err) {
            console.error("book save", row.rfqId, err instanceof Error ? err.message : err);
            // Keep status filled but drop the txid so housekeeping retries save / recovery.
            const stuck = book.get(row.rfqId);
            if (stuck) delete stuck.fillTxid;
          }
          console.log("filled", row.rfqId, outcome.txid ?? "");
        } else if (outcome.result === "expired") {
          book.mark(row.rfqId, "expired");
          forgetScript(row.rfqId);
          await book.save();
        } else if (outcome.result === "short") {
          console.error("float short", row.rfqId);
        }
      } catch (err) {
        console.error("fill", row.rfqId, err instanceof Error ? err.message : err);
      }
    }
  } finally {
    filling = false;
    if (queued.size) void pump();
  }
}

async function housekeeping() {
  if (polling) return;
  polling = true;
  try {
    try {
      spot = await spotCents();
    } catch (err) {
      console.error("spot", err instanceof Error ? err.message : err);
    }
    let dropped = 0;
    for (const row of book.list()) {
      const unsettled = row.status === "open" || (row.status === "filled" && !row.fillTxid);
      if (!unsettled) continue;
      if (!hasBeacon(row)) {
        row.status = "expired";
        forgetScript(row.rfqId);
        dropped += 1;
        continue;
      }
      if (!tracked(row.rfqId)) {
        try {
          await track(row);
        } catch (err) {
          console.error("register", row.rfqId, err instanceof Error ? err.message : err);
          continue;
        }
      }
      // Poll unsettled quotes: EventSource can miss a coin; recovery needs another look after a crash.
      queueFill(row.rfqId);
    }
    if (dropped) {
      await book.save();
      console.log("dropped", dropped, "quotes with no beacon");
    }
  } finally {
    polling = false;
  }
}

function queueOpenFills() {
  for (const row of book.list()) {
    if (row.status === "open" || (row.status === "filled" && !row.fillTxid)) queueFill(row.rfqId);
  }
}

contractManager.onContractEvent((event) => {
  if (event.type !== "vtxo_received" && event.type !== "vtxo_spent") return;
  if (event.contractScript === deskScriptHex) {
    rememberDesk(event);
    queueOpenFills();
    return;
  }
  const rfqId = quoteByScript.get(event.contractScript);
  if (rfqId) queueFill(rfqId);
});
await contractManager.watchScript(deskScriptHex, { label: "desk" });

function revision(): string {
  const baked = process.env.GIT_COMMIT?.trim();
  if (baked) return baked;
  try {
    const file = readFileSync("/etc/git-commit", "utf8").trim();
    if (file) return file;
  } catch {
    // Local `pnpm desk` has no image revision.
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function statusBody() {
  return JSON.stringify({
    commit: revision(),
    pubkey,
    address,
    balance: balance.toString(),
    beaconTxid: beaconDisplay.txid,
    beaconGidx: beaconDisplay.gidx,
    spotCents: spot ? spot.cents.toString() : null,
    spotSources: spot?.sources ?? [],
    pricing: volOverride != null
      ? { source: "override", vol: volOverride }
      : { source: "deribit", ...surfaceStatus() },
    quotes: book.list().map((row) => ({
      rfqId: row.rfqId,
      status: row.status,
      collateral: row.collateral,
      premium: row.premium,
      strike: row.strike,
      expiry: row.expiry,
      deadline: row.deadline,
      intentAddress: row.intentAddress,
      vaultAddress: row.vaultAddress,
      fillTxid: row.fillTxid ?? null,
    })),
  });
}

const server = http.createServer((req, res) => {
  const url = req.url?.split("?")[0];
  if (url !== "/" && url !== "/status") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(statusBody());
});

server.listen(port, () => {
  console.log(`commit ${revision()}`);
  console.log(`desk ${pubkey}`);
  console.log(`address ${address}`);
  console.log(`beacon ${beaconDisplay.txid}:${beaconDisplay.gidx}`);
  console.log(`status http://127.0.0.1:${port}/status`);
});

const timer = setInterval(() => {
  void housekeeping();
}, 2_000);
void housekeeping();

function shutdown() {
  clearInterval(timer);
  contractManager.dispose();
  transport.close();
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
