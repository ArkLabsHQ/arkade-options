import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type StoredPrint = {
  pubkey: string;
  price: string;
  time: number;
  sig: string;
  /** Expiries whose fixing used this print. */
  usedFor: number[];
};

export type StoredFixing = {
  expiry: number;
  twap: string;
  txid: string;
  prints: StoredPrint[];
};

export type OracleFile = {
  pubkeys: string[] | null;
  assetId: string | null;
  issueTxid: string | null;
  deployTxid: string | null;
  prints: StoredPrint[];
  fixings: StoredFixing[];
};

export function emptyFile(): OracleFile {
  return { pubkeys: null, assetId: null, issueTxid: null, deployTxid: null, prints: [], fixings: [] };
}

function isPrint(value: unknown): value is StoredPrint {
  if (!value || typeof value !== "object") return false;
  const print = value as StoredPrint;
  return typeof print.pubkey === "string" && typeof print.price === "string" && typeof print.time === "number" && typeof print.sig === "string" && Array.isArray(print.usedFor);
}

function parse(raw: string): OracleFile {
  const body = JSON.parse(raw) as Partial<OracleFile>;
  if (body.pubkeys != null && (!Array.isArray(body.pubkeys) || body.pubkeys.some((item) => typeof item !== "string"))) {
    throw new Error("oracle.json pubkeys");
  }
  if (!Array.isArray(body.prints) || !body.prints.every(isPrint)) throw new Error("oracle.json prints");
  if (!Array.isArray(body.fixings)) throw new Error("oracle.json fixings");
  return {
    pubkeys: body.pubkeys ?? null,
    assetId: typeof body.assetId === "string" ? body.assetId : null,
    issueTxid: typeof body.issueTxid === "string" ? body.issueTxid : null,
    deployTxid: typeof body.deployTxid === "string" ? body.deployTxid : null,
    prints: body.prints,
    fixings: body.fixings as StoredFixing[],
  };
}

export function oraclePath(dir: string): string {
  return path.join(dir, "oracle.json");
}

export async function loadStore(dir: string): Promise<OracleFile> {
  try {
    return parse(await readFile(oraclePath(dir), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyFile();
    throw err;
  }
}

export async function saveStore(dir: string, file: OracleFile): Promise<void> {
  await mkdir(dir, { recursive: true });
  const dest = oraclePath(dir);
  const tmp = `${dest}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2));
  await rename(tmp, dest);
}
