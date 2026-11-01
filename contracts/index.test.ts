import assert from "node:assert/strict";
import test from "node:test";

import { asset, SingleKey } from "@arkade-os/sdk";

import { beaconIdOf, bindBeacon as bindBeaconFromProtocol } from "../protocol/beacon.ts";
import { EXIT, OPTION_VAULT_PROGRAM_ID } from "../protocol/constants.ts";
import { bindContracts as bindContractsFromProtocol, bindFill as bindFillFromContracts } from "../protocol/contracts.ts";
import { buildSettle as buildSettleFromProtocol } from "../protocol/cospend.ts";
import { bytesToHex } from "../protocol/hex.ts";
import { announceFill as announceFillFromMessages, parsePosition as parsePositionFromMessages } from "../protocol/messages.ts";
import { beaconProgram as beaconProgramFromProtocol, vaultProgram as vaultProgramFromProtocol, vaultProgramFor as vaultProgramForFromPrograms } from "../protocol/programs.ts";
import { settlePayouts as settlePayoutsFromSettle, slotFixing as slotFixingFromSettle, slotPrice as slotPriceFromSettle } from "../settle/vault.ts";
import {
  announceFill,
  attestationBeaconArtifact,
  beaconProgram,
  bindBeacon,
  bindContracts,
  bindFill,
  buildSettle,
  optionVaultArtifact,
  parsePosition,
  settlePayouts,
  slotFixing,
  slotPrice,
  vaultProgram,
  vaultProgramFor,
} from "./index.ts";

type Artifact = {
  contractName: string;
  constructorInputs: { name: string }[];
  functions: {
    name: string;
    arkade?: { inputs?: { name: string }[] };
    leaves?: { name: string; witness?: { name: string }[] }[];
  }[];
};

/** Caller-facing names. Skips script bytes. */
function api(artifact: Artifact) {
  return {
    name: artifact.contractName,
    constructor: artifact.constructorInputs.map((input) => input.name),
    functions: artifact.functions.map((fn) => ({
      name: fn.name,
      inputs:
        fn.arkade?.inputs?.map((input) => input.name) ??
        fn.leaves?.find((leaf) => leaf.name === fn.name)?.witness?.map((item) => item.name) ??
        [],
    })),
  };
}

test("the two artifacts publish the vault and beacon functions", () => {
  assert.deepEqual(api(optionVaultArtifact as Artifact), {
    name: "OptionVault",
    constructor: [
      "kind",
      "writerPk",
      "holderPk",
      "writerScript",
      "holderScript",
      "strike",
      "collateral",
      "expiry",
      "beaconTxid",
      "beaconGidx",
      "readFee",
      "exit",
    ],
    functions: [
      { name: "settle", inputs: [] },
      { name: "close", inputs: ["writerSig", "holderSig"] },
      { name: "unilateral", inputs: ["writerSig"] },
    ],
  });
  assert.deepEqual(api(attestationBeaconArtifact as Artifact), {
    name: "AttestationBeacon",
    constructor: [
      "ctrlTxid",
      "ctrlGidx",
      "signers",
      "signersN",
      "threshold",
      "domain",
      "expiryLag",
      "readFee",
      "adminPk",
      "exit",
    ],
    functions: [
      { name: "attest", inputs: ["expiry", "price", "time", "sigs"] },
      { name: "read", inputs: ["selfIndex"] },
      { name: "migrate", inputs: ["next", "opSig"] },
      { name: "unilateral", inputs: ["adminSig"] },
    ],
  });
});

test("the import surface is the protocol bind and settle helpers", () => {
  assert.equal(bindContracts, bindContractsFromProtocol);
  assert.equal(bindFill, bindFillFromContracts);
  assert.equal(announceFill, announceFillFromMessages);
  assert.equal(parsePosition, parsePositionFromMessages);
  assert.equal(bindBeacon, bindBeaconFromProtocol);
  assert.equal(buildSettle, buildSettleFromProtocol);
  assert.equal(vaultProgram, vaultProgramFromProtocol);
  assert.equal(vaultProgramFor, vaultProgramForFromPrograms);
  assert.equal(beaconProgram, beaconProgramFromProtocol);
  assert.equal(slotPrice, slotPriceFromSettle);
  assert.equal(slotFixing, slotFixingFromSettle);
  assert.equal(settlePayouts, settlePayoutsFromSettle);
  assert.deepEqual(Object.keys(vaultProgram().functions).sort(), ["close", "settle", "unilateral"]);
  assert.deepEqual(Object.keys(beaconProgram().functions).sort(), ["attest", "migrate", "read", "unilateral"]);
});

test("a fill with two user pubkeys binds a vault without the desk pubkey", async () => {
  const writer = SingleKey.fromHex("11".repeat(32));
  const holder = SingleKey.fromHex("22".repeat(32));
  const desk = SingleKey.fromHex("33".repeat(32));
  const server = SingleKey.fromHex("44".repeat(32));
  const emulator = SingleKey.fromHex("55".repeat(32));
  const writerPk = await writer.xOnlyPublicKey();
  const holderPk = await holder.xOnlyPublicKey();
  const deskPk = await desk.xOnlyPublicKey();
  const terms = {
    kind: 0 as const,
    strike: 9_700_000n,
    collateral: 10_000_000n,
    premium: 235_647n,
    expiry: 1_790_000_000n,
    deadline: 1_790_000_210n,
    exit: EXIT,
    beacon: beaconIdOf(asset.AssetId.create("07".repeat(32), 0)),
    serverKey: await server.xOnlyPublicKey(),
    emulatorKey: await emulator.compressedPublicKey(),
  };
  const bound = bindFill({ holder: holderPk, writer: writerPk }, terms);
  const deskHex = bytesToHex(deskPk);
  const seen = [
    ...Object.values(bound.vault),
    ...Object.values(bound.intent),
    bound.holderPkScript,
    bound.writerPkScript,
    bound.vaultPkScript,
    bound.intentPkScript,
  ];
  for (const value of seen) {
    const hex = typeof value === "bigint" ? "" : bytesToHex(value);
    assert.equal(hex.includes(deskHex), false, hex);
  }
  assert.equal(bytesToHex(bound.vault.holderPk as Uint8Array), bytesToHex(holderPk));
  assert.equal(bytesToHex(bound.vault.writerPk as Uint8Array), bytesToHex(writerPk));

  const announced = announceFill({
    holder: bytesToHex(holderPk),
    writer: bytesToHex(writerPk),
    writerScript: bytesToHex(bound.writerPkScript),
    rfqId: "11".repeat(32),
    kind: 0,
    collateral: "10000000",
    strike: "9700000",
    expiry: 1_790_000_000,
    exit: Number(EXIT),
    beaconTxid: "07".repeat(32),
    beaconGidx: 0,
    vaultAddress: bound.vaultAddress,
    fillTxid: "ee".repeat(32),
  });
  assert.ok(announced);
  assert.equal(announced.program_id, OPTION_VAULT_PROGRAM_ID);
  assert.equal(announced.holder_pubkey, bytesToHex(holderPk));
  assert.equal(announced.writer_pubkey, bytesToHex(writerPk));
  assert.notEqual(announced.holder_pubkey, deskHex);
  assert.notEqual(announced.writer_pubkey, deskHex);

  const { program_id: _programId, ...legacy } = announced;
  assert.equal(parsePosition(legacy)?.program_id, OPTION_VAULT_PROGRAM_ID);
  assert.equal(vaultProgramFor().name, OPTION_VAULT_PROGRAM_ID);
  assert.throws(
    () => bindFill({ holder: holderPk, writer: writerPk, programId: "PredictVault" }, terms),
    /unsupported program PredictVault/,
  );
});
