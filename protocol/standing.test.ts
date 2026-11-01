import assert from "node:assert/strict";
import test from "node:test";

import {
  CSVMultisigTapscript,
  Extension,
  SingleKey,
  Transaction,
  asset,
  buildOffchainTx,
} from "@arkade-os/sdk";
import { base64 } from "@scure/base";

import { beaconIdOf } from "./beacon.ts";
import { DUST_SATS, EXIT } from "./constants.ts";
import { payoutVtxo } from "./contracts.ts";
import { submit, type Coin } from "./cospend.ts";
import { bytesToHex, hexToBytes } from "./hex.ts";
import { rawStandingVaultProgram, rawVaultProgram } from "./programs.ts";
import {
  STANDING_PARTY,
  bindHolderLeg,
  bindStandingVault,
  bindWriterLeg,
  buildStandingMatch,
  type StandingTerms,
} from "./standing.ts";

const CHECKPOINT = "03080040b27520dfcaec558c7e78cf3e38b898ba8a43cfb5727266bae32c5c5b3aeb32c558aa0bac";
const checkpoint = CSVMultisigTapscript.decode(hexToBytes(CHECKPOINT));
const collateral = 20_000n;
const premium = 1_000n;

function key(n: number) {
  return SingleKey.fromHex(n.toString(16).padStart(64, "0"));
}

async function terms(): Promise<StandingTerms> {
  const writer = key(1);
  const server = key(8);
  const emulator = key(9);
  return {
    kind: 0,
    strike: 9_700_000n,
    collateral,
    premium,
    expiry: 1_790_000_000n,
    deadline: 1_790_000_210n,
    exit: EXIT,
    writerPk: await writer.xOnlyPublicKey(),
    beacon: beaconIdOf(asset.AssetId.create("07".repeat(32), 0)),
    serverKey: await server.xOnlyPublicKey(),
    emulatorKey: await emulator.compressedPublicKey(),
  };
}

async function funded(script: Uint8Array, amount: bigint): Promise<Coin> {
  const owner = payoutVtxo(await key(3).xOnlyPublicKey(), await key(8).xOnlyPublicKey(), EXIT);
  const { arkTx } = buildOffchainTx(
    [{
      txid: crypto.getRandomValues(new Uint8Array(32)),
      vout: 0,
      value: Number(amount),
      tapLeafScript: owner.forfeit(),
      tapTree: owner.encode(),
    }],
    [{ script, amount }],
    checkpoint,
  );
  return { txid: arkTx.id, vout: 0, value: Number(amount), prevTx: arkTx.toBytes(true, true) };
}

function spend(tx: Transaction) {
  const outputs = [];
  for (let i = 0; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i);
    outputs.push({ amount: out?.amount ?? 0n, script: out?.script ? bytesToHex(out.script) : "" });
  }
  return outputs;
}

function opcodeCount(program: ReturnType<typeof rawVaultProgram>, name: string) {
  const asm = program.functions.settle?.arkadeScript?.asm ?? [];
  return asm.filter((token) => token === name).length;
}

test("the writer's offer does not name a holder", async () => {
  const shared = await terms();
  const writer = bindWriterLeg(shared);
  const vault = bindStandingVault(shared);
  const first = await key(2).xOnlyPublicKey();
  const second = await key(4).xOnlyPublicKey();
  const one = bindHolderLeg(shared, first);
  const other = bindHolderLeg(shared, second);
  assert.equal(bytesToHex(writer.args.vaultProgram as Uint8Array), bytesToHex(vault.program));
  assert.equal(bytesToHex(one.args.vaultProgram as Uint8Array), bytesToHex(vault.program));
  assert.equal(bytesToHex(other.args.vaultProgram as Uint8Array), bytesToHex(vault.program));
  assert.equal(writer.address, bindWriterLeg(shared).address);
  assert.notEqual(one.address, other.address);
  assert.notEqual(one.address, writer.address);
  assert.equal(bytesToHex(one.args.userPk as Uint8Array), bytesToHex(first));
  assert.equal(bytesToHex(other.args.userPk as Uint8Array), bytesToHex(second));
  const writerFields = Object.values(writer.args).filter((value) => value instanceof Uint8Array).map((value) => bytesToHex(value));
  const vaultFields = Object.values(vault.args).filter((value) => value instanceof Uint8Array).map((value) => bytesToHex(value));
  assert.equal(writerFields.includes(bytesToHex(first)), false);
  assert.equal(vaultFields.includes(bytesToHex(first)), false);
  assert.equal(opcodeCount(rawStandingVaultProgram(), "MUL"), opcodeCount(rawVaultProgram(), "MUL"));
  assert.equal(opcodeCount(rawStandingVaultProgram(), "DIV"), opcodeCount(rawVaultProgram(), "DIV"));
  assert.equal(opcodeCount(rawVaultProgram(), "MUL"), 2);
  assert.equal(opcodeCount(rawVaultProgram(), "DIV"), 2);
});

test("a matcher spends the writer leg and a later holder leg", async () => {
  const shared = await terms();
  const writer = bindWriterLeg(shared);
  const holderPk = await key(2).xOnlyPublicKey();
  const holder = bindHolderLeg(shared, holderPk);
  const built = buildStandingMatch({
    writer: { script: writer.script, coin: await funded(writer.pkScript, collateral) },
    holder: { script: holder.script, coin: await funded(holder.pkScript, premium) },
    checkpoint,
  });
  assert.deepEqual(built.signIndexes, []);
  assert.equal(built.arkTx.inputsLength, 2);
  for (let vin = 0; vin < 2; vin++) {
    assert.equal((built.arkTx.getInput(vin).tapScriptSig ?? []).length, 0);
  }
  const paid = spend(built.arkTx);
  assert.equal(paid[0]?.amount, premium);
  assert.equal(paid[0]?.script, bytesToHex(programOf(writer.args.userScript as Uint8Array)));
  assert.equal(paid[1]?.amount, collateral);
  assert.equal(paid[1]?.script, bytesToHex(programOf(writer.args.vaultProgram as Uint8Array)));
  assert.equal(paid.length, 4);
  const extension = Extension.fromBytes(hexToBytes(paid[2]!.script));
  const party = extension.getPacketByType(STANDING_PARTY)!.serialize();
  assert.equal(party.length, 65);
  assert.equal(party[0], 1);
  assert.equal(bytesToHex(party.subarray(1, 33)), bytesToHex(holderPk));
  assert.equal(bytesToHex(party.subarray(33)), bytesToHex(holder.args.userScript as Uint8Array));
  const emulator = extension.getEmulatorPacket()!;
  assert.deepEqual(emulator.entries.map((entry) => entry.vin), [0, 1]);
  assert.equal(bytesToHex(emulator.entries[0]!.script), bytesToHex(writer.script.functionByName("fill")!.arkadeScript!));
  assert.equal(bytesToHex(emulator.entries[1]!.script), bytesToHex(holder.script.functionByName("fill")!.arkadeScript!));

  const sent = await submit(built, {
    async submitTx(arkTx: string, checkpoints: string[]) {
      assert.equal(checkpoints.length, 2);
      return { signedArkTx: arkTx, signedCheckpointTxs: checkpoints };
    },
  });
  assert.equal(sent.txid, Transaction.fromPSBT(base64.decode(sent.signedArkTx)).id);
});

test("holder change above dust returns to the holder, and dust folds into the premium", async () => {
  const shared = await terms();
  const writer = bindWriterLeg(shared);
  const holder = bindHolderLeg(shared, await key(2).xOnlyPublicKey());
  const changed = buildStandingMatch({
    writer: { script: writer.script, coin: await funded(writer.pkScript, collateral + 500n) },
    holder: { script: holder.script, coin: await funded(holder.pkScript, premium + DUST_SATS + 1n) },
    checkpoint,
  });
  const outputs = spend(changed.arkTx);
  assert.equal(outputs[0]?.amount, premium + 500n);
  assert.equal(outputs[2]?.amount, DUST_SATS + 1n);
  assert.equal(outputs[2]?.script, bytesToHex(programOf(holder.args.userScript as Uint8Array)));
  assert.equal(outputs.length, 5);

  const folded = buildStandingMatch({
    writer: { script: writer.script, coin: await funded(writer.pkScript, collateral) },
    holder: { script: holder.script, coin: await funded(holder.pkScript, premium + DUST_SATS) },
    checkpoint,
  });
  const dust = spend(folded.arkTx);
  assert.equal(dust[0]?.amount, premium + DUST_SATS);
  assert.equal(dust.length, 4);
});

test("a holder leg that pays the wrong writer is refused", async () => {
  const shared = await terms();
  const writer = bindWriterLeg(shared);
  const holderPk = await key(2).xOnlyPublicKey();
  const holder = bindHolderLeg(shared, holderPk);
  const coins = {
    writer: { script: writer.script, coin: await funded(writer.pkScript, collateral) },
    holder: { script: holder.script, coin: await funded(holder.pkScript, premium) },
    checkpoint,
  };
  const otherWriter = bindWriterLeg({ ...shared, writerPk: await key(5).xOnlyPublicKey() });
  const aimedElsewhere = bindHolderLeg({ ...shared, writerPk: await key(5).xOnlyPublicKey() }, holderPk);
  assert.throws(
    () => buildStandingMatch({ ...coins, holder: { script: aimedElsewhere.script, coin: coins.holder.coin } }),
    /different vaults|not paid to the writer/,
  );
  assert.notEqual(otherWriter.address, writer.address);

  const shortWriter = await funded(writer.pkScript, collateral - 1n);
  const shortHolder = await funded(holder.pkScript, premium - 1n);
  assert.throws(
    () => buildStandingMatch({ ...coins, writer: { script: writer.script, coin: shortWriter } }),
    /short of the collateral/,
  );
  assert.throws(
    () => buildStandingMatch({ ...coins, holder: { script: holder.script, coin: shortHolder } }),
    /short of the premium/,
  );
});

function programOf(program: Uint8Array): Uint8Array {
  const script = new Uint8Array(34);
  script[0] = 0x51;
  script[1] = 0x20;
  script.set(program, 2);
  return script;
}
