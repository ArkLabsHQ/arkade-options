import { schnorr } from "@noble/curves/secp256k1.js";

import { oraclePreimage } from "../app/settle-math.js";

type Status = {
  pubkeys: string[] | null;
  assetId: string | null;
  issueTxid: string | null;
  deployTxid: string | null;
  address: string | null;
  beaconTxid: string | null;
  args: {
    ctrlTxid: string | null;
    ctrlGidx: number | null;
    signers: string[] | null;
    threshold: number;
    domain: string;
    keyLag: number;
    readFee: number;
    adminPk: string | null;
    exit: number;
  };
  fixings: { expiry: number; twap: string; txid: string }[];
  prints: { pubkey: string; price: string; time: number }[];
};

const app = document.querySelector("#app");
if (!app) throw new Error("missing app");

const status = document.createElement("section");
const keys = document.createElement("section");
const admin = document.createElement("section");
const print = document.createElement("section");
app.append(status, keys, admin, print);

function line(parent: ParentNode, text: string, className?: string): HTMLElement {
  const el = document.createElement("p");
  if (className) el.className = className;
  el.textContent = text;
  parent.append(el);
  return el;
}

function field(form: HTMLElement, labelText: string, input: HTMLInputElement): void {
  const label = document.createElement("label");
  label.textContent = labelText;
  label.append(input);
  form.append(label);
}

const statusText = document.createElement("div");
status.append(statusText);

const keyHeading = document.createElement("h2");
keyHeading.textContent = "Oracle pubkeys";
const keyList = document.createElement("ol");
keys.append(keyHeading, keyList);

const adminNote = document.createElement("p");
adminNote.className = "muted";
adminNote.textContent = "Admin token stays in this field. It is sent only as a bearer on keys, issue, and deploy.";
const tokenInput = document.createElement("input");
tokenInput.type = "password";
tokenInput.autocomplete = "off";
const keyLabel = document.createElement("p");
keyLabel.textContent = "Five x-only pubkeys, one per line.";
const keyBox = document.createElement("textarea");
keyBox.rows = 5;
const issueButton = document.createElement("button");
issueButton.type = "button";
issueButton.textContent = "Issue";
const deployButton = document.createElement("button");
deployButton.type = "button";
deployButton.textContent = "Deploy";
const keysButton = document.createElement("button");
keysButton.type = "button";
keysButton.textContent = "Save keys";
const adminError = document.createElement("p");
adminError.className = "err";
admin.append(adminNote, tokenInput, keyLabel, keyBox, keysButton, issueButton, deployButton, adminError);

const priceInput = document.createElement("input");
priceInput.inputMode = "numeric";
const timeInput = document.createElement("input");
timeInput.inputMode = "numeric";
timeInput.value = String(Math.floor(Date.now() / 1000));
const secretInput = document.createElement("input");
secretInput.type = "password";
secretInput.autocomplete = "off";
const printButton = document.createElement("button");
printButton.type = "button";
printButton.textContent = "Sign and submit print";
const printNote = document.createElement("p");
printNote.className = "muted";
printNote.textContent = "The oracle secret is cleared after signing and is not sent to the server.";
const printError = document.createElement("p");
printError.className = "err";
const printForm = document.createElement("form");
field(printForm, "Price, USD cents", priceInput);
field(printForm, "Time, unix seconds", timeInput);
field(printForm, "Oracle secret", secretInput);
printForm.append(printButton);
printForm.addEventListener("submit", (event) => {
  event.preventDefault();
});
print.append(printNote, printForm, printError);

function bearer(): string {
  return tokenInput.value;
}

async function post(path: string, body: unknown, withToken: boolean): Promise<string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (withToken) headers.authorization = `Bearer ${bearer()}`;
  const res = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) {
    let message = text || res.statusText;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      message = text || res.statusText;
    }
    throw new Error(message);
  }
  return text;
}

function showError(el: HTMLElement, err: unknown): void {
  el.textContent = err instanceof Error ? err.message : "error";
}

async function refresh(): Promise<void> {
  const res = await fetch("/api/status");
  const body = (await res.json()) as Status;
  statusText.replaceChildren();
  const heading = document.createElement("h1");
  heading.textContent = "Oracle";
  statusText.append(heading);
  line(statusText, `Threshold ${body.args.threshold}. Key lag ${body.args.keyLag}. Read fee ${body.args.readFee}. Exit ${body.args.exit}.`);
  line(statusText, `Domain ${body.args.domain}`);
  line(statusText, `Admin ${body.args.adminPk ?? "unset"}`, "mono");
  line(statusText, `Asset ${body.assetId ?? "unset"}`, "mono");
  line(statusText, `Issue ${body.issueTxid ?? "unset"}`, "mono");
  line(statusText, `Deploy ${body.deployTxid ?? "unset"}`, "mono");
  line(statusText, `Beacon ${body.address ?? "unset"}`, "mono");
  line(statusText, `BEACON_TXID ${body.beaconTxid ?? "unset"}`, "mono");
  line(statusText, `ctrlTxid ${body.args.ctrlTxid ?? "unset"}`, "mono");
  line(statusText, `Fixings ${body.fixings.length}. Prints ${body.prints.length}.`);
  keyList.replaceChildren();
  const pubkeys = body.pubkeys ?? [];
  if (pubkeys.length === 0) {
    const item = document.createElement("li");
    item.textContent = "No keys yet.";
    keyList.append(item);
  }
  for (const pubkey of pubkeys) {
    const item = document.createElement("li");
    item.className = "mono";
    item.textContent = pubkey;
    keyList.append(item);
  }
}

keysButton.addEventListener("click", () => {
  adminError.textContent = "";
  const pubkeys = keyBox.value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  void post("/api/keys", { pubkeys }, true).then(() => refresh()).catch((err) => showError(adminError, err));
});

issueButton.addEventListener("click", () => {
  adminError.textContent = "";
  void post("/api/issue", {}, true).then(() => refresh()).catch((err) => showError(adminError, err));
});

deployButton.addEventListener("click", () => {
  adminError.textContent = "";
  void post("/api/deploy", {}, true).then(() => refresh()).catch((err) => showError(adminError, err));
});

printButton.addEventListener("click", () => {
  printError.textContent = "";
  const secretHex = secretInput.value.trim();
  secretInput.value = "";
  void (async () => {
    if (!/^[0-9a-fA-F]{64}$/.test(secretHex)) throw new Error("oracle secret must be 32 bytes");
    const secret = Uint8Array.from(secretHex.match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
    const price = BigInt(priceInput.value);
    const time = BigInt(timeInput.value);
    const preimage = oraclePreimage(price, time);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", preimage));
    const sig = schnorr.sign(hash, secret);
    const pubkey = schnorr.getPublicKey(secret);
    secret.fill(0);
    const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    await post("/api/prints", { pubkey: hex(pubkey), price: price.toString(), time: Number(time), sig: hex(sig) }, false);
    await refresh();
  })().catch((err) => showError(printError, err));
});

void refresh().catch((err) => showError(printError, err));
