import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

export type StoredSample = {
  price: string;
  time: number;
  sig: string;
};

export type StoredFixing = {
  expiry: number;
  price: string;
  txid: string;
};

export type OracleFile = {
  assetId: string | null;
  issueTxid: string | null;
  deployTxid: string | null;
  samples: StoredSample[];
  fixings: StoredFixing[];
};

const empty = (): OracleFile => ({ assetId: null, issueTxid: null, deployTxid: null, samples: [], fixings: [] });

/** Only this service writes the file, so it is read back as is. */
export async function loadStore(dir: string): Promise<OracleFile> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, "oracle.json"), "utf8")) as Partial<OracleFile>;
    return {
      ...empty(),
      ...parsed,
      samples: Array.isArray(parsed.samples) ? parsed.samples : [],
      fixings: Array.isArray(parsed.fixings) ? parsed.fixings : [],
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return empty();
  }
}

/** Write then fsync the tmp file before rename so a crash cannot leave a torn oracle.json. */
export async function saveStore(dir: string, file: OracleFile): Promise<void> {
  await mkdir(dir, { recursive: true });
  const dest = path.join(dir, "oracle.json");
  const tmp = `${dest}.${process.pid}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(JSON.stringify(file, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, dest);
}
