import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ArkAddress,
  asset,
  CSVMultisigTapscript,
  Extension,
  networks,
  SingleKey,
  Transaction,
} from "@arkade-os/sdk";
import { base64 } from "@scure/base";

import { holderPayoff, settlementOutputs } from "../app/settle-math.js";
import { beaconIdOf, bindBeacon, genesisState } from "../protocol/beacon.ts";
import { BEACON_READ_FEE, EXIT } from "../protocol/constants.ts";
import { bindContracts } from "../protocol/contracts.ts";
import { statePacket } from "../protocol/cospend.ts";
import { bytesToHex } from "../protocol/hex.ts";
import { createOracle, type HeldCoin, type OracleWallet } from "../oracle/service.ts";
import { settleQuote } from "../settle/vault.ts";

/**
 * One simulated round trip: issue a one-signer beacon, store a price, publish
 * the fixing, and settle the vault. The price is chosen here. No exchange is called.
 *
 *   pnpm roundtrip
 *
 * This runs the oracle service and the settler against an in-memory chain.
 * The Arkade Mutinynet faucet has no vtxos to dispense, so the same steps are
 * not broadcast yet.
 */

const CHECKPOINT_HEX = "03080040b27520dfcaec558c7e78cf3e38b898ba8a43cfb5727266bae32c5c5b3aeb32c558aa0bac";
const EXPIRY = 1_700_000_000;
const NOW = EXPIRY + 120;
const SAMPLE_TIME = EXPIRY + 30;
const PRICE = 10_000_000n;
const STRIKE = 9_700_000n;
const COLLATERAL = 20_000n;
const ADMIN = "test-token";

function secret(byte: number): Uint8Array {
  return Uint8Array.from(Buffer.from(byte.toString(16).padStart(2, "0").repeat(32), "hex"));
}

export type RoundtripReport = {
  mode: "rehearsal";
  price: string;
  sampleTime: number;
  expiry: number;
  publishTxid: string;
  settleTxid: string;
  holder: string;
  writer: string;
  beacon: string;
  readFee: string;
};

export async function rehearseRoundtrip(): Promise<RoundtripReport> {
  const dir = await mkdtemp(path.join(tmpdir(), "roundtrip-"));
  const serverKey = await SingleKey.fromHex(Buffer.from(secret(1)).toString("hex")).xOnlyPublicKey();
  const emulatorKey = await SingleKey.fromHex(Buffer.from(secret(2)).toString("hex")).compressedPublicKey();
  const oracleSecret = secret(9);
  const adminPk = await SingleKey.fromHex(Buffer.from(oracleSecret).toString("hex")).xOnlyPublicKey();
  const writerPk = await SingleKey.fromHex(Buffer.from(secret(21)).toString("hex")).xOnlyPublicKey();
  const holderPk = await SingleKey.fromHex(Buffer.from(secret(22)).toString("hex")).xOnlyPublicKey();
  const recorded: { outputs?: { script: Uint8Array; amount: bigint }[] } = {};
  let assetId = "";
  const issueTxid = "ee".repeat(32);
  const submitted: string[] = [];
  let creating: Transaction | undefined;

  const wallet: OracleWallet = {
    assetManager: {
      async issue(params) {
        if (params.amount !== 1n) throw new Error("identity amount");
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
        assets: [{ assetId, amount: 1n }],
      };
      return [coin];
    },
    async buildAndSubmitOffchainTx(_inputs, outputs) {
      recorded.outputs = outputs;
      return { arkTxid: "dd".repeat(32), signedCheckpointTxs: [] };
    },
    arkServerPublicKey: serverKey,
    serverUnrollScript: CSVMultisigTapscript.decode(Buffer.from(CHECKPOINT_HEX, "hex")),
  };

  const oracle = await createOracle({
    dataDir: dir,
    adminToken: ADMIN,
    oracleKey: oracleSecret,
    emulatorKey,
    wallet,
    indexer: {
      async getVtxos(opts) {
        const script = Buffer.from(opts.scripts[0]!, "hex");
        const last = submitted.at(-1);
        if (last) creating = Transaction.fromPSBT(base64.decode(last));
        else {
          creating = new Transaction({ version: 3, allowUnknownOutputs: true });
          creating.addInput({ txid: new Uint8Array(32).fill(8), index: 1 });
          creating.addOutput({ script, amount: 330n });
          creating.addOutput(Extension.create([statePacket(genesisState())]).txOut());
        }
        return { vtxos: [{ txid: creating.id, vout: 0, value: Number(creating.getOutput(0)?.amount ?? 330), assets: [{ assetId, amount: 1n }] }] };
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
    now: () => NOW,
  });

  try {
    const call = async (pathName: string, body?: unknown) => {
      const res = await fetch(oracle.url + pathName, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` },
        body: JSON.stringify(body ?? {}),
      });
      const json = await res.json() as Record<string, unknown>;
      if (!res.ok) throw new Error(`${pathName} ${res.status} ${json.error ?? ""}`);
      return json;
    };

    const issued = await call("/api/issue");
    const deployed = await call("/api/deploy");
    if (!recorded.outputs?.[0] || recorded.outputs[0].amount !== 330n) throw new Error("deploy output");
    const beaconTxid = String(issued.txid);
    const sampled = await call("/api/samples", { price: PRICE.toString(), time: SAMPLE_TIME });
    if (sampled.time !== SAMPLE_TIME) throw new Error("sample time");
    const published = await call("/api/publish", { expiry: EXPIRY });

    const id = beaconIdOf(asset.AssetId.create(beaconTxid, 0));
    const beacon = bindBeacon({
      id,
      signers: [adminPk],
      threshold: 1n,
      domain: new TextEncoder().encode("BTCUSD-FIX"),
      keyLag: 60n,
      readFee: BEACON_READ_FEE,
      adminPk,
      exit: EXIT,
      serverKey,
      emulatorKey,
    });
    const terms = {
      kind: 0 as const,
      strike: STRIKE,
      collateral: COLLATERAL,
      premium: 1_000n,
      expiry: BigInt(EXPIRY),
      deadline: BigInt(EXPIRY),
      exit: EXIT,
      writerPk,
      holderPk,
      beacon: id,
      readFee: BEACON_READ_FEE,
      serverKey,
      emulatorKey,
    };
    const bound = bindContracts(terms);
    const vaultTx = new Transaction({ version: 3, allowUnknownOutputs: true });
    vaultTx.addInput({ txid: new Uint8Array(32).fill(3), index: 0 });
    vaultTx.addOutput({ script: bound.vaultPkScript, amount: COLLATERAL });
    const attestRaw = submitted.at(-1);
    if (!attestRaw) throw new Error("beacon coin");
    const beaconCoinTx = Transaction.fromPSBT(base64.decode(attestRaw));

    const chain = {
      async getVtxos(opts: { scripts?: string[]; spendableOnly?: boolean }) {
        const scripts = new Set(opts.scripts ?? []);
        const rows = [];
        if (scripts.has(bytesToHex(bound.vaultPkScript))) {
          rows.push({ txid: vaultTx.id, vout: 0, value: Number(COLLATERAL), script: bytesToHex(bound.vaultPkScript) });
        }
        if (scripts.has(bytesToHex(beacon.pkScript))) {
          rows.push({
            txid: beaconCoinTx.id,
            vout: 0,
            value: Number(beaconCoinTx.getOutput(0)?.amount ?? 330),
            script: bytesToHex(beacon.pkScript),
            assets: [{ assetId: asset.AssetId.create(beaconTxid, 0).toString(), amount: 1n }],
          });
        }
        return { vtxos: rows };
      },
      async getVirtualTxs(txids: string[]) {
        return {
          txs: txids.map((id) => {
            if (id === vaultTx.id) return base64.encode(vaultTx.toPSBT());
            if (id === beaconCoinTx.id) return base64.encode(beaconCoinTx.toPSBT());
            return "";
          }),
        };
      },
    };

    const settled = await settleQuote({
      chain,
      serverKey,
      emulatorKey,
      emulator: { async submitTx(arkTx) { submitted.push(arkTx); return { signedArkTx: arkTx }; } },
      checkpoint: wallet.serverUnrollScript,
      fillTxid: vaultTx.id,
      terms,
      beacon: {
        assetId: asset.AssetId.create(beaconTxid, 0).toString(),
        address: String(deployed.address),
        signers: [adminPk],
        threshold: 1n,
        domain: new TextEncoder().encode("BTCUSD-FIX"),
        keyLag: 60n,
        readFee: BEACON_READ_FEE,
        adminPk,
        exit: EXIT,
      },
      now: NOW,
    });
    if (settled.result !== "settled" || settled.price == null || settled.holder == null || settled.writer == null) {
      throw new Error(`settle ${settled.result}`);
    }
    const expectHolder = holderPayoff(0, PRICE, STRIKE, COLLATERAL);
    const expectSplit = settlementOutputs(expectHolder, COLLATERAL, BEACON_READ_FEE);
    if (settled.holder !== expectSplit.holder || settled.writer !== expectSplit.writer) {
      throw new Error(`payout holder ${settled.holder} writer ${settled.writer}`);
    }
    if (String(published.price) !== PRICE.toString()) throw new Error("published price");
    return {
      mode: "rehearsal",
      price: PRICE.toString(),
      sampleTime: SAMPLE_TIME,
      expiry: EXPIRY,
      publishTxid: String(published.txid),
      settleTxid: settled.txid,
      holder: settled.holder.toString(),
      writer: settled.writer.toString(),
      beacon: (330n + BEACON_READ_FEE).toString(),
      readFee: BEACON_READ_FEE.toString(),
    };
  } finally {
    await oracle.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invoked) {
  const report = await rehearseRoundtrip();
  console.log(JSON.stringify(report, null, 2));
}
