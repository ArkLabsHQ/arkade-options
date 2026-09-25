import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  arkade,
  DefaultVtxo,
  networks,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  SingleKey,
} from "@arkade-os/sdk";

import {
  ARK_URL,
  DEFAULT_RELAYS,
  EMULATOR_URL,
  EXIT,
  LOCK_S,
  PAIR,
  QUOTE_TTL_S,
} from "../protocol/constants.ts";
import { bindContracts, payoutVtxo, scriptHex, type Terms } from "../protocol/contracts.ts";
import { bytesToHex, hexToBytes } from "../protocol/hex.ts";
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
import { Book, type QuoteRow } from "./book.ts";
import { fillQuote } from "./fill.ts";
import { spotCents } from "./spot.ts";

/**
 * One process: Nostr RFQ, the quote book, and the fill loop.
 *
 *   DESK_KEY        32-byte hex. Nostr pubkey and the option holder key.
 *   RELAYS          comma-separated websocket URLs
 *   ARK_URL         default Mutinynet arkd
 *   EMULATOR_URL    default Mutinynet emulator
 *   DATA_DIR        quote book and oracle keys. Default ./data
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

async function oraclePubkeys(dir: string): Promise<Uint8Array[]> {
  const file = path.join(dir, "oracles.json");
  let hexes: string[] | undefined;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { keys?: unknown };
    if (!Array.isArray(parsed.keys) || !parsed.keys.every((item) => typeof item === "string")) {
      throw new Error("oracles.json needs a keys array");
    }
    hexes = parsed.keys;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (!hexes) {
    hexes = Array.from({ length: 5 }, () => SingleKey.fromRandomBytes().toHex());
    await writeFile(file, JSON.stringify({ keys: hexes }, null, 2));
  }
  if (hexes.length !== 5) throw new Error("oracles.json needs five keys");
  return Promise.all(hexes.map((hex) => SingleKey.fromHex(hex).xOnlyPublicKey()));
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
const oracles = await oraclePubkeys(dataDir);
const client = await arkade.Arkade.connect({
  arkade: new RestArkProvider(arkUrl),
  indexer: new RestIndexerProvider(arkUrl),
  emulator: new RestEmulatorProvider(emulatorUrl),
  identity,
  network: networks.mutinynet,
});
if (!client.emulatorKey) throw new Error("emulator key missing");

const holderPk = await identity.xOnlyPublicKey();
const deskScript: DefaultVtxo.Script = payoutVtxo(holderPk, client.serverKey, EXIT);
const address = deskScript.address(networks.mutinynet.hrp, client.serverKey).encode();
const pubkey = nostrPubkey(secret);

let balance = 0n;
let spot: { cents: bigint; sources: string[] } | null = null;
let polling = false;

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
    holderPk: hexToBytes(row.holderPubkey),
    oraclePks: row.oraclePubkeys.map((item) => hexToBytes(item)),
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
      holder_pk_script: scriptHex(bound.holderPkScript),
      oracle_pubkeys: row.oraclePubkeys,
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
  if (existing && existing.clientPubkey === from && existing.deadline > now) {
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
  const dust = premiumRefusal(sats);
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
    oraclePubkeys: oracles.map((item) => bytesToHex(item)),
    intentAddress: "",
    vaultAddress: "",
    status: "open",
    createdAt: now,
    clientPubkey: from,
  };
  const bound = bindContracts(termsFor(row));
  if (scriptHex(bound.writerPkScript) !== message.profile.writer_pk_script) {
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

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    try {
      spot = await spotCents();
    } catch (err) {
      console.error("spot", err instanceof Error ? err.message : err);
    }
    if (client.indexer) {
      try {
        const page = await client.indexer.getVtxos({
          scripts: [bytesToHex(deskScript.pkScript)],
          spendableOnly: true,
        });
        balance = page.vtxos.reduce((sum, coin) => sum + BigInt(coin.value), 0n);
      } catch (err) {
        console.error("balance", err instanceof Error ? err.message : err);
      }
    }
    for (const row of book.list()) {
      if (row.status !== "open") continue;
      try {
        const outcome = await fillQuote({ client, termsFor, deskScript, row, now });
        if (outcome.result === "filled") {
          book.mark(row.rfqId, "filled", outcome.txid);
          await book.save();
          console.log("filled", row.rfqId, outcome.txid ?? "vault");
        } else if (outcome.result === "expired") {
          book.mark(row.rfqId, "expired");
          await book.save();
        } else if (outcome.result === "short") {
          console.error("float short", row.rfqId);
        }
      } catch (err) {
        console.error("fill", row.rfqId, err instanceof Error ? err.message : err);
      }
    }
  } finally {
    polling = false;
  }
}

function statusBody() {
  return JSON.stringify({
    pubkey,
    address,
    balance: balance.toString(),
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
  console.log(`desk ${pubkey}`);
  console.log(`address ${address}`);
  console.log(`status http://127.0.0.1:${port}/status`);
});

const timer = setInterval(() => {
  void poll();
}, 2_000);
void poll();

function shutdown() {
  clearInterval(timer);
  transport.close();
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
