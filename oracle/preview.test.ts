import assert from "node:assert/strict";
import test from "node:test";

import { BEACON_READ_FEE } from "../protocol/constants.ts";
import { previewFromFields, previewSettlement } from "./preview.ts";

const collateral = 100_000n;

test("covered call preview subtracts the 1000-sat read fee before the split", () => {
  const seen = previewSettlement({ kind: 0, price: 20_000n, strike: 10_000n, collateral });
  assert.deepEqual(seen, {
    holder: 50_000n,
    writer: 49_000n,
    mode: "split",
    readFee: BEACON_READ_FEE,
  });
});

test("a call at or below the strike pays the writer the pot", () => {
  const seen = previewSettlement({ kind: 0, price: 10_000n, strike: 10_000n, collateral });
  assert.deepEqual(seen, {
    holder: 0n,
    writer: collateral - BEACON_READ_FEE,
    mode: "writer",
    readFee: BEACON_READ_FEE,
  });
});

test("a limited put caps the holder and folds a dust writer leg", () => {
  const seen = previewSettlement({ kind: 1, price: 4_000n, strike: 10_000n, collateral });
  assert.deepEqual(seen, {
    holder: collateral - BEACON_READ_FEE,
    writer: 0n,
    mode: "holder",
    readFee: BEACON_READ_FEE,
  });
});

test("a holder leg at or below dust is paid to the writer", () => {
  const seen = previewSettlement({ kind: 0, price: 1_000_000n, strike: 999_000n, collateral: 10_000n });
  assert.ok(!("error" in seen));
  if ("error" in seen) return;
  assert.equal(seen.holder, 0n);
  assert.equal(seen.writer, 10_000n - BEACON_READ_FEE);
  assert.equal(seen.mode, "writer");
});

test("page fields preview without publishing", () => {
  const seen = previewFromFields({
    kind: "0",
    price: "20000",
    strike: "10000",
    collateral: "100000",
  });
  assert.deepEqual(seen, {
    holder: 50_000n,
    writer: 49_000n,
    mode: "split",
    readFee: 1_000n,
  });
  assert.deepEqual(previewFromFields({ kind: "0", price: "", strike: "1", collateral: "100000" }), { error: "price" });
  assert.deepEqual(previewFromFields({ kind: "2", price: "1", strike: "1", collateral: "100000" }), { error: "kind" });
});
