// App links from arkade-os/wallet #1033, merge b4188bd49d115fd9cf9e9ca4fa164b0c5c7a567f.
// The wallet asks before it shares an address or sends funds, then navigates
// to the callback. Build every link with URLSearchParams: a BIP21 and a
// callback are both URLs, and a raw "?" or "&" would be parsed as the wallet's
// own query.

export const WALLET_APP_LINKS_COMMIT = "b4188bd49d115fd9cf9e9ca4fa164b0c5c7a567f";

/** Same cap the wallet enforces on `location.search`. */
export const WALLET_SEARCH_LIMIT = 6_000;

const CALLBACK_LIMIT = 2_000;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const RETURN_KEYS = ["address", "pubkey", "error", "status", "txid", "flow", "position"];

export type WalletHandoff =
  | { kind: "none" }
  | { kind: "connect"; address: string; pubkey: string }
  | { kind: "connect-denied" }
  | { kind: "connect-invalid" }
  | { kind: "sent"; positionId: string; txid?: string }
  | { kind: "send-denied"; positionId: string }
  | { kind: "send-invalid"; positionId: string };

function searchParams(search: string): URLSearchParams {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  return new URLSearchParams(raw);
}

/** https, or http on localhost / 127.0.0.1 / ::1. No username or password. */
export function callbackAllowed(callback: string): boolean {
  if (!callback || callback.length > CALLBACK_LIMIT) return false;
  let url: URL;
  try {
    url = new URL(callback);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)) return true;
  return false;
}

/** This page, plus the params the wallet should keep when it appends its own. */
export function pageCallback(pageHref: string, params: Record<string, string>): string {
  const url = new URL(pageHref);
  for (const key of RETURN_KEYS) url.searchParams.delete(key);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** Drop the wallet's return params. Leave the hash and any other query. */
export function stripWalletParams(href: string): string {
  const url = new URL(href);
  for (const key of RETURN_KEYS) url.searchParams.delete(key);
  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
}

export function hasWalletParams(search: string): boolean {
  const params = searchParams(search);
  return RETURN_KEYS.some((key) => params.has(key));
}

function walletUrl(origin: string, params: Record<string, string>): string {
  const url = new URL(origin);
  url.search = "";
  url.hash = "";
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (url.search.length > WALLET_SEARCH_LIMIT) throw new Error("That wallet link is too long.");
  return url.toString();
}

export function walletConnectUrl(origin: string, callback: string): string {
  if (!callbackAllowed(callback)) throw new Error("The wallet cannot return to this page.");
  return walletUrl(origin, { action: "connect", callback });
}

export function walletSendUrl(origin: string, request: string, callback?: string): string {
  if (!request.startsWith("bitcoin:")) throw new Error("The payment link is not a BIP21 request.");
  const params: Record<string, string> = { action: "send", request };
  if (callback) {
    if (!callbackAllowed(callback)) throw new Error("The wallet cannot return to this page.");
    params.callback = callback;
  }
  return walletUrl(origin, params);
}

function pubkeyOf(value: string | null): string | undefined {
  const pubkey = value?.trim().toLowerCase() ?? "";
  return /^[0-9a-f]{64}$/.test(pubkey) ? pubkey : undefined;
}

function txidOf(value: string | null): string | undefined {
  const txid = value?.trim().toLowerCase() ?? "";
  return /^[0-9a-f]{64}$/.test(txid) ? txid : undefined;
}

/** What the wallet appended to the callback. An error wins over a leftover address. */
export function readWalletHandoff(search: string): WalletHandoff {
  if (!search || search === "?") return { kind: "none" };
  const params = searchParams(search);
  const flow = params.get("flow")?.trim().toLowerCase() ?? "";
  const positionId = params.get("position")?.trim() ?? "";
  const error = params.get("error")?.trim().toLowerCase() ?? "";

  if (error) {
    const denied = error === "denied";
    if (flow === "send") return { kind: denied ? "send-denied" : "send-invalid", positionId };
    if (flow === "connect" || error === "denied" || error === "invalid") {
      return { kind: denied ? "connect-denied" : "connect-invalid" };
    }
    return { kind: "none" };
  }

  if ((params.get("status")?.trim().toLowerCase() ?? "") === "sent") {
    return { kind: "sent", positionId, txid: txidOf(params.get("txid")) };
  }

  const address = params.get("address")?.trim() ?? "";
  const pubkey = pubkeyOf(params.get("pubkey"));
  if (address && pubkey && flow !== "send") return { kind: "connect", address, pubkey };
  if (flow === "connect") return { kind: "connect-invalid" };
  return { kind: "none" };
}
