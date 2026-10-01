/** Deribit BTCUSD index, in cents. Null when the feed does not answer. */
export async function btcUsdCents(signal?: AbortSignal): Promise<bigint | null> {
  const res = await fetch("https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd", { signal });
  if (!res.ok) return null;
  const body = (await res.json()) as { result?: { index_price?: unknown } };
  const usd = Number(body.result?.index_price);
  if (!Number.isFinite(usd) || usd <= 0) return null;
  return BigInt(Math.round(usd * 100));
}
