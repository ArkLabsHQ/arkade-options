import {
  ArkAddress,
  arkade,
  networks,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  SingleKey,
} from "@arkade-os/sdk";

import { ARK_URL, EMULATOR_URL, EXIT } from "../../protocol/constants.ts";
import { assertServerExit, bindContracts, payoutVtxo, type Terms } from "../../protocol/contracts.ts";
import { bytesToHex, hexToBytes, xOnly } from "../../protocol/hex.ts";
import { intentProgram, vaultProgram } from "./program.ts";

export const NETWORK_NAME = "Mutinynet";
export const WALLET_URL = "https://mutinynet.arkade.money";

const HOLDER = SingleKey.fromHex("0000000000000000000000000000000000000000000000000000000000000021");
const ORACLES = [0x31, 0x32, 0x33, 0x34, 0x35].map((n) =>
  SingleKey.fromHex(n.toString(16).padStart(64, "0")),
);

export type FundRequest = {
  kind: 0 | 1;
  strike: bigint;
  collateral: bigint;
  premium: bigint;
  expiry: bigint;
  deadline: bigint;
  /** Pasted Mutinynet address. Premium and settlement pay its taproot key. */
  writerAddress?: string;
  /** Older positions that stored a private key. */
  writerHex?: string;
  holderPkHex?: string;
  oraclePkHex?: string[];
  exit?: bigint;
};

export type Deposit = {
  network: typeof NETWORK_NAME;
  address: string;
  vaultAddress: string;
  amountSats: bigint;
  uri: string;
  holderPkHex: string;
  oraclePkHex: string[];
  exit: number;
};

export type WriterBinding = {
  pubkey: string;
  pkScript: string;
  address: string;
  payoutKey: Uint8Array;
  serverKey: Uint8Array;
  emulatorKey: Uint8Array;
};

type Session = {
  client: Awaited<ReturnType<typeof arkade.Arkade.connect>>;
};

const sessions = new Map<string, Promise<Session>>();
const ADDRESS_KEY = "arkade-options-address-v1";
const SESSION_KEY = "arkade-options-session-v1";
const LEGACY_WRITER_KEY = "arkade-options-writer-v1";

function openSession(identity: SingleKey): Promise<Session> {
  const id = identity.toHex();
  let pending = sessions.get(id);
  if (!pending) {
    pending = (async () => {
      const client = await arkade.Arkade.connect({
        arkade: new RestArkProvider(ARK_URL),
        indexer: new RestIndexerProvider(ARK_URL),
        emulator: new RestEmulatorProvider(EMULATOR_URL),
        identity,
        network: networks.mutinynet,
      });
      return { client };
    })();
    pending.catch(() => {
      sessions.delete(id);
    });
    sessions.set(id, pending);
  }
  return pending;
}

export function btcAmount(sats: bigint) {
  const whole = sats / 100_000_000n;
  const frac = (sats % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function storedHex(name: string): string | null {
  const raw = globalThis.localStorage?.getItem(name)?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(raw) || raw === "0".repeat(64)) return null;
  return raw;
}

/** Canonical Mutinynet address, or an error the page can show. */
export function parseWriterAddress(raw: string): string {
  const trimmed = raw.trim();
  let decoded: ArkAddress;
  try {
    decoded = ArkAddress.decode(trimmed);
  } catch {
    throw new Error("Paste a Mutinynet Arkade address. It starts with tark.");
  }
  if (decoded.hrp !== networks.mutinynet.hrp) {
    throw new Error("Paste a Mutinynet address. It starts with tark.");
  }
  return decoded.encode();
}

export function readAddress(): string | null {
  const raw = globalThis.localStorage?.getItem(ADDRESS_KEY)?.trim() ?? "";
  if (!raw) return null;
  try {
    return parseWriterAddress(raw);
  } catch {
    return null;
  }
}

export function saveAddress(raw: string): string {
  const address = parseWriterAddress(raw);
  globalThis.localStorage?.setItem(ADDRESS_KEY, address);
  return address;
}

export function clearAddress(): void {
  globalThis.localStorage?.removeItem(ADDRESS_KEY);
}

/** Browser identity for talking to arkd. It is not the payout address. */
export function sessionHex(): string {
  const existing = storedHex(SESSION_KEY);
  if (existing) return existing;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  if (bytes.every((byte) => byte === 0)) bytes[0] = 1;
  const hex = bytesToHex(bytes);
  globalThis.localStorage?.setItem(SESSION_KEY, hex);
  return hex;
}

/** Key an older page created without asking. Used only to finish those positions. */
export function legacyWriterHex(): string | null {
  return storedHex(LEGACY_WRITER_KEY);
}

/** Address finalize pays, and the script the desk must accept. */
export async function writerBinding(address: string): Promise<WriterBinding> {
  const decoded = ArkAddress.decode(parseWriterAddress(address));
  const { client } = await openSession(SingleKey.fromHex(sessionHex()));
  if (!client.emulatorKey) throw new Error("The emulator key is missing.");
  await assertServerExit();
  if (bytesToHex(xOnly(client.serverKey)) !== bytesToHex(xOnly(decoded.serverPubKey))) {
    throw new Error("That address is for a different Arkade server.");
  }
  const payoutKey = xOnly(decoded.vtxoTaprootKey);
  return {
    pubkey: bytesToHex(payoutKey),
    pkScript: bytesToHex(decoded.pkScript),
    address: decoded.encode(),
    payoutKey,
    serverKey: client.serverKey,
    emulatorKey: client.emulatorKey,
  };
}

/** Address finalize pays the premium to, for an older stored key. */
export async function writerPayoutAddress(writerHex: string): Promise<string> {
  const writer = SingleKey.fromHex(writerHex);
  const { client } = await openSession(writer);
  await assertServerExit();
  const pubkey = await writer.xOnlyPublicKey();
  const script = payoutVtxo(pubkey, client.serverKey, EXIT);
  return script.address(networks.mutinynet.hrp, xOnly(client.serverKey)).encode();
}

async function build(req: FundRequest) {
  let writerPk: Uint8Array;
  let payoutKey: Uint8Array | undefined;
  let serverKey: Uint8Array;
  let emulatorKey: Uint8Array;
  let identity: SingleKey;
  if (req.writerAddress) {
    const binding = await writerBinding(req.writerAddress);
    writerPk = binding.payoutKey;
    payoutKey = binding.payoutKey;
    serverKey = binding.serverKey;
    emulatorKey = binding.emulatorKey;
    identity = SingleKey.fromHex(sessionHex());
  } else if (req.writerHex) {
    identity = SingleKey.fromHex(req.writerHex);
    const { client } = await openSession(identity);
    if (!client.emulatorKey) throw new Error("The emulator key is missing.");
    await assertServerExit();
    writerPk = await identity.xOnlyPublicKey();
    serverKey = client.serverKey;
    emulatorKey = client.emulatorKey;
  } else {
    throw new Error("Paste your Arkade address first.");
  }
  const { client } = await openSession(identity);
  const holderPk = req.holderPkHex ? hexToBytes(req.holderPkHex) : await HOLDER.xOnlyPublicKey();
  const oraclePks = req.oraclePkHex
    ? req.oraclePkHex.map((hex) => hexToBytes(hex))
    : await Promise.all(ORACLES.map((key) => key.xOnlyPublicKey()));
  const exit = req.exit ?? EXIT;
  const terms: Terms = {
    kind: req.kind,
    strike: req.strike,
    collateral: req.collateral,
    premium: req.premium,
    expiry: req.expiry,
    deadline: req.deadline,
    exit,
    writerPk,
    payoutKey,
    holderPk,
    oraclePks,
    serverKey,
    emulatorKey,
  };
  const bound = bindContracts(terms);
  const intent = client.contract(intentProgram(), bound.intent);
  const vault = client.contract(vaultProgram(), bound.vault);
  if (intent.address !== bound.intentAddress || vault.address !== bound.vaultAddress) {
    throw new Error("The contract address does not match the local derivation.");
  }
  return { bound, intent, vault, holderPk, oraclePks, exit };
}

/** Mutinynet address the seller funds. Collateral stays with the seller until finalize. */
export async function depositAddress(req: FundRequest): Promise<Deposit> {
  const { bound, holderPk, oraclePks, exit } = await build(req);
  const amount = btcAmount(req.collateral);
  return {
    network: NETWORK_NAME,
    address: bound.intentAddress,
    vaultAddress: bound.vaultAddress,
    amountSats: req.collateral,
    uri: `bitcoin:?ark=${bound.intentAddress}&amount=${amount}`,
    holderPkHex: bytesToHex(holderPk),
    oraclePkHex: oraclePks.map((pk) => bytesToHex(pk)),
    exit: Number(exit),
  };
}

/** After the deadline, cancel pays the whole coin back to the writer address. */
export async function cancelIntent(req: FundRequest): Promise<string> {
  const { intent, bound } = await build(req);
  const coins = await intent.getUtxos();
  const coin = coins[0];
  if (!coin) throw new Error("No coin on this address.");
  const sent = await intent.functions.cancel().from(coin).to(bound.writerPkScript, BigInt(coin.value)).send();
  return sent.txid;
}
