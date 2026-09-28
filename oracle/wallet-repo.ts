import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { InMemoryWalletRepository } from "@arkade-os/sdk";

/**
 * In-memory wallet repo that persists `walletState` (including hasPendingTx) under
 * DATA_DIR so a crash between submitTx and finalizeTx can recover on the next boot.
 */
export async function openWalletRepository(dataDir: string): Promise<InMemoryWalletRepository> {
  const dir = path.join(dataDir, "wallet");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "state.json");
  const repo = new InMemoryWalletRepository();
  try {
    await repo.saveWalletState(JSON.parse(await readFile(file, "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const save = repo.saveWalletState.bind(repo);
  repo.saveWalletState = async (state) => {
    await save(state);
    await writeFile(file, `${JSON.stringify(state)}\n`, "utf8");
  };
  return repo;
}
