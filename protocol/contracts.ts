import { arkade, DefaultVtxo, networks, RestArkProvider } from "@arkade-os/sdk";

import { ARK_URL, EXIT } from "./constants.ts";
import { bytesToHex, hexToBytes, xOnly } from "./hex.ts";
import { intentProgram, swapProgram, vaultProgram } from "./programs.ts";

export type Terms = {
  kind: 0 | 1;
  strike: bigint;
  collateral: bigint;
  premium: bigint;
  expiry: bigint;
  deadline: bigint;
  exit: bigint;
  writerPk: Uint8Array;
  /** Taproot output key of the writer's Arkade address. Premium and settlement pay this key. */
  payoutKey?: Uint8Array;
  holderPk: Uint8Array;
  oraclePks: readonly Uint8Array[];
  serverKey: Uint8Array;
  emulatorKey: Uint8Array;
};

export type Bound = {
  intentAddress: string;
  vaultAddress: string;
  writerPkScript: Uint8Array;
  holderPkScript: Uint8Array;
  vaultPkScript: Uint8Array;
  intentPkScript: Uint8Array;
  writerProgram: Uint8Array;
  holderProgram: Uint8Array;
  optionProgram: Uint8Array;
  intent: Record<string, bigint | Uint8Array>;
  vault: Record<string, bigint | Uint8Array>;
};

/** Arkd refuses a vtxo whose shortest exit leaf is under this delay. */
export async function assertServerExit(url = ARK_URL) {
  const delay = BigInt((await new RestArkProvider(url).getInfo()).unilateralExitDelay);
  if (delay !== EXIT) throw new Error(`server unilateralExitDelay is ${delay}; contracts use ${EXIT}`);
}

export function payoutVtxo(pubKey: Uint8Array, serverKey: Uint8Array, exit: bigint = EXIT) {
  return new DefaultVtxo.Script({
    pubKey: xOnly(pubKey),
    serverPubKey: xOnly(serverKey),
    csvTimelock: { type: "seconds", value: exit },
  });
}

/** Taproot key of a pasted Arkade address, when the script is exactly that key. */
export function directPayoutKey(writerPubkey: string, writerPkScript: string): Uint8Array | undefined {
  let key: Uint8Array;
  let script: Uint8Array;
  try {
    key = xOnly(hexToBytes(writerPubkey));
    script = hexToBytes(writerPkScript);
  } catch {
    return undefined;
  }
  if (script.length !== 34 || script[0] !== 0x51 || script[1] !== 0x20) return undefined;
  if (bytesToHex(script.subarray(2)) !== bytesToHex(key)) return undefined;
  return key;
}

function directPayout(key: Uint8Array): { tweakedPublicKey: Uint8Array; pkScript: Uint8Array } {
  const tweakedPublicKey = xOnly(key);
  const pkScript = new Uint8Array(34);
  pkScript[0] = 0x51;
  pkScript[1] = 0x20;
  pkScript.set(tweakedPublicKey, 2);
  return { tweakedPublicKey, pkScript };
}

function addressOf(script: { address: (hrp: string, server: Uint8Array) => { encode: () => string } }, serverKey: Uint8Array) {
  return script.address(networks.mutinynet.hrp, xOnly(serverKey)).encode();
}

/**
 * OptionVault and OptionIntent for one quote. The page and the desk both call
 * this. A quote whose addresses differ from this derivation is refused.
 */
export function bindContracts(terms: Terms): Bound {
  const serverKey = xOnly(terms.serverKey);
  const writerPk = xOnly(terms.writerPk);
  const holderPk = xOnly(terms.holderPk);
  if (terms.emulatorKey.length !== 33) {
    throw new Error("emulator key must be 33 bytes");
  }
  if (terms.oraclePks.length !== 5) throw new Error("five oracle keys");
  const oraclePks = terms.oraclePks.map((pk) => xOnly(pk));

  const writer = terms.payoutKey ? directPayout(terms.payoutKey) : payoutVtxo(writerPk, serverKey, terms.exit);
  const holder = payoutVtxo(holderPk, serverKey, terms.exit);
  const keys = { serverKey, emulatorKey: terms.emulatorKey };
  const oracles = Object.fromEntries(oraclePks.map((pk, index) => [`oracles.${index}`, pk]));

  const vaultArgs: Record<string, bigint | Uint8Array> = {
    kind: BigInt(terms.kind),
    writerPk,
    holderPk,
    writerScript: writer.tweakedPublicKey,
    holderScript: holder.tweakedPublicKey,
    strike: terms.strike,
    collateral: terms.collateral,
    expiry: terms.expiry,
    ...oracles,
    exit: terms.exit,
    server: serverKey,
  };
  const vaultScript = new arkade.ArkadeProgramScript(vaultProgram(), vaultArgs, keys);

  const intentArgs: Record<string, bigint | Uint8Array> = {
    userPk: writerPk,
    userScript: writer.tweakedPublicKey,
    solverScript: holder.tweakedPublicKey,
    optionScript: vaultScript.tweakedPublicKey,
    side: 0n,
    collateral: terms.collateral,
    premium: terms.premium,
    deadline: terms.deadline,
    exit: terms.exit,
    server: serverKey,
  };
  const intentScript = new arkade.ArkadeProgramScript(intentProgram(), intentArgs, keys);

  return {
    intentAddress: addressOf(intentScript, serverKey),
    vaultAddress: addressOf(vaultScript, serverKey),
    writerPkScript: writer.pkScript,
    holderPkScript: holder.pkScript,
    vaultPkScript: vaultScript.pkScript,
    intentPkScript: intentScript.pkScript,
    writerProgram: writer.tweakedPublicKey,
    holderProgram: holder.tweakedPublicKey,
    optionProgram: vaultScript.tweakedPublicKey,
    intent: intentArgs,
    vault: vaultArgs,
  };
}

/** Witness program the swap's output 0 is checked against. */
export function swapMakerProgram(makerPk: Uint8Array, serverKey: Uint8Array, exit: bigint = EXIT): Uint8Array {
  return payoutVtxo(makerPk, serverKey, exit).tweakedPublicKey;
}

export function bindSwap(input: {
  makerPk: Uint8Array;
  serverKey: Uint8Array;
  emulatorKey: Uint8Array;
  offerAssetIdTxid: Uint8Array;
  offerAssetIdGidx: bigint;
  offerAmount: bigint;
  wantAssetIdTxid: Uint8Array;
  wantAssetIdGidx: bigint;
  wantAmount: bigint;
  expirationTime: bigint;
  exit?: bigint;
  makerProgram: Uint8Array;
}) {
  const exit = input.exit ?? EXIT;
  const serverKey = xOnly(input.serverKey);
  const args: Record<string, bigint | Uint8Array> = {
    makerPk: xOnly(input.makerPk),
    offerAssetIdTxid: input.offerAssetIdTxid,
    offerAssetIdGidx: input.offerAssetIdGidx,
    offerAmount: input.offerAmount,
    wantAssetIdTxid: input.wantAssetIdTxid,
    wantAssetIdGidx: input.wantAssetIdGidx,
    wantAmount: input.wantAmount,
    expirationTime: input.expirationTime,
    exit,
    vtxo_SingleSig_makerPk_exit: input.makerProgram,
    server: serverKey,
  };
  const script = new arkade.ArkadeProgramScript(swapProgram(), args, {
    serverKey,
    emulatorKey: input.emulatorKey,
  });
  return {
    address: addressOf(script, serverKey),
    pkScript: script.pkScript,
    args,
  };
}
