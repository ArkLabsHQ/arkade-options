export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(value: string): Uint8Array {
  const hex = value.toLowerCase();
  if (hex.length % 2 !== 0 || /[^0-9a-f]/.test(hex)) {
    throw new Error("hex");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function xOnly(key: Uint8Array): Uint8Array {
  if (key.length === 32) return key;
  if (key.length === 33 && (key[0] === 2 || key[0] === 3)) return key.subarray(1);
  throw new Error(`expected a 32-byte key, got ${key.length}`);
}
