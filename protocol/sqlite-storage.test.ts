import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openSqliteStorage } from "./sqlite-storage.ts";

test("sqlite storage persists wallet state across opens", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sqlite-"));
  try {
    const first = await openSqliteStorage(dir);
    await first.walletRepository.saveWalletState({ settings: { hasPendingTx: true } });
    first.db.close();

    const second = await openSqliteStorage(dir);
    const state = await second.walletRepository.getWalletState();
    assert.equal(state?.settings?.hasPendingTx, true);
    second.db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
