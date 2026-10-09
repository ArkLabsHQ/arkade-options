import { networks, type Network } from "@arkade-os/sdk";

const BY_NAME: Record<string, Network> = {
  bitcoin: networks.bitcoin,
  mainnet: networks.bitcoin,
  testnet: networks.testnet,
  signet: networks.signet,
  mutinynet: networks.mutinynet,
  regtest: networks.regtest,
};

/** Network advertised by arkd `/v1/info`. The emulator co-signer is pinned per network. */
export function networkByName(name: string): Network {
  const network = BY_NAME[name.trim().toLowerCase()];
  if (!network) throw new Error(`unsupported ark network ${name}`);
  return network;
}
