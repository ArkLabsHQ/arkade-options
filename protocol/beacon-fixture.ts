import { CSVMultisigTapscript, DefaultVtxo, Extension, SingleKey, Transaction } from "@arkade-os/sdk";
import { base64 } from "@scure/base";

import { holderPayoff, settlementOutputs } from "../app/settle-math.js";
import {
  attestDigest,
  beaconIdOf,
  bindBeacon,
  bindBeaconVault,
  genesisState,
  nextState,
  priceValue,
  type BeaconId,
} from "./beacon.ts";
import { EXIT } from "./constants.ts";
import { buildAttest, buildSettle, statePacket, type Built } from "./cospend.ts";
import { asset } from "@arkade-os/sdk";
import { bytesToHex, hexToBytes } from "./hex.ts";

/**
 * A deterministic settle and attest, built by cospend.ts and executed by the
 * Go VM tests in contracts/vm. Fixed keys, fixed previous transactions, the
 * Mutinynet checkpoint tapscript read on 2026-09-26.
 */

export const CHECKPOINT_HEX = "03080040b27520dfcaec558c7e78cf3e38b898ba8a43cfb5727266bae32c5c5b3aeb32c558aa0bac";
export const FIXTURE = {
  kind: 0 as const,
  strike: 9_700_000n,
  collateral: 20_000n,
  expiry: 1_700_000_000n,
  price: 10_000_000n,
  beaconSats: 330n,
  readFee: 100n,
  keyLag: 60n,
  threshold: 3n,
  domain: new TextEncoder().encode("BTCUSD-FIX"),
  /** Display-order txid whose script form is 0x07 followed by zeros. */
  assetTxid: "00".repeat(31) + "07",
};

function key(byte: number) {
  return SingleKey.fromHex(byte.toString(16).padStart(2, "0").repeat(32));
}

/** A coin's creating transaction: output 0 pays the script, an extension may follow. */
function creatingTx(pkScript: Uint8Array, amount: bigint, packets: Parameters<typeof Extension.create>[0] = []): Transaction {
  const tx = new Transaction({ version: 3, allowUnknownOutputs: true });
  tx.addInput({ txid: new Uint8Array(32), index: 1 });
  tx.addOutput({ script: pkScript, amount });
  if (packets.length > 0) tx.addOutput(Extension.create(packets).txOut());
  return tx;
}

function coinOf(tx: Transaction, value: bigint) {
  return { txid: tx.id, vout: 0, value, prevTx: tx.toBytes(true, true) };
}

export async function buildFixture() {
  const serverKey = await key(1).xOnlyPublicKey();
  const emulatorKey = await key(2).compressedPublicKey();
  const signers = await Promise.all([11, 12, 13, 14, 15].map((n) => key(n).xOnlyPublicKey()));
  const adminPk = await key(9).xOnlyPublicKey();
  const writerPk = await key(21).xOnlyPublicKey();
  const holderPk = await key(22).xOnlyPublicKey();
  const deskKey = key(23);
  const deskPk = await deskKey.xOnlyPublicKey();
  const checkpoint = CSVMultisigTapscript.decode(hexToBytes(CHECKPOINT_HEX));

  const assetId = asset.AssetId.create(FIXTURE.assetTxid, 0);
  const id: BeaconId = beaconIdOf(assetId);
  const beacon = bindBeacon({
    id,
    signers,
    threshold: FIXTURE.threshold,
    domain: FIXTURE.domain,
    keyLag: FIXTURE.keyLag,
    readFee: FIXTURE.readFee,
    adminPk,
    serverKey,
    emulatorKey,
  });
  const vault = bindBeaconVault({
    kind: FIXTURE.kind,
    strike: FIXTURE.strike,
    collateral: FIXTURE.collateral,
    expiry: FIXTURE.expiry,
    writerPk,
    holderPk,
    beacon: id,
    serverKey,
    emulatorKey,
  });

  const value = priceValue(FIXTURE.price);
  const digest = attestDigest(FIXTURE.domain, id, FIXTURE.expiry, value);
  const sigs = await Promise.all(
    [11, 12, 13].map((n) => key(n).signSchnorrDeterministic(digest)),
  );
  const allSigs = [...sigs, new Uint8Array(), new Uint8Array()];

  const genesis = creatingTx(beacon.pkScript, FIXTURE.beaconSats, [statePacket(genesisState())]);
  const fixed = nextState(genesisState(), FIXTURE.expiry, value);
  const attest = buildAttest({
    beacon: { script: beacon.script, coin: coinOf(genesis, FIXTURE.beaconSats), state: genesisState(), id: assetId },
    key: FIXTURE.expiry,
    value,
    sigs: allSigs,
    next: fixed,
    checkpoint,
  });

  const beaconTx = creatingTx(beacon.pkScript, FIXTURE.beaconSats, [statePacket(fixed)]);
  const vaultTx = creatingTx(vault.pkScript, FIXTURE.collateral);
  const feeScript = new DefaultVtxo.Script({ pubKey: deskPk, serverPubKey: serverKey, csvTimelock: { type: "seconds", value: EXIT } });
  const feeTx = creatingTx(feeScript.pkScript, FIXTURE.readFee);
  const split = settlementOutputs(holderPayoff(FIXTURE.kind, FIXTURE.price, FIXTURE.strike, FIXTURE.collateral), FIXTURE.collateral);
  const settle = buildSettle({
    vault: { script: vault.script, coin: coinOf(vaultTx, FIXTURE.collateral) },
    beacon: { script: beacon.script, coin: coinOf(beaconTx, FIXTURE.beaconSats), state: fixed, id: assetId },
    readFee: FIXTURE.readFee,
    payouts: [
      { script: vault.holderPkScript, amount: split.holder },
      { script: vault.writerPkScript, amount: split.writer },
    ],
    fee: { coin: coinOf(feeTx, FIXTURE.readFee), tapLeafScript: feeScript.forfeit(), tapTree: feeScript.encode() },
    checkpoint,
  });

  return { beacon, vault, assetId, split, attest, settle, emulatorKey, fixed };
}

export function psbt(built: Built): string {
  return base64.encode(built.arkTx.toPSBT());
}

/** The JSON the Go test reads. */
export async function fixtureJson(): Promise<string> {
  const built = await buildFixture();
  return `${JSON.stringify(
    {
      emulatorKey: bytesToHex(built.emulatorKey),
      settle: psbt(built.settle),
      attest: psbt(built.attest),
    },
    null,
    2,
  )}\n`;
}
