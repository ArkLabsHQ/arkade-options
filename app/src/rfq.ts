import { generateSecretKey } from "nostr-tools/pure";

import { DUST_SATS, EXIT, PAIR } from "../../protocol/constants.ts";
import { bindContracts } from "../../protocol/contracts.ts";
import { bytesToHex, hexToBytes } from "../../protocol/hex.ts";
import type { RfqQuote, RfqRefusal, RfqRequest } from "../../protocol/messages.ts";
import { collectReplies } from "../../protocol/nostr.ts";
import { arkKeys, writerProfile } from "./fund.ts";

export type LiveQuote = {
  name: string;
  pubkey: string;
  sats: bigint;
  usd: number;
  validUntil: number;
  deadline: number;
  exit: number;
  holderPkHex: string;
  oraclePkHex: string[];
  intentAddress: string;
  vaultAddress: string;
};

function randomId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function isQuote(value: unknown): value is RfqQuote {
  return Boolean(value && typeof value === "object" && (value as { type?: string }).type === "rfq_quote");
}

function isRefusal(value: unknown): value is RfqRefusal {
  return Boolean(value && typeof value === "object" && (value as { type?: string }).type === "rfq_refusal");
}

/**
 * Ask the pinned desks. The deposit address is derived here from the quote's
 * binding fields. A quote whose address does not match is dropped.
 */
export async function requestQuotes(input: {
  relays: string[];
  desks: { name: string; pubkey: string }[];
  kind: 0 | 1;
  strike: bigint;
  collateral: bigint;
  expiry: bigint;
  spotCents: bigint;
  writerHex: string;
}): Promise<{ quotes: LiveQuote[]; note: string }> {
  const names = new Map(input.desks.map((desk) => [desk.pubkey, desk.name]));
  const [profile, keys] = await Promise.all([
    writerProfile(input.writerHex),
    arkKeys(input.writerHex),
  ]);
  const request: RfqRequest = {
    v: 1,
    type: "rfq_request",
    rfq_id: randomId(),
    pair: PAIR,
    amount_side: "from",
    amount: input.collateral.toString(),
    profile: {
      kind: input.kind,
      strike: Number(input.strike),
      expiry: Number(input.expiry),
      writer_pubkey: profile.pubkey,
      writer_pk_script: profile.pkScript,
    },
  };
  const secret = generateSecretKey();
  const acceptId = request.rfq_id;
  let replies = await collectReplies({
    relays: input.relays,
    secretKey: secret,
    recipients: input.desks.map((desk) => desk.pubkey),
    payload: request,
    timeoutMs: 8_000,
    accept: (incoming) => messageId(incoming.message) === acceptId,
  });
  if (replies.length === 0) {
    replies = await collectReplies({
      relays: input.relays,
      secretKey: secret,
      recipients: input.desks.map((desk) => desk.pubkey),
      payload: request,
      timeoutMs: 8_000,
      accept: (incoming) => messageId(incoming.message) === acceptId,
    });
  }
  const now = Math.floor(Date.now() / 1000);
  const quotes: LiveQuote[] = [];
  const reasons: string[] = [];
  for (const incoming of replies) {
    if (!names.has(incoming.from)) continue;
    if (isRefusal(incoming.message)) {
      reasons.push(incoming.message.reason);
      continue;
    }
    if (!isQuote(incoming.message)) continue;
    const quote = incoming.message;
    if (quote.from_amount !== request.amount) continue;
    if (quote.solver_pubkey !== incoming.from || quote.profile.holder_pubkey !== incoming.from) continue;
    if (quote.valid_until <= now || quote.profile.deadline < now + 120) continue;
    if (quote.profile.exit !== Number(EXIT)) continue;
    const premium = BigInt(quote.to_amount);
    if (premium <= DUST_SATS) continue;
    let bound;
    try {
      bound = bindContracts({
        kind: input.kind,
        strike: input.strike,
        collateral: input.collateral,
        premium,
        expiry: input.expiry,
        deadline: BigInt(quote.profile.deadline),
        exit: EXIT,
        writerPk: hexToBytes(profile.pubkey),
        holderPk: hexToBytes(quote.profile.holder_pubkey),
        oraclePks: quote.profile.oracle_pubkeys.map((pk) => hexToBytes(pk)),
        serverKey: keys.serverKey,
        emulatorKey: keys.emulatorKey,
      });
    } catch {
      continue;
    }
    if (bound.intentAddress !== quote.profile.intent_address) continue;
    if (bound.vaultAddress !== quote.profile.vault_address) continue;
    if (bytesToHex(bound.holderPkScript) !== quote.profile.holder_pk_script) continue;
    const spot = Number(input.spotCents) / 100;
    quotes.push({
      name: names.get(incoming.from) ?? incoming.from.slice(0, 8),
      pubkey: incoming.from,
      sats: premium,
      usd: Number(premium) / 1e8 * spot,
      validUntil: quote.valid_until,
      deadline: quote.profile.deadline,
      exit: quote.profile.exit,
      holderPkHex: quote.profile.holder_pubkey,
      oraclePkHex: quote.profile.oracle_pubkeys,
      intentAddress: quote.profile.intent_address,
      vaultAddress: quote.profile.vault_address,
    });
  }
  if (quotes.length === 0) {
    return { quotes, note: reasons[0] ? `The desk refused: ${reasons[0]}.` : "The desk did not answer." };
  }
  return { quotes, note: "" };
}

function messageId(message: { rfq_id?: string }): string | undefined {
  return message.rfq_id;
}
