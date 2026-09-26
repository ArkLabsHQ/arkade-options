import {
  defaultEmulatorPubkey,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  networks,
  RestEmulatorProvider,
  SingleKey,
  Wallet,
} from "@arkade-os/sdk";

import { ARK_URL, EMULATOR_URL } from "../protocol/constants.ts";
import { bytesToHex, hexToBytes } from "../protocol/hex.ts";
import { createOracle, type OracleWallet } from "./service.ts";

/**
 *   ORACLE_KEY     optional 32-byte hex. Never generated. Admin pubkey and publish key.
 *   ORACLE_ADMIN   optional bearer. Unset disables /api/keys, /api/issue, and /api/deploy.
 *   ARK_URL        default https://mutinynet.arkade.sh
 *   EMULATOR_URL   default Mutinynet emulator
 *   DATA_DIR       oracle.json. Default ./data
 *   PORT           default 8789
 */

function optionalKey(name: string): Uint8Array | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`${name} must be 32 bytes`);
  return hexToBytes(raw);
}

const oracleKey = optionalKey("ORACLE_KEY");
const adminToken = process.env.ORACLE_ADMIN?.trim() || undefined;
const dataDir = process.env.DATA_DIR?.trim() || "data";
const port = Number(process.env.PORT ?? "8789");
const arkUrl = process.env.ARK_URL?.trim() || ARK_URL;
const emulatorUrl = process.env.EMULATOR_URL?.trim() || EMULATOR_URL;
if (!Number.isInteger(port) || port < 0) throw new Error("PORT");

const wallet = oracleKey
  ? await Wallet.create({
      identity: SingleKey.fromHex(bytesToHex(oracleKey)),
      arkServerUrl: arkUrl,
      indexerUrl: arkUrl,
      settlementConfig: false,
      storage: {
        walletRepository: new InMemoryWalletRepository(),
        contractRepository: new InMemoryContractRepository(),
      },
    })
  : undefined;

const wrapped: OracleWallet | undefined = wallet
  ? {
      assetManager: { issue: (params) => wallet.assetManager.issue(params) },
      getAddress: () => wallet.getAddress(),
      getVtxos: () => wallet.getVtxos(),
      buildAndSubmitOffchainTx: (inputs, outputs) => wallet.buildAndSubmitOffchainTx(inputs as never, outputs),
      arkServerPublicKey: wallet.arkServerPublicKey,
      serverUnrollScript: wallet.serverUnrollScript,
    }
  : undefined;

const oracle = await createOracle({
  dataDir,
  port,
  adminToken,
  oracleKey,
  emulatorKey: hexToBytes(defaultEmulatorPubkey(networks.mutinynet)),
  wallet: wrapped,
  indexer: wallet?.indexerProvider,
  emulator: new RestEmulatorProvider(emulatorUrl),
});

console.log(`oracle http://127.0.0.1:${oracle.port}/`);
