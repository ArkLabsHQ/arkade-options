/** Black-Scholes, r = 0. A covered call is a vanilla call. A limited put is the put spread K against K/2. */

function erf(x: number) {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-a * a);
  return sign * y;
}

function normCdf(x: number) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export function bsCall(spot: number, strike: number, years: number, vol: number) {
  if (years <= 0 || vol <= 0 || spot <= 0 || strike <= 0) return Math.max(0, spot - strike);
  const s = vol * Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (0.5 * vol * vol * years)) / s;
  const d2 = d1 - s;
  return spot * normCdf(d1) - strike * normCdf(d2);
}

export function bsPut(spot: number, strike: number, years: number, vol: number) {
  return bsCall(spot, strike, years, vol) - spot + strike;
}

/** Per-tenor implied vol the desk quotes with. Shorter options use a higher vol. */
export function tenorVol(years: number) {
  const days = years * 365;
  if (days <= 7) return 0.62;
  if (days <= 30) return 0.55;
  if (days <= 90) return 0.48;
  return 0.45;
}

export function premiumSats(input: {
  kind: 0 | 1;
  spotCents: number;
  strikeCents: number;
  years: number;
  collateralSats: bigint;
  vol: number;
}): { sats: bigint; usd: number } {
  const spot = input.spotCents / 100;
  const strike = input.strikeCents / 100;
  const notional = Number(input.collateralSats) / 1e8;
  const usd = input.kind === 0
    ? bsCall(spot, strike, input.years, input.vol) * notional
    : Math.max(0, bsPut(spot, strike, input.years, input.vol) - bsPut(spot, strike / 2, input.years, input.vol)) * notional;
  const sats = BigInt(Math.max(0, Math.round((usd / spot) * 1e8)));
  return { sats, usd };
}
