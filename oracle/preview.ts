import { holderPayoff, settlementOutputs } from "../app/settle-math.js";
import { BEACON_READ_FEE, DUST_SATS, PRICE_MAX, Q_MAX } from "../protocol/constants.ts";

/** Amounts the vault pays. Same split as option_vault.ark: payoff, then the read fee, then dust. */
export type SettlementPreview = {
  holder: bigint;
  writer: bigint;
  mode: "split" | "holder" | "writer";
  readFee: bigint;
};

const WHOLE = /^(0|[1-9][0-9]*)$/;

function whole(raw: string, label: string): bigint | { error: string } {
  const text = raw.trim();
  if (!WHOLE.test(text)) return { error: label };
  return BigInt(text);
}

/**
 * Holder and writer sats for one typed price.
 * `locked` is the vault coin. A filled vault locks the collateral, so that is the default.
 * The 1000-sat read fee leaves the vault before the split. This does not sample or publish.
 */
export function previewSettlement(input: {
  kind: 0 | 1;
  price: bigint;
  strike: bigint;
  collateral: bigint;
  locked?: bigint;
}): SettlementPreview | { error: string } {
  if (input.kind !== 0 && input.kind !== 1) return { error: "kind" };
  if (input.price <= 0n || input.price > PRICE_MAX) return { error: "price" };
  if (input.strike <= 0n || input.strike > PRICE_MAX) return { error: "strike" };
  if (input.collateral <= DUST_SATS || input.collateral > Q_MAX) return { error: "collateral" };
  const locked = input.locked ?? input.collateral;
  if (locked < input.collateral) return { error: "underfunded" };
  if (locked < BEACON_READ_FEE) return { error: "fee" };
  const ph = holderPayoff(input.kind, input.price, input.strike, input.collateral);
  if (ph > input.collateral) return { error: "holder overpaid" };
  const split = settlementOutputs(ph, locked, BEACON_READ_FEE);
  return {
    holder: split.holder,
    writer: split.writer,
    mode: split.mode,
    readFee: BEACON_READ_FEE,
  };
}

/** Field strings from the oracle page. Invalid input is an error string, not a publish. */
export function previewFromFields(fields: {
  kind: string;
  price: string;
  strike: string;
  collateral: string;
}): SettlementPreview | { error: string } {
  if (fields.kind !== "0" && fields.kind !== "1") return { error: "kind" };
  const price = whole(fields.price, "price");
  if (typeof price !== "bigint") return price;
  const strike = whole(fields.strike, "strike");
  if (typeof strike !== "bigint") return strike;
  const collateral = whole(fields.collateral, "collateral");
  if (typeof collateral !== "bigint") return collateral;
  return previewSettlement({ kind: fields.kind === "1" ? 1 : 0, price, strike, collateral });
}
