import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { arkade, asset, CSVMultisigTapscript, DefaultVtxo, Extension, SingleKey, Transaction } from "@arkade-os/sdk";

import { holderPayoff, settlementOutputs } from "../app/settle-math.js";

import {
  attestDigest,
  beaconIdOf,
  bin2num,
  bindBeacon,
  bindBeaconVault,
  decodeState,
  encodeState,
  findFixing,
  genesisState,
  migrateDigest,
  nextState,
  num2bin,
  priceOf,
  priceValue,
  SLOT_OFFSETS,
  STATE_SIZE,
  STATE_TYPE,
  verifyGenesis,
  type BeaconId,
} from "./beacon.ts";
import { EXIT } from "./constants.ts";
import { buildAttest, buildSettle, encodeWitness, statePacket } from "./cospend.ts";
import { bytesToHex, hexToBytes } from "./hex.ts";
import { beaconProgram, beaconVaultProgram, rawBeaconProgram, rawBeaconVaultProgram } from "./programs.ts";

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

test("the newest slot wins and the price is the first eight bytes", () => {
  const twice = encodeState({
    version: 1,
    round: 2n,
    slots: [
      { key: 5n, value: priceValue(10_000_000n) },
      { key: 5n, value: priceValue(9_700_000n) },
      ...Array.from({ length: 6 }, () => ({ key: 0n, value: new Uint8Array(32) })),
    ],
  });
  assert.equal(priceOf(findFixing(twice, 5n)!), 10_000_000n);
  assert.equal(findFixing(twice, 6n), undefined);
  const evidence = new TextEncoder().encode("nine prints");
  const value = priceValue(1n, evidence);
  assert.equal(priceOf(value), 1n);
  assert.equal(bytesToHex(value.subarray(8)), createHash("sha256").update(evidence).digest("hex").slice(0, 48));
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
  for (const file of ["../contracts/attestation_beacon.ark", "../contracts/beacon_option_vault.ark"]) {
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

test("digests are what the contracts hash", () => {
  const id = { txid: hexToBytes("07" + "00".repeat(31)), gidx: 0n };
  const domain = new TextEncoder().encode("BTCUSD-FIX");
  const value = priceValue(10_000_000n);
  const expected = createHash("sha256")
    .update(Buffer.concat([domain, id.txid, Buffer.from("00000000", "hex"), num2bin(1_700_000_000n, 8), value]))
    .digest("hex");
  assert.equal(bytesToHex(attestDigest(domain, id, 1_700_000_000n, value)), expected);
  const next = new Uint8Array(32).fill(0x55);
  const migrate = createHash("sha256")
    .update(Buffer.concat([domain, Buffer.from("migrate"), id.txid, Buffer.from("00000000", "hex"), num2bin(4n, 8), next]))
    .digest("hex");
  assert.equal(bytesToHex(migrateDigest(domain, id, 4n, next)), migrate);
  assert.notEqual(bytesToHex(attestDigest(domain, { ...id, gidx: 1n }, 1_700_000_000n, value)), expected);
});

test("the asset id the vault compares is the reversed display txid", () => {
  const id = beaconIdOf(asset.AssetId.create(FIXTURE.assetTxid, 0));
  assert.equal(bytesToHex(id.txid), "07" + "00".repeat(31));
  assert.equal(id.gidx, 0n);
});

function onlyExitDiffers(raw: ReturnType<typeof rawBeaconProgram>, spent: ReturnType<typeof beaconProgram>) {
  assert.equal(raw.functions.unilateral?.tapscript?.csv?.type, "blocks");
  assert.equal(spent.functions.unilateral?.tapscript?.csv?.type, "seconds");
  const back = {
    ...spent,
    functions: {
      ...spent.functions,
      unilateral: {
        ...spent.functions.unilateral,
        tapscript: { ...spent.functions.unilateral!.tapscript, csv: { type: "blocks" as const, value: "$exit" } },
      },
    },
  };
  assert.deepEqual(back, raw);
}

test("artifacts load and only the exit leaf changes", () => {
  onlyExitDiffers(rawBeaconProgram(), beaconProgram());
  onlyExitDiffers(rawBeaconVaultProgram(), beaconVaultProgram());
  const count = (asm: readonly unknown[] | undefined, name: string) => (asm ?? []).filter((token) => token === name).length;
  const beacon = beaconProgram();
  const attest = beacon.functions.attest?.arkadeScript?.asm;
  assert.equal(count(attest, "CHECKSIGFROMSTACK"), 5);
  assert.equal(count(attest, "INSPECTINPUTPACKET"), 1);
  assert.equal(count(attest, "INSPECTPACKET"), 1);
  assert.equal(count(attest, "CHECKTIME"), 1);
  assert.equal(count(attest, "INSPECTOUTASSETLOOKUP"), 1);
  const read = beacon.functions.read?.arkadeScript?.asm;
  assert.equal(count(read, "INSPECTINPUTPACKET"), 1);
  assert.equal(count(read, "CHECKSIGFROMSTACK"), 0);
  assert.equal(count(beacon.functions.migrate?.arkadeScript?.asm, "CHECKSIGFROMSTACK"), 5);
  const settle = beaconVaultProgram().functions.settle?.arkadeScript?.asm;
  assert.equal(count(settle, "INSPECTINASSETLOOKUP"), 1);
  assert.equal(count(settle, "INSPECTINPUTPACKET"), 1);
  assert.equal(count(settle, "CHECKTIME"), 1);
  assert.equal(count(settle, "CHECKSIGFROMSTACK"), 0);
  assert.deepEqual(Object.keys(beacon.functions), ["attest", "read", "migrate", "unilateral"]);
  assert.deepEqual(Object.keys(beaconVaultProgram().functions), ["settle", "close", "unilateral"]);
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

function genesisTx(beaconPkScript: Uint8Array, group: asset.AssetGroup, state: Uint8Array): Transaction {
  const tx = new Transaction({ version: 3, allowUnknownOutputs: true });
  tx.addInput({ txid: new Uint8Array(32).fill(1), index: 0 });
  tx.addOutput({ script: beaconPkScript, amount: 330n });
  tx.addOutput(Extension.create([asset.Packet.create([group]), statePacket(state)]).txOut());
  return tx;
}

test("verifyGenesis accepts one uncontrolled unit on the beacon and nothing else", async () => {
  const built = await buildFixture();
  const signers = await Promise.all([11, 12, 13, 14, 15].map((n) => key(n).xOnlyPublicKey()));
  const unit = asset.AssetGroup.create(null, null, [], [asset.AssetOutput.create(0, 1n)], []);
  const good = genesisTx(built.beacon.pkScript, unit, genesisState());
  const id = verifyGenesis({ tx: good, gidx: 0, beaconPkScript: built.beacon.pkScript, signers, threshold: 3n });
  assert.equal(bytesToHex(id.txid), good.id);
  assert.equal(id.groupIndex, 0);

  const check = (tx: Transaction, pattern: RegExp, extra: Partial<Parameters<typeof verifyGenesis>[0]> = {}) =>
    assert.throws(() => verifyGenesis({ tx, gidx: 0, beaconPkScript: built.beacon.pkScript, signers, threshold: 3n, ...extra }), pattern);

  const controlled = asset.AssetGroup.create(null, asset.AssetRef.fromId(asset.AssetId.create("11".repeat(32), 0)), [], [asset.AssetOutput.create(0, 1n)], []);
  check(genesisTx(built.beacon.pkScript, controlled, genesisState()), /control asset/);
  const two = asset.AssetGroup.create(null, null, [], [asset.AssetOutput.create(0, 2n)], []);
  check(genesisTx(built.beacon.pkScript, two, genesisState()), /supply/);
  check(genesisTx(built.vault.pkScript, unit, genesisState()), /beacon script/);
  check(genesisTx(built.beacon.pkScript, unit, built.fixed), /genesis state/);
  check(good, /threshold/, { threshold: 0n });
  check(good, /duplicate/, { signers: [signers[0]!, signers[0]!, signers[2]!, signers[3]!, signers[4]!] });
  check(good, /group 1/, { gidx: 1 });
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
  // count, three 64-byte signatures, two empty items, the 32-byte value, the 4-byte key
  assert.equal(attestExt.getEmulatorPacket()!.entries[0]!.witness!.length, 1 + 3 * 65 + 2 + 33 + 5);
});


test("the witness encoding is compact size framed", () => {
  assert.equal(bytesToHex(encodeWitness([])), "00");
  assert.equal(bytesToHex(encodeWitness([Uint8Array.of(1), new Uint8Array()])), "02010100");
  assert.equal(bytesToHex(encodeWitness([new Uint8Array(253)]).subarray(0, 4)), "01fdfd00");
});

test("programs bind the same asset id the fixture uses", () => {
  const id = asset.AssetId.create(FIXTURE.assetTxid, 0);
  assert.equal(id.toString(), `${FIXTURE.assetTxid}0000`);
  assert.equal(arkade.programFromArtifact(JSON.parse(readFileSync(here("../contracts/attestation_beacon.artifact.json"), "utf8"))).name, "AttestationBeacon");
});
