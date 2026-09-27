import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";

import { oraclePreimage } from "../app/settle-math.js";

type Status = {
  pubkeys: string[] | null;
  assetId: string | null;
  issueTxid: string | null;
  deployTxid: string | null;
  wallet: string | null;
  address: string | null;
  beaconTxid: string | null;
  args: { ctrlTxid: string | null; threshold: number; domain: string; keyLag: number; readFee: number; adminPk: string | null; exit: number };
  fixings: unknown[];
  prints: unknown[];
};

const byId = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;

function lines(parent: HTMLElement, tag: string, texts: string[]): void {
  parent.replaceChildren(...texts.map((text) => {
    const el = document.createElement(tag);
    el.className = "mono";
    el.textContent = text;
    return el;
  }));
}

async function post(path: string, body: unknown, admin: boolean): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (admin) headers.authorization = `Bearer ${byId("token").value}`;
  const res = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
}

async function refresh(): Promise<void> {
  const body = (await (await fetch("/api/status")).json()) as Status;
  const { args } = body;
  lines(byId("status"), "p", [
    `Threshold ${args.threshold}. Key lag ${args.keyLag}. Read fee ${args.readFee}. Exit ${args.exit}.`,
    `Domain ${args.domain}`,
    `Admin ${args.adminPk ?? "unset"}`,
    `Fund ${body.wallet ?? "unset"}`,
    `Asset ${body.assetId ?? "unset"}`,
    `Issue ${body.issueTxid ?? "unset"}`,
    `Deploy ${body.deployTxid ?? "unset"}`,
    `Beacon ${body.address ?? "unset"}`,
    `BEACON_TXID ${body.beaconTxid ?? "unset"}`,
    `ctrlTxid ${args.ctrlTxid ?? "unset"}`,
    `Fixings ${body.fixings.length}. Prints ${body.prints.length}.`,
  ]);
  lines(byId("keys"), "li", body.pubkeys ?? ["No keys yet."]);
}

function shown(errorId: string, work: () => Promise<void>): void {
  byId(errorId).textContent = "";
  work().then(refresh).catch((err: Error) => {
    byId(errorId).textContent = err.message;
  });
}

const pubkeys = () => byId<HTMLTextAreaElement>("pubkeys").value.split(/[\s,]+/).filter(Boolean);
byId("save").addEventListener("click", () => shown("admin-error", () => post("/api/keys", { pubkeys: pubkeys() }, true)));
byId("issue").addEventListener("click", () => shown("admin-error", () => post("/api/issue", {}, true)));
byId("deploy").addEventListener("click", () => shown("admin-error", () => post("/api/deploy", {}, true)));

byId("time").value = String(Math.floor(Date.now() / 1000));
byId("print").addEventListener("submit", (event) => {
  event.preventDefault();
  const secretHex = byId("secret").value.trim().toLowerCase();
  byId("secret").value = "";
  shown("print-error", async () => {
    if (!/^[0-9a-f]{64}$/.test(secretHex)) throw new Error("oracle secret must be 32 bytes");
    const secret = hex.decode(secretHex);
    const price = BigInt(byId("price").value);
    const time = BigInt(byId("time").value);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", oraclePreimage(price, time)));
    const sig = schnorr.sign(hash, secret);
    const pubkey = schnorr.getPublicKey(secret);
    secret.fill(0);
    await post("/api/prints", { pubkey: hex.encode(pubkey), price: price.toString(), time: Number(time), sig: hex.encode(sig) }, false);
  });
});

void refresh().catch((err: Error) => {
  byId("print-error").textContent = err.message;
});
