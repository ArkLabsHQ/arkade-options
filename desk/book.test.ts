import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Book, type QuoteRow } from "./book.ts";

function row(patch: Partial<QuoteRow> = {}): QuoteRow {
  return {
    rfqId: "aa".repeat(32),
    collateral: "10000000",
    premium: "50000",
    kind: 0,
    strike: "9700000",
    expiry: 2_000,
    deadline: 1_500,
    validUntil: 1_030,
    exit: 512,
    writerPubkey: "11".repeat(32),
    writerPkScript: "5120" + "22".repeat(32),
    holderPubkey: "33".repeat(32),
    oraclePubkeys: ["44", "55", "66", "77", "88"].map((byte) => byte.repeat(32)),
    intentAddress: "tark1intent",
    vaultAddress: "tark1vault",
    status: "open",
    createdAt: 1_000,
    clientPubkey: "99".repeat(32),
    ...patch,
  };
}

test("exposure counts open quotes and unexpired fills, and the cap refuses the next one", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "arkade-book-"));
  try {
    const book = await Book.open(dir);
    const caps = { perStrike: 15_000_000n, total: 20_000_000n };
    assert.equal(book.hold(row(), caps, 1_200), true);
    assert.equal(book.hold(row({ rfqId: "bb".repeat(32), collateral: "10000000" }), caps, 1_200), false);
    book.mark("aa".repeat(32), "filled", "cc".repeat(32));
    assert.equal(book.exposure(1_200).total, 10_000_000n);
    assert.equal(book.hold(row({ rfqId: "dd".repeat(32), strike: "9800000", collateral: "10000000" }), caps, 1_200), true);
    book.mark("aa".repeat(32), "filled");
    const reopened = await Book.open(dir);
    assert.equal(reopened.list().length, 0);
    await book.save();
    const saved = await Book.open(dir);
    assert.equal(saved.list().length, 2);
    assert.equal(saved.get("aa".repeat(32))?.fillTxid, "cc".repeat(32));
    assert.equal(saved.exposure(1_600).total, 10_000_000n);
    assert.equal(saved.exposure(3_000).total, 0n);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
