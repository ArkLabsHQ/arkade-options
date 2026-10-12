import assert from "node:assert/strict";
import test from "node:test";

import { SingleKey } from "@arkade-os/sdk";

import { bytesToHex } from "../../protocol/hex.ts";
import { restoreFromCoin, SAMPLE_VAULT_TXID, vaultPkScriptHex, type RestoreInput } from "./restore.ts";

const key = (n: number) => SingleKey.fromHex(n.toString(16).padStart(64, "0"));

test("the sample outpoint is an open vault when unspent and settled when spentBy is set", async () => {
  const writer = key(1);
  const holder = key(2);
  const server = key(8);
  const emulator = key(9);
  const input: RestoreInput = {
    txid: SAMPLE_VAULT_TXID,
    vout: 1,
    kind: 0,
    strike: 10_000_000n,
    expiry: 1_790_000_000n,
    collateral: 100_000n,
    writerPk: await writer.xOnlyPublicKey(),
    holderPk: await holder.xOnlyPublicKey(),
    beaconTxidHex: "07".repeat(32),
    beaconGidx: 0,
    exit: 2048n,
    readFee: 1000n,
    serverKey: await server.xOnlyPublicKey(),
    emulatorKey: await emulator.compressedPublicKey(),
  };

  const open = restoreFromCoin(input, { isSpent: false, spentBy: "" });
  assert.equal(open.status, "filled");
  assert.equal(open.settleTxid, "");
  assert.equal(open.kind, 0);
  assert.equal(open.strike, 10_000_000n);
  assert.equal(open.collateral, 100_000n);
  assert.equal(open.expiry, 1_790_000_000n);
  assert.equal(open.closeTxid, SAMPLE_VAULT_TXID);
  assert.equal(open.id, `restore:${SAMPLE_VAULT_TXID}:1`);
  assert.match(open.vaultAddress, /^tark1/);

  const spentBy = "c446b59cb2f7abe68f9a259c1b93a7c33f019d657cf356f117a41b53d85def33";
  const settled = restoreFromCoin(input, { isSpent: false, spentBy });
  assert.equal(settled.status, "settled");
  assert.equal(settled.settleTxid, spentBy);
  assert.equal(settled.vaultAddress, open.vaultAddress);

  const ark = "eb287e814b7d8e2b8435faf93c0c66d2a43bdfb9b917f4829156f331832b55b0";
  const linked = restoreFromCoin(input, { isSpent: true, spentBy, arkTxId: ark });
  assert.equal(linked.status, "settled");
  assert.equal(linked.settleTxid, ark);
});

test("a coin with another script is not this vault", async () => {
  const writer = key(1);
  const holder = key(2);
  const server = key(8);
  const emulator = key(9);
  const input: RestoreInput = {
    txid: SAMPLE_VAULT_TXID,
    vout: 1,
    kind: 0,
    strike: 10_000_000n,
    expiry: 1_790_000_000n,
    collateral: 100_000n,
    writerPk: await writer.xOnlyPublicKey(),
    holderPk: await holder.xOnlyPublicKey(),
    beaconTxidHex: "07".repeat(32),
    beaconGidx: 0,
    exit: 2048n,
    readFee: 1000n,
    serverKey: await server.xOnlyPublicKey(),
    emulatorKey: await emulator.compressedPublicKey(),
  };
  const script = vaultPkScriptHex(input);
  const wrongStrike = { ...input, strike: input.strike + 1n };
  assert.notEqual(vaultPkScriptHex(wrongStrike), script);
  assert.throws(
    () => restoreFromCoin(wrongStrike, { isSpent: true, spentBy: "ab".repeat(32), script }),
    /not the vault/,
  );
  assert.equal(restoreFromCoin(input, { isSpent: false, spentBy: "", script }).status, "filled");
});
