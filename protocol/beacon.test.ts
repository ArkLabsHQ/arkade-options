import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { arkade, asset, buildOffchainTx, CSVMultisigTapscript, DefaultVtxo, Extension, SingleKey, Transaction } from "@arkade-os/sdk";

import { holderPayoff, settlementOutputs } from "../app/settle-math.js";

import {
  beaconIdOf,
  bin2num,
  bindBeacon,
  decodeState,
  encodeState,
  findFixing,
  genesisOutputs,
  genesisState,
  migrateDigest,
  nextState,
  num2bin,
  priceOf,
  priceValue,
  publishDigest,
  SLOT_OFFSETS,
  STATE_SIZE,
  STATE_TYPE,
  verifyGenesis,
  type BeaconId,
} from "./beacon.ts";
import { EXIT } from "./constants.ts";
import { bindContracts } from "./contracts.ts";
import { buildAttest, buildSettle, encodeWitness, statePacket, type AttestSlice } from "./cospend.ts";
import { bytesToHex, hexToBytes } from "./hex.ts";
import { beaconProgram, rawBeaconProgram, rawVaultProgram, vaultProgram } from "./programs.ts";

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
  const value = priceValue(1n);
  assert.equal(priceOf(value), 1n);
  assert.deepEqual(value, num2bin(1n, 32));
  assert.ok(value.subarray(8).every((byte) => byte === 0));
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

test("digests are what the contracts hash", () => {
  const id = { txid: hexToBytes("07" + "00".repeat(31)), gidx: 0n };
  const domain = new TextEncoder().encode("BTCUSD-FIX");
  const next = priceValue(10_000_000n);
  const state = nextState(genesisState(), 1_700_000_000n, next);
  const expected = createHash("sha256").update(Buffer.concat([id.txid, state])).digest("hex");
  assert.equal(bytesToHex(publishDigest(id.txid, state)), expected);
  const other = nextState(state, 1_700_086_400n, priceValue(9_000_000n));
  assert.notEqual(bytesToHex(publishDigest(id.txid, other)), expected);
  const migrate = createHash("sha256")
    .update(Buffer.concat([domain, Buffer.from("migrate"), id.txid, Buffer.from("00000000", "hex"), num2bin(4n, 8), new Uint8Array(32).fill(0x55)]))
    .digest("hex");
  assert.equal(bytesToHex(migrateDigest(domain, id, 4n, new Uint8Array(32).fill(0x55))), migrate);
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
  onlyExitDiffers(rawVaultProgram(), vaultProgram());
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
  assert.equal(count(beacon.functions.migrate?.arkadeScript?.asm, "CHECKSIGFROMSTACK"), 5);
  const settle = vaultProgram().functions.settle?.arkadeScript?.asm;
  assert.equal(count(settle, "INSPECTINASSETLOOKUP"), 1);
  assert.equal(count(settle, "INSPECTINPUTPACKET"), 1);
  assert.equal(count(settle, "CHECKTIME"), 1);
  assert.equal(count(settle, "CHECKSIGFROMSTACK"), 0);
  assert.deepEqual(Object.keys(beacon.functions), ["attest", "read", "migrate", "unilateral"]);
  assert.deepEqual(Object.keys(vaultProgram().functions), ["settle", "close", "unilateral"]);
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

/** Mirrors AssetManager.issue when the selected coin already holds another asset: group 0 is the new unit, later groups return the other assets to the wallet output. */
function stubWalletIssue(walletScript: Uint8Array, sats: bigint, other: { id: asset.AssetId; amount: bigint } | null): Transaction {
  const groups = [asset.AssetGroup.create(null, null, [], [asset.AssetOutput.create(0, 1n)], [])];
  if (other) {
    groups.push(
      asset.AssetGroup.create(
        other.id,
        null,
        [asset.AssetInput.create(0, other.amount)],
        [asset.AssetOutput.create(0, other.amount)],
        [],
      ),
    );
  }
  const tx = new Transaction({ version: 3, allowUnknownOutputs: true });
  tx.addInput({ txid: new Uint8Array(32).fill(2), index: 0 });
  tx.addOutput({ script: walletScript, amount: sats });
  tx.addOutput(Extension.create([asset.Packet.create(groups)]).txOut());
  return tx;
}

test("verifyGenesis accepts issue then deploy, and keeps a second asset off the beacon", async () => {
  const serverKey = await key(1).xOnlyPublicKey();
  const emulatorKey = await key(2).compressedPublicKey();
  const signers = await Promise.all([11, 12, 13, 14, 15].map((n) => key(n).xOnlyPublicKey()));
  const adminPk = await key(9).xOnlyPublicKey();
  const ownerPk = await key(4).xOnlyPublicKey();
  const changePk = await key(5).xOnlyPublicKey();
  const timelock = { type: "seconds" as const, value: EXIT };
  const walletScript = new DefaultVtxo.Script({ pubKey: ownerPk, serverPubKey: serverKey, csvTimelock: timelock });
  const changeScript = new DefaultVtxo.Script({ pubKey: changePk, serverPubKey: serverKey, csvTimelock: timelock });
  const other = asset.AssetId.create("ab".repeat(32), 0);
  const issued = stubWalletIssue(walletScript.pkScript, 10_000n, { id: other, amount: 7n });
  const identity = asset.AssetId.create(issued.id, 0);
  const args = {
    signers,
    threshold: 3n,
    domain: FIXTURE.domain,
    keyLag: FIXTURE.keyLag,
    readFee: FIXTURE.readFee,
    adminPk,
    serverKey,
    emulatorKey,
  };
  const beacon = bindBeacon({ ...args, id: beaconIdOf(identity) });
  const coin = {
    value: 10_000n,
    assets: [
      { assetId: identity.toString(), amount: 1n },
      { assetId: other.toString(), amount: 7n },
    ],
  };
  const outputs = genesisOutputs(coin, identity, beacon.pkScript, changeScript.pkScript);
  assert.equal(outputs[0]!.amount, 330n);
  assert.equal(bytesToHex(outputs[0]!.script), bytesToHex(beacon.pkScript));
  assert.equal(outputs[1]!.amount, 9_670n);
  assert.equal(bytesToHex(outputs[1]!.script), bytesToHex(changeScript.pkScript));
  const extension = Extension.fromBytes(outputs[2]!.script);
  const groups = extension.getAssetPacket()!.groups;
  assert.equal(groups[0]!.outputs[0]!.vout, 0);
  assert.equal(BigInt(groups[0]!.outputs[0]!.amount), 1n);
  assert.equal(groups[1]!.assetId!.toString(), other.toString());
  assert.equal(groups[1]!.outputs[0]!.vout, 1);
  assert.ok(groups.every((group) => group.outputs.every((output) => output.vout !== 0 || group.assetId!.toString() === identity.toString())));

  const deployed = buildOffchainTx(
    [{ txid: issued.id, vout: 0, value: 10_000, tapLeafScript: walletScript.forfeit(), tapTree: walletScript.encode() }],
    outputs,
    CSVMultisigTapscript.decode(hexToBytes(CHECKPOINT_HEX)),
  );
  const good = { issueTx: issued, deployTx: deployed.arkTx, checkpoint: deployed.checkpoints[0]!, ...args };
  const id = verifyGenesis(good);
  assert.equal(id.toString(), identity.toString());
  assert.equal(bytesToHex(id.txid), issued.id);

  const check = (pattern: RegExp, extra: Partial<Parameters<typeof verifyGenesis>[0]>) =>
    assert.throws(() => verifyGenesis({ ...good, ...extra }), pattern);

  const controlTx = new Transaction({ version: 3, allowUnknownOutputs: true });
  controlTx.addInput({ txid: new Uint8Array(32).fill(3), index: 0 });
  controlTx.addOutput({ script: walletScript.pkScript, amount: 10_000n });
  controlTx.addOutput(
    Extension.create([
      asset.Packet.create([
        asset.AssetGroup.create(null, asset.AssetRef.fromId(asset.AssetId.create("11".repeat(32), 0)), [], [asset.AssetOutput.create(0, 1n)], []),
      ]),
    ]).txOut(),
  );
  check(/control asset/, { issueTx: controlTx });

  const minted = new Transaction({ version: 3, allowUnknownOutputs: true });
  minted.addInput({ txid: new Uint8Array(32).fill(4), index: 0 });
  minted.addOutput({ script: walletScript.pkScript, amount: 10_000n });
  minted.addOutput(Extension.create([asset.Packet.create([asset.AssetGroup.create(null, null, [], [asset.AssetOutput.create(0, 2n)], [])])]).txOut());
  check(/supply is not 1/, { issueTx: minted });

  const issuedGroup = asset.AssetGroup.create(null, null, [], [asset.AssetOutput.create(0, 1n)], []);
  issuedGroup.inputs.push(asset.AssetInput.create(0, 1n));
  const reissued = new Transaction({ version: 3, allowUnknownOutputs: true });
  reissued.addInput({ txid: new Uint8Array(32).fill(5), index: 0 });
  reissued.addOutput({ script: walletScript.pkScript, amount: 10_000n });
  reissued.addOutput(Extension.create([asset.Packet.create([issuedGroup])]).txOut());
  check(/issuance/, { issueTx: reissued });

  const wrong = buildOffchainTx(
    [{ txid: issued.id, vout: 0, value: 10_000, tapLeafScript: walletScript.forfeit(), tapTree: walletScript.encode() }],
    [{ script: changeScript.pkScript, amount: 10_000n }, outputs[2]!],
    CSVMultisigTapscript.decode(hexToBytes(CHECKPOINT_HEX)),
  );
  check(/wrong script/, { deployTx: wrong.arkTx, checkpoint: wrong.checkpoints[0]! });

  const extra = buildOffchainTx(
    [{ txid: issued.id, vout: 0, value: 10_000, tapLeafScript: walletScript.forfeit(), tapTree: walletScript.encode() }],
    [
      { script: beacon.pkScript, amount: 330n },
      { script: changeScript.pkScript, amount: 9_670n },
      Extension.create([
        asset.Packet.create([
          asset.AssetGroup.create(identity, null, [asset.AssetInput.create(0, 1n)], [asset.AssetOutput.create(0, 1n)], []),
          asset.AssetGroup.create(other, null, [asset.AssetInput.create(0, 7n)], [asset.AssetOutput.create(0, 7n)], []),
        ]),
        statePacket(genesisState()),
      ]).txOut(),
    ],
    CSVMultisigTapscript.decode(hexToBytes(CHECKPOINT_HEX)),
  );
  check(/extra asset/, { deployTx: extra.arkTx, checkpoint: extra.checkpoints[0]! });

  const moved = buildOffchainTx(
    [{ txid: issued.id, vout: 0, value: 10_000, tapLeafScript: walletScript.forfeit(), tapTree: walletScript.encode() }],
    [
      outputs[0]!,
      outputs[1]!,
      Extension.create([asset.Packet.create(groups), statePacket(nextState(genesisState(), 1_700_000_000n, priceValue(1n)))]).txOut(),
    ],
    CSVMultisigTapscript.decode(hexToBytes(CHECKPOINT_HEX)),
  );
  check(/non-genesis state/, { deployTx: moved.arkTx, checkpoint: moved.checkpoints[0]! });

  const elsewhere = stubWalletIssue(walletScript.pkScript, 10_000n, null);
  const missed = buildOffchainTx(
    [{ txid: elsewhere.id, vout: 0, value: 10_000, tapLeafScript: walletScript.forfeit(), tapTree: walletScript.encode() }],
    outputs,
    CSVMultisigTapscript.decode(hexToBytes(CHECKPOINT_HEX)),
  );
  check(/deploy does not spend the issuance/, { deployTx: missed.arkTx, checkpoint: missed.checkpoints[0]! });
  check(/issuance tx passed as deploy/, { deployTx: issued });
  check(/threshold/, { threshold: 0n });
  check(/duplicate/, { signers: [signers[0]!, signers[0]!, signers[2]!, signers[3]!, signers[4]!] });

  assert.throws(
    () => genesisOutputs({ value: 659n, assets: coin.assets }, identity, beacon.pkScript, changeScript.pkScript),
    /change cannot be paid/,
  );
  const folded = genesisOutputs({ value: 400n, assets: [{ assetId: identity.toString(), amount: 1n }] }, identity, beacon.pkScript, changeScript.pkScript);
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
