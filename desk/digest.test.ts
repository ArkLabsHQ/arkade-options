import assert from "node:assert/strict";
import test from "node:test";

import { countFill, countQuote, emptyHour, hourLine, msUntilNextHour } from "./digest.ts";

test("an hour line reports quotes, fills, premium paid, and collateral locked", () => {
  const stats = emptyHour();
  countQuote(stats);
  countQuote(stats);
  countFill(stats, 1_500n, 10_000_000n);
  assert.equal(
    hourLine(stats),
    "hour 2 quotes, 1 filled, 1500 premium paid, 10000000 collateral locked",
  );
});

test("a quiet hour still has a line", () => {
  assert.equal(hourLine(emptyHour()), "hour 0 quotes, 0 filled, 0 premium paid, 0 collateral locked");
});

test("the digest waits until the next UTC hour", () => {
  const now = Date.parse("2026-09-28T10:17:30.000Z");
  assert.equal(msUntilNextHour(now), 42 * 60 * 1000 + 30_000);
  assert.equal(msUntilNextHour(Date.parse("2026-09-28T11:00:00.000Z")), 60 * 60 * 1000);
});
