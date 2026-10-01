import assert from "node:assert/strict";
import test from "node:test";

import { rehearseRoundtrip } from "./roundtrip.ts";

test("a simulated price settles the vault through the oracle", async () => {
  const report = await rehearseRoundtrip();
  assert.equal(report.mode, "rehearsal");
  assert.equal(report.price, "10000000");
  assert.equal(report.holder, "600");
  assert.equal(report.writer, "18400");
  assert.equal(report.beacon, "1330");
  assert.equal(report.readFee, "1000");
  assert.equal(report.publishTxid.length, 64);
  assert.equal(report.settleTxid.length, 64);
});
