// Simulated RFQ, used when no desk pubkey is pinned in rfq-config.js.
// A covered call is priced as a vanilla call. A limited put is priced as a
// put spread struck at K and K/2, which matches the payoff until the cap.

import { premiumSats } from "../protocol/pricing.ts";

export { bsCall, bsPut } from "../protocol/pricing.ts";

const DESKS = [
  { name: "Northbridge", vol: 0.48 },
  { name: "Harbor", vol: 0.55 },
  { name: "Kestrel", vol: 0.62 },
];

export function deskQuotes({ kind, spotCents, strikeCents, years, collateralSats }) {
  return DESKS.map((desk) => {
    const { sats, usd } = premiumSats({
      kind,
      spotCents,
      strikeCents,
      years,
      collateralSats,
      vol: desk.vol,
    });
    return { name: desk.name, vol: desk.vol, usd, sats };
  });
}

export function bestQuote(rows, side) {
  return rows.reduce((best, row) => {
    if (side === 0) return row.sats > best.sats ? row : best;
    return row.sats < best.sats ? row : best;
  });
}
