import { toXOnly } from "@arkade-os/sdk";
import { hex } from "@scure/base";

export function bytesToHex(bytes: Uint8Array): string {
  return hex.encode(bytes);
}

export function hexToBytes(value: string): Uint8Array {
  return hex.decode(value);
}

export const xOnly = toXOnly;
