import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  SQLiteContractRepository,
  SQLiteIntentRepository,
  SQLiteWalletRepository,
  type SQLExecutor,
} from "@arkade-os/sdk/repositories/sqlite";

/** Open a WAL sqlite file under `dataDir` and return SDK repositories backed by it. */
export async function openSqliteStorage(dataDir: string, name = "arkade.sqlite") {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, name);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  const executor: SQLExecutor = {
    async run(sql, params) {
      db.prepare(sql).run(...(params ?? []));
    },
    async get(sql, params) {
      return db.prepare(sql).get(...(params ?? [])) as Record<string, unknown> | undefined;
    },
    async all(sql, params) {
      return db.prepare(sql).all(...(params ?? [])) as Record<string, unknown>[];
    },
  };
  return {
    file,
    db,
    walletRepository: new SQLiteWalletRepository(executor),
    contractRepository: new SQLiteContractRepository(executor),
    intentRepository: new SQLiteIntentRepository(executor),
  };
}
