import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

export type QuoteStatus = "open" | "filled" | "expired";

export type QuoteRow = {
  rfqId: string;
  collateral: string;
  premium: string;
  kind: 0 | 1;
  strike: string;
  expiry: number;
  deadline: number;
  validUntil: number;
  exit: number;
  writerPubkey: string;
  writerPkScript: string;
  holderPubkey: string;
  /** Display txid of the beacon identity asset. */
  beaconTxid: string;
  beaconGidx: number;
  intentAddress: string;
  vaultAddress: string;
  status: QuoteStatus;
  fillTxid?: string;
  /** Arkade tx that spent the vault: settle, or a close / unilateral observed later. */
  settleTxid?: string;
  createdAt: number;
  clientPubkey: string;
};

export type Caps = {
  perStrike: bigint;
  total: bigint;
};

type FileShape = {
  quotes: QuoteRow[];
};

/** Old book rows predate the beacon field. They cannot be registered. */
export function hasBeacon(row: QuoteRow): boolean {
  return /^[0-9a-f]{64}$/.test(row.beaconTxid ?? "") && Number.isInteger(row.beaconGidx) && row.beaconGidx >= 0 && row.beaconGidx <= 65_535;
}

/** Still binding float or vault exposure for this rfqId. A recorded settle releases it. */
export function liveQuote(row: QuoteRow, now: number): boolean {
  if (row.status === "open") return row.deadline > now;
  if (row.status === "filled") {
    if (row.settleTxid) return false;
    if (!row.fillTxid) return true;
    return row.expiry > now;
  }
  return false;
}

export class Book {
  private rows: QuoteRow[] = [];
  private readonly file: string;
  private writing: Promise<void> = Promise.resolve();

  private constructor(file: string) {
    this.file = file;
  }

  static async open(dir: string): Promise<Book> {
    await mkdir(dir, { recursive: true });
    const book = new Book(path.join(dir, "book.json"));
    try {
      const parsed = JSON.parse(await readFile(book.file, "utf8")) as FileShape;
      book.rows = Array.isArray(parsed.quotes) ? parsed.quotes : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return book;
  }

  get(rfqId: string): QuoteRow | undefined {
    return this.rows.find((row) => row.rfqId === rfqId);
  }

  list(): QuoteRow[] {
    return this.rows;
  }

  exposure(now: number): { total: bigint; byStrike: Map<string, bigint> } {
    const byStrike = new Map<string, bigint>();
    let total = 0n;
    for (const row of this.rows) {
      const counted = (row.status === "open" && row.deadline > now)
        || (row.status === "filled" && Boolean(row.fillTxid) && !row.settleTxid && row.expiry > now);
      if (!counted) continue;
      const amount = BigInt(row.collateral);
      total += amount;
      byStrike.set(row.strike, (byStrike.get(row.strike) ?? 0n) + amount);
    }
    return { total, byStrike };
  }

  /** One rfqId, one row. Refuses while a same-id quote is still live; replaces dead ones. */
  hold(row: QuoteRow, caps: Caps, now: number): boolean {
    const prior = this.rows.find((item) => item.rfqId === row.rfqId);
    if (prior && liveQuote(prior, now)) return false;
    if (prior) this.rows = this.rows.filter((item) => item.rfqId !== row.rfqId);
    const amount = BigInt(row.collateral);
    const { total, byStrike } = this.exposure(now);
    const strike = (byStrike.get(row.strike) ?? 0n) + amount;
    if (strike > caps.perStrike || total + amount > caps.total) return false;
    this.rows.push(row);
    return true;
  }

  mark(rfqId: string, status: QuoteStatus, fillTxid?: string): QuoteRow | undefined {
    const row = this.get(rfqId);
    if (!row) return undefined;
    row.status = status;
    if (fillTxid) row.fillTxid = fillTxid;
    return row;
  }

  /** Remember the spend that closed the vault. The first txid sticks. */
  noteSettle(rfqId: string, txid: string): QuoteRow | undefined {
    const row = this.get(rfqId);
    if (!row || row.status !== "filled" || !txid || txid.length > 128) return undefined;
    if (!row.settleTxid) row.settleTxid = txid;
    return row;
  }

  async save(): Promise<void> {
    const run = this.writing.then(() => this.write());
    this.writing = run.then(() => undefined, () => undefined);
    return run;
  }

  private async write(): Promise<void> {
    const tmp = `${this.file}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(16).slice(2)}.tmp`;
    const handle = await open(tmp, "w");
    try {
      await handle.writeFile(JSON.stringify({ quotes: this.rows }, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, this.file);
  }
}
