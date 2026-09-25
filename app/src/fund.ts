import {
  arkade,
  DefaultVtxo,
  networks,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  SingleKey,
} from "@arkade-os/sdk";

import { intentProgram, vaultProgram } from "./program.ts";

export const NETWORK_NAME = "Mutinynet";
const ARK_URL = "https://mutinynet.arkade.sh";
const EMULATOR_URL = "https://emulator.mutinynet.arkade.sh";
const EXIT = 512n;

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
};

export type Deposit = {
  network: typeof NETWORK_NAME;
  address: string;
  amountSats: bigint;
  uri: string;
};

type Session = {
  client: Awaited<ReturnType<typeof arkade.Arkade.connect>>;
};

let session: Promise<Session> | null = null;

function openSession(identity: SingleKey): Promise<Session> {
  if (!session) {
    session = (async () => {
      const arkadeOperator = new RestArkProvider(ARK_URL);
      const indexer = new RestIndexerProvider(ARK_URL);
      const emulator = new RestEmulatorProvider(EMULATOR_URL);
      const client = await arkade.Arkade.connect({
        arkade: arkadeOperator,
        indexer,
        emulator,
        identity,
        network: networks.mutinynet,
      });
      return { client };
    })();
    session.catch(() => {
      session = null;
    });
  }
  return session;
}

function btcAmount(sats: bigint) {
  const whole = sats / 100_000_000n;
  const frac = (sats % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * The sell-side intent. The writer sends `collateral` sats to its address.
 * The desk does not lock that coin.
 */
async function buildIntent(req: FundRequest): Promise<Deposit & { intent: { address: string; getUtxos: () => Promise<unknown[]> } }> {
  const writer = SingleKey.fromHex(req.writerHex);
  const { client } = await openSession(writer);
  const serverPubKey = client.serverKey;
  const writerPk = await writer.xOnlyPublicKey();
  const holderPk = await HOLDER.xOnlyPublicKey();
  const writerVtxo = new DefaultVtxo.Script({
    pubKey: writerPk,
    serverPubKey,
    csvTimelock: { type: "seconds", value: EXIT },
  });
  const holderVtxo = new DefaultVtxo.Script({
    pubKey: holderPk,
    serverPubKey,
    csvTimelock: { type: "seconds", value: EXIT },
  });
  const oracles = Object.fromEntries(
    await Promise.all(
      ORACLES.map(async (key, index) => [`oracles.${index}`, await key.xOnlyPublicKey()] as const),
    ),
  );

  const vault = client.contract(vaultProgram(), {
    kind: BigInt(req.kind),
    writerPk,
    holderPk,
    writerScript: writerVtxo.tweakedPublicKey,
    holderScript: holderVtxo.tweakedPublicKey,
    strike: req.strike,
    collateral: req.collateral,
    expiry: req.expiry,
    ...oracles,
    exit: EXIT,
  });

  const intent = client.contract(intentProgram(), {
    userPk: writerPk,
    userScript: writerVtxo.tweakedPublicKey,
    solverScript: holderVtxo.tweakedPublicKey,
    optionScript: vault.vtxoScript.tweakedPublicKey,
    side: 0n,
    collateral: req.collateral,
    premium: req.premium,
    deadline: req.deadline,
    exit: EXIT,
  });

  const address = intent.address;
  const amount = btcAmount(req.collateral);
  return {
    network: NETWORK_NAME,
    address,
    amountSats: req.collateral,
    uri: `bitcoin:?ark=${address}&amount=${amount}`,
    intent,
  };
}

function xOnly(key: Uint8Array): Uint8Array {
  if (key.length === 32) return key;
  if (key.length === 33) return key.subarray(1);
  throw new Error(`Expected a 32-byte key, got ${key.length} bytes.`);
}

/** Address finalize pays the premium to, and cancel refunds the collateral to. */
export async function writerPayoutAddress(writerHex: string): Promise<string> {
  const writer = SingleKey.fromHex(writerHex);
  const { client } = await openSession(writer);
  const script = new DefaultVtxo.Script({
    pubKey: await writer.xOnlyPublicKey(),
    serverPubKey: client.serverKey,
    csvTimelock: { type: "seconds", value: EXIT },
  });
  return script.address(networks.mutinynet.hrp, xOnly(client.serverKey)).encode();
}

/** Mutinynet address the seller funds. Collateral stays with the seller until finalize. */
export async function depositAddress(req: FundRequest): Promise<Deposit> {
  const { intent: _intent, ...deposit } = await buildIntent(req);
  return deposit;
}

export async function hasDeposit(req: FundRequest): Promise<boolean> {
  const { intent } = await buildIntent(req);
  const coins = await intent.getUtxos();
  return coins.length > 0;
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
