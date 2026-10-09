// Wallet app links (arkade-os/wallet #1033). URLSearchParams, because a BIP21
// and a callback both contain "?" and "&".

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const RETURN = ["address", "pubkey", "error", "status", "txid", "flow", "position"];

export type WalletHandoff =
  | { kind: "none" }
  | { kind: "connect"; address: string; pubkey: string }
  | { kind: "connect-error" }
  | { kind: "sent"; positionId: string; txid?: string };

/** https, or http on localhost. No username or password. */
export function callbackAllowed(callback: string): boolean {
  let url: URL;
  try {
    url = new URL(callback);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOCAL.has(url.hostname);
}

/** Drop a previous wallet return, then keep the params this page still wants. */
export function pageCallback(href: string, params: Record<string, string>): string {
  const url = new URL(href);
  for (const key of RETURN) url.searchParams.delete(key);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export function stripWalletParams(href: string): string {
  const url = new URL(pageCallback(href, {}));
  return `${url.pathname}${url.search}${url.hash}`;
}

export function walletAppUrl(origin: string, action: "connect" | "send", callback: string, request?: string): string {
  if (!callbackAllowed(callback)) throw new Error("The wallet cannot return to this page.");
  const url = new URL(origin);
  url.search = "";
  url.hash = "";
  url.searchParams.set("action", action);
  if (request) url.searchParams.set("request", request);
  url.searchParams.set("callback", callback);
  return url.toString();
}

function hex64(value: string | null): string | undefined {
  const hex = value?.trim().toLowerCase() ?? "";
  return /^[0-9a-f]{64}$/.test(hex) ? hex : undefined;
}

/** An error wins, so a denial does not keep a prefilled address. */
export function readWalletHandoff(search: string): WalletHandoff {
  const params = new URLSearchParams(search);
  const flow = params.get("flow");
  const positionId = params.get("position")?.trim() ?? "";
  if (params.get("error")) return flow === "connect" ? { kind: "connect-error" } : { kind: "none" };
  if (flow === "send" && params.get("status") === "sent") {
    return { kind: "sent", positionId, txid: hex64(params.get("txid")) };
  }
  if (flow === "connect") {
    const address = params.get("address")?.trim() ?? "";
    const pubkey = hex64(params.get("pubkey"));
    if (address && pubkey) return { kind: "connect", address, pubkey };
    return { kind: "connect-error" };
  }
  return { kind: "none" };
}
