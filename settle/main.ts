import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";

import {
  arkade,
  networks,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  SingleKey,
} from "@arkade-os/sdk";

import { ARK_URL, EMULATOR_URL, EXIT } from "../protocol/constants.ts";
import { bindContracts, payoutVtxo } from "../protocol/contracts.ts";
import { bytesToHex } from "../protocol/hex.ts";
import { fetchOracleStatus, parseOracleBeacon, serviceOrigin } from "./oracle.ts";
import { duePositions, positionsFromDesk, termsFor, type WatchPosition } from "./positions.ts";
import { Progress } from "./progress.ts";
import { settleQuote } from "./vault.ts";

/**
 * A third party. It watches desks for filled vaults and settles them after
 * expiry by reading the oracle. It does not quote, fill, or hold the book.
 *
 *   DESKS        comma-separated desk origins. Each is polled at /status.
 *   ORACLE_URL   oracle origin. The beacon script comes from /api/status.
 *   SETTLE_KEY   optional 32-byte hex. Signs the read-fee coin when readFee > 0.
 *   ARK_URL      default Mutinynet arkd
 *   EMULATOR_URL default Mutinynet emulator
 *   DATA_DIR     progress.json. Default ./data
 *   PORT         status HTTP. Default 8790
 */

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function origins(name: string): string[] {
  const values = required(name).split(",").map((item) => item.trim()).filter(Boolean);
  if (!values.length) throw new Error(`${name} is required`);
  return values.map(serviceOrigin);
}

const desks = origins("DESKS");
const oracleUrl = serviceOrigin(required("ORACLE_URL"));
const settleKey = process.env.SETTLE_KEY?.trim() ?? "";
if (settleKey && !/^[0-9a-fA-F]{64}$/.test(settleKey)) throw new Error("SETTLE_KEY must be 32 bytes");
const dataDir = process.env.DATA_DIR?.trim() || "data";
const port = Number(process.env.PORT ?? "8790");
const arkUrl = process.env.ARK_URL?.trim() || ARK_URL;
const emulatorUrl = process.env.EMULATOR_URL?.trim() || EMULATOR_URL;
if (!Number.isInteger(port) || port < 1) throw new Error("PORT");

const identity = settleKey ? SingleKey.fromHex(settleKey) : undefined;
const progress = await Progress.open(dataDir);
const indexer = new RestIndexerProvider(arkUrl);
const client = await arkade.Arkade.connect({
  arkade: new RestArkProvider(arkUrl),
  indexer,
  emulator: new RestEmulatorProvider(emulatorUrl),
  identity,
  network: networks.mutinynet,
});
if (!client.emulatorKey || !client.emulator) throw new Error("emulator missing");

const holderPk = identity ? await identity.xOnlyPublicKey() : undefined;
const feeScript = holderPk ? payoutVtxo(holderPk, client.serverKey, EXIT) : undefined;

let polling = false;
let watching = 0;
const noted = new Set<string>();

function once(key: string, line: string, error = false) {
  if (noted.has(key)) return;
  noted.add(key);
  if (error) console.error(line);
  else console.log(line);
}

function revision(): string {
  const baked = process.env.GIT_COMMIT?.trim();
  if (baked) return baked;
  try {
    const file = readFileSync("/etc/git-commit", "utf8").trim();
    if (file) return file;
  } catch {
    // Local `pnpm settle` has no image revision.
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

async function feeCoins() {
  if (!feeScript || !client.indexer) return [];
  const page = await client.indexer.getVtxos({
    scripts: [bytesToHex(feeScript.pkScript)],
    spendableOnly: true,
  });
  return page.vtxos ?? [];
}

async function deskPositions(origin: string): Promise<WatchPosition[]> {
  const res = await fetch(`${origin}/status`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`desk status ${res.status}`);
  return positionsFromDesk(await res.json(), origin);
}

/**
 * One settle per pass. Desks share one beacon coin, so the next vault has to
 * read the outpoint the previous settle created.
 */
async function progressDue() {
  const now = Math.floor(Date.now() / 1000);
  const positions: WatchPosition[] = [];
  for (const origin of desks) {
    try {
      positions.push(...await deskPositions(origin));
      noted.delete(`desk:${origin}`);
    } catch (err) {
      once(`desk:${origin}`, `desk ${origin} ${err instanceof Error ? err.message : err}`, true);
    }
  }
  watching = positions.length;
  const due = duePositions(positions, now, progress.ids());
  if (!due.length) return;

  let parsed;
  try {
    parsed = parseOracleBeacon(await fetchOracleStatus(oracleUrl, AbortSignal.timeout(10_000)));
  } catch (err) {
    once("oracle-fetch", `oracle ${err instanceof Error ? err.message : err}`, true);
    return;
  }
  if (!parsed.ok) {
    once(`oracle-parse:${parsed.error}`, `oracle ${parsed.error}`, true);
    return;
  }
  noted.delete("oracle-fetch");

  const coins = parsed.beacon.readFee > 0n ? await feeCoins() : [];
  for (const position of due) {
    const terms = termsFor(position, client.serverKey, client.emulatorKey!);
    if (bindContracts(terms).vaultAddress !== position.vaultAddress) {
      once(`addr:${position.id}`, `skip ${position.rfqId} vault address`, true);
      continue;
    }
    try {
      const outcome = await settleQuote({
        chain: client.indexer!,
        serverKey: client.serverKey,
        emulatorKey: client.emulatorKey!,
        emulator: client.emulator!,
        checkpoint: client.checkpoint,
        identity,
        fillTxid: position.fillTxid,
        terms,
        beacon: parsed.beacon,
        now,
        feeCoins: coins,
        feeScript,
      });
      if (outcome.result === "settled") {
        progress.note(position.id, outcome.txid);
        try {
          await progress.save();
        } catch (err) {
          console.error("progress save", position.rfqId, err instanceof Error ? err.message : err);
        }
        console.log("settled", position.rfqId, outcome.txid);
        return;
      }
      if (outcome.result === "short") {
        once("fee", "read fee coin missing", true);
        return;
      }
      if (outcome.result === "mismatch") {
        once(`mismatch:${position.id}`, `skip ${position.rfqId} beacon mismatch`, true);
        continue;
      }
      if (outcome.result === "unfixed") {
        once(`unfixed:${position.id}`, `waiting ${position.rfqId} no fixing`);
        continue;
      }
      if (outcome.reason === "beacon") {
        once("beacon-coin", "waiting beacon coin");
        return;
      }
      once(`wait:${position.id}:${outcome.reason}`, `waiting ${position.rfqId} ${outcome.reason}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      once(`err:${position.id}:${message}`, `settle ${position.rfqId} ${message}`, true);
      return;
    }
  }
}

async function tick() {
  if (polling) return;
  polling = true;
  try {
    await progressDue();
  } finally {
    polling = false;
  }
}

const server = http.createServer((req, res) => {
  const url = req.url?.split("?")[0];
  if (url !== "/" && url !== "/status") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify({
    commit: revision(),
    oracle: oracleUrl,
    desks,
    watching,
    settled: [...progress.ids()].length,
  }));
});

server.listen(port, () => {
  console.log(`commit ${revision()}`);
  console.log(`oracle ${oracleUrl}`);
  for (const desk of desks) console.log(`desk ${desk}`);
  console.log(`status http://127.0.0.1:${port}/status`);
});

const timer = setInterval(() => {
  void tick();
}, 2_000);
void tick();

function shutdown() {
  clearInterval(timer);
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
