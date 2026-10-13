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
import { BEACON_READ_FEE } from "../protocol/constants.ts";
import { payablePremium } from "../protocol/pricing.ts";
import { bestQuote } from "./quote.js";
import { PINNED_DESKS, RELAYS } from "./rfq-config.js";
import { DUST, Q_MAX, Q_MIN, keepCrossing, writerKeep } from "./settle-math.js";
import { positionOutcome, settlementKnown } from "./src/position-status.ts";
import { restoreVault } from "./src/restore.ts";
import { settleFromPage } from "./src/settle.ts";
import { pkScriptOf, readIntent, readKept, watchIntents } from "./src/watch.ts";

const STORE = "arkade-options-desk-v1";
const REFRESH_MS = 18_000;
const WALLET_ASK = "arkade-options-wallet";

let promotedSettled = false;

const state = {
  spotCents: null,
  spotSource: "Loading",
  address: "",
  kind: 0,
  days: 30,
  tenorSec: 0,
  strikeIndex: 0,
  view: "connect",
  market: null,
  deskQuote: null,
  quoteNote: "",
  quoting: false,
  confirming: false,
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

function fmtWhen(unix) {
  return `${new Date(Number(unix) * 1000).toLocaleString("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })} UTC`;
}

/** A premium in dollars, from spot or else from the quote's own USD figure. */
function aboutUsd(sats, usd) {
  let cents = null;
  if (state.spotCents != null && sats != null) cents = (sats * state.spotCents + 50_000_000n) / 100_000_000n;
  else if (usd != null && Number.isFinite(Number(usd))) cents = BigInt(Math.round(Number(usd) * 100));
  return cents == null ? "" : `about $${fmtUsdFromCents(cents)}`;
}

function upfront(sats, usd) {
  const about = aboutUsd(sats, usd);
  return about ? `${sats} sats · ${about}` : `${sats} sats`;
}

function annualized(premiumSats, collateralSats, days) {
  if (collateralSats <= 0n || !(days > 0)) return null;
  return (Number(premiumSats) / Number(collateralSats)) * (365 / days) * 100;
}

function selectedDays() {
  if (state.tenorSec > 0) return state.tenorSec / 86400;
  return state.days;
}

function tenorDays(position) {
  if (position.tenorSec > 0) return position.tenorSec / 86400;
  if (position.days > 0) return position.days;
  const start = position.createdAt || Math.floor(Date.now() / 1000);
  const span = Number(position.expiry) - start;
  if (span > 0) return span / 86400;
  return 30;
}

function btcToSats(text) {
  const s = text.trim();
  if (!/^\d+(\.\d{0,8})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * 100_000_000n + BigInt((frac + "00000000").slice(0, 8));
}

let pinnedExpiry = 0;
let termsTouched = false;

function expiryUnix() {
  if (state.tenorSec > 0) {
    const now = Math.floor(Date.now() / 1000);
    if (pinnedExpiry <= now + 90) pinnedExpiry = now + state.tenorSec;
    return BigInt(pinnedExpiry);
  }
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + state.days);
  d.setUTCHours(8, 0, 0, 0);
  return BigInt(Math.floor(d.getTime() / 1000));
}

let pinnedStrike = null;

function ladder() {
  const steps = state.kind === 0 ? [105n, 110n, 115n, 125n, 140n] : [95n, 90n, 85n, 75n, 60n];
  const grid = state.spotCents >= 10_000_000n ? 100_000n : 50_000n;
  const seen = new Set([state.spotCents.toString()]);
  const rows = [state.spotCents];
  for (const step of steps) {
    let cents = ((state.spotCents * step) / 100n + grid / 2n) / grid * grid;
    const bump = state.kind === 0 ? grid : -grid;
    while (seen.has(cents.toString())) cents += bump;
    seen.add(cents.toString());
    rows.push(cents);
  }
  if (pinnedStrike != null && !rows.includes(pinnedStrike)) return [pinnedStrike, ...rows.slice(0, 5)];
  return rows;
}

function strike() {
  return ladder()[state.strikeIndex] ?? ladder()[0];
}

function sizeSats() {
  return btcToSats($("size").value);
}

function sizeError(sats) {
  if (sats == null) return "Use a BTC amount with up to 8 decimals.";
  if (sats < Q_MIN) return "Minimum size is 0.0001 BTC.";
  if (sats > Q_MAX) return "Maximum size is 10 BTC.";
  return "";
}

function termsKey() {
  const sats = sizeSats();
  if (state.spotCents == null || sats == null) return "";
  return `${state.kind}:${strike()}:${expiryUnix()}:${sats}`;
}

function kindCopy() {
  if (state.kind === 0) return "You sell upside above the strike. You keep the rest of the collateral.";
  return "You sell downside below the strike, down to the collateral.";
}

function shortAddress(address) {
  if (!address || address.length < 20) return address || "";
  return `${address.slice(0, 12)}…${address.slice(-6)}`;
}

const STEPS = ["Waiting for deposit", "Deposited", "Waiting for payout", "Premium paid", "Settled"];

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
      ? ["Waiting for deposit", "Deposited", "Refunded"]
      : ["Waiting for deposit", "Deposited", "Window closed"];
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
  if (position.status === "locking") return "Waiting for deposit";
  if (position.status === "deposited") return "Waiting for payout";
  if (position.status === "settled" || settlementKnown(position)) return "Settled";
  if (position.status === "filled") return "Premium paid";
  if (position.status === "expired") return "Window closed";
  if (position.status === "refunded") return "Refunded";
  if (position.status === "settled") return "Settled";
  return "Open";
}

function statusLead(position) {
  if (position.status === "locking") {
    if (position.walletTxid) return "The wallet sent this payment. Waiting for the deposit to show up.";
    return "Waiting for your deposit. This address keeps the payout below. The market can move until the coins arrive.";
  }
  if (position.status === "deposited") return "Deposit received. Waiting for the desk to pay your address.";
  if (position.status === "filled" || position.status === "refunded" || position.status === "settled") return "";
  if (position.status === "expired") {
    return position.refundable
      ? "The fill window closed. Your deposit is still on this address."
      : "The fill window closed before the deposit arrived.";
  }
  return "Open.";
}

function dustNote(sats) {
  const paid = sats == null ? "This premium" : `${fmtBtc(sats)} BTC (${sats} sats)`;
  return `${paid} is at or below ${DUST} sats. That is the smallest premium Arkade can pay, so this strike cannot be deposited. A closer strike, or a larger size, pays more.`;
}

function humanNote(note) {
  if (!note) return "";
  if (note.includes("writer script")) {
    return "This desk needs a redeploy before it can pay a pasted address. The number above is the live market.";
  }
  if (note.includes("premium below dust")) {
    return dustNote();
  }
  if (note.includes("float short")) {
    return "The desk has no sats to pay this premium yet. Fund the desk, then quote again.";
  }
  if (note.includes("expiry")) {
    return "The desk will not quote an expiry this soon. Redeploy it to allow 10 minutes.";
  }
  return note;
}

function positionKey(position) {
  return `${position.kind}:${position.strike}:${position.expiry}:${position.collateral}`;
}

function positionForForm() {
  const key = termsKey();
  if (!key) return null;
  let match = null;
  for (const position of visiblePositions()) {
    if (positionKey(position) !== key) continue;
    if (!match || (position.createdAt || 0) >= (match.createdAt || 0)) match = position;
  }
  return match;
}

function shownDeposit() {
  const position = positionForForm();
  if (!position) return null;
  return {
    address: position.address,
    uri: position.uri || paymentUri(position.address, position.collateral),
    amountSats: position.collateral,
    premium: position.premiumSats,
    apy: position.apy,
    deadline: position.deadline,
  };
}

function liveQuote() {
  if (PINNED_DESKS.length === 0) return state.market;
  return state.deskQuote;
}

function headlineQuote() {
  return state.deskQuote || state.market;
}

function mine(position) {
  if (position.writerAddress) return position.writerAddress === state.address;
  if (position.payoutAddress) return position.payoutAddress === state.address;
  return false;
}

function visiblePositions() {
  return state.positions.filter(mine);
}

let strikeKey = "";

function renderStrikes() {
  const host = $("strikes");
  if (state.spotCents == null) return;
  const rows = ladder();
  if (state.strikeIndex >= rows.length) state.strikeIndex = 0;
  const key = `${state.kind}:${rows.join(",")}`;
  if (key !== strikeKey) {
    strikeKey = key;
    host.replaceChildren();
    rows.forEach((cents, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "strike";
      btn.role = "radio";
      btn.dataset.index = String(index);
      const d = document.createElement("span");
      d.className = "delta";
      d.textContent = pctFromSpot(cents);
      const px = document.createElement("span");
      px.className = "px";
      px.textContent = fmtUsdFromCents(cents);
      btn.append(d, px);
      host.append(btn);
    });
  }
  for (const btn of host.querySelectorAll(".strike")) {
    btn.setAttribute("aria-checked", String(Number(btn.dataset.index) === state.strikeIndex));
  }
}

function pctFromSpot(cents) {
  if (cents === state.spotCents) return "±0%";
  const delta = Number((cents - state.spotCents) * 10000n / state.spotCents) / 100;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta.toFixed(1)}%`;
}

// The Quote page's summary is built by the same code as each position's.
const quoteSummary = payoffFigure();
$("sell").querySelector(".book").append(quoteSummary.figure);

function renderPayoff(quoted) {
  const sats = sizeSats();
  const ready = state.spotCents != null && sats != null && !sizeError(sats);
  quoteSummary.figure.hidden = !ready;
  if (!ready) return;
  const terms = {
    kind: state.kind,
    strike: strike(),
    collateral: sats,
    spot: state.spotCents,
    expiry: expiryUnix(),
    premium: quoted?.sats ?? null,
    premiumUsd: quoted?.usd ?? null,
    days: selectedDays(),
  };
  writeSummary(quoteSummary, terms);
  drawPayoff(quoteSummary.host, terms);
}

/** Summary sentence, note and chart: the Quote page has one, and so does each open position. */
function payoffFigure() {
  const figure = document.createElement("figure");
  figure.className = "payoff";
  const caption = document.createElement("figcaption");
  const lead = document.createElement("p");
  lead.className = "payoff-lead";
  const note = document.createElement("p");
  note.className = "payoff-note";
  const host = document.createElement("div");
  caption.append(lead, note);
  figure.append(caption, host);
  return { figure, lead, note, host };
}

/** "You put X, earn Y (APR) and get back X if BTC stays on your side of the strike." */
function writeSummary({ lead, note }, { kind, strike: k, collateral: q, expiry, premium, premiumUsd, days }) {
  const back = writerKeep(kind, k, k, q, BEACON_READ_FEE);
  let earn = `earn a premium (${state.quoting ? "getting a quote" : "Confirm to see it"})`;
  if (premium != null) {
    const apr = annualized(premium, q, days);
    const rate = apr != null && Number.isFinite(apr) ? `${apr.toFixed(Math.abs(apr) >= 100 ? 0 : 1)}% APR` : "";
    const parts = [aboutUsd(premium, premiumUsd), rate].filter(Boolean).map((part) => part.replaceAll(" ", "\u00a0"));
    earn = `earn ${btcUnit(premium)}${parts.length ? ` (${parts.join(", ")})` : ""}`;
  }
  lead.textContent = `You put ${btcUnit(q)}, ${earn} and get back ${btcUnit(back)} if BTC is at or ${kind === 0 ? "below" : "above"} ${usd(k)} on ${fmtWhen(expiry).replaceAll(" ", "\u00a0")}.`;
  const fee = `The read fee takes ${BEACON_READ_FEE} sats of the collateral.`;
  note.textContent = kind === 0
    ? `Above ${usd(k)}, part of it goes to the desk. ${fee}`
    : `Below ${usd(k)}, part of it goes to the desk, and all of it at ${wholeUsd(keepCrossing(kind, 0n, k, q, BEACON_READ_FEE))} or lower. ${fee}`;
}

function usd(cents) {
  const text = fmtUsdFromCents(cents);
  return `$${text.endsWith(".00") ? text.slice(0, -3) : text}`;
}

/** A computed price, to the dollar. */
function wholeUsd(cents) {
  return usd(((cents + 50n) / 100n) * 100n);
}

/** An amount with its unit, on one line. */
function btcUnit(sats) {
  return `${fmtBtc(sats)}\u00a0BTC`;
}

// The chart is drawn at its rendered width so 11px labels stay 11px.
const MONO_CHAR = 6.6;
const AXIS_ROW = 16;
const payoffDrawn = new WeakMap();
const payoffResize = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    if (target.isConnected) drawPayoff(target, payoffDrawn.get(target).terms);
    else payoffResize.unobserve(target);
  }
});

/** Price range: spot, the strike, and the crossings that fit, with room beside the outermost for its label. */
function payoffModel({ kind, strike: k, collateral: q, spot }, plotWidth) {
  const quarters = [3n, 2n, 1n, 0n].map((n) => {
    const sats = (q * n) / 4n;
    return { sats, price: keepCrossing(kind, sats, k, q, BEACON_READ_FEE) };
  });
  // A call shows down to half the collateral. Lower crossings sit far out, so they get an edge note.
  const outer = quarters[kind === 0 ? 1 : 3].price ?? (kind === 0 ? k * 2n : k / 2n);
  const anchor = Number(outer);
  const room = Math.min(0.4, (wholeUsd(outer).length * MONO_CHAR + 12) / plotWidth);
  const s = Number(spot);
  const strikeN = Number(k);
  if (kind === 0) {
    const lo = Math.min(s, strikeN) * 0.8;
    return { quarters, lo, hi: Math.max((anchor - room * lo) / (1 - room), s * 1.08) };
  }
  const hi = Math.max(s, strikeN) * 1.1;
  return { quarters, hi, lo: Math.max(1, Math.min((anchor - room * hi) / (1 - room), s * 0.9)) };
}

/** Everything the chart paints, in pixels, with each positioned item keyed by what it shows. */
function payoffScene(terms, width) {
  const { kind, strike: k, collateral: q, spot } = terms;
  const yText = [4n, 3n, 2n, 1n, 0n].map((n) => fmtBtc((q * n) / 4n));
  const left = Math.ceil(Math.max(...yText.map((text) => text.length)) * MONO_CHAR) + 14;
  const right = width - 14;
  const top = 12;
  const bottom = top + (width < 420 ? 148 : 172);
  const { quarters, lo, hi } = payoffModel(terms, right - left);
  const keepAt = (cents) => writerKeep(kind, cents, k, q, BEACON_READ_FEE);
  const scene = {
    width,
    height: bottom + AXIS_ROW * 2 + 8,
    left,
    right,
    top,
    bottom,
    lo,
    hi,
    grid: [0, 1, 2, 3, 4].map((i) => top + ((bottom - top) * i) / 4),
    x: (cents) => left + ((Number(cents) - lo) / (hi - lo)) * (right - left),
    y: (sats) => top + (1 - Number(sats) / Number(q)) * (bottom - top),
    price: (x) => lo + ((x - left) / (right - left)) * (hi - lo),
    curve: [],
    corners: {},
    items: {},
  };
  const { items, x: sx, y: sy } = scene;

  // The curve is sampled every 3px, plus its corners: the strike, and where a put hits zero.
  const sample = (x) => [x, sy(keepAt(BigInt(Math.max(1, Math.round(scene.price(x))))))];
  for (let x = left; x < right; x += 3) scene.curve.push(sample(x));
  scene.curve.push(sample(right));
  const inside = (cents) => Number(cents) > lo && Number(cents) < hi;
  if (inside(k)) scene.corners.strike = [sx(k), sy(keepAt(k))];
  if (kind === 1 && quarters[3].price != null && inside(quarters[3].price)) scene.corners.floor = [sx(quarters[3].price), bottom];
  scene.spotX = sx(spot);
  scene.strikeX = sx(k);

  yText.forEach((text, i) => {
    items[`y${i}`] = { x: left - 8, y: scene.grid[i], text, cls: "ylab" };
  });
  if (scene.corners.strike) items[`kink${kind}`] = { dot: true, x: scene.corners.strike[0], y: scene.corners.strike[1] };

  // Labels stay between `min` and `max` whichever way they are anchored.
  const fit = (x, w, anchor, min, max) => {
    const offset = { start: 0, middle: w / 2, end: w }[anchor];
    return Math.min(Math.max(x, min + offset), max - w + offset);
  };
  // A point and its price where the curve crosses each quarter, on the side the curve leaves open.
  const side = kind === 0 ? 1 : -1;
  const label = (x, y, text, anchor, cls) => ({ x: fit(x, text.length * MONO_CHAR, anchor, left, right), y, text, anchor, cls });
  quarters.forEach(({ sats, price }, i) => {
    if (price == null) return;
    const y = sy(sats);
    if (Number(price) > hi) {
      items[`edge${i}`] = label(right, y - 7, `${wholeUsd(price)} →`, "end", "halo");
      return;
    }
    const x = sx(price);
    items[`dot${i}${kind}`] = { dot: true, x, y };
    items[`cross${i}${kind}`] = label(x + side * 7, y - 7, wholeUsd(price), side > 0 ? "start" : "end", "halo cross");
  });

  // The x axis carries two prices: the strike with its distance from spot, then spot below it.
  // The strike label leans away from the spot line, which runs down past it.
  const axis = (x, y, anchor, parts) => {
    const w = parts.reduce((sum, [text]) => sum + text.length, 0) * MONO_CHAR;
    return { x: fit(x, w, anchor, 0, width), y, anchor, parts, cls: "halo" };
  };
  const { spotX, strikeX } = scene;
  const lean = Math.abs(spotX - strikeX) < 1 ? side : Math.sign(strikeX - spotX);
  const anchor = lean > 0 ? "start" : "end";
  const strikeAt = lean > 0 ? Math.max(strikeX - 4, spotX + 6) : Math.min(strikeX + 4, spotX - 6);
  items[`strike${anchor}`] = axis(strikeAt, bottom + AXIS_ROW, anchor, [[usd(k), "ink"], [` ${pctFromSpot(k)}`, ""]]);
  items.spot = axis(spotX, bottom + AXIS_ROW * 2, "middle", [["Spot ", ""], [usd(spot), "cross"]]);

  const said = quarters
    .filter(({ price }) => price != null)
    .map(({ sats, price }) => `${btcUnit(sats)} at ${wholeUsd(price)}`)
    .join(", ");
  scene.aria = `What you get back at expiry: ${btcUnit(keepAt(k))} ${kind === 0 ? "up to" : "down to"} ${usd(k)}, then ${said}. Spot is ${usd(spot)}.`;
  return scene;
}

function paintScene(svg, scene) {
  const { width, height, left, right, top, bottom } = scene;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  const nodes = scene.grid.map((y) => svgEl("line", { x1: left, x2: right, y1: y, y2: y, class: "grid" }));
  const points = [...scene.curve, ...Object.values(scene.corners)].sort((a, b) => a[0] - b[0]);
  const line = points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  nodes.push(
    svgEl("path", { d: `${line}L${right},${bottom}L${left},${bottom}Z`, class: "area" }),
    svgEl("line", { x1: scene.spotX, x2: scene.spotX, y1: top, y2: bottom + AXIS_ROW * 2 - 12, class: "spot-line" }),
    svgEl("line", { x1: scene.strikeX, x2: scene.strikeX, y1: top, y2: bottom + AXIS_ROW - 12, class: "strike-line" }),
    svgEl("path", { d: line, class: "curve" }),
  );
  const items = Object.values(scene.items);
  for (const item of items) {
    if (item.dot) nodes.push(svgEl("circle", { cx: item.x, cy: item.y, r: 4, class: "dot" }));
  }
  for (const item of items) {
    if (item.dot) continue;
    const attrs = { x: item.x, y: item.y, class: item.cls };
    if (item.anchor) attrs["text-anchor"] = item.anchor;
    const node = svgEl("text", attrs, item.parts ? null : item.text);
    for (const [text, cls] of item.parts ?? []) node.append(svgEl("tspan", { class: cls }, text));
    nodes.push(node);
  }
  svg.replaceChildren(...nodes);
}

function drawPayoff(host, terms) {
  const width = host.clientWidth;
  // Hidden or not on the page yet: whatever shows it calls this again.
  if (!width) return;
  let entry = payoffDrawn.get(host);
  if (!entry) {
    entry = { key: "" };
    payoffDrawn.set(host, entry);
    payoffResize.observe(host);
  }
  entry.terms = terms;
  const { kind, strike: k, collateral: q, spot } = terms;
  const ok = spot != null && q != null && q > 0n && k != null;
  const key = ok ? `${kind}:${k}:${q}:${spot}:${width}` : "";
  let svg = host.querySelector("svg");
  if (entry.key === key && svg) return;
  entry.key = key;
  if (!ok) {
    host.replaceChildren();
    return;
  }
  const scene = payoffScene(terms, width);
  if (!svg) {
    svg = svgEl("svg", { role: "img" });
    host.replaceChildren(svg);
  }
  svg.setAttribute("aria-label", scene.aria);
  paintScene(svg, scene);
}

function svgEl(name, attrs, text) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text != null) node.textContent = text;
  return node;
}

function clearStaleDeskQuote(now = Math.floor(Date.now() / 1000)) {
  const quote = state.deskQuote;
  if (!quote) return false;
  if ((quote.validUntil && quote.validUntil <= now) || (quote.deadline && quote.deadline <= now)) {
    state.deskQuote = null;
    return true;
  }
  return false;
}

function renderSell() {
  if (state.view !== "sell") return;
  clearStaleDeskQuote();
  document.querySelectorAll("[data-kind]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(Number(btn.dataset.kind) === state.kind));
  });
  document.querySelectorAll("[data-days], [data-tenor]").forEach((btn) => {
    const tenor = Number(btn.dataset.tenor || 0);
    const days = Number(btn.dataset.days || 0);
    const on = tenor ? state.tenorSec === tenor : !state.tenorSec && days === state.days;
    btn.setAttribute("aria-pressed", String(on));
  });
  $("kind-copy").textContent = kindCopy();
  $("expiry-when").textContent = fmtWhen(expiryUnix());
  const sats = sizeSats();
  const err = state.spotCents == null ? "" : sizeError(sats);
  $("size-error").textContent = err;
  renderStrikes();

  const deposit = shownDeposit();
  const position = deposit && state.positions.find((item) => item.address === deposit.address);
  const frozen = position && position.status !== "locking";
  const head = frozen
    ? { sats: position.premiumSats, name: position.solver || "Desk", usd: position.premiumUsd }
    : headlineQuote();
  let quoted = null;
  if (!head || err) {
    $("premium").textContent = state.quoting && !err ? "…" : "—";
    $("premium-meta").textContent = err ? "" : (state.spotCents == null ? "Loading the price." : "");
  } else {
    $("premium").textContent = `${fmtBtc(head.sats)} BTC`;
    const source = frozen ? statusLabel(position) : (state.deskQuote ? "now" : "market");
    const pay = upfront(head.sats, head.usd);
    $("premium-meta").textContent = `${pay} · ${source}. The read fee takes ${BEACON_READ_FEE} sats of the collateral.`;
    quoted = { sats: head.sats, usd: head.usd };
  }
  renderPayoff(quoted);

  const quote = liveQuote();
  const moved = Boolean(quote && deposit && !frozen && quote.sats !== deposit.premium);
  const confirm = $("confirm");
  const again = position && (position.status === "filled" || position.status === "settled" || position.status === "refunded" || position.status === "expired");
  if (again) {
    confirm.hidden = false;
    confirm.textContent = state.confirming ? "Confirming" : "Sell again";
    const tooSmall = quote && quote.sats <= DUST;
    confirm.disabled = state.quoting || state.confirming || Boolean(err) || state.spotCents == null || !state.address || tooSmall;
  } else if (frozen) {
    confirm.hidden = true;
  } else if (!deposit || moved) {
    confirm.hidden = false;
    confirm.textContent = state.confirming ? "Confirming" : (moved ? "Confirm the new payout" : "Confirm");
    const tooSmall = quote && quote.sats <= DUST;
    confirm.disabled = state.quoting || state.confirming || Boolean(err) || state.spotCents == null || !state.address || tooSmall;
  } else {
    confirm.hidden = true;
  }

  const pay = $("pay-wallet");
  const box = $("deposit");
  const settled = position && (position.status === "filled" || position.status === "settled" || position.status === "refunded");
  if (pay) pay.hidden = !deposit || settled || !position || position.status !== "locking";
  if (!deposit || settled) {
    box.hidden = true;
  } else {
    box.hidden = false;
    const sent = position && position.status !== "locking";
    $("deposit-amount").textContent = sent
      ? `${fmtBtc(deposit.amountSats)} BTC is on this address`
      : `Send ${fmtBtc(deposit.amountSats)} BTC`;
    $("deposit-fixed").textContent = `This deposit pays ${fmtBtc(deposit.premium)} BTC · ${upfront(deposit.premium, position?.premiumUsd)}. The read fee takes ${BEACON_READ_FEE} sats of the collateral.`;
    $("deposit-address").textContent = deposit.address;
    $("copy-address").disabled = false;
  }

  let note = "";
  if (position?.status === "locking" && position.walletTxid) note = statusLead(position);
  else if (!frozen) {
    if (quote && quote.sats <= DUST) {
      note = dustNote(quote.sats);
    } else if (state.quoting) {
      note = "Getting a quote.";
    } else if (!quote) {
      note = humanNote(state.quoteNote);
    } else if (state.quoteNote && !state.deskQuote) {
      note = humanNote(state.quoteNote);
    }
  } else {
    note = statusLead(position);
  }
  $("status").textContent = note;
  $("ticket-kicker").textContent = frozen ? statusLabel(position) : "Payout now";
  const refund = $("refund");
  if (refund) refund.hidden = !(position && position.refundable && position.status === "expired");
  const abort = $("abort");
  if (abort) abort.hidden = !(position && position.status === "locking");
  const track = $("steps");
  if (track) {
    track.replaceChildren();
    const steps = position ? progressSteps(position.status) : null;
    track.hidden = !steps;
    if (steps) track.append(steps);
  }
}

function renderHome() {
  renderBlotter();
}

function pageHash(view) {
  if (view === "connect") return "#/connect";
  if (view === "home") return "#/positions";
  return state.kind === 1 ? "#/quote/put" : "#/quote/call";
}

function routeFromHash() {
  const path = (location.hash || "#/").replace(/^#/, "");
  if (path.startsWith("/sell/put") || path.startsWith("/quote/put")) return { view: "sell", kind: 1 };
  if (path.startsWith("/sell/call") || path.startsWith("/quote/call")) return { view: "sell", kind: 0 };
  if (path.startsWith("/positions")) return { view: "home", kind: state.kind };
  if (path.startsWith("/connect")) return { view: "connect", kind: state.kind };
  return { view: "sell", kind: state.kind };
}

function show(view, mode = "push") {
  if (!state.address && view !== "connect") view = "connect";
  state.view = view;
  document.body.dataset.view = view;
  $("connect").hidden = view !== "connect";
  $("home").hidden = view !== "home";
  $("sell").hidden = view !== "sell";
  const known = Boolean(state.address);
  $("who").hidden = !known || view === "connect";
  $("who-address").textContent = known ? shortAddress(state.address) : "";
  $("sub").hidden = view !== "connect";
  const tabs = $("tabs");
  if (tabs) tabs.hidden = view === "connect";
  document.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.tab === view));
  });
  const next = pageHash(view);
  if (mode !== "quiet" && location.hash !== next) {
    if (mode === "replace") history.replaceState(null, "", next);
    else history.pushState(null, "", next);
  }
  if (view === "home") renderHome();
  if (view === "sell") renderSell();
  if (view === "connect") $("account-key").focus();
}

function renderBlotter() {
  const host = $("blotter");
  if (!host) return;
  host.replaceChildren();
  const rows = [...state.restored, ...visiblePositions()];
  if (!rows.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "No positions yet.";
    host.append(p);
    return;
  }
  for (const position of rows) {
    const wrap = document.createElement("article");
    wrap.className = "position";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "position-head";
    head.addEventListener("click", () => {
      state.selected = state.selected === position.id ? null : position.id;
      renderBlotter();
    });
    const main = document.createElement("span");
    main.className = "position-main";
    const title = document.createElement("strong");
    title.textContent = position.kind === 0 ? "Covered call" : "Limited put";
    const meta = document.createElement("span");
    meta.className = "tag";
    meta.textContent = `${fmtBtc(position.collateral)} BTC · $${fmtUsdFromCents(position.strike)} · ${fmtWhen(position.expiry)}`;
    main.append(title, meta);
    const status = document.createElement("span");
    status.className = "position-status";
    status.textContent = statusLabel(position);
    head.append(main, status);
    wrap.append(head);
    const steps = progressSteps(position.status);
    if (steps) wrap.append(steps);
    const result = outcomeLine(position);
    const txs = txLinks(position);
    if (result || txs) {
      const foot = document.createElement("div");
      foot.className = "position-foot";
      if (result) {
        const line = document.createElement("p");
        line.className = "position-result";
        line.textContent = result;
        foot.append(line);
      }
      if (txs) foot.append(txs);
      const settle = settleButton(position);
      if (settle) foot.append(settle);
      wrap.append(foot);
    }
    if (state.selected === position.id) wrap.append(detail(position));
    host.append(wrap);
  }
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
  if (outcome.result === "unfixed") return "The oracle has not published this expiry yet.";
  if (outcome.result === "mismatch") return "This option is on a different beacon.";
  if (outcome.result === "waiting" && outcome.reason === "early") return "Wait until expiry.";
  if (outcome.result === "waiting" && outcome.reason === "beacon") return "The beacon coin is not ready.";
  if (outcome.result === "waiting") return "The vault coin is not ready.";
  return "Could not settle.";
}

async function settlePosition(position, button) {
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = "Settling";
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
  button.className = "copy-uri";
  button.textContent = "Settle";
  button.addEventListener("click", () => {
    void settlePosition(position, button);
  });
  return button;
}

function outcomeLine(position) {
  return positionOutcome(position);
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
  box.className = "tx-links";
  const funding = txLink("Deposit tx", position.fundingTxid);
  const refunded = position.status === "refunded";
  const refund = refunded ? txLink("Refund tx", position.closeTxid) : null;
  const filled = position.status === "filled" || position.status === "settled";
  const completed = filled ? txLink("Payout tx", position.closeTxid) : null;
  const settlement = position.settleTxid && position.settleTxid !== position.closeTxid
    ? txLink("Settlement tx", position.settleTxid)
    : null;
  if (!funding && !refund && !completed && !settlement) return null;
  for (const node of [funding, completed, settlement, refund]) {
    if (node) box.append(node);
  }
  return box;
}

function restoredDetail(position) {
  const box = document.createElement("div");
  box.className = "lab";
  if (!position.vaultAddress) return box;
  const where = document.createElement("p");
  where.className = "lock-note";
  where.textContent = "Vault";
  const addr = document.createElement("p");
  addr.className = "deposit-address";
  addr.textContent = position.vaultAddress;
  box.append(where, addr);
  return box;
}

function detail(position) {
  if (position.restored) return restoredDetail(position);
  const box = document.createElement("div");
  box.className = "lab";
  const leadText = statusLead(position);
  if (leadText) {
    const lead = document.createElement("p");
    lead.className = "lock-note";
    lead.textContent = leadText;
    box.append(lead);
  }
  if (position.status === "locking" && position.marketSats && position.marketSats !== position.premiumSats) {
    const now = document.createElement("p");
    now.className = "market-now";
    now.textContent = `Market now ${fmtBtc(position.marketSats)} BTC · ${upfront(position.marketSats)}`;
    box.append(now);
  }
  if (position.address && !["filled", "refunded", "settled"].includes(position.status)) {
    box.append(depositBlock(position));
  }
  const terms = {
    kind: position.kind,
    strike: position.strike,
    collateral: position.collateral,
    spot: state.spotCents,
    expiry: position.expiry,
    premium: position.premiumSats,
    premiumUsd: position.premiumUsd,
    days: tenorDays(position),
  };
  const summary = payoffFigure();
  writeSummary(summary, terms);
  box.append(summary.figure);
  // The row is attached after detail() returns; draw once it is on the page.
  queueMicrotask(() => drawPayoff(summary.host, terms));
  if (position.payoutAddress) {
    const where = document.createElement("p");
    where.className = "lock-note";
    where.textContent = position.status === "filled" || position.status === "settled" ? "Premium paid to" : "Your address";
    const addr = document.createElement("p");
    addr.className = "deposit-address";
    addr.textContent = position.payoutAddress;
    box.append(where, addr);
  }
  if (position.status === "locking") {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "copy-uri";
    cancel.textContent = "Cancel trade";
    cancel.addEventListener("click", () => {
      void abortLock(position, cancel);
    });
    box.append(cancel);
  }
  if (position.refundable && position.status === "expired") {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "copy-uri";
    cancel.textContent = "Refund";
    cancel.addEventListener("click", () => {
      void refund(position, cancel);
    });
    box.append(cancel);
  }
  return box;
}

function depositBlock(position) {
  const frag = document.createDocumentFragment();
  const amount = document.createElement("p");
  amount.className = "deposit-amount";
  amount.textContent = position.status === "locking"
    ? `Send ${fmtBtc(position.collateral)} BTC`
    : `${fmtBtc(position.collateral)} BTC is on this address`;
  const addr = document.createElement("p");
  addr.className = "deposit-address";
  addr.textContent = position.address;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy-uri";
  copy.textContent = "Copy payment link";
  copy.addEventListener("click", () => {
    void copyToClipboard(copy, position.uri || paymentUri(position.address, position.collateral));
  });
  frag.append(amount, addr);
  if (position.status === "locking") {
    const pay = document.createElement("button");
    pay.type = "button";
    pay.className = "copy-uri";
    pay.textContent = "Pay in Arkade wallet";
    pay.addEventListener("click", () => {
      openWallet(position);
    });
    frag.append(pay);
  }
  frag.append(copy);
  return frag;
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

function adoptQuote() {
  if (termsTouched) return;
  const latest = visiblePositions()
    .filter((position) => position.kind === state.kind && position.address)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
  if (!latest) return;
  pinnedStrike = latest.strike;
  const idx = ladder().findIndex((cents) => cents === latest.strike);
  if (idx < 0) return;
  state.strikeIndex = idx;
  if (latest.tenorSec > 0) {
    state.tenorSec = latest.tenorSec;
    state.days = 0;
  } else if (latest.days === 7 || latest.days === 30 || latest.days === 90) {
    state.tenorSec = 0;
    state.days = latest.days;
  }
  const size = $("size");
  if (size) size.value = fmtBtc(latest.collateral);
  strikeKey = "";
}

function onTermsChanged() {
  pinnedExpiry = 0;
  state.market = null;
  state.deskQuote = null;
  state.quoteNote = "";
  state.quoting = false;
  quoteGen += 1;
  renderSell();
}

async function askQuote() {
  if (state.view !== "sell" || state.quoting || state.confirming) return;
  const sats = sizeSats();
  const err = state.spotCents == null ? "spot" : sizeError(sats);
  if (sats == null || err || state.spotCents == null || !state.address) {
    renderSell();
    return;
  }
  const gen = ++quoteGen;
  state.quoting = true;
  state.market = null;
  state.deskQuote = null;
  state.quoteNote = "";
  renderSell();
  const expiry = expiryUnix();
  const picked = strike();
  try {
    if (PINNED_DESKS.length === 0) {
      const points = await fetchSurface();
      if (gen !== quoteGen) return;
      const priced = deribitPremium({
        kind: state.kind,
        strikeUsd: Number(picked) / 100,
        expiry: Number(expiry),
        now: Math.floor(Date.now() / 1000),
        collateralSats: sats,
        spotUsd: Number(state.spotCents) / 100,
        points,
      });
      if (!priced) {
        state.quoteNote = "No market for this strike yet.";
      } else {
        const paid = payablePremium(priced.sats);
        state.market = {
          sats: paid,
          usd: Number(paid) / 1e8 * (Number(state.spotCents) / 100),
          iv: priced.iv,
          name: "Market",
        };
      }
    } else {
      const live = await requestQuotes({
        relays: RELAYS,
        desks: PINNED_DESKS,
        kind: state.kind,
        strike: picked,
        collateral: sats,
        expiry,
        spotCents: state.spotCents,
        writerAddress: state.address,
      });
      if (gen !== quoteGen) return;
      const best = live.quotes.length ? bestQuote(live.quotes, 0) : null;
      if (best) state.deskQuote = best;
      else state.quoteNote = live.note || "The desk did not answer.";
    }
  } catch (err) {
    if (gen !== quoteGen) return;
    state.quoteNote = err instanceof Error ? err.message : "The desk did not answer.";
  }
  if (gen !== quoteGen) return;
  state.quoting = false;
  renderSell();
}

async function confirm() {
  const quote = liveQuote();
  const sats = sizeSats();
  const now = Math.floor(Date.now() / 1000);
  if (!state.address || !quote || sats == null || sizeError(sats) || quote.sats <= DUST || state.confirming) return;
  if (PINNED_DESKS.length > 0 && (
    !quote.intentAddress
    || !quote.deadline || quote.deadline <= now
    || !quote.validUntil || quote.validUntil <= now
  )) return;
  state.confirming = true;
  $("status").textContent = "";
  renderSell();
  const deadline = quote.deadline;
  try {
    const deposit = await depositAddress({
      kind: state.kind,
      strike: strike(),
      collateral: sats,
      premium: quote.sats,
      expiry: expiryUnix(),
      deadline: BigInt(deadline),
      writerAddress: state.address,
      holderPkHex: quote.holderPkHex,
      beaconTxidHex: quote.beaconTxid,
      beaconGidx: quote.beaconGidx,
      exit: quote.exit != null ? BigInt(quote.exit) : undefined,
    });
    if (quote.intentAddress && (deposit.address !== quote.intentAddress || deposit.vaultAddress !== quote.vaultAddress)) {
      throw new Error("The desk address does not match this page.");
    }
    const apy = annualized(quote.sats, sats, selectedDays());
    let position = state.positions.find((item) => item.address === deposit.address && item.status === "locking");
    if (!position) {
      position = {
        id: crypto.randomUUID(),
        side: 0,
        kind: state.kind,
        strike: strike(),
        expiry: expiryUnix(),
        collateral: sats,
        premiumSats: quote.sats,
        premiumUsd: quote.usd,
        solver: quote.name,
        status: "locking",
        deadline,
        address: deposit.address,
        holderPkHex: deposit.holderPkHex,
        beaconTxid: deposit.beaconTxidHex,
        beaconGidx: deposit.beaconGidx,
        exit: deposit.exit,
        vaultAddress: deposit.vaultAddress,
        writerAddress: state.address,
        payoutAddress: state.address,
        days: state.tenorSec > 0 ? 0 : state.days,
        tenorSec: state.tenorSec,
        createdAt: Math.floor(Date.now() / 1000),
        apy,
        uri: deposit.uri,
        apyFrozen: false,
        marketSats: null,
        marketApy: null,
      };
      state.positions.unshift(position);
    }
    state.selected = position.id;
    persist();
  } catch (err) {
    $("status").textContent = err instanceof Error ? err.message : "Could not build the deposit.";
  }
  state.confirming = false;
  renderSell();
  renderBlotter();
}

function openSell(kind) {
  const onSell = state.view === "sell";
  const changed = state.kind !== kind;
  state.kind = kind;
  if (changed) {
    state.strikeIndex = 0;
    strikeKey = "";
    pinnedStrike = null;
  }
  show("sell", onSell ? "replace" : "push");
  if (changed) onTermsChanged();
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
  state.market = null;
  state.deskQuote = null;
  show("connect");
  $("account-key").focus();
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
  button.textContent = "Refunding";
  try {
    await cancelIntent(await fundRequest(position));
    applyChain(position, await readIntent(watchRow(position)));
    if (position.status !== "refunded" && button.isConnected) {
      button.disabled = false;
      button.textContent = "Refund";
    }
  } catch (err) {
    button.disabled = false;
    button.textContent = err instanceof Error ? err.message : "Refund failed";
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
  if (clearStaleDeskQuote(now) && state.view === "sell") renderSell();
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

function openWallet(position) {
  if (position && position.status !== "locking") return;
  const request = position ? (position.uri || paymentUri(position.address, position.collateral)) : "";
  const params = position ? { flow: "send", position: position.id } : { flow: "connect" };
  const back = pageCallback(location.href, params);
  const tell = $(position ? "status" : "account-error");
  if (!callbackAllowed(back)) {
    if (tell) tell.textContent = "The wallet only returns to https, or to localhost.";
    return;
  }
  const action = position ? "send" : "connect";
  const payment = request || undefined;
  const popupUrl = walletAppUrl(WALLET_URL, action, pageCallback(location.href, { ...params, popup: "1" }), payment);
  const pageUrl = walletAppUrl(WALLET_URL, action, back, payment);
  if (!askWallet(position ? position.id : "connect")) {
    if (tell) tell.textContent = "This browser is not keeping the wallet return.";
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
      const node = $("account-error");
      if (node) node.textContent = "";
    } catch (err) {
      const node = $("account-error");
      if (node) node.textContent = err instanceof Error ? err.message : "That address was not saved.";
    }
    return;
  }
  if (handoff.kind === "connect-error" && pending === "connect") {
    const node = $("account-error");
    if (node) node.textContent = "The wallet did not share an address.";
    return;
  }
  if (handoff.kind !== "sent" || handoff.positionId !== pending || !handoff.txid) return;
  const position = state.positions.find((item) => item.id === pending);
  if (!position) return;
  position.walletTxid = handoff.txid;
  persist();
}

function showWalletHandoff(handoff) {
  if (handoff.kind === "connect" && state.address) show("sell");
  if (handoff.kind !== "sent" || !handoff.txid) return;
  if (state.view === "home") renderBlotter();
  else if (state.view === "sell") renderSell();
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
  document.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const view = btn.dataset.tab;
      if (view === state.view) return;
      show(view);
    });
  });
  document.querySelectorAll("[data-days], [data-tenor]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tenor = Number(btn.dataset.tenor || 0);
      const days = Number(btn.dataset.days || 0);
      termsTouched = true;
      if (tenor) {
        if (state.tenorSec === tenor) return;
        state.tenorSec = tenor;
        state.days = 0;
      } else if (!state.tenorSec && days === state.days) {
        return;
      } else {
        state.tenorSec = 0;
        state.days = days;
      }
      document.querySelectorAll("[data-days], [data-tenor]").forEach((other) => {
        other.setAttribute("aria-pressed", String(other === btn));
      });
      onTermsChanged();
    });
  });
  listen("strikes", "click", (event) => {
    const btn = event.target.closest("button");
    if (!btn) return;
    termsTouched = true;
    const index = Number(btn.dataset.index);
    const picked = ladder()[index];
    if (pinnedStrike != null && picked !== pinnedStrike) {
      pinnedStrike = null;
      strikeKey = "";
      const next = ladder().findIndex((cents) => cents === picked);
      state.strikeIndex = next >= 0 ? next : 0;
    } else if (index !== state.strikeIndex) {
      state.strikeIndex = index;
    } else {
      return;
    }
    onTermsChanged();
  });
  listen("size", "input", () => {
    termsTouched = true;
    onTermsChanged();
  });
  listen("size", "keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void askQuote();
  });
  listen("confirm", "click", () => {
    if (!liveQuote()) {
      void askQuote();
      return;
    }
    void confirm();
  });
  listen("abort", "click", () => {
    const deposit = shownDeposit();
    const position = deposit && state.positions.find((item) => item.address === deposit.address);
    if (position) void abortLock(position, $("abort"));
  });
  listen("refund", "click", () => {
    const deposit = shownDeposit();
    const position = deposit && state.positions.find((item) => item.address === deposit.address);
    if (position) void refund(position, $("refund"));
  });
  listen("copy-address", "click", () => {
    const deposit = shownDeposit();
    if (!deposit) return;
    void copyToClipboard($("copy-address"), deposit.uri || paymentUri(deposit.address, deposit.amountSats));
  });
  listen("pay-wallet", "click", () => {
    const deposit = shownDeposit();
    const position = deposit && state.positions.find((item) => item.address === deposit.address);
    if (position) openWallet(position);
  });
  document.querySelectorAll("[data-kind]").forEach((btn) => {
    btn.addEventListener("click", () => openSell(Number(btn.dataset.kind)));
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
    renderBlotter();
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
    state.spotSource = "Deribit";
  } catch {
    state.spotCents = null;
    state.spotSource = "Spot unavailable";
  }
}

function loadArtifact() {
  const node = $("artifact");
  try {
    node.textContent = artifactLine();
  } catch (err) {
    node.textContent = err instanceof Error ? err.message : "The option programs did not load.";
  }
}

function showFromHash() {
  const route = routeFromHash();
  if (!state.address) {
    show("connect", location.hash === "#/connect" ? "quiet" : "replace");
    return;
  }
  if (route.view === "connect") {
    show("sell", "replace");
    return;
  }
  if (route.view === "sell") {
    const changed = !(state.view === "sell" && state.kind === route.kind);
    state.kind = route.kind;
    if (changed && state.view === "sell") {
      state.strikeIndex = 0;
      strikeKey = "";
      pinnedStrike = null;
    }
    show("sell", "quiet");
    if (changed) onTermsChanged();
    return;
  }
  show("home", "quiet");
}

state.address = readAddress() || "";
window.addEventListener("message", onWalletMessage);
if (!consumeWalletHandoff()) {
  bind();
  {
    const route = routeFromHash();
    if (!state.address) show("connect", "replace");
    else if (route.view === "sell") {
      state.kind = route.kind;
      show("sell", "replace");
    } else if (route.view === "home") show("home", "replace");
    else show("sell", "replace");
  }
  window.addEventListener("hashchange", showFromHash);
  loadSpot().then(() => {
    $("spot-source").textContent = state.spotSource;
    $("spot-px").textContent = state.spotCents == null ? "—" : fmtUsdFromCents(state.spotCents);
    adoptQuote();
    if (state.view === "sell") renderSell();
    renderBlotter();
  });
  loadArtifact();
  if (promotedSettled) persist();
  void fillKept();
  startWatch();
  setInterval(tick, 1000);
  setInterval(startWatch, 15_000);
  setInterval(() => {
    void refreshPositionMarkets();
  }, REFRESH_MS);
  void hydrateMissing();
}
