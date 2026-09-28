/** Counts for one hour of desk activity. Premium and collateral are sats. */
export type HourStats = {
  quotes: number;
  filled: number;
  premium: bigint;
  collateral: bigint;
};

export function emptyHour(): HourStats {
  return { quotes: 0, filled: 0, premium: 0n, collateral: 0n };
}

export function countQuote(stats: HourStats): void {
  stats.quotes += 1;
}

/** A fill that was not already counted. Premium paid and collateral locked are the quote terms. */
export function countFill(stats: HourStats, premium: bigint, collateral: bigint): void {
  stats.filled += 1;
  stats.premium += premium;
  stats.collateral += collateral;
}

export function hourLine(stats: HourStats): string {
  return `hour ${stats.quotes} quotes, ${stats.filled} filled, ${stats.premium} premium paid, ${stats.collateral} collateral locked`;
}

/** Milliseconds until the next UTC hour. An exact hour waits a full hour. */
export function msUntilNextHour(now = Date.now()): number {
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  const wait = next.getTime() - now;
  return wait > 0 ? wait : 60 * 60 * 1000;
}
