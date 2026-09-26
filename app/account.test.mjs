import assert from "node:assert/strict";
import test from "node:test";

import { clearAddress, parseWriterAddress, paymentUri, readAddress, saveAddress } from "./src/fund.ts";

const ADDRESS =
  "tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf848nste9qrnlrjwdc39u8pmyczeuwf2g4cfjhqa8esm8mt05u9ev8d3v5pf";

function memory() {
  const box = new Map();
  return {
    getItem: (key) => (box.has(key) ? box.get(key) : null),
    setItem: (key, value) => box.set(key, value),
    removeItem: (key) => box.delete(key),
  };
}

test("a deposit link is the SDK BIP21 form, including one sat", () => {
  assert.equal(paymentUri(ADDRESS, 20_000n), `bitcoin:?ark=${ADDRESS}&amount=0.0002`);
  assert.equal(paymentUri(ADDRESS, 1n), `bitcoin:?ark=${ADDRESS}&amount=0.00000001`);
});

test("a Mutinynet address is saved and a key is refused", () => {
  globalThis.localStorage = memory();
  assert.throws(() => saveAddress("ab".repeat(32)), /tark/);
  assert.throws(() => parseWriterAddress("not an address"), /tark/);
  assert.equal(readAddress(), null);
  assert.equal(saveAddress(`  ${ADDRESS.toUpperCase()}  `), ADDRESS);
  assert.equal(readAddress(), ADDRESS);
  clearAddress();
  assert.equal(readAddress(), null);
});
