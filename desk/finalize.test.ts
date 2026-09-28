import assert from "node:assert/strict";
import test from "node:test";

import { base64 } from "@scure/base";
import { buildOffchainTx, SingleKey, Transaction, type ArkTxInput, type IndexerProvider } from "@arkade-os/sdk";

import { EXIT } from "../protocol/constants.ts";
import { payoutVtxo } from "../protocol/contracts.ts";
import { bytesToHex } from "../protocol/hex.ts";
import { cosignCheckpoint, finalizeDeskSpends } from "./finalize.ts";

const SERVER = "03301078808e4f7bc0dadfe29e34b1df8eaf0108ef06b1722274075ebc107a127a";

function key(n: number) {
  return SingleKey.fromHex(n.toString(16).padStart(64, "0"));
}

test("cosign adds the desk signature on its checkpoint and leaves the other input alone", async () => {
  const desk = key(2);
  const foreignKey = key(4);
  const server = Uint8Array.from(Buffer.from(SERVER, "hex"));
  const script = payoutVtxo(await desk.xOnlyPublicKey(), server, EXIT);
  const foreign = payoutVtxo(await foreignKey.xOnlyPublicKey(), server, EXIT);
  const { checkpoints } = buildOffchainTx(
    [
      {
        txid: "aa".repeat(32),
        vout: 0,
        value: 20_000,
        tapLeafScript: foreign.forfeit(),
        tapTree: foreign.encode(),
      } as unknown as ArkTxInput,
      {
        txid: "bb".repeat(32),
        vout: 1,
        value: 1_000,
        tapLeafScript: script.forfeit(),
        tapTree: script.encode(),
      } as unknown as ArkTxInput,
    ],
    [{ script: script.pkScript, amount: 21_000n }],
    { script: new Uint8Array([0x51]), params: { timelock: { type: "seconds", value: EXIT }, pubkeys: [server] } } as never,
  );
  const foreignPsbt = base64.encode(checkpoints[0]!.toPSBT());
  const owned = base64.encode(checkpoints[1]!.toPSBT());
  const kept = await cosignCheckpoint(desk, script.pkScript, foreignPsbt);
  const signed = await cosignCheckpoint(desk, script.pkScript, owned);
  assert.equal(kept, foreignPsbt);
  const before = Transaction.fromPSBT(base64.decode(owned)).getInput(0).tapScriptSig?.length ?? 0;
  const after = Transaction.fromPSBT(base64.decode(signed)).getInput(0).tapScriptSig?.length ?? 0;
  assert.equal(before, 0);
  assert.equal(after, 1);
  assert.equal(bytesToHex(script.pkScript).length, 68);
});

test("finalizeDeskSpends proves the pending coin and finalizes the server checkpoints", async () => {
  const desk = key(3);
  const holderPk = await desk.xOnlyPublicKey();
  const server = Uint8Array.from(Buffer.from(SERVER, "hex"));
  const script = payoutVtxo(holderPk, server, EXIT);
  const { checkpoints } = buildOffchainTx(
    [{
      txid: "cc".repeat(32),
      vout: 2,
      value: 40_633,
      tapLeafScript: script.forfeit(),
      tapTree: script.encode(),
    } as unknown as ArkTxInput],
    [{ script: script.pkScript, amount: 40_633n }],
    { script: new Uint8Array([0x51]), params: { timelock: { type: "seconds", value: EXIT }, pubkeys: [server] } } as never,
  );
  const raw = base64.encode(checkpoints[0]!.toPSBT());
  let proved = false;
  const finalized: string[][] = [];
  const done = await finalizeDeskSpends({
    identity: desk,
    deskScript: script,
    indexer: {
      async getVtxos(filter) {
        assert.ok(filter);
        assert.equal(filter.pendingOnly, true);
        assert.deepEqual(filter.scripts, [bytesToHex(script.pkScript)]);
        return { vtxos: [{ txid: "cc".repeat(32), vout: 2, value: 40_633, isSpent: true }] };
      },
    } as Pick<IndexerProvider, "getVtxos">,
    ark: {
      async getPendingTxs(intent) {
        assert.equal(intent.message.type, "get-pending-tx");
        assert.equal(intent.message.expire_at, 0);
        const proof = Transaction.fromPSBT(base64.decode(intent.proof));
        assert.ok((proof.getInput(0).tapScriptSig?.length ?? 0) > 0);
        proved = true;
        return [{ arkTxid: "dd".repeat(32), signedCheckpointTxs: [raw] }];
      },
      async finalizeTx(arkTxid, txs) {
        finalized.push([arkTxid, ...txs]);
      },
    },
  });
  assert.equal(proved, true);
  assert.deepEqual(done, ["dd".repeat(32)]);
  const signed = Transaction.fromPSBT(base64.decode(finalized[0]![1]!));
  assert.equal(signed.getInput(0).tapScriptSig?.length, 1);
});
