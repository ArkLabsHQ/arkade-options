import assert from "node:assert/strict";
import test from "node:test";

import { SingleKey } from "@arkade-os/sdk";
import { generateSecretKey } from "nostr-tools/pure";

import { bindContracts, bindSwap } from "./contracts.ts";
import { bytesToHex } from "./hex.ts";
import { parseWire, premiumRefusal, requestRefusal, type RfqRequest } from "./messages.ts";
import { nostrPubkey, openSealed, seal } from "./nostr.ts";
import { premiumSats } from "./pricing.ts";

const key = (n: number) => SingleKey.fromHex(n.toString(16).padStart(64, "0"));

async function sampleTerms() {
  const writer = key(1);
  const holder = key(2);
  const oracles = [3, 4, 5, 6, 7].map(key);
  const server = key(8);
  const emulator = key(9);
  return {
    kind: 0 as const,
    strike: 9_700_000n,
    collateral: 10_000_000n,
    premium: 235_647n,
    expiry: 1_790_000_000n,
    deadline: 1_790_000_210n,
    exit: 512n,
    writerPk: await writer.xOnlyPublicKey(),
    holderPk: await holder.xOnlyPublicKey(),
    oraclePks: await Promise.all(oracles.map((item) => item.xOnlyPublicKey())),
    serverKey: await server.xOnlyPublicKey(),
    emulatorKey: await emulator.compressedPublicKey(),
  };
}

test("derived intent and vault addresses stay pinned", async () => {
  const terms = await sampleTerms();
  const bound = bindContracts(terms);
  assert.equal(
    bound.intentAddress,
    "tark1qqhsre0ptn9r28d07wzrldc08shs5x7aqhj6lzy2vauyaulppg4qrpvwumn6q529zcl6lruapmg34r0upz6a6jpu5clpsj0kjqq9r8ccwg7c7d",
  );
  assert.equal(
    bound.vaultAddress,
    "tark1qqhsre0ptn9r28d07wzrldc08shs5x7aqhj6lzy2vauyaulppg4qrw4swtnv64x0kzl0r4vxp4swnpwjdst2jgax5l8nkffvs59nlskcv7z7yj",
  );
  assert.equal(bytesToHex(bound.writerPkScript), "51203d002da23716b1975b89b46563d89040a3c71d017593934bfb751b68a7cae991");
  assert.deepEqual(bindContracts(terms).intentPkScript, bound.intentPkScript);
});

test("the reference swap derives a pinned address", async () => {
  const terms = await sampleTerms();
  const bound = bindContracts(terms);
  const swap = bindSwap({
    makerPk: terms.writerPk,
    serverKey: terms.serverKey,
    emulatorKey: terms.emulatorKey,
    offerAssetIdTxid: terms.writerPk,
    offerAssetIdGidx: 0n,
    offerAmount: 1n,
    wantAssetIdTxid: terms.holderPk,
    wantAssetIdGidx: 0n,
    wantAmount: 1n,
    expirationTime: terms.expiry,
    exit: terms.exit,
    makerProgram: bound.writerProgram,
  });
  assert.equal(
    swap.address,
    "tark1qqhsre0ptn9r28d07wzrldc08shs5x7aqhj6lzy2vauyaulppg4qrt674da9cj4dhz9l2r8cu9cl7wn89krrkzym2mwakh5ksx9ak672jdq8n6",
  );
});

test("a premium at or below 330 sats is a refusal", () => {
  assert.equal(premiumRefusal(330n), "premium below dust");
  assert.equal(premiumRefusal(331n), "");
  const priced = premiumSats({
    kind: 0,
    spotCents: 10_000_000,
    strikeCents: 11_000_000,
    years: 30 / 365,
    collateralSats: 10_000_000n,
    vol: 0.55,
  });
  assert.equal(priced.sats > 330n, true);
});

test("the desk nostr key is the arkade x-only key", async () => {
  const secret = key(1);
  const raw = Uint8Array.from(Buffer.from(secret.toHex(), "hex"));
  assert.equal(nostrPubkey(raw), bytesToHex(await secret.xOnlyPublicKey()));
});

test("NIP-44 seals a quote to the recipient only", () => {
  const desk = generateSecretKey();
  const client = generateSecretKey();
  const request: RfqRequest = {
    v: 1,
    type: "rfq_request",
    rfq_id: "11".repeat(32),
    pair: "arkade:BTC->arkade:BTC-OPTION",
    amount_side: "from",
    amount: "10000000",
    profile: {
      kind: 0,
      strike: 9_700_000,
      expiry: 1_790_000_000,
      writer_pubkey: "ab".repeat(32),
      writer_pk_script: "5120" + "cd".repeat(32),
    },
  };
  const event = seal(client, nostrPubkey(desk), request, 1_790_000_000);
  assert.equal(event.kind, 24859);
  assert.deepEqual(event.tags, [["p", nostrPubkey(desk)]]);
  assert.deepEqual(openSealed(desk, event), request);
  assert.equal(openSealed(client, event), null);
});

test("a wire message with the wrong pair is dropped", () => {
  const request: RfqRequest = {
    v: 1,
    type: "rfq_request",
    rfq_id: "11".repeat(32),
    pair: "arkade:BTC->arkade:BTC-OPTION",
    amount_side: "from",
    amount: "10000000",
    profile: {
      kind: 0,
      strike: 9_700_000,
      expiry: 1_790_000_000,
      writer_pubkey: "ab".repeat(32),
      writer_pk_script: "5120" + "cd".repeat(32),
    },
  };
  assert.deepEqual(parseWire(request), request);
  assert.equal(parseWire({ ...request, pair: "arkade:BTC->arkade:BTC" }), null);
  assert.equal(parseWire({ ...request, amount: "0001" }), null);
  assert.equal(requestRefusal(request, 1_790_000_000), "expiry");
  assert.equal(requestRefusal({ ...request, profile: { ...request.profile, expiry: 1_800_000_000 } }, 1_700_000_000), "");
});
