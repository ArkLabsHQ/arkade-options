import {
  btcAmount,
  cancelIntent,
  clearAddress,
  depositAddress,
  legacyWriterHex,
  paymentUri,
  readAddress,
  registerIntent,
  saveAddress,
  WALLET_URL,
  writerPayoutAddress,
} from "./src/fund.ts";
import {
  callbackAllowed,
  pageCallback,
  popupHandoffMessage,
  readWalletHandoff,
  readWalletHandoffMessage,
  stripWalletParams,
  walletAppUrl,
  walletMessageTarget,
} from "./src/wallet-link.ts";
import { artifactLine } from "./src/program.ts";
import { requestQuotes } from "./src/rfq.ts";
import { deribitPremium, fetchSurface } from "../protocol/deribit.ts";
import { BEACON_READ_FEE, QUOTE_TTL_S } from "../protocol/constants.ts";
import { payablePremium } from "../protocol/pricing.ts";
import { bestQuote } from "./quote.js";
import { PINNED_DESKS, RELAYS } from "./rfq-config.js";
import { holderPayoff, settlementOutputs } from "./settle-math.js";
import { settlementKnown } from "./src/position-status.ts";
import { restoreVault } from "./src/restore.ts";
import { settleFromPage } from "./src/settle.ts";
import { pkScriptOf, readIntent, readKept, watchIntents } from "./src/watch.ts";

const STORE = "arkade-options-desk-v1";
const REFRESH_MS = 18_000;
const WALLET_ASK = "arkade-options-wallet";
const SIZES = [200_000n, 500_000n, 1_000_000n, 2_000_000n];
// `?test` adds the 10-minute date, and the listed line nearest today's price.
const TEST = new URLSearchParams(location.search).has("test");
const VERBS = {
  now: ["I’ll lock", "give up gains above", "take the loss below"],
  ing: ["You’re locking", "giving up gains above", "taking the loss below"],
  past: ["You locked", "gave up gains above", "took the loss below"],
};

let promotedSettled = false;

const state = {
  spotCents: null,
  points: null,
  loaded: false,
  address: "",
  kind: 0,
  size: 1_000_000n,
  date: 0,
  tenorSec: 0,
  lines: { 0: 0, 1: 0 },
  open: "",
  view: "sell",
  checkout: false,
  agree: false,
  offer: null,
  quoteNote: "",
  quoting: false,
  walletNote: "",
  positions: loadPositions(),
  restored: [],
  selected: null,
};

let quoteGen = 0;
let restoreKind = 0;
const expiring = new Set();
let walletWindow = null;

const $ = (id) => document.getElementById(id);

function loadPositions() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || "[]");
    const rows = Array.isArray(raw) ? raw : raw.positions || [];
    return rows.map(revive);
  } catch {
    return [];
  }
}

function revive(row) {
  const position = {
    ...row,
    collateral: BigInt(row.collateral),
    premiumSats: BigInt(row.premiumSats),
    strike: BigInt(row.strike),
    expiry: BigInt(row.expiry),
    marketSats: row.marketSats ? BigInt(row.marketSats) : null,
  };
  if (position.status === "filled" && settlementKnown(position)) {
    position.status = "settled";
    promotedSettled = true;
  }
  return position;
}

function persist() {
  const rows = state.positions.map((p) => ({
    id: p.id,
    side: p.side,
    kind: p.kind,
    strike: p.strike.toString(),
    expiry: p.expiry.toString(),
    collateral: p.collateral.toString(),
    premiumSats: p.premiumSats.toString(),
    premiumUsd: p.premiumUsd,
    solver: p.solver,
    status: p.status,
    address: p.address,
    deadline: p.deadline,
    holderPkHex: p.holderPkHex,
    beaconTxid: p.beaconTxid,
    beaconGidx: p.beaconGidx,
    exit: p.exit,
    vaultAddress: p.vaultAddress,
    writerHex: p.writerHex,
    writerAddress: p.writerAddress,
    payoutAddress: p.payoutAddress,
    days: p.days,
    tenorSec: p.tenorSec || 0,
    createdAt: p.createdAt,
    apy: p.apy,
    apyFrozen: p.apyFrozen,
    refundable: Boolean(p.refundable),
    marketSats: p.marketSats ? p.marketSats.toString() : "",
    marketApy: p.marketApy,
    fundingTxid: p.fundingTxid || "",
    walletTxid: p.walletTxid || "",
    closeTxid: p.closeTxid || "",
    settleTxid: p.settleTxid || "",
    writerKeep: p.writerKeep || "",
    deskTake: p.deskTake || "",
    settleCents: p.settleCents || "",
  }));
  localStorage.setItem(STORE, JSON.stringify(rows));
}

function fmtUsdFromCents(cents) {
  const neg = cents < 0n;
  const v = neg ? -cents : cents;
  const whole = (v / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (v % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

function fmtBtc(sats) {
  const neg = sats < 0n;
  const body = btcAmount(neg ? -sats : sats);
  return neg ? `-${body}` : body;
}

function annualized(premiumSats, collateralSats, days) {
  if (collateralSats <= 0n || !(days > 0)) return null;
  return (Number(premiumSats) / Number(collateralSats)) * (365 / days) * 100;
}

function tenorDays(position) {
  if (position.tenorSec > 0) return position.tenorSec / 86400;
  if (position.days > 0) return position.days;
  const start = position.createdAt || Math.floor(Date.now() / 1000);
  const span = Number(position.expiry) - start;
  if (span > 0) return span / 86400;
  return 30;
}

let pinnedExpiry = 0;

function expiryUnix() {
  if (state.tenorSec > 0) {
    const now = Math.floor(Date.now() / 1000);
    if (pinnedExpiry <= now + 90) pinnedExpiry = now + state.tenorSec;
    return BigInt(pinnedExpiry);
  }
  return BigInt(state.date || 0);
}

const nearestTo = (list, want) => list.reduce((best, value) => (best == null || Math.abs(value - want) < Math.abs(best - want) ? value : best), null);
const clears = (sats) => sats != null && sats > BEACON_READ_FEE;
const spotUsd = () => Number(state.spotCents) / 100;
const cents = (usd) => BigInt(Math.round(usd * 100));

/** Listed Friday expiries: the nearest one, then the month-end ones. */
function dates() {
  const now = Math.floor(Date.now() / 1000);
  const month = (unix) => new Date(unix * 1000).getUTCMonth();
  return [...new Set(state.points.map((point) => point.expiry))]
    .filter((unix) => unix > now + 3600 && new Date(unix * 1000).getUTCDay() === 5)
    .sort((a, b) => a - b)
    .filter((unix, index) => index === 0 || month(unix) !== month(unix + 7 * 86400))
    .slice(0, 4);
}

/** Strikes Deribit lists at this date on the far side of today's price, nearest first. */
function linesFor(kind, expiry) {
  const call = kind === 0;
  const spot = spotUsd();
  const book = state.points.filter((point) => point.call === call && point.expiry >= expiry);
  const at = Math.min(...book.map((point) => point.expiry));
  const listed = book
    .filter((point) => point.expiry === at && (call ? point.strike > spot : point.strike < spot))
    .map((point) => point.strike);
  const want = call ? [1.05, 1.075, 1.1, 1.15] : [0.95, 0.925, 0.9, 0.85];
  if (TEST) want.unshift(1);
  const lines = [];
  for (const step of want) {
    const line = nearestTo(listed, spot * step);
    if (line != null && !lines.includes(line)) lines.push(line);
  }
  return lines.sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot));
}

function estimate(kind, line, expiry, size) {
  const priced = deribitPremium({
    kind,
    strikeUsd: line,
    expiry,
    now: Math.floor(Date.now() / 1000),
    collateralSats: size,
    spotUsd: spotUsd(),
    points: state.points,
  });
  return priced ? payablePremium(priced.sats) : null;
}

/** Picks the date and both lines from the book. False until prices load. */
function ready() {
  if (!state.points || state.spotCents == null) return false;
  const list = dates();
  if (!list.length) return false;
  if (!list.includes(state.date)) state.date = nearestTo(list, Date.now() / 1000 + 42 * 86400);
  const expiry = Number(expiryUnix());
  for (const kind of [0, 1]) {
    const lines = linesFor(kind, expiry);
    if (!lines.length) return false;
    if (lines.includes(state.lines[kind])) continue;
    const first = !state.lines[kind];
    state.lines[kind] = nearestTo(lines, state.lines[kind] || spotUsd() * (kind === 0 ? 1.075 : 0.925));
    if (first) fitLine(kind);
  }
  return true;
}

/** A line that pays no more than the fee moves toward today's price, to the first one that does. */
function fitLine(kind) {
  const expiry = Number(expiryUnix());
  const lines = linesFor(kind, expiry);
  const pays = (line) => clears(estimate(kind, line, expiry, state.size));
  if (pays(state.lines[kind])) return;
  const closer = lines.slice(0, lines.indexOf(state.lines[kind])).reverse().find(pays);
  if (closer != null) state.lines[kind] = closer;
}

function terms() {
  const line = state.lines[state.kind];
  return { kind: state.kind, line, strike: cents(line), expiry: expiryUnix(), size: state.size, tenorSec: state.tenorSec };
}

/** What the vault sends back to you at this price, after the price-check fee. */
function backSats(kind, price, line, q) {
  return settlementOutputs(holderPayoff(kind, cents(price), cents(line), q), q, BEACON_READ_FEE).writer;
}

/** The highest price at which a put sends nothing back. */
function zeroAt(line, q) {
  const k = cents(line);
  let lo = 1n;
  let hi = k;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (settlementOutputs(holderPayoff(1, mid, k, q), q, BEACON_READ_FEE).writer === 0n) lo = mid;
    else hi = mid - 1n;
  }
  return Number(lo) / 100;
}

const int = (n) => BigInt(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const usd0 = (x) => `$${Math.round(x).toLocaleString("en-US")}`;
const usd2 = (x) => `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const worth = (sats, usd) => (Number(sats) * usd) / 1e8;
const capital = (text) => text[0].toUpperCase() + text.slice(1);
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const hhmm = (d) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;

function pct(line) {
  const p = (line / spotUsd() - 1) * 100;
  return `${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(1)}%`;
}

function whenDay(unix) {
  return new Date(Number(unix) * 1000).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
}

/** "Fri, Nov 27" for an 08:00 UTC date, otherwise the day and the time. */
function whenShort(unix) {
  const d = new Date(Number(unix) * 1000);
  if (hhmm(d) !== "08:00") return `${whenDay(unix)}, ${hhmm(d)} UTC`;
  return d.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}

function atTime(unix) {
  return `${hhmm(new Date(Number(unix) * 1000))} UTC on ${whenDay(unix)}`;
}

function away(unix) {
  const days = (unix - Date.now() / 1000) / 86400;
  if (days < 1.5) {
    const hours = Math.max(1, Math.round(days * 24));
    return `In ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (days < 14) return `In ${Math.round(days)} days`;
  const weeks = days < 31 ? Math.round(days / 3.5) / 2 : Math.round(days / 7);
  return `In ${String(weeks).replace(".5", "½")} weeks`;
}

function toGo(unix) {
  const s = Number(unix) - Date.now() / 1000;
  if (s >= 2 * 86400) return `${Math.floor(s / 86400)} days to go`;
  if (s >= 7200) return `${Math.floor(s / 3600)} hours to go`;
  return `${Math.max(1, Math.ceil(s / 60))} min to go`;
}

function sentenceInto(node, kind, size, expiry, line, tense) {
  const verbs = VERBS[tense];
  node.replaceChildren(
    `${verbs[0]} `,
    el("span", "chip", `₿${fmtBtc(size)}`),
    " until ",
    el("span", "chip", whenShort(expiry)),
    ` and ${verbs[1 + kind]} `,
    el("span", "chip", usd0(line)),
    ".",
  );
}

function shortAddress(address) {
  if (!address || address.length < 20) return address || "";
  return `${address.slice(0, 12)}…${address.slice(-6)}`;
}

const STEPS = ["Waiting for your BTC", "BTC received", "Paying you", "You’re paid", "Done"];

function progressIndex(status) {
  if (status === "locking") return 0;
  if (status === "deposited") return 2;
  if (status === "filled") return 3;
  if (status === "settled") return 4;
  return -1;
}

function markStep(item, kind, busy = false) {
  item.className = kind;
  if (!busy) return;
  const spin = document.createElement("span");
  spin.className = "spin";
  spin.setAttribute("aria-hidden", "true");
  item.append(spin);
}

function progressSteps(status) {
  const list = document.createElement("ol");
  list.className = "steps";
  list.setAttribute("aria-label", "Progress");
  if (status === "expired" || status === "refunded") {
    const labels = status === "refunded"
      ? ["Waiting for your BTC", "BTC received", "Sent back"]
      : ["Waiting for your BTC", "BTC received", "Time ran out"];
    labels.forEach((label, step) => {
      const item = document.createElement("li");
      item.textContent = label;
      markStep(item, step === labels.length - 1 ? "now" : "done", false);
      list.append(item);
    });
    return list;
  }
  const index = progressIndex(status);
  if (index < 0) return null;
  STEPS.forEach((label, step) => {
    const item = document.createElement("li");
    item.textContent = label;
    const currentDone = status === "settled" || step < index || (status === "filled" && step === index);
    if (currentDone) markStep(item, "done");
    else if (step === index) markStep(item, "now", true);
    list.append(item);
  });
  return list;
}

function statusLabel(position) {
  if (position.status === "locking") return position.walletTxid ? "Waiting for your BTC" : "Send your BTC";
  if (position.status === "deposited") return "Paying you";
  if (position.status === "settled" || settlementKnown(position)) return "Done";
  if (position.status === "filled") return Number(position.expiry) > Date.now() / 1000 ? toGo(position.expiry) : "Checking the price";
  if (position.status === "expired") return "Time ran out";
  if (position.status === "refunded") return "Sent back";
  return "Open";
}

function humanNote(note) {
  if (!note) return "";
  const asked = terms();
  if (note.includes("exposure")) {
    return `The desk has taken all it can at ${usd0(asked.line)} for ${whenDay(asked.expiry)}. Try another line or date.`;
  }
  if (note.includes("float short")) return "The desk can’t pay this much right now. Try a smaller amount, or try again later.";
  if (/refused: (spot|deribit) unavailable/.test(note)) {
    return "We can’t get a fair price right now, so we won’t make an offer. Try again in a minute.";
  }
  if (note.includes("refused: expiry")) return "That date is too close. Pick a later one.";
  if (note.includes("refused: collateral")) return "The desk can’t take this amount right now. Pick another one.";
  if (note.includes("below dust")) {
    return "This doesn’t pay more than the 1,000-sat price-check fee. Pick a closer line, a later date or more BTC.";
  }
  if (note.includes("did not answer")) return "The desk didn’t answer. Nothing was locked. Try again.";
  if (note.startsWith("The desk refused")) return "We couldn’t set this up. Nothing was locked. Try again.";
  return note;
}

function mine(position) {
  if (position.writerAddress) return position.writerAddress === state.address;
  if (position.payoutAddress) return position.payoutAddress === state.address;
  return false;
}

function visiblePositions() {
  return state.positions.filter(mine);
}

function svgEl(name, attrs, text) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text != null) node.textContent = text;
  return node;
}

function el(tag, className = "", text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function action(className, text, fn) {
  const node = el("button", className, text);
  node.type = "button";
  node.addEventListener("click", fn);
  return node;
}

function kindIcon(kind) {
  const svg = svgEl("svg", { viewBox: "0 0 20 20", "aria-hidden": "true" });
  svg.append(
    svgEl("path", { d: kind === 0 ? "M2.5 16.5l4.5-4.5 3 2.5 6-7" : "M2.5 3.5l4.5 4.5 3-2.5 6 7" }),
    svgEl("path", { d: kind === 0 ? "M2.5 4.5h15" : "M2.5 15.5h15", "stroke-dasharray": "2.2 2.4" }),
  );
  return svg;
}

let chartSeq = 0;

/** What you end up with at each price on the date: what comes back, plus what you were paid. */
function drawChart(host, { kind, k, q, pay, at, day }) {
  const W = Math.max(260, Math.floor(host.clientWidth));
  const H = 250;
  const top = 50;
  const ly = 15;
  let x0 = kind === 0 ? k * 0.65 : k * 0.4;
  let x1 = kind === 0 ? k * 1.6 : k * 1.3;
  if (at) {
    x0 = Math.min(x0, at.p * 0.9);
    x1 = Math.max(x1, at.p * 1.1);
  }
  const lock = Number(q);
  const ymax = (lock + Math.max(Number(pay), 14_000)) * 1.06;
  const X = (p) => 2 + ((p - x0) / (x1 - x0)) * (W - 4);
  const Y = (s) => top + (1 - s / ymax) * (H - top - 28);
  const yb = Y(0);
  const yt = top - 8;
  const yl = Y(lock);
  const end = (p) => Number(backSats(kind, p, k, q) + pay);
  const prices = Array.from({ length: 97 }, (_, i) => x0 + ((x1 - x0) * i) / 96);
  prices.push(k);
  if (kind === 1) prices.push(zeroAt(k, q));
  prices.sort((a, b) => a - b);
  const curve = prices.map((p, i) => `${i ? "L" : "M"}${X(p).toFixed(1)} ${Y(end(p)).toFixed(1)}`).join("");
  const under = `${curve}L${X(x1).toFixed(1)} ${yb.toFixed(1)}L${X(x0).toFixed(1)} ${yb.toFixed(1)}Z`;
  const over = `${curve}L${X(x1).toFixed(1)} ${yt}L${X(x0).toFixed(1)} ${yt}Z`;
  const id = `chart${++chartSeq}`;
  const safe = kind === 0 ? "under" : "above";
  const svg = svgEl("svg", {
    width: W,
    height: H,
    viewBox: `0 0 ${W} ${H}`,
    role: "img",
    "aria-label": `What you end up with on ${day}: ₿${fmtBtc(backSats(kind, k, k, q) + pay)} if BTC is ${safe} ${usd0(k)}, and less the further it goes ${kind === 0 ? "above" : "below"}.`,
  });
  const defs = svgEl("defs", {});
  for (const [name, y, h] of [["a", yt - 20, yl - yt + 20], ["b", yl, yb - yl]]) {
    const clip = svgEl("clipPath", { id: id + name });
    clip.append(svgEl("rect", { x: 0, y, width: W, height: Math.max(0, h) }));
    defs.append(clip);
  }
  svg.append(defs);
  const step = W < 460 ? 20_000 : 10_000;
  for (let p = Math.ceil(x0 / step) * step; p <= x1; p += step) {
    svg.append(
      svgEl("line", { x1: X(p), x2: X(p), y1: yt, y2: yb, class: "gl" }),
      svgEl("text", { x: X(p), y: yb + 19, "text-anchor": "middle", class: "tick" }, `$${p / 1000}k`),
    );
  }
  svg.append(
    svgEl("path", { d: under, class: "area" }),
    svgEl("path", { d: under, class: "more", "clip-path": `url(#${id}a)` }),
    svgEl("path", { d: over, class: "less", "clip-path": `url(#${id}b)` }),
    svgEl("path", { d: curve, class: "curve" }),
    svgEl("line", { x1: 2, x2: W - 2, y1: yl, y2: yl, class: "lock" }),
    svgEl("text", { x: kind === 1 ? W - 8 : 8, y: yl + 17, "text-anchor": kind === 1 ? "end" : "start" }, `You lock ₿${fmtBtc(q)}`),
    svgEl("line", { x1: 2, x2: W - 2, y1: yb, y2: yb, class: "base" }),
  );
  if (pay > 0n) {
    const label = `+${int(pay)} sats paid now`;
    const half = label.length * 3.5;
    const mid = X(kind === 0 ? (x0 + k) / 2 : (k + x1) / 2);
    svg.append(svgEl("text", {
      x: Math.min(W - half - 4, Math.max(half + 4, mid)),
      y: Y(lock + Number(pay)) - 9,
      "text-anchor": "middle",
      class: "paid",
    }, label));
  }
  const right = !at || at.p < k;
  const mark = (p, className, text, onRight) => {
    const x = X(p);
    svg.append(
      svgEl("line", { x1: x, x2: x, y1: ly - 11, y2: yb, class: className }),
      svgEl("text", { x: onRight ? x + 7 : x - 7, y: ly, "text-anchor": onRight ? "start" : "end", class: `${className}-label` }, text),
    );
  };
  mark(k, "mark", `Your line ${usd0(k)}`, right);
  if (at) mark(at.p, "today", `${at.label} ${usd0(at.p)}`, !right);
  host.replaceChildren(svg);
}

function renderSell() {
  if (state.view !== "sell") return;
  document.querySelectorAll("[data-kind]").forEach((btn) => {
    btn.setAttribute("aria-checked", String(Number(btn.dataset.kind) === state.kind));
  });
  $("verb").textContent = `and ${VERBS.now[1 + state.kind]}`;
  const ok = ready();
  const [sizeChip, dateChip, lineChip] = ["size", "date", "line"].map((name) => document.querySelector(`[data-chip="${name}"]`));
  for (const chip of [sizeChip, dateChip, lineChip]) chip.disabled = !ok;
  const coin = el("span", "btc", "₿");
  coin.setAttribute("aria-hidden", "true");
  sizeChip.replaceChildren(coin, fmtBtc(state.size));
  sizeChip.setAttribute("aria-label", `Amount, ${fmtBtc(state.size)} BTC`);
  const see = $("see");
  if (!ok) {
    dateChip.textContent = "…";
    lineChip.textContent = "…";
    $("estimate").textContent = state.loaded
      ? "We can’t get a fair price right now. Try again in a minute."
      : "Getting today’s prices…";
    see.disabled = true;
    see.textContent = "See what happens";
    renderPop();
    renderCheckout();
    return;
  }
  const t = terms();
  const day = whenDay(t.expiry);
  dateChip.textContent = whenShort(t.expiry);
  dateChip.setAttribute("aria-label", `Date, ${whenShort(t.expiry)}`);
  lineChip.replaceChildren(usd0(t.line), el("span", "delta", pct(t.line)));
  lineChip.setAttribute("aria-label", `Price, ${usd0(t.line)}, ${pct(t.line)} from today`);
  const pay = estimate(t.kind, t.line, Number(t.expiry), t.size);
  const note = $("estimate");
  if (clears(pay)) note.replaceChildren("You get paid about ", el("b", "", `${int(pay)} sats`), ` now · 1,000-sat fee on ${day}`);
  else if (pay == null) note.textContent = "We can’t price this one right now. Pick another date or line.";
  else note.textContent = `This pays about ${int(pay)} sats, which doesn’t cover the 1,000-sat fee on ${day}. Pick a closer line, a later date or more BTC.`;
  see.disabled = !clears(pay);
  see.textContent = `See what happens on ${day}`;
  renderPop();
  renderCheckout();
}

/** The short list under a chip. A choice that pays no more than the fee stays listed, greyed out, with the reason. */
function renderPop(focus = false) {
  const pop = $("pop");
  document.querySelectorAll("[data-chip]").forEach((chip) => {
    chip.setAttribute("aria-expanded", String(chip.dataset.chip === state.open));
  });
  if (!state.open || state.view !== "sell" || !ready()) {
    pop.hidden = true;
    return;
  }
  const had = pop.contains(document.activeElement) ? document.activeElement.dataset.pick : "";
  const t = terms();
  const kind = t.kind;
  const expiry = Number(t.expiry);
  let title;
  let hint;
  let rows;
  if (state.open === "size") {
    title = "How much BTC to lock?";
    hint = "The 1,000-sat price-check fee comes out of this on the date. We start at 0.002 BTC so the fee stays small.";
    rows = SIZES.map((q) => ({
      pick: `size:${q}`,
      on: q === t.size,
      label: `${fmtBtc(q)} BTC`,
      note: `${int(q)} sats · about ${usd0(worth(q, spotUsd()))}`,
      pay: estimate(kind, t.line, expiry, q),
    }));
  } else if (state.open === "date") {
    title = "Until when?";
    hint = "Fridays at 08:00 UTC, the same dates as Deribit’s BTC options. Your BTC stays locked until then.";
    const row = (pick, on, label, note, unix) => {
      const at = nearestTo(linesFor(kind, unix), t.line);
      return { pick, on, label, note, at, pay: estimate(kind, at, unix, t.size) };
    };
    rows = dates().map((unix) => row(`date:${unix}`, !state.tenorSec && unix === state.date, whenShort(unix), away(unix), unix));
    if (TEST) rows.push(row("tenor:600", state.tenorSec === 600, "In 10 minutes", "Test date", Math.floor(Date.now() / 1000) + 600));
  } else {
    title = kind === 0 ? "Give up gains above" : "Take the loss below";
    hint = `Today’s price is ${usd0(spotUsd())}.`;
    rows = linesFor(kind, expiry).map((k) => ({
      pick: `line:${k}`,
      on: k === t.line,
      label: usd0(k),
      note: `${Math.abs((k / spotUsd() - 1) * 100).toFixed(1)}% ${k > spotUsd() ? "above" : "below"} today`,
      pay: estimate(kind, k, expiry, t.size),
    }));
  }
  const list = el("div", "opts");
  for (const row of rows) {
    const btn = el("button", row.on ? "on" : "");
    btn.type = "button";
    btn.dataset.pick = row.pick;
    btn.append(el("b", "", row.label), el("span", "", row.note));
    if (clears(row.pay)) {
      btn.setAttribute("aria-pressed", String(row.on));
    } else {
      btn.className = "off";
      btn.setAttribute("aria-disabled", "true");
      btn.append(el("em", "", row.pay == null
        ? "There’s no price for this yet."
        : `Pays ${int(row.pay)} sats${row.at ? ` at ${usd0(row.at)}` : ""}, which doesn’t cover the 1,000-sat price-check fee.`));
    }
    list.append(btn);
  }
  const heading = el("p", "q", title);
  heading.id = "pop-title";
  pop.replaceChildren(heading, list, el("p", "hint", hint));
  pop.hidden = false;
  const chip = document.querySelector(`[data-chip="${state.open}"]`);
  pop.style.left = `${Math.max(0, Math.min(chip.offsetLeft, pop.parentElement.clientWidth - pop.offsetWidth))}px`;
  pop.style.top = `${chip.offsetTop + chip.offsetHeight + 12}px`;
  const target = had || (focus ? (rows.find((row) => row.on) || rows[0])?.pick : "");
  if (target) pop.querySelector(`[data-pick="${target}"]`)?.focus();
}

function onPick(event) {
  const btn = event.target.closest("[data-pick]");
  if (!btn || btn.getAttribute("aria-disabled") === "true") return;
  const [what, value] = btn.dataset.pick.split(":");
  if (what === "size") state.size = BigInt(value);
  if (what === "date") {
    state.date = Number(value);
    state.tenorSec = 0;
  }
  if (what === "tenor") state.tenorSec = Number(value);
  if (what === "line") state.lines[state.kind] = Number(value);
  const chip = document.querySelector(`[data-chip="${state.open}"]`);
  state.open = "";
  onTermsChanged();
  chip?.focus();
}

/** The drawer. Everything in it is a local estimate until the box is ticked. */
function renderCheckout() {
  const open = state.checkout && state.view === "sell" && ready();
  $("checkout").hidden = !open;
  $("scrim").hidden = !open;
  document.body.classList.toggle("locked", open);
  for (const id of ["top", "main", "note"]) $(id).inert = open;
  if (!open) return;
  const t = terms();
  const { kind, line: k, size: q } = t;
  const day = whenDay(t.expiry);
  const est = estimate(kind, k, Number(t.expiry), q);
  const pay = state.offer ? state.offer.quote.sats : est;
  const all = backSats(kind, k, k, q);
  sentenceInto($("checkout-sentence"), kind, q, t.expiry, k, "now");
  if (clears(pay)) {
    $("pay-head").replaceChildren(state.offer ? "You get paid " : "You get paid about ", el("span", "amt", `₿${fmtBtc(pay)}`), " now.");
    const was = state.offer && est != null && est !== pay ? ` · the estimate was ${int(est)} sats` : "";
    $("pay-sub").textContent = `${int(pay)} sats · about ${usd2(worth(pay, spotUsd()))} at today’s ${usd0(spotUsd())}${was}`;
  } else {
    $("pay-head").textContent = "This doesn’t cover the price-check fee.";
    $("pay-sub").textContent = pay == null
      ? "We can’t price this one right now."
      : `It pays ${state.offer ? "" : "about "}${int(pay)} sats, not more than the 1,000-sat price-check fee, so it can’t be locked.`;
  }
  $("fee-label").textContent = `Price-check fee on ${day}`;
  $("rows-when").textContent = `If BTC on ${day} is`;
  const rows = [[`Stays ${kind === 0 ? "under" : "above"} ${usd0(k)}`, `₿${fmtBtc(all)}`, `${int(all)} sats · all of it, less the fee`]];
  let worst;
  if (kind === 0) {
    const high = Math.ceil((k * 1.1) / 10_000) * 10_000;
    const kept = usd0(worth(backSats(0, high, k, q), high));
    rows.push([`Goes above ${usd0(k)}`, "Fewer sats", `always worth about ${kept}`]);
    worst = `I understand that if BTC is above ${usd0(k)} on ${day}, I get back fewer sats (worth about ${kept}).`;
  } else {
    const zero = usd0(Math.floor(zeroAt(k, q)));
    rows.push(
      [`Falls below ${usd0(k)}`, "Fewer sats", `${usd0(Number(q) / 1e5)} of your BTC for every $1,000 it falls`],
      [`${zero} or lower`, "Nothing", "the desk keeps what you locked"],
    );
    worst = `I understand that if BTC is below ${usd0(k)} on ${day}, I get back less, and nothing at ${zero} or lower.`;
  }
  $("rows").replaceChildren(...rows.map(([when, get, small], index) => {
    const row = el("div", "row");
    const value = el("span", index === 2 ? "get zero" : "get", get);
    value.append(el("small", "", small));
    row.append(el("span", "when", when), value);
    return row;
  }));
  $("agree-text").textContent = worst;
  $("chart-title").textContent = `What you end up with on ${day}`;
  $("chart-cap").textContent = clears(pay)
    ? `Back from the lock, plus the ${int(pay)} sats paid now.`
    : "No payment: this doesn’t pay more than the 1,000-sat price-check fee.";
  drawChart($("checkout-chart"), { kind, k, q, pay: clears(pay) ? pay : 0n, at: { p: spotUsd(), label: "Today" }, day });
  renderFoot();
}

/** The button, the firm offer and its ring. Runs every second while the drawer is open. */
function renderFoot() {
  if (!state.checkout) return;
  const now = Math.floor(Date.now() / 1000);
  const quote = state.offer?.quote;
  const left = quote ? Math.min(quote.validUntil, quote.deadline) - now : 0;
  const firm = $("firm");
  let label = "Lock and get paid";
  let off = false;
  let note = state.walletNote;
  firm.replaceChildren();
  $("agree").checked = state.agree;
  if (!state.address) {
    label = "Connect wallet";
  } else if (!state.agree) {
    off = true;
  } else if (state.quoting) {
    label = "Getting your offer…";
    off = true;
  } else if (quote && !clears(quote.sats)) {
    off = true;
    firm.append(el("span", "", `${int(quote.sats)} sats`));
    note = `The desk offers ${int(quote.sats)} sats, which doesn’t cover the 1,000-sat price-check fee. Pick a closer line, a later date or more BTC.`;
  } else if (quote && left > 0) {
    const ring = el("span", "ring", `Offer holds ${mmss(left)}`);
    ring.style.setProperty("--left", String(Math.min(100, (left / QUOTE_TTL_S) * 100)));
    firm.append(el("span", "", `₿${fmtBtc(quote.sats)}`), ring);
  } else if (quote) {
    label = "Refresh offer";
    firm.append(el("span", "ring", "Offer expired"));
  } else if (state.quoteNote) {
    label = "Try again";
    note = humanNote(state.quoteNote);
  }
  $("confirm").textContent = label;
  $("confirm").disabled = off;
  $("checkout-status").textContent = note;
}

function pageHash(view) {
  if (view === "connect") return "#/connect";
  if (view === "home") return state.selected ? `#/positions/${state.selected}` : "#/positions";
  return state.kind === 1 ? "#/quote/put" : "#/quote/call";
}

function routeFromHash() {
  const path = (location.hash || "#/").replace(/^#/, "");
  if (path.startsWith("/sell/put") || path.startsWith("/quote/put")) return { view: "sell", kind: 1 };
  if (path.startsWith("/sell/call") || path.startsWith("/quote/call")) return { view: "sell", kind: 0 };
  if (path.startsWith("/positions")) return { view: "home", kind: state.kind, id: path.slice("/positions/".length) || null };
  if (path.startsWith("/connect")) return { view: "connect", kind: state.kind };
  return { view: "sell", kind: state.kind };
}

function show(view, mode = "push") {
  state.view = view;
  $("connect").hidden = view !== "connect";
  $("home").hidden = view !== "home";
  $("sell").hidden = view !== "sell";
  if (view !== "sell") {
    state.open = "";
    closeCheckout();
  }
  const next = pageHash(view);
  if (mode !== "quiet" && location.hash !== next) {
    if (mode === "replace") history.replaceState(null, "", next);
    else history.pushState(null, "", next);
  }
  renderTop();
  if (view === "home") renderBlotter();
  if (view === "sell") renderSell();
  if (view === "connect") {
    $("connect-current").hidden = !state.address;
    $("connect-address").textContent = shortAddress(state.address);
    $("account-key").focus();
  }
}

function renderTop() {
  const known = Boolean(state.address);
  $("who").hidden = !known;
  $("who-address").textContent = known ? shortAddress(state.address) : "";
  $("who-tail").textContent = known ? `…${state.address.slice(-4)}` : "";
  $("top-connect").hidden = known;
  const count = state.restored.length + visiblePositions().length;
  $("count").hidden = !count;
  $("count").textContent = String(count);
  document.querySelectorAll("[data-tab]").forEach((btn) => {
    if (btn.dataset.tab === state.view) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
}

let shownId = "";

function renderBlotter() {
  const rows = [...state.restored, ...visiblePositions()];
  const selected = rows.find((position) => position.id === state.selected) || null;
  if (!selected) state.selected = null;
  if (state.view === "home" && location.hash !== pageHash("home")) history.replaceState(null, "", pageHash("home"));
  renderTop();
  $("list-view").hidden = Boolean(selected);
  $("position-view").hidden = !selected;
  if (selected) {
    if (shownId !== selected.id) $("status").textContent = "";
    shownId = selected.id;
    renderPosition(selected);
    return;
  }
  shownId = "";
  const host = $("blotter");
  host.replaceChildren();
  if (!rows.length) {
    host.append(el("p", "empty", state.address
      ? "No positions yet. Lock some BTC and it shows up here."
      : "Connect your wallet to see your positions."));
    return;
  }
  for (const position of rows) {
    const row = el("a", "prow");
    row.href = `#/positions/${position.id}`;
    const icon = el("span", position.kind === 1 ? "kindico put" : "kindico");
    icon.append(kindIcon(position.kind));
    const what = el("span");
    what.append(
      el("b", "", `${capital(VERBS.past[1 + position.kind])} ${usd0(Number(position.strike) / 100)}`),
      el("span", "m", `${fmtBtc(position.collateral)} BTC · until ${whenShort(position.expiry)}`),
    );
    const done = position.status === "settled" || settlementKnown(position);
    const side = el("span", "r");
    side.append(el("span", done ? "pill ok" : "pill", statusLabel(position)));
    const pay = position.premiumSats || 0n;
    let extra = "";
    if (done && position.writerKeep) {
      const net = BigInt(position.writerKeep) + pay - position.collateral;
      extra = `${net < 0n ? "−" : "+"}${int(net < 0n ? -net : net)} sats overall`;
    } else if (pay > 0n && (position.status === "filled" || done)) extra = `+${int(pay)} sats paid`;
    else if (pay > 0n && (position.status === "locking" || position.status === "deposited")) extra = `Pays ${int(pay)} sats`;
    if (extra) side.append(el("small", "", extra));
    row.append(icon, what, side);
    host.append(row);
  }
}

function sendClock(node) {
  const left = Number(node.dataset.until) - Math.floor(Date.now() / 1000);
  node.textContent = left > 0 ? `${mmss(left)} left to send` : "Time ran out. Checking…";
}

function renderPosition(p) {
  const k = Number(p.strike) / 100;
  const q = p.collateral;
  const pay = p.premiumSats || 0n;
  const now = Math.floor(Date.now() / 1000);
  const done = p.status === "settled" || settlementKnown(p);
  const live = p.status === "locking" || p.status === "deposited";
  const side = (price) => (p.kind === 0 ? (price > k ? "above" : "under") : (price < k ? "below" : "above"));
  sentenceInto($("position-sentence"), p.kind, q, p.expiry, k, live ? "ing" : "past");
  const head = el("h2");
  const body = [];
  let at = state.spotCents == null ? null : { p: spotUsd(), label: "Now" };
  if (p.status === "locking") {
    head.textContent = p.walletTxid ? "Your wallet sent it." : "Send your BTC to finish.";
    body.push(el("p", "sub", p.walletTxid
      ? `Waiting for ₿${fmtBtc(q)} to arrive. As soon as it lands, we pay you ${int(pay)} sats.`
      : `Send ₿${fmtBtc(q)} from your wallet. As soon as it lands, we pay you ${int(pay)} sats.`));
    const timer = el("p", "clock");
    timer.dataset.until = String(p.deadline);
    sendClock(timer);
    const acts = el("div", "acts");
    acts.append(
      action("btn sm", "Reopen wallet", () => openWallet(p)),
      action("textbtn", "Copy payment link", (event) => {
        void copyToClipboard(event.currentTarget, p.uri || paymentUri(p.address, p.collateral));
      }),
      action("textbtn", "Cancel", (event) => {
        void abortLock(p, event.currentTarget);
      }),
    );
    body.push(timer, acts);
  } else if (p.status === "deposited") {
    head.textContent = "Your BTC arrived.";
    body.push(el("p", "sub", "Paying you now…"));
  } else if (done) {
    const keep = p.writerKeep ? BigInt(p.writerKeep) : null;
    const desk = p.deskTake ? BigInt(p.deskTake) : 0n;
    if (p.settleCents) at = { p: Number(p.settleCents) / 100, label: "BTC was" };
    if (keep == null) {
      head.textContent = "Done.";
      body.push(el("p", "sub", "Your BTC left the vault. Reading what came back…"));
    } else {
      head.textContent = `Done. You ended with ₿${fmtBtc(keep + pay)}.`;
      const where = p.settleCents
        ? `BTC was $${fmtUsdFromCents(BigInt(p.settleCents))} at ${atTime(p.expiry)}, ${side(at.p)}`
        : `BTC ended ${desk > 0n ? (p.kind === 0 ? "above" : "below") : (p.kind === 0 ? "under" : "above")}`;
      const then = desk === 0n ? ", so all of it came back." : keep === 0n ? ", so the desk kept what you locked." : ".";
      body.push(el("p", "sub", `${where} your ${usd0(k)} line${then}`));
      const ledger = el("div", "ledger");
      const line = (name, value, className = "") => {
        const row = el("div", className === "tot" ? "tot" : "");
        row.append(el("span", "", name), el("span", className === "minus" ? "minus" : "", value));
        ledger.append(row);
      };
      line("You locked", `${int(q)} sats`);
      if (pay > 0n) line("Paid to you", `+${int(pay)}`);
      if (desk > 0n) line(`To the desk, for ${p.kind === 0 ? "gains above" : "the loss below"} ${usd0(k)}`, `−${int(desk)}`, "minus");
      line(`Price-check fee on ${whenDay(p.expiry)}`, `−${int(q - keep - desk)}`, "minus");
      line("You ended with", `${int(keep + pay)} sats`, "tot");
      body.push(ledger);
    }
  } else if (p.status === "filled" && Number(p.expiry) > now) {
    head.textContent = `${capital(toGo(p.expiry))}.`;
    if (at) {
      const back = backSats(p.kind, at.p, k, q);
      const box = el("div", "ifnow");
      box.append(el("p", "", "If it ended now, you’d get back"), el("p", "big", `₿${fmtBtc(back)} · ${int(back)} sats`));
      if (pay > 0n) box.append(el("p", "small", `on top of the ${int(pay)} sats you already have.`));
      body.push(el("p", "sub", `BTC is ${usd0(at.p)}, ${side(at.p)} your ${usd0(k)} line.`), box);
    }
  } else if (p.status === "filled") {
    head.textContent = "Checking the price.";
    body.push(el("p", "sub", `We check the BTC price at ${atTime(p.expiry)} and send back what’s yours. Nothing for you to do.`));
    const settle = settleButton(p);
    if (settle) {
      const acts = el("div", "acts");
      acts.append(settle);
      body.push(acts);
    }
  } else if (p.status === "expired") {
    head.textContent = p.refundable ? "The desk didn’t take it in time." : "Time ran out before your BTC arrived.";
    body.push(el("p", "sub", p.refundable ? `Your ₿${fmtBtc(q)} is still yours. Take it back.` : "Nothing was locked."));
    if (p.refundable) {
      const acts = el("div", "acts");
      acts.append(action("btn sm", "Take it back", (event) => {
        void refund(p, event.currentTarget);
      }));
      body.push(acts);
    }
  } else if (p.status === "refunded") {
    head.textContent = "Your BTC is back in your wallet.";
    body.push(el("p", "sub", "The desk didn’t take it, so nothing was locked."));
  }
  const host = $("position-body");
  const opened = Boolean(host.querySelector("details")?.open);
  host.replaceChildren(head, ...body);
  const steps = progressSteps(p.status);
  if (steps) host.append(steps);
  const txs = txLinks(p);
  if (txs) host.append(txs);
  const more = el("details", "more");
  more.open = opened;
  const facts = el("dl", "kv");
  for (const [name, value] of [
    ["Position ID", p.restored ? p.id.replace(/^restore:/, "") : ""],
    ["Vault", p.vaultAddress],
    ["Paid to", p.payoutAddress || p.writerAddress],
    ["Price check", `Deribit BTC index, ${atTime(p.expiry)}`],
  ]) {
    if (value) facts.append(el("dt", "", name), el("dd", "", value));
  }
  more.append(el("summary", "", "Details"), facts);
  host.append(more);
  $("position-chart-title").textContent = `What you end up with on ${whenDay(p.expiry)}`;
  drawChart($("position-chart"), { kind: p.kind, k, q, pay, at, day: whenDay(p.expiry) });
}

function canSettle(position) {
  if (position.restored) return false;
  if (position.status !== "filled") return false;
  if (!position.vaultAddress || !position.holderPkHex || !position.beaconTxid) return false;
  const expiry = Number(position.expiry) || 0;
  if (!expiry || expiry > Math.floor(Date.now() / 1000)) return false;
  if (position.settleTxid && position.settleTxid !== position.closeTxid) return false;
  return true;
}

function settleNote(outcome) {
  if (outcome.result === "unfixed") return "The price check isn’t published yet. Try again in a minute.";
  if (outcome.result === "mismatch") return "This position reads a different price feed.";
  if (outcome.result === "waiting" && outcome.reason === "early") return "Wait until the date.";
  if (outcome.result === "waiting" && outcome.reason === "beacon") return "The price feed isn’t ready yet.";
  if (outcome.result === "waiting") return "Your vault isn’t ready yet.";
  return "Couldn’t pay out. Try again.";
}

async function settlePosition(position, button) {
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = "Paying out";
  try {
    const outcome = await settleFromPage({
      ...(await fundRequest(position)),
      fillTxid: position.closeTxid || undefined,
    });
    if (outcome.result !== "settled") {
      button.disabled = false;
      button.textContent = settleNote(outcome);
      return;
    }
    position.status = "settled";
    position.settleTxid = outcome.txid;
    if (outcome.writer != null) position.writerKeep = outcome.writer.toString();
    if (outcome.holder != null) position.deskTake = outcome.holder.toString();
    if (outcome.price != null) position.settleCents = outcome.price.toString();
    persist();
    renderBlotter();
  } catch (err) {
    button.disabled = false;
    button.textContent = err instanceof Error ? err.message : previous;
  }
}

function settleButton(position) {
  if (!canSettle(position)) return null;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn sm";
  button.textContent = "Pay out now";
  button.addEventListener("click", () => {
    void settlePosition(position, button);
  });
  return button;
}

function txLink(label, txid) {
  if (!/^[0-9a-f]{64}$/.test(txid || "")) return null;
  const row = document.createElement("p");
  row.className = "tx-link";
  const name = document.createElement("span");
  name.textContent = label;
  const link = document.createElement("a");
  link.href = `https://explorer.mutinynet.arkade.sh/tx/${txid}`;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = `${txid.slice(0, 8)}…${txid.slice(-4)}`;
  row.append(name, link);
  return row;
}

function txLinks(position) {
  const box = document.createElement("div");
  box.className = "txs";
  const funding = txLink("Lock", position.fundingTxid);
  const refunded = position.status === "refunded";
  const refund = refunded ? txLink("Sent back", position.closeTxid) : null;
  const filled = position.status === "filled" || position.status === "settled";
  const completed = filled ? txLink("Payment to you", position.closeTxid) : null;
  const settlement = position.settleTxid && position.settleTxid !== position.closeTxid
    ? txLink("Payout", position.settleTxid)
    : null;
  if (!funding && !refund && !completed && !settlement) return null;
  for (const node of [funding, completed, settlement, refund]) {
    if (node) box.append(node);
  }
  return box;
}

let copiedUntil = 0;

async function copyToClipboard(button, text) {
  if (!text) return;
  const previous = button.textContent;
  copiedUntil = Date.now() + 1200;
  button.textContent = "Copied";
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) {
      copiedUntil = 0;
      button.textContent = "Copy failed";
      return;
    }
  }
  setTimeout(() => {
    if (button.isConnected && Date.now() >= copiedUntil) button.textContent = previous;
  }, 1200);
}

function onTermsChanged() {
  pinnedExpiry = 0;
  dropQuote();
  renderSell();
}

function dropQuote() {
  quoteGen += 1;
  state.quoting = false;
  state.offer = null;
  state.quoteNote = "";
}

/** The only desk request: sent when "I understand" is ticked, or on Refresh offer. */
async function askQuote() {
  if (!state.checkout || !state.agree || !state.address || state.quoting || !ready()) return;
  const gen = ++quoteGen;
  const asked = terms();
  state.quoting = true;
  state.offer = null;
  state.quoteNote = "";
  renderFoot();
  try {
    const live = await requestQuotes({
      relays: RELAYS,
      desks: PINNED_DESKS,
      kind: asked.kind,
      strike: asked.strike,
      collateral: asked.size,
      expiry: asked.expiry,
      spotCents: state.spotCents,
      writerAddress: state.address,
    });
    if (gen !== quoteGen) return;
    const quote = live.quotes.length ? bestQuote(live.quotes, 0) : null;
    if (!quote) throw new Error(live.note || "The desk did not answer.");
    let deposit = null;
    // The vault is derived now, so the Lock click can open the wallet without waiting.
    if (clears(quote.sats)) {
      deposit = await depositAddress({
        kind: asked.kind,
        strike: asked.strike,
        collateral: asked.size,
        premium: quote.sats,
        expiry: asked.expiry,
        deadline: BigInt(quote.deadline),
        writerAddress: state.address,
        holderPkHex: quote.holderPkHex,
        beaconTxidHex: quote.beaconTxid,
        beaconGidx: quote.beaconGidx,
        exit: quote.exit != null ? BigInt(quote.exit) : undefined,
      });
      if (gen !== quoteGen) return;
      if (deposit.address !== quote.intentAddress || deposit.vaultAddress !== quote.vaultAddress) {
        throw new Error("The desk address does not match this page.");
      }
    }
    state.offer = { quote, deposit, terms: asked };
  } catch (err) {
    if (gen !== quoteGen) return;
    state.quoteNote = err instanceof Error ? err.message : "The desk did not answer.";
  }
  if (gen !== quoteGen) return;
  state.quoting = false;
  renderCheckout();
}

function onConfirm() {
  if (!state.address) {
    openWallet();
    return;
  }
  const quote = state.offer?.quote;
  const now = Math.floor(Date.now() / 1000);
  if (quote && state.offer.deposit && clears(quote.sats) && quote.validUntil > now && quote.deadline > now) lock();
  else void askQuote();
}

/** Synchronous from the click to window.open, so the wallet popup is not blocked. */
function lock() {
  const { quote, deposit, terms: locked } = state.offer;
  const now = Math.floor(Date.now() / 1000);
  let position = state.positions.find((item) => item.address === deposit.address && item.status === "locking");
  if (!position) {
    position = {
      id: crypto.randomUUID(),
      side: 0,
      kind: locked.kind,
      strike: locked.strike,
      expiry: locked.expiry,
      collateral: locked.size,
      premiumSats: quote.sats,
      premiumUsd: quote.usd,
      solver: quote.name,
      status: "locking",
      deadline: quote.deadline,
      address: deposit.address,
      holderPkHex: deposit.holderPkHex,
      beaconTxid: deposit.beaconTxidHex,
      beaconGidx: deposit.beaconGidx,
      exit: deposit.exit,
      vaultAddress: deposit.vaultAddress,
      writerAddress: state.address,
      payoutAddress: state.address,
      days: 0,
      tenorSec: locked.tenorSec,
      createdAt: now,
      apy: annualized(quote.sats, locked.size, (Number(locked.expiry) - now) / 86400),
      uri: deposit.uri,
      apyFrozen: false,
      marketSats: null,
      marketApy: null,
    };
    state.positions.unshift(position);
  }
  persist();
  closeCheckout();
  state.selected = position.id;
  show("home");
  startWatch();
  openWallet(position);
}

function setKind(kind, mode) {
  if (state.kind !== kind) {
    state.kind = kind;
    state.open = "";
    closeCheckout();
    if (ready()) fitLine(kind);
    dropQuote();
  }
  show("sell", mode);
}

function openCheckout() {
  state.open = "";
  state.checkout = true;
  state.agree = false;
  state.walletNote = "";
  dropQuote();
  renderSell();
  $("checkout-change").focus();
}

function closeCheckout() {
  if (!state.checkout) return;
  state.checkout = false;
  state.agree = false;
  state.walletNote = "";
  dropQuote();
  renderCheckout();
  if (state.view === "sell") $("see").focus();
}

function connectAddress() {
  try {
    state.address = saveAddress($("account-key").value);
    $("account-error").textContent = "";
    $("account-key").value = "";
    show("sell");
  } catch (err) {
    $("account-error").textContent = err instanceof Error ? err.message : "That address was not saved.";
  }
}

function disconnect() {
  clearAddress();
  state.address = "";
  dropQuote();
  show("connect");
}

async function hydrateMissing() {
  let changed = false;
  for (const position of state.positions) {
    if (position.payoutAddress || position.writerAddress) continue;
    const hex = position.writerHex || legacyWriterHex();
    if (!hex) continue;
    try {
      position.writerHex = position.writerHex || hex;
      position.payoutAddress = await writerPayoutAddress(hex);
      changed = true;
    } catch {
      // A position we cannot price stays out of the list.
    }
  }
  if (!changed) return;
  persist();
  renderBlotter();
}

async function fundRequest(position) {
  const base = {
    kind: position.kind,
    strike: position.strike,
    collateral: position.collateral,
    premium: position.premiumSats,
    expiry: position.expiry,
    deadline: BigInt(position.deadline),
    holderPkHex: position.holderPkHex,
    beaconTxidHex: position.beaconTxid,
    beaconGidx: position.beaconGidx,
    exit: position.exit != null ? BigInt(position.exit) : undefined,
  };
  if (position.writerAddress) return { ...base, writerAddress: position.writerAddress };
  const hex = position.writerHex || legacyWriterHex();
  if (!hex) throw new Error("This position has no address in this browser.");
  return { ...base, writerHex: hex };
}

async function abortLock(position, button) {
  if (!position || position.status !== "locking") return;
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = "Checking";
  try {
    const phase = await readIntent(watchRow(position));
    if (phase.phase !== "open") {
      applyChain(position, phase);
      renderSell();
      renderBlotter();
      return;
    }
  } catch (err) {
    button.disabled = false;
    button.textContent = err instanceof Error ? err.message : "Could not check the deposit";
    return;
  }
  state.positions = state.positions.filter((item) => item.id !== position.id);
  if (state.selected === position.id) state.selected = null;
  persist();
  button.disabled = false;
  button.textContent = previous;
  renderSell();
  renderBlotter();
}

async function refund(position, button) {
  button.disabled = true;
  button.textContent = "Taking it back";
  try {
    await cancelIntent(await fundRequest(position));
    applyChain(position, await readIntent(watchRow(position)));
    if (position.status !== "refunded" && button.isConnected) {
      button.disabled = false;
      button.textContent = "Take it back";
    }
  } catch (err) {
    button.disabled = false;
    button.textContent = err instanceof Error ? err.message : "Couldn’t take it back";
  }
}

function freeze(position) {
  position.apyFrozen = true;
  position.apy = annualized(position.premiumSats, position.collateral, tenorDays(position));
  position.marketSats = null;
  position.marketApy = null;
}

const CHAIN_STATUS = {
  open: "locking",
  funded: "deposited",
  expired: "expired",
  filled: "filled",
  refunded: "refunded",
};

function applyChain(position, update) {
  const next = CHAIN_STATUS[update.phase];
  if (!next) return;
  if (next === "locking" && position.status !== "locking") return;
  const fundingTxid = update.fundingTxid || position.fundingTxid || "";
  const closeTxid = update.closeTxid || position.closeTxid || "";
  const settleTxid = next === "refunded" ? "" : (update.settleTxid || position.settleTxid || "");
  const display = next === "filled" && settlementKnown({ settleTxid, closeTxid }) ? "settled" : next;
  const same = position.status === display
    && Boolean(position.refundable) === update.refundable
    && (position.fundingTxid || "") === fundingTxid
    && (position.closeTxid || "") === closeTxid
    && (position.settleTxid || "") === settleTxid;
  if (same) return;
  if (display === "deposited" || display === "filled" || display === "settled" || display === "expired") freeze(position);
  position.status = display;
  position.refundable = update.refundable;
  position.fundingTxid = fundingTxid;
  position.closeTxid = closeTxid;
  position.settleTxid = settleTxid;
  persist();
  renderBlotter();
  renderSell();
  if (display === "settled") void fillKept();
}

function watchRow(position) {
  return {
    address: position.address,
    writerAddress: position.writerAddress || position.payoutAddress || "",
    collateral: BigInt(position.collateral),
    premium: BigInt(position.premiumSats),
    deadline: Number(position.deadline),
    since: Number(position.createdAt) || 0,
    vaultAddress: position.vaultAddress || "",
  };
}

let watchAbort = null;
let watchKey = "";

function startWatch() {
  const rows = state.positions.filter((position) => position.address && position.writerAddress && !["refunded", "settled"].includes(position.status));
  const key = rows.map((position) => position.address).sort().join("|");
  if (key === watchKey) return;
  watchAbort?.abort();
  watchKey = key;
  if (!rows.length) return;
  const ctrl = new AbortController();
  watchAbort = ctrl;
  const watched = rows.map((position) => ({
    ...watchRow(position),
    register: async () => {
      if (!position.holderPkHex || !position.beaconTxid) return "";
      return registerIntent(await fundRequest(position));
    },
  }));
  void watchIntents(watched, (update) => {
    const position = state.positions.find((item) => item.address === update.address);
    if (position) applyChain(position, update);
  }, ctrl.signal).catch(() => {
    if (!ctrl.signal.aborted) watchKey = "";
  });
}

async function refreshPositionMarkets() {
  if (state.spotCents == null) return;
  const open = state.positions.filter((position) => position.status === "locking" && !position.apyFrozen);
  if (!open.length) return;
  let points;
  try {
    points = await fetchSurface();
  } catch {
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  let changed = false;
  for (const position of open) {
    const priced = deribitPremium({
      kind: position.kind,
      strikeUsd: Number(position.strike) / 100,
      expiry: Number(position.expiry),
      now,
      collateralSats: position.collateral,
      spotUsd: Number(state.spotCents) / 100,
      points,
    });
    if (!priced) continue;
    const paid = payablePremium(priced.sats);
    position.marketSats = paid;
    position.marketApy = annualized(paid, position.collateral, tenorDays(position));
    changed = true;
  }
  if (!changed) return;
  persist();
  if (state.view === "home") renderBlotter();
}

function tick() {
  const now = Math.floor(Date.now() / 1000);
  document.querySelectorAll("[data-until]").forEach(sendClock);
  renderFoot();
  for (const position of state.positions) {
    if (position.status !== "deposited" || !position.deadline || now < Number(position.deadline)) continue;
    if (!position.address || expiring.has(position.address)) continue;
    expiring.add(position.address);
    void readIntent(watchRow(position)).then((phase) => {
      applyChain(position, phase);
    }).catch(() => undefined).finally(() => expiring.delete(position.address));
  }
}

function listen(id, type, fn) {
  const node = $(id);
  if (node) node.addEventListener(type, fn);
}

function askWallet(value) {
  try {
    sessionStorage.setItem(WALLET_ASK, value);
    return true;
  } catch {
    return false;
  }
}

function takeWalletAsk() {
  try {
    const value = sessionStorage.getItem(WALLET_ASK) || "";
    sessionStorage.removeItem(WALLET_ASK);
    return value;
  } catch {
    return "";
  }
}

function openWalletPopup(url) {
  if (walletWindow && !walletWindow.closed) {
    try {
      walletWindow.close();
    } catch {
      // The previous wallet window is already gone.
    }
  }
  walletWindow = null;
  let popup = null;
  try {
    // No `noopener`: the callback window has to see this page as `window.opener`.
    popup = window.open(url, "_blank");
  } catch {
    popup = null;
  }
  if (!popup || popup === window) return false;
  walletWindow = popup;
  return true;
}

/** A connect error shows in the drawer while it is open. */
function walletError(position, text) {
  if (position) {
    $("status").textContent = text;
  } else if (state.checkout) {
    state.walletNote = text;
    renderFoot();
  } else {
    $("account-error").textContent = text;
  }
}

function openWallet(position) {
  if (position && position.status !== "locking") return;
  const request = position ? (position.uri || paymentUri(position.address, position.collateral)) : "";
  const params = position ? { flow: "send", position: position.id } : { flow: "connect" };
  const back = pageCallback(location.href, params);
  if (!callbackAllowed(back)) {
    walletError(position, "The wallet only returns to https, or to localhost.");
    return;
  }
  const action = position ? "send" : "connect";
  const payment = request || undefined;
  const popupUrl = walletAppUrl(WALLET_URL, action, pageCallback(location.href, { ...params, popup: "1" }), payment);
  const pageUrl = walletAppUrl(WALLET_URL, action, back, payment);
  if (!askWallet(position ? position.id : "connect")) {
    walletError(position, "This browser is not keeping the wallet return.");
    return;
  }
  // The wallet redirects the window it was opened in. Keep this page, and let
  // that window post the return. A blocked popup still does the round trip.
  if (!openWalletPopup(popupUrl)) location.assign(pageUrl);
}

function applyWalletHandoff(handoff, pending) {
  if (handoff.kind === "connect" && pending === "connect") {
    try {
      state.address = saveAddress(handoff.address);
      walletError(null, "");
    } catch (err) {
      walletError(null, err instanceof Error ? err.message : "That address was not saved.");
    }
    return;
  }
  if (handoff.kind === "connect-error" && pending === "connect") {
    walletError(null, "Your wallet didn’t connect. Try again, or open Arkade Wallet yourself.");
    return;
  }
  if (handoff.kind !== "sent" || handoff.positionId !== pending || !handoff.txid) return;
  const position = state.positions.find((item) => item.id === pending);
  if (!position) return;
  position.walletTxid = handoff.txid;
  persist();
}

function showWalletHandoff(handoff) {
  renderTop();
  if (handoff.kind === "connect" && state.address) {
    if (state.checkout) {
      renderCheckout();
      void askQuote();
    } else {
      show("sell");
    }
  }
  if (handoff.kind === "sent" && handoff.txid) renderBlotter();
}

function onWalletMessage(event) {
  const target = walletMessageTarget(location.origin);
  if (!target || event.origin !== target) return;
  if (!walletWindow || event.source !== walletWindow) return;
  const handoff = readWalletHandoffMessage(event.data);
  if (!handoff) return;
  applyWalletHandoff(handoff, takeWalletAsk());
  showWalletHandoff(handoff);
}

function walletOpener() {
  try {
    if (!window.opener || window.opener === window) return null;
    return window.opener;
  } catch {
    return null;
  }
}

function consumeWalletHandoff() {
  const opener = walletOpener();
  const message = popupHandoffMessage(location.search, opener != null);
  if (opener && message) {
    const target = walletMessageTarget(location.origin);
    history.replaceState(null, "", stripWalletParams(location.href));
    if (target) {
      try {
        opener.postMessage(message, target);
      } catch {
        // The opener is gone.
      }
    }
    window.close();
    return true;
  }
  const handoff = readWalletHandoff(location.search);
  const pending = takeWalletAsk();
  history.replaceState(null, "", stripWalletParams(location.href));
  applyWalletHandoff(handoff, pending);
  return false;
}

function bind() {
  listen("wallet-connect", "click", () => openWallet());
  listen("account-save", "click", connectAddress);
  listen("account-key", "keydown", (event) => {
    if (event.key === "Enter") connectAddress();
  });
  listen("account-change", "click", disconnect);
  listen("top-connect", "click", () => show("connect"));
  listen("who", "click", () => show("connect"));
  document.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.tab === "home") state.selected = null;
      show(btn.dataset.tab);
    });
  });
  document.querySelectorAll("[data-kind]").forEach((btn) => {
    btn.addEventListener("click", () => setKind(Number(btn.dataset.kind), state.view === "sell" ? "replace" : "push"));
  });
  document.querySelectorAll("[data-chip]").forEach((chip) => {
    chip.addEventListener("click", () => {
      state.open = state.open === chip.dataset.chip ? "" : chip.dataset.chip;
      renderPop(true);
    });
  });
  listen("pop", "click", onPick);
  // A tap outside an open list only closes it, the way a sheet's backdrop does.
  document.addEventListener("click", (event) => {
    if (!state.open || event.target.closest("#pop, [data-chip]")) return;
    event.preventDefault();
    event.stopPropagation();
    state.open = "";
    renderPop();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!state.open) {
      closeCheckout();
      return;
    }
    const chip = document.querySelector(`[data-chip="${state.open}"]`);
    state.open = "";
    renderPop();
    chip?.focus();
  });
  listen("see", "click", openCheckout);
  listen("checkout-change", "click", closeCheckout);
  listen("scrim", "click", closeCheckout);
  listen("agree", "change", () => {
    state.agree = $("agree").checked;
    if (state.agree) void askQuote();
    else dropQuote();
    renderFoot();
  });
  listen("confirm", "click", onConfirm);
  window.addEventListener("resize", () => {
    if (state.view === "home") renderBlotter();
    renderCheckout();
  });
  document.querySelectorAll("[data-restore-kind]").forEach((btn) => {
    btn.addEventListener("click", () => {
      restoreKind = Number(btn.dataset.restoreKind);
      document.querySelectorAll("[data-restore-kind]").forEach((other) => {
        other.setAttribute("aria-pressed", String(other === btn));
      });
    });
  });
  listen("restore-form", "submit", (event) => {
    event.preventDefault();
    void submitRestore();
  });
}

function writerScriptOf(position) {
  if (position.writerScript) return position.writerScript;
  const address = position.writerAddress || position.payoutAddress;
  if (!address) return "";
  try {
    return pkScriptOf(address);
  } catch {
    return "";
  }
}

async function fillKept() {
  const rows = [...state.positions, ...state.restored];
  let localChanged = false;
  let any = false;
  await Promise.all(rows.map(async (position) => {
    if (position.keptChecked || position.writerKeep || !settlementKnown(position)) return;
    const script = writerScriptOf(position);
    if (!script) return;
    const split = await readKept(position.settleTxid, script);
    if (!split) return;
    position.keptChecked = true;
    position.writerKeep = split.writer.toString();
    position.deskTake = split.desk.toString();
    any = true;
    if (!position.restored) localChanged = true;
  }));
  if (localChanged) persist();
  if (any && state.view === "home") renderBlotter();
  if (any && state.view === "sell") renderSell();
}

async function submitRestore() {
  const button = $("restore-submit");
  const error = $("restore-error");
  if (error) error.textContent = "";
  if (button) {
    button.disabled = true;
    button.textContent = "Restoring";
  }
  try {
    const position = await restoreVault({
      outpoint: $("restore-outpoint").value,
      kind: restoreKind,
      strike: $("restore-strike").value,
      expiry: $("restore-expiry").value,
      collateral: $("restore-collateral").value,
      writerPk: $("restore-writer").value,
      holderPk: $("restore-holder").value,
      beaconTxid: $("restore-beacon").value,
      beaconGidx: $("restore-gidx").value,
      exit: $("restore-exit").value,
      readFee: $("restore-fee").value,
    });
    const index = state.restored.findIndex((item) => item.id === position.id);
    if (index >= 0) state.restored[index] = position;
    else state.restored.unshift(position);
    state.selected = position.id;
    show("home");
    await fillKept();
  } catch (err) {
    if (error) error.textContent = err instanceof Error ? err.message : "Could not restore that vault.";
  }
  if (button) {
    button.disabled = false;
    button.textContent = "Restore";
  }
}

async function loadSpot() {
  try {
    const res = await fetch("https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd");
    if (!res.ok) throw new Error("spot");
    const price = Number((await res.json())?.result?.index_price);
    if (!(price > 1000 && price < 10_000_000)) throw new Error("spot");
    state.spotCents = BigInt(Math.round(price * 100));
  } catch {
    // A failed refresh keeps the last index price.
  }
}

/** Public Deribit reads only. The desk is asked nothing until the box is ticked. */
async function loadPrices() {
  const [, points] = await Promise.all([loadSpot(), fetchSurface().catch(() => null)]);
  state.points = points;
  state.loaded = true;
  $("spot-line").textContent = state.spotCents == null
    ? "Today’s BTC price isn’t loading."
    : `BTC is $${fmtUsdFromCents(state.spotCents)} on the Deribit index.`;
  renderSell();
  if (state.view === "home") renderBlotter();
}

function loadArtifact() {
  const node = $("artifact");
  try {
    node.textContent = artifactLine();
  } catch (err) {
    node.textContent = err instanceof Error ? err.message : "The option programs did not load.";
  }
}

function showFromHash(mode = "quiet") {
  const route = routeFromHash();
  if (route.view === "connect" && state.address) {
    show("sell", "replace");
    return;
  }
  if (route.view === "sell") {
    setKind(route.kind, mode);
    return;
  }
  if (route.view === "home") state.selected = route.id;
  show(route.view, mode);
}

state.address = readAddress() || "";
window.addEventListener("message", onWalletMessage);
if (!consumeWalletHandoff()) {
  bind();
  showFromHash("replace");
  window.addEventListener("hashchange", () => showFromHash());
  void loadPrices();
  loadArtifact();
  if (promotedSettled) persist();
  void fillKept();
  startWatch();
  setInterval(tick, 1000);
  setInterval(startWatch, 15_000);
  setInterval(() => {
    void refreshPositionMarkets();
    void loadPrices();
  }, REFRESH_MS);
  void hydrateMissing();
}
