import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

type FileShape = {
  settled: { id: string; txid: string }[];
};

/**
 * Vaults this process has already progressed. The desk is not told.
 * A restart must not submit the same settle again.
 */
export class Progress {
  private readonly done = new Map<string, string>();
  private readonly file: string;
  private writing: Promise<void> = Promise.resolve();

  private constructor(file: string) {
    this.file = file;
  }

  static async open(dir: string): Promise<Progress> {
    await mkdir(dir, { recursive: true });
    const progress = new Progress(path.join(dir, "progress.json"));
    try {
      const parsed = JSON.parse(await readFile(progress.file, "utf8")) as FileShape;
      for (const row of parsed.settled ?? []) {
        if (row && typeof row.id === "string" && typeof row.txid === "string" && row.id && row.txid) {
          progress.done.set(row.id, row.txid);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return progress;
  }

  has(id: string): boolean {
    return this.done.has(id);
  }

  ids(): ReadonlySet<string> {
    return new Set(this.done.keys());
  }

  txid(id: string): string | undefined {
    return this.done.get(id);
  }

  note(id: string, txid: string): void {
    if (!id || !txid || txid.length > 128) return;
    if (!this.done.has(id)) this.done.set(id, txid);
  }

  async save(): Promise<void> {
    const run = this.writing.then(() => this.write());
    this.writing = run.then(() => undefined, () => undefined);
    return run;
  }

  private async write(): Promise<void> {
    const tmp = `${this.file}.${process.pid}.${Date.now().toString(36)}.tmp`;
    const handle = await open(tmp, "w");
    try {
      const settled = [...this.done.entries()].map(([id, txid]) => ({ id, txid }));
      await handle.writeFile(JSON.stringify({ settled }, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, this.file);
  }
}
