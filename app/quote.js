// A covered call is priced as a vanilla call. A limited put is priced as a
// put spread struck at K and K/2, which matches the payoff until the cap.
// The page and the desk take that premium from the Deribit mark.

export { bsCall, bsPut } from "../protocol/pricing.ts";

export function bestQuote(rows, side) {
  return rows.reduce((best, row) => {
    if (side === 0) return row.sats > best.sats ? row : best;
    return row.sats < best.sats ? row : best;
  });
}
