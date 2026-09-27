import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type StoredPrint = {
  pubkey: string;
  price: string;
  time: number;
  sig: string;
};

export type StoredFixing = {
  expiry: number;
  twap: string;
  txid: string;
};

export type OracleFile = {
  pubkeys: string[] | null;
  assetId: string | null;
  issueTxid: string | null;
  deployTxid: string | null;
  prints: StoredPrint[];
  fixings: StoredFixing[];
};

const empty = (): OracleFile => ({ pubkeys: null, assetId: null, issueTxid: null, deployTxid: null, prints: [], fixings: [] });

/** Only this service writes the file, so it is read back as is. */
export async function loadStore(dir: string): Promise<OracleFile> {
  try {
    return { ...empty(), ...(JSON.parse(await readFile(path.join(dir, "oracle.json"), "utf8")) as Partial<OracleFile>) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return empty();
    throw err;
  }
}

export async function saveStore(dir: string, file: OracleFile): Promise<void> {
  await mkdir(dir, { recursive: true });
  const dest = path.join(dir, "oracle.json");
  const tmp = `${dest}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2));
  await rename(tmp, dest);
}
