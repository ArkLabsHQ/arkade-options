import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

export type StoredSample = {
  price: string;
  time: number;
  /** One signature per oracle key, in constructor order. */
  sigs: string[];
};

/** Signed samples older than this are dropped. A day of one-minute prints. */
export const SAMPLE_HISTORY_S = 24 * 60 * 60;

export function pruneSamples(samples: readonly StoredSample[], now: number): StoredSample[] {
  const cutoff = now - SAMPLE_HISTORY_S;
  return samples.filter((sample) => sample.time >= cutoff);
}

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

function normalizeSample(value: unknown): StoredSample | null {
  if (!value || typeof value !== "object") return null;
  const sample = value as { price?: unknown; time?: unknown; sigs?: unknown; sig?: unknown };
  if (typeof sample.price !== "string" || typeof sample.time !== "number") return null;
  const sigs = Array.isArray(sample.sigs)
    ? sample.sigs.filter((item): item is string => typeof item === "string")
    : typeof sample.sig === "string"
      ? [sample.sig]
      : [];
  if (!sigs.length) return null;
  return { price: sample.price, time: sample.time, sigs };
}

/** Only this service writes the file, so it is read back as is. */
export async function loadStore(dir: string): Promise<OracleFile> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, "oracle.json"), "utf8")) as Partial<OracleFile>;
    return {
      ...empty(),
      ...parsed,
      samples: Array.isArray(parsed.samples) ? parsed.samples.map(normalizeSample).filter((sample): sample is StoredSample => sample != null) : [],
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
