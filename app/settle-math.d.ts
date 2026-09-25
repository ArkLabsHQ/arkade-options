export function holderPayoff(kind: number, settlement: bigint, strike: bigint, collateral: bigint): bigint;
export function oraclePreimage(price: bigint, time: bigint): Uint8Array;
export function settlementOutputs(ph: bigint, locked: bigint): {
  mode: "split" | "writer" | "holder";
  holder: bigint;
  writer: bigint;
};
export function twap(m0: bigint, m1: bigint, m2: bigint): bigint;
export function windows(expiry: bigint): Record<"open" | "mid" | "close", [bigint, bigint]>;
