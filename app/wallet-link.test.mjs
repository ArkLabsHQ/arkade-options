import assert from "node:assert/strict";
import test from "node:test";

import { callbackAllowed, readWalletHandoff, stripWalletParams, walletAppUrl } from "./src/wallet-link.ts";

const ADDRESS =
  "tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf848nste9qrnlrjwdc39u8pmyczeuwf2g4cfjhqa8esm8mt05u9ev8d3v5pf";
const PUBKEY = "ab".repeat(32);
const TXID = "cd".repeat(32);
const ORIGIN = "https://mutinynet.arkade.money";

test("a wallet link encodes the callback, and a denial drops the address", () => {
  const connect = new URL(walletAppUrl(ORIGIN, "connect", "https://arkade.trade/?flow=connect"));
  assert.equal(connect.origin, ORIGIN);
  assert.equal(connect.searchParams.get("action"), "connect");
  assert.equal(connect.searchParams.get("callback"), "https://arkade.trade/?flow=connect");

  const request = `bitcoin:?ark=${ADDRESS}&amount=0.00000001`;
  const send = walletAppUrl(ORIGIN, "send", "http://127.0.0.1:4173/?flow=send&position=pos-1", request);
  const parsed = new URL(send);
  assert.equal(parsed.searchParams.get("action"), "send");
  assert.equal(parsed.searchParams.get("request"), request);
  assert.equal(send.includes("request=bitcoin:?"), false);

  assert.equal(callbackAllowed("http://192.168.1.20/"), false);
  assert.throws(() => walletAppUrl(ORIGIN, "connect", "http://192.168.1.20/"), /return/);

  assert.deepEqual(readWalletHandoff(`?flow=connect&address=${ADDRESS}&pubkey=${PUBKEY.toUpperCase()}`), {
    kind: "connect",
    address: ADDRESS,
    pubkey: PUBKEY,
  });
  assert.deepEqual(readWalletHandoff(`?flow=connect&error=denied&address=${ADDRESS}&pubkey=${PUBKEY}`), {
    kind: "connect-error",
  });
  assert.deepEqual(readWalletHandoff(`?flow=send&position=pos-1&status=sent&txid=${TXID}`), {
    kind: "sent",
    positionId: "pos-1",
    txid: TXID,
  });
  assert.equal(
    stripWalletParams(`https://arkade.trade/?flow=send&position=pos-1&status=sent&txid=${TXID}&dev=1#/positions`),
    "/?dev=1#/positions",
  );
});
