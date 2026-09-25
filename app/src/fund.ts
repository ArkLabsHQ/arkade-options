import {
  arkade,
  networks,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  SingleKey,
} from "@arkade-os/sdk";

import { ARK_URL, EMULATOR_URL, EXIT } from "../../protocol/constants.ts";
import { bindContracts, payoutVtxo, type Terms } from "../../protocol/contracts.ts";
import { bytesToHex, hexToBytes, xOnly } from "../../protocol/hex.ts";
import { intentProgram, vaultProgram } from "./program.ts";

export const NETWORK_NAME = "Mutinynet";

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
  writerHex: string;
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

type Session = {
  client: Awaited<ReturnType<typeof arkade.Arkade.connect>>;
};

const sessions = new Map<string, Promise<Session>>();

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

async function assertServerExit() {
  const info = await new RestArkProvider(ARK_URL).getInfo();
  if (BigInt(info.unilateralExitDelay) !== EXIT) {
    throw new Error(`server unilateralExitDelay is ${info.unilateralExitDelay}; contracts use ${EXIT}`);
  }
}

function btcAmount(sats: bigint) {
  const whole = sats / 100_000_000n;
  const frac = (sats % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

async function build(req: FundRequest) {
  const writer = SingleKey.fromHex(req.writerHex);
  const { client } = await openSession(writer);
  if (!client.emulatorKey) throw new Error("The emulator key is missing.");
  await assertServerExit();
  const writerPk = await writer.xOnlyPublicKey();
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
    holderPk,
    oraclePks,
    serverKey: client.serverKey,
    emulatorKey: client.emulatorKey,
  };
  const bound = bindContracts(terms);
  const intent = client.contract(intentProgram(), bound.intent);
  const vault = client.contract(vaultProgram(), bound.vault);
  if (intent.address !== bound.intentAddress || vault.address !== bound.vaultAddress) {
    throw new Error("The contract address does not match the local derivation.");
  }
  return { bound, intent, vault, holderPk, oraclePks, exit };
}

/** Address finalize pays the premium to, and cancel refunds the collateral to. */
export async function writerPayoutAddress(writerHex: string): Promise<string> {
  return (await writerProfile(writerHex)).address;
}

/** Writer key and the script the desk pays the premium to. */
export async function writerProfile(writerHex: string): Promise<{ pubkey: string; pkScript: string; address: string }> {
  const writer = SingleKey.fromHex(writerHex);
  const { client } = await openSession(writer);
  await assertServerExit();
  const pubkey = await writer.xOnlyPublicKey();
  const script = payoutVtxo(pubkey, client.serverKey, EXIT);
  return {
    pubkey: bytesToHex(pubkey),
    pkScript: bytesToHex(script.pkScript),
    address: script.address(networks.mutinynet.hrp, xOnly(client.serverKey)).encode(),
  };
}

export async function arkKeys(writerHex: string): Promise<{ serverKey: Uint8Array; emulatorKey: Uint8Array }> {
  const { client } = await openSession(SingleKey.fromHex(writerHex));
  if (!client.emulatorKey) throw new Error("The emulator key is missing.");
  return { serverKey: client.serverKey, emulatorKey: client.emulatorKey };
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

export async function fundingState(req: FundRequest): Promise<"open" | "funded" | "filled"> {
  const { intent, vault } = await build(req);
  const [vaultCoins, intentCoins] = await Promise.all([vault.getUtxos(), intent.getUtxos()]);
  if (vaultCoins.length > 0) return "filled";
  if (intentCoins.length > 0) return "funded";
  return "open";
}

export async function hasDeposit(req: FundRequest): Promise<boolean> {
  const state = await fundingState(req);
  return state === "funded" || state === "filled";
}

/** After the deadline, cancel pays the whole coin back to the writer. */
export async function cancelIntent(req: FundRequest): Promise<string> {
  const { intent, bound } = await build(req);
  const coins = await intent.getUtxos();
  const coin = coins[0];
  if (!coin) throw new Error("No coin on this address.");
  const sent = await intent.functions.cancel().from(coin).to(bound.writerPkScript, BigInt(coin.value)).send();
  return sent.txid;
}

export async function writerHex(): Promise<string> {
  const keyName = "arkade-options-writer-v1";
  const store = globalThis.localStorage;
  const existing = store?.getItem(keyName);
  if (existing) return existing;
  const hex = await SingleKey.fromRandomBytes().toHex();
  store?.setItem(keyName, hex);
  return hex;
}
