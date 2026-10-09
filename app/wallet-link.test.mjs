import assert from "node:assert/strict";
import test from "node:test";

import {
  WALLET_SEARCH_LIMIT,
  callbackAllowed,
  hasWalletParams,
  pageCallback,
  readWalletHandoff,
  stripWalletParams,
  walletConnectUrl,
  walletSendUrl,
} from "./src/wallet-link.ts";

const ADDRESS =
  "tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf848nste9qrnlrjwdc39u8pmyczeuwf2g4cfjhqa8esm8mt05u9ev8d3v5pf";
const PUBKEY = "ab".repeat(32);
const TXID = "cd".repeat(32);
const ORIGIN = "https://mutinynet.arkade.money";
const REQUEST = `bitcoin:?ark=${ADDRESS}&amount=0.00000001`;

test("connect and send links encode the callback and the BIP21", () => {
  const connectCallback = "https://arkade.trade/?flow=connect";
  const connect = new URL(walletConnectUrl(ORIGIN, connectCallback));
  assert.equal(connect.origin, ORIGIN);
  assert.equal(connect.searchParams.get("action"), "connect");
  assert.equal(connect.searchParams.get("callback"), connectCallback);
  assert.equal(connect.searchParams.get("request"), null);

  const sendCallback = "http://127.0.0.1:4173/?flow=send&position=pos-1#/quote/call";
  const send = walletSendUrl(ORIGIN, REQUEST, sendCallback);
  const parsed = new URL(send);
  assert.equal(parsed.searchParams.get("action"), "send");
  assert.equal(parsed.searchParams.get("request"), REQUEST);
  assert.equal(parsed.searchParams.get("callback"), sendCallback);
  assert.ok(parsed.search.length <= WALLET_SEARCH_LIMIT);
  assert.equal(send.includes("request=bitcoin:?"), false);
  assert.ok(send.includes("request=bitcoin%3A"));
});

test("the wallet can return to https and to localhost only", () => {
  assert.equal(callbackAllowed("https://arkade.trade/"), true);
  assert.equal(callbackAllowed("http://127.0.0.1:4173/?flow=connect"), true);
  assert.equal(callbackAllowed("http://localhost:4173/"), true);
  assert.equal(callbackAllowed("http://[::1]:4173/"), true);
  assert.equal(callbackAllowed("http://arkade.trade/"), false);
  assert.equal(callbackAllowed("https://user:pass@arkade.trade/"), false);
  assert.equal(callbackAllowed("http://192.168.1.20:4173/"), false);
  assert.throws(() => walletConnectUrl(ORIGIN, "http://192.168.1.20/"), /return/);
});

test("a page callback keeps the hash and drops a previous wallet return", () => {
  const href = pageCallback(
    `http://127.0.0.1:4173/?address=${ADDRESS}&pubkey=${PUBKEY}&error=denied#/quote/put`,
    { flow: "send", position: "pos-1" },
  );
  const url = new URL(href);
  assert.equal(url.searchParams.get("flow"), "send");
  assert.equal(url.searchParams.get("position"), "pos-1");
  assert.equal(url.searchParams.get("address"), null);
  assert.equal(url.searchParams.get("error"), null);
  assert.equal(url.hash, "#/quote/put");
});

test("the wallet return is read once and then stripped", () => {
  const connect = `?flow=connect&address=${ADDRESS}&pubkey=${PUBKEY.toUpperCase()}`;
  assert.deepEqual(readWalletHandoff(connect), { kind: "connect", address: ADDRESS, pubkey: PUBKEY });

  const denied = `?flow=connect&error=denied&address=${ADDRESS}&pubkey=${PUBKEY}`;
  assert.deepEqual(readWalletHandoff(denied), { kind: "connect-denied" });
  assert.deepEqual(readWalletHandoff("?flow=send&position=pos-1&error=denied"), {
    kind: "send-denied",
    positionId: "pos-1",
  });
  assert.deepEqual(readWalletHandoff(`?flow=send&position=pos-1&status=sent&txid=${TXID}`), {
    kind: "sent",
    positionId: "pos-1",
    txid: TXID,
  });
  assert.deepEqual(readWalletHandoff("?flow=send&position=pos-1&error=invalid"), {
    kind: "send-invalid",
    positionId: "pos-1",
  });
  assert.deepEqual(readWalletHandoff("?flow=connect&address=tark1&pubkey=abcd"), { kind: "connect-invalid" });
  assert.equal(hasWalletParams(connect), true);
  assert.equal(hasWalletParams(""), false);

  const stripped = stripWalletParams(
    `https://arkade.trade/?flow=send&position=pos-1&status=sent&txid=${TXID}&dev=1#/positions`,
  );
  assert.equal(stripped, "/?dev=1#/positions");
});
