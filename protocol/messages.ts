import { DUST_SATS, EXIT, PAIR, PRICE_MAX, Q_MAX, Q_MIN } from "./constants.ts";

const HEX64 = /^[0-9a-f]{64}$/;
const AMOUNT = /^[1-9][0-9]{0,15}$/;
const SCRIPT = /^51[0-9a-f]{66}$/;

export type RequestProfile = {
  kind: 0 | 1;
  strike: number;
  expiry: number;
  writer_pubkey: string;
  writer_pk_script: string;
};

export type QuoteProfile = {
  holder_pubkey: string;
  holder_pk_script: string;
  /** Display txid of the beacon identity asset. The vault compares it reversed. */
  beacon_txid: string;
  beacon_gidx: number;
  deadline: number;
  exit: number;
  intent_address: string;
  vault_address: string;
};

export type RfqRequest = {
  v: 1;
  type: "rfq_request";
  rfq_id: string;
  pair: typeof PAIR;
  amount_side: "from";
  amount: string;
  profile: RequestProfile;
};

export type RfqQuote = {
  v: 1;
  type: "rfq_quote";
  rfq_id: string;
  pair: typeof PAIR;
  from_amount: string;
  to_amount: string;
  solver_pubkey: string;
  valid_until: number;
  profile: QuoteProfile;
};

export type RfqRefusal = {
  v: 1;
  type: "rfq_refusal";
  rfq_id: string;
  reason: string;
};

export type RfqStatusRequest = {
  v: 1;
  type: "rfq_status_request";
  rfq_id: string;
};

export type RfqStatus = {
  v: 1;
  type: "rfq_status";
  rfq_id: string;
  status: "open" | "filled" | "expired";
  txid?: string;
};

/** A filled vault, published in the clear. The sealed RFQ is not this record. */
export type OptionPosition = {
  v: 1;
  type: "option_position";
  rfq_id: string;
  pair: typeof PAIR;
  kind: 0 | 1;
  collateral: string;
  strike: string;
  expiry: number;
  exit: number;
  writer_pubkey: string;
  writer_pk_script: string;
  holder_pubkey: string;
  beacon_txid: string;
  beacon_gidx: number;
  vault_address: string;
  fill_txid: string;
};

export type Wire = RfqRequest | RfqQuote | RfqRefusal | RfqStatusRequest | RfqStatus;

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hex64(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}

function amount(value: unknown): value is string {
  return typeof value === "string" && AMOUNT.test(value);
}

function int(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function script(value: unknown): value is string {
  return typeof value === "string" && SCRIPT.test(value);
}

function address(value: unknown): value is string {
  return typeof value === "string" && value.length >= 10 && value.length <= 120 && /^[a-z0-9]+$/.test(value);
}

export function parseWire(value: unknown): Wire | null {
  const body = record(value);
  if (!body || body.v !== 1 || typeof body.type !== "string") return null;
  if (body.type === "rfq_request") return parseRequest(body);
  if (body.type === "rfq_quote") return parseQuote(body);
  if (body.type === "rfq_refusal") return parseRefusal(body);
  if (body.type === "rfq_status_request") return parseStatusRequest(body);
  if (body.type === "rfq_status") return parseStatus(body);
  return null;
}

function parseRequest(body: Record<string, unknown>): RfqRequest | null {
  const profile = record(body.profile);
  if (!profile) return null;
  if (!hex64(body.rfq_id) || body.pair !== PAIR || body.amount_side !== "from" || !amount(body.amount)) return null;
  if (profile.kind !== 0 && profile.kind !== 1) return null;
  if (!int(profile.strike, Number(PRICE_MAX)) || profile.strike <= 0) return null;
  if (!int(profile.expiry, 4_000_000_000) || profile.expiry <= 1800) return null;
  if (!hex64(profile.writer_pubkey) || !script(profile.writer_pk_script)) return null;
  return {
    v: 1,
    type: "rfq_request",
    rfq_id: body.rfq_id,
    pair: PAIR,
    amount_side: "from",
    amount: body.amount,
    profile: {
      kind: profile.kind,
      strike: profile.strike,
      expiry: profile.expiry,
      writer_pubkey: profile.writer_pubkey,
      writer_pk_script: profile.writer_pk_script,
    },
  };
}

function parseQuote(body: Record<string, unknown>): RfqQuote | null {
  const profile = record(body.profile);
  if (!profile) return null;
  if (!hex64(body.rfq_id) || body.pair !== PAIR || !amount(body.from_amount) || !amount(body.to_amount)) return null;
  if (!hex64(body.solver_pubkey) || !int(body.valid_until, 4_000_000_000)) return null;
  if (!hex64(profile.holder_pubkey) || !script(profile.holder_pk_script)) return null;
  if (!hex64(profile.beacon_txid) || !int(profile.beacon_gidx, 65_535)) return null;
  if (!int(profile.deadline, 4_000_000_000) || profile.exit !== Number(EXIT)) return null;
  if (!address(profile.intent_address) || !address(profile.vault_address)) return null;
  return {
    v: 1,
    type: "rfq_quote",
    rfq_id: body.rfq_id,
    pair: PAIR,
    from_amount: body.from_amount,
    to_amount: body.to_amount,
    solver_pubkey: body.solver_pubkey,
    valid_until: body.valid_until,
    profile: {
      holder_pubkey: profile.holder_pubkey,
      holder_pk_script: profile.holder_pk_script,
      beacon_txid: profile.beacon_txid,
      beacon_gidx: profile.beacon_gidx,
      deadline: profile.deadline,
      exit: profile.exit,
      intent_address: profile.intent_address,
      vault_address: profile.vault_address,
    },
  };
}

function parseRefusal(body: Record<string, unknown>): RfqRefusal | null {
  if (!hex64(body.rfq_id) || typeof body.reason !== "string" || body.reason.length === 0 || body.reason.length > 160) {
    return null;
  }
  return { v: 1, type: "rfq_refusal", rfq_id: body.rfq_id, reason: body.reason };
}

function parseStatusRequest(body: Record<string, unknown>): RfqStatusRequest | null {
  if (!hex64(body.rfq_id)) return null;
  return { v: 1, type: "rfq_status_request", rfq_id: body.rfq_id };
}

export function parsePosition(value: unknown): OptionPosition | null {
  const body = record(value);
  if (!body || body.v !== 1 || body.type !== "option_position" || body.pair !== PAIR) return null;
  if (!hex64(body.rfq_id) || (body.kind !== 0 && body.kind !== 1)) return null;
  if (!amount(body.collateral) || !amount(body.strike)) return null;
  if (!int(body.expiry, 4_000_000_000) || !int(body.exit, 4_000_000_000)) return null;
  if (!hex64(body.writer_pubkey) || !script(body.writer_pk_script)) return null;
  if (!hex64(body.holder_pubkey) || !hex64(body.beacon_txid) || !int(body.beacon_gidx, 65_535)) return null;
  if (!address(body.vault_address) || !hex64(body.fill_txid)) return null;
  return {
    v: 1,
    type: "option_position",
    rfq_id: body.rfq_id.toLowerCase(),
    pair: PAIR,
    kind: body.kind,
    collateral: body.collateral,
    strike: body.strike,
    expiry: body.expiry,
    exit: body.exit,
    writer_pubkey: body.writer_pubkey.toLowerCase(),
    writer_pk_script: body.writer_pk_script.toLowerCase(),
    holder_pubkey: body.holder_pubkey.toLowerCase(),
    beacon_txid: body.beacon_txid.toLowerCase(),
    beacon_gidx: body.beacon_gidx,
    vault_address: body.vault_address,
    fill_txid: body.fill_txid.toLowerCase(),
  };
}

function parseStatus(body: Record<string, unknown>): RfqStatus | null {
  if (!hex64(body.rfq_id)) return null;
  if (body.status !== "open" && body.status !== "filled" && body.status !== "expired") return null;
  if (body.txid !== undefined && !hex64(body.txid)) return null;
  return {
    v: 1,
    type: "rfq_status",
    rfq_id: body.rfq_id,
    status: body.status,
    ...(body.txid ? { txid: body.txid } : {}),
  };
}

/** Why a parsed request is not quotable. Empty string means the desk may price it. */
export function requestRefusal(message: RfqRequest, now: number): string {
  const collateral = BigInt(message.amount);
  if (collateral < Q_MIN || collateral > Q_MAX) return "collateral";
  if (message.profile.expiry <= now + 1800) return "expiry";
  return "";
}

export function premiumRefusal(sats: bigint, collateral?: bigint): string {
  if (sats <= DUST_SATS) return "premium below dust";
  if (collateral != null && sats >= collateral) return "premium";
  return "";
}
