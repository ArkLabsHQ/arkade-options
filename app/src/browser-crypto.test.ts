import assert from "node:assert/strict";
import { createHash as nodeHash } from "node:crypto";
import test from "node:test";

import { createHash } from "./browser-crypto.ts";

test("page sha256 matches node:crypto", () => {
  for (const text of ["", "abc", "BTCUSD-FIX", "a".repeat(1000)]) {
    const bytes = new TextEncoder().encode(text);
    const want = new Uint8Array(nodeHash("sha256").update(bytes).digest());
    const got = createHash("sha256").update(bytes).digest();
    assert.deepEqual(got, want);
  }
});
