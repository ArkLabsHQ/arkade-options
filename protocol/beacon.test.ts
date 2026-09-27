import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { arkade, asset, CSVMultisigTapscript, DefaultVtxo, Extension, SingleKey, Transaction } from "@arkade-os/sdk";

import { holderPayoff, settlementOutputs } from "../app/settle-math.js";

import {
  beaconIdOf,
  bin2num,
  bindBeacon,
  decodeState,
  encodeState,
  genesisOutputs,
  genesisState,
  nextState,
  num2bin,
  priceValue,
  SLOT_OFFSETS,
  STATE_SIZE,
  STATE_TYPE,
  type BeaconId,
} from "./beacon.ts";
import { EXIT } from "./constants.ts";
import { bindContracts } from "./contracts.ts";
import { buildAttest, buildSettle, encodeWitness, statePacket, type AttestSlice } from "./cospend.ts";
import { bytesToHex, hexToBytes } from "./hex.ts";
import { beaconProgram, vaultProgram } from "./programs.ts";

const here = (file: string) => new URL(file, import.meta.url);

const CHECKPOINT_HEX = "03080040b27520dfcaec558c7e78cf3e38b898ba8a43cfb5727266bae32c5c5b3aeb32c558aa0bac";
const FIXTURE = {
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

async function buildFixture() {
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
  const bound = bindContracts({
    kind: FIXTURE.kind,
    strike: FIXTURE.strike,
    collateral: FIXTURE.collateral,
    premium: 1_000n,
    expiry: FIXTURE.expiry,
    deadline: FIXTURE.expiry,
    exit: EXIT,
    writerPk,
    holderPk,
    beacon: id,
    serverKey,
    emulatorKey,
  });
  const vault = {
    script: new arkade.ArkadeProgramScript(vaultProgram(), bound.vault, { serverKey, emulatorKey }),
    pkScript: bound.vaultPkScript,
    address: bound.vaultAddress,
    args: bound.vault,
    holderPkScript: bound.holderPkScript,
    writerPkScript: bound.writerPkScript,
    program: bound.optionProgram,
  };

  const value = priceValue(FIXTURE.price);
  const genesis = creatingTx(beacon.pkScript, FIXTURE.beaconSats, [statePacket(genesisState())]);
  const fixed = nextState(genesisState(), FIXTURE.expiry, value);
  const dummy = new Uint8Array(64).fill(1);
  const sliceAt = (times: bigint[], who: bigint[]): AttestSlice => ({
    price: [FIXTURE.price, FIXTURE.price, FIXTURE.price],
    time: times,
    who,
    sig: [dummy, dummy, dummy],
  });
  const attest = buildAttest({
    beacon: { script: beacon.script, coin: coinOf(genesis, FIXTURE.beaconSats), state: genesisState(), id: assetId },
    key: FIXTURE.expiry,
    slices: [
      sliceAt([FIXTURE.expiry - 1780n, FIXTURE.expiry - 1770n, FIXTURE.expiry - 1760n], [0n, 1n, 2n]),
      sliceAt([FIXTURE.expiry - 940n, FIXTURE.expiry - 930n, FIXTURE.expiry - 920n], [1n, 2n, 3n]),
      sliceAt([FIXTURE.expiry + 10n, FIXTURE.expiry + 20n, FIXTURE.expiry + 30n], [2n, 3n, 4n]),
    ],
    opSig: dummy,
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


test("state packet encodes and decodes the documented layout", () => {
  const genesis = genesisState();
  assert.equal(genesis.length, STATE_SIZE);
  assert.equal(genesis[0], 1);
  assert.ok(genesis.subarray(1).every((byte) => byte === 0));

  const value = priceValue(10_000_000n);
  const one = nextState(genesis, 1_700_000_000n, value);
  const decoded = decodeState(one);
  assert.equal(decoded.round, 1n);
  assert.equal(decoded.slots[0]!.key, 1_700_000_000n);
  assert.deepEqual(decoded.slots[0]!.value, value);
  assert.equal(decoded.slots[1]!.key, 0n);
  assert.deepEqual(encodeState(decoded), one);

  const two = nextState(one, 1_700_086_400n, priceValue(9_000_000n));
  assert.equal(bytesToHex(two.subarray(49, 329)), bytesToHex(one.subarray(9, 289)));
  assert.equal(bin2num(two.subarray(1, 9)), 2n);
  assert.throws(() => nextState(two, 1_700_000_000n, value), /already in a slot/);
  assert.throws(() => nextState(two, 0n, value), /positive/);
});

test("script numbers are little-endian sign-magnitude", () => {
  assert.equal(bytesToHex(num2bin(1_700_000_000n, 8)), "00f1536500000000");
  assert.equal(bin2num(num2bin(1_700_000_000n, 8)), 1_700_000_000n);
  assert.equal(bin2num(hexToBytes("81")), -1n);
  assert.throws(() => num2bin(1n << 63n, 8), /does not fit/);
  assert.throws(() => num2bin(-1n, 8), /negative/);
  assert.equal(bytesToHex(num2bin(0n, 4)), "00000000");
});

test("slot offsets match both contract sources", () => {
  const literal = `[${SLOT_OFFSETS.join(", ")}]`;
  for (const file of ["../contracts/attestation_beacon.ark", "../contracts/option_vault.ark"]) {
    const source = readFileSync(here(file), "utf8");
    assert.ok(source.includes(literal), `${file} lacks ${literal}`);
    assert.ok(source.includes(`const int SIZE = ${STATE_SIZE};`), file);
    assert.ok(source.includes(`const int STATE = ${STATE_TYPE};`), file);
  }
  const beacon = readFileSync(here("../contracts/attestation_beacon.ark"), "utf8");
  assert.ok(beacon.includes("const int VALUE_AT = 17;"));
  assert.ok(beacon.includes("const int HISTORY_AT = 49;"));
  assert.ok(beacon.includes("const int HISTORY = 280;"));
});

test("the beacon leaves check what the design says", () => {
  const count = (asm: readonly unknown[] | undefined, name: string) => (asm ?? []).filter((token) => token === name).length;
  const beacon = beaconProgram();
  const attest = beacon.functions.attest?.arkadeScript?.asm;
  assert.equal(count(attest, "CHECKSIGFROMSTACK"), 10);
  assert.equal(count(attest, "INSPECTINPUTPACKET"), 1);
  assert.equal(count(attest, "INSPECTPACKET"), 1);
  assert.equal(count(attest, "CHECKTIME"), 1);
  assert.equal(count(attest, "INSPECTOUTASSETLOOKUP"), 1);
  const read = beacon.functions.read?.arkadeScript?.asm;
  assert.equal(count(read, "INSPECTINPUTPACKET"), 1);
  assert.equal(count(read, "CHECKSIGFROMSTACK"), 0);
  assert.equal(count(beacon.functions.migrate?.arkadeScript?.asm, "CHECKSIGFROMSTACK"), 6);
  assert.equal(beacon.functions.migrate?.arkadeScript?.witness?.[0], "opSig");
  assert.deepEqual(Object.keys(beacon.functions), ["attest", "read", "migrate", "unilateral"]);
});

test("bindings are deterministic Mutinynet addresses and refuse a bad committee", async () => {
  const built = await buildFixture();
  assert.ok(built.beacon.address.startsWith("tark1"));
  assert.ok(built.vault.address.startsWith("tark1"));
  assert.equal(bytesToHex(built.beacon.pkScript.subarray(0, 2)), "5120");
  assert.equal(built.beacon.pkScript.length, 34);
  assert.equal(bytesToHex(built.beacon.pkScript.subarray(2)), bytesToHex(built.beacon.program));
  assert.equal(built.vault.args.beaconTxid && bytesToHex(built.vault.args.beaconTxid as Uint8Array), "07" + "00".repeat(31));
  const again = await buildFixture();
  assert.equal(again.beacon.address, built.beacon.address);
  assert.equal(again.vault.address, built.vault.address);

  const serverKey = await key(1).xOnlyPublicKey();
  const emulatorKey = await key(2).compressedPublicKey();
  const signers = await Promise.all([11, 12, 13, 14, 15].map((n) => key(n).xOnlyPublicKey()));
  const base = {
    id: built.vault.args.beaconTxid ? { txid: built.vault.args.beaconTxid as Uint8Array, gidx: 0n } : { txid: new Uint8Array(32), gidx: 0n },
    signers,
    threshold: 3n,
    domain: FIXTURE.domain,
    keyLag: 60n,
    readFee: 100n,
    adminPk: signers[0]!,
    serverKey,
    emulatorKey,
  };
  assert.throws(() => bindBeacon({ ...base, threshold: 0n }), /threshold/);
  assert.throws(() => bindBeacon({ ...base, threshold: 6n }), /threshold/);
  assert.throws(() => bindBeacon({ ...base, signers: [signers[0]!, signers[0]!, signers[2]!, signers[3]!, signers[4]!] }), /duplicate/);
  assert.throws(() => bindBeacon({ ...base, signers: signers.slice(0, 4) }), /5 signers/);
});

test("the deploy pays the unit to the beacon and any other asset to change", async () => {
  const built = await buildFixture();
  const change = new DefaultVtxo.Script({ pubKey: await key(5).xOnlyPublicKey(), serverPubKey: await key(1).xOnlyPublicKey(), csvTimelock: { type: "seconds", value: EXIT } });
  const identity = built.assetId;
  const other = asset.AssetId.create("ab".repeat(32), 0);
  const coin = { value: 10_000n, assets: [{ assetId: identity.toString(), amount: 1n }, { assetId: other.toString(), amount: 7n }] };
  const outputs = genesisOutputs(coin, identity, built.beacon.pkScript, change.pkScript);
  assert.deepEqual(outputs.slice(0, 2).map((out) => [bytesToHex(out.script), out.amount]), [[bytesToHex(built.beacon.pkScript), 330n], [bytesToHex(change.pkScript), 9_670n]]);
  const extension = Extension.fromBytes(outputs[2]!.script);
  const routed = extension.getAssetPacket()!.groups.map((group) => [group.assetId!.toString(), group.outputs.map((out) => [out.vout, BigInt(out.amount)])]);
  assert.deepEqual(routed, [[identity.toString(), [[0, 1n]]], [other.toString(), [[1, 7n]]]]);
  assert.equal(bytesToHex(extension.getPacketByType(STATE_TYPE)!.serialize()), bytesToHex(genesisState()));
  assert.throws(() => genesisOutputs({ value: 659n, assets: coin.assets }, identity, built.beacon.pkScript, change.pkScript), /change cannot be paid/);
  const folded = genesisOutputs({ value: 400n, assets: [coin.assets[0]!] }, identity, built.beacon.pkScript, change.pkScript);
  assert.equal(folded.length, 2);
  assert.equal(folded[0]!.amount, 400n);
});

test("the settle transaction has the documented layout", async () => {
  const built = await buildFixture();
  const tx = built.settle.arkTx;
  assert.equal(tx.inputsLength, 3);
  assert.deepEqual(built.settle.signIndexes, [2]);
  assert.equal(built.settle.checkpoints.length, 3);
  assert.equal(tx.outputsLength, 5);
  const out = (i: number) => tx.getOutput(i)!;
  assert.equal(bytesToHex(out(0).script!), bytesToHex(built.beacon.pkScript));
  assert.equal(out(0).amount, FIXTURE.beaconSats + FIXTURE.readFee);
  assert.equal(out(1).amount, built.split.holder);
  assert.equal(bytesToHex(out(1).script!), bytesToHex(built.vault.holderPkScript));
  assert.equal(out(2).amount, built.split.writer);
  assert.equal(bytesToHex(out(2).script!), bytesToHex(built.vault.writerPkScript));
  assert.equal(bytesToHex(out(4).script!), "51024e73");
  assert.equal(out(4).amount, 0n);

  const extension = Extension.fromBytes(out(3).script!);
  const group = extension.getAssetPacket()!.groups[0]!;
  assert.equal(group.assetId!.toString(), built.assetId.toString());
  assert.deepEqual(group.inputs.map((i) => i.input), [{ type: 1, vin: 1, amount: 1n }]);
  assert.equal(group.outputs[0]!.vout, 0);
  assert.equal(group.outputs[0]!.amount, 1n);
  assert.equal(bytesToHex(extension.getPacketByType(STATE_TYPE)!.serialize()), bytesToHex(built.fixed));
  const emulator = extension.getEmulatorPacket()!;
  assert.deepEqual(emulator.entries.map((entry) => entry.vin), [0, 1]);
  assert.deepEqual(emulator.entries[0]!.witness, encodeWitness([]));
  assert.deepEqual(emulator.entries[1]!.witness, encodeWitness([Uint8Array.of(1)]));
  assert.equal(bytesToHex(emulator.entries[0]!.script), bytesToHex(built.vault.script.functionByName("settle")!.arkadeScript!));
  assert.equal(bytesToHex(emulator.entries[1]!.script), bytesToHex(built.beacon.script.functionByName("read")!.arkadeScript!));

  const attest = built.attest.arkTx;
  assert.equal(attest.inputsLength, 1);
  assert.equal(attest.outputsLength, 3);
  assert.equal(bytesToHex(attest.getOutput(0)!.script!), bytesToHex(built.beacon.pkScript));
  const attestExt = Extension.fromBytes(attest.getOutput(1)!.script!);
  assert.deepEqual(attestExt.getAssetPacket()!.groups[0]!.inputs.map((i) => i.input), [{ type: 1, vin: 0, amount: 1n }]);
  assert.equal(bytesToHex(attestExt.getPacketByType(STATE_TYPE)!.serialize()), bytesToHex(built.fixed));
  assert.equal(attestExt.getEmulatorPacket()!.entries[0]!.witness![0], 38);
  assert.deepEqual(built.beacon.script.functionByName("attest")!.def.arkadeScript?.witness?.slice(0, 4), ["opSig", "sig2.2", "sig2.1", "sig2.0"]);
});
