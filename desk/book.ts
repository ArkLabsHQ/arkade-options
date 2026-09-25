import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
  oraclePubkeys: string[];
  intentAddress: string;
  vaultAddress: string;
  status: QuoteStatus;
  fillTxid?: string;
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

export class Book {
  private rows: QuoteRow[] = [];
  private readonly file: string;

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
        || (row.status === "filled" && Boolean(row.fillTxid) && row.expiry > now);
      if (!counted) continue;
      const amount = BigInt(row.collateral);
      total += amount;
      byStrike.set(row.strike, (byStrike.get(row.strike) ?? 0n) + amount);
    }
    return { total, byStrike };
  }

  /** Insert an open quote when the caps still hold. The check and the insert are one step. */
  hold(row: QuoteRow, caps: Caps, now: number): boolean {
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

  async save(): Promise<void> {
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify({ quotes: this.rows }, null, 2));
    await rename(tmp, this.file);
  }
}
