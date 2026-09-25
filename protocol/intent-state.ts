export type IntentPhase = "open" | "funded" | "expired" | "filled" | "refunded";

export type CoinView = {
  value: bigint;
  spent: boolean;
  spentBy: string;
};

export type TxOutput = {
  amount: bigint;
  script: string;
};

export function classifyIntent(input: {
  coins: CoinView[];
  spends: Record<string, TxOutput[]>;
  collateral: bigint;
  premium: bigint;
  writerScript: string;
  now: number;
  deadline: number;
}): { phase: IntentPhase; refundable: boolean } {
  const writer = input.writerScript.toLowerCase();
  const live = input.coins.find((coin) => !coin.spent && coin.value >= input.collateral);
  if (live) {
    const open = input.now < input.deadline;
    return { phase: open ? "funded" : "expired", refundable: !open };
  }
  const spent = input.coins
    .filter((coin) => coin.spent && coin.value >= input.collateral && coin.spentBy)
    .sort((a, b) => Number(b.value - a.value));
  for (const coin of spent) {
    const outputs = input.spends[coin.spentBy] ?? [];
    const paid = outputs.reduce((sum, output) => (
      output.script.toLowerCase() === writer ? sum + output.amount : sum
    ), 0n);
    if (paid >= coin.value) return { phase: "refunded", refundable: false };
    if (paid >= input.premium) return { phase: "filled", refundable: false };
  }
  return { phase: input.now < input.deadline ? "open" : "expired", refundable: false };
}

function readVarint(bytes: Uint8Array, at: number): [number, number] {
  const first = bytes[at] ?? 0;
  if (first < 0xfd) return [first, at + 1];
  if (first === 0xfd) return [(bytes[at + 1] ?? 0) | ((bytes[at + 2] ?? 0) << 8), at + 3];
  const view = new DataView(bytes.buffer, bytes.byteOffset + at + 1, 4);
  return [view.getUint32(0, true), at + 5];
}

function readAmount(bytes: Uint8Array, at: number): bigint {
  let value = 0n;
  for (let i = 0; i < 8; i++) value |= BigInt(bytes[at + i] ?? 0) << BigInt(8 * i);
  return value;
}

function txOutputs(raw: Uint8Array): TxOutput[] {
  let at = 4;
  if (raw[at] === 0 && raw[at + 1] === 1) at += 2;
  const [inputs, afterInputs] = readVarint(raw, at);
  at = afterInputs;
  for (let i = 0; i < inputs; i++) {
    at += 36;
    const [scriptLen, next] = readVarint(raw, at);
    at = next + scriptLen + 4;
  }
  const [outputs, afterCount] = readVarint(raw, at);
  at = afterCount;
  const parsed: TxOutput[] = [];
  for (let i = 0; i < outputs; i++) {
    const amount = readAmount(raw, at);
    at += 8;
    const [scriptLen, next] = readVarint(raw, at);
    const script = raw.slice(next, next + scriptLen);
    at = next + scriptLen;
    parsed.push({ amount, script: [...script].map((byte) => byte.toString(16).padStart(2, "0")).join("") });
  }
  return parsed;
}

/** Outputs of an indexer virtual transaction. The wire value is a base64 PSBT. */
export function psbtOutputs(b64: string): TxOutput[] {
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (bytes[0] !== 0x70 || bytes[1] !== 0x73 || bytes[2] !== 0x62 || bytes[3] !== 0x74) {
    throw new Error("not a psbt");
  }
  let at = 5;
  let unsigned: Uint8Array | null = null;
  while (at < bytes.length) {
    if (bytes[at] === 0) break;
    const [keyLen, keyAt] = readVarint(bytes, at);
    const key = bytes.slice(keyAt, keyAt + keyLen);
    const [valLen, valAt] = readVarint(bytes, keyAt + keyLen);
    const value = bytes.slice(valAt, valAt + valLen);
    if (key.length === 1 && key[0] === 0) unsigned = value;
    at = valAt + valLen;
  }
  if (!unsigned) throw new Error("psbt has no transaction");
  return txOutputs(unsigned);
}
