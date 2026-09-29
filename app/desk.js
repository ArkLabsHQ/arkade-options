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
  writerPayoutAddress,
} from "./src/fund.ts";
import { artifactLine } from "./src/program.ts";
import { requestQuotes } from "./src/rfq.ts";
import { deribitPremium, fetchSurface } from "../protocol/deribit.ts";
import { bestQuote } from "./quote.js";
import { PINNED_DESKS, RELAYS } from "./rfq-config.js";
import { DUST, Q_MAX, Q_MIN, writerPayoff } from "./settle-math.js";
import { settleFromPage } from "./src/settle.ts";
import { readIntent, watchIntents } from "./src/watch.ts";

const STORE = "arkade-options-desk-v1";
const REFRESH_MS = 18_000;

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
  selected: null,
};

let quoteGen = 0;
let quoteTimer = 0;
const expiring = new Set();

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
  return {
    ...row,
    collateral: BigInt(row.collateral),
    premiumSats: BigInt(row.premiumSats),
    strike: BigInt(row.strike),
    expiry: BigInt(row.expiry),
    marketSats: row.marketSats ? BigInt(row.marketSats) : null,
  };
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

function fmtApy(value) {
  if (value == null || !Number.isFinite(value)) return "";
  const digits = Math.abs(value) >= 100 ? 0 : 1;
  return `${value.toFixed(digits)}% APY`;
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

const STEPS = ["Waiting for deposit", "Deposited", "Waiting for payout", "Premium paid"];

function progressIndex(status) {
  if (status === "locking") return 0;
  if (status === "deposited") return 2;
  if (status === "filled") return 3;
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
    if (step < index || (index === STEPS.length - 1 && step === index)) markStep(item, "done");
    else if (step === index) markStep(item, "now", true);
    list.append(item);
  });
  return list;
}

function statusLabel(position) {
  if (position.status === "locking") return "Waiting for deposit";
  if (position.status === "deposited") return "Waiting for payout";
  if (position.status === "filled") return "Premium paid";
  if (position.status === "expired") return "Window closed";
  if (position.status === "refunded") return "Refunded";
  if (position.status === "settled") return "Settled";
  return "Open";
}

function statusLead(position) {
  if (position.status === "locking") {
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

function renderPayoff() {
  const host = $("payoff");
  if (!$("payoff-details").open) {
    host.replaceChildren();
    return;
  }
  const sats = sizeSats();
  if (state.spotCents == null || sats == null || sizeError(sats)) {
    host.replaceChildren();
    return;
  }
  drawPayoff(host, {
    kind: state.kind,
    strike: strike(),
    collateral: sats,
    spot: state.spotCents,
  });
}

function drawPayoff(host, { kind, strike: k, collateral: q, spot }) {
  host.replaceChildren();
  if (spot == null || q == null || q <= 0n || k == null) return;
  let lo = kind === 0 ? k * 70n / 100n : k * 30n / 100n;
  let hi = kind === 0 ? k * 160n / 100n : k * 130n / 100n;
  if (spot < lo) lo = spot * 90n / 100n;
  if (spot > hi) hi = spot * 110n / 100n;
  if (hi <= lo) hi = lo + 1n;
  const steps = 48;
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const px = lo + (hi - lo) * BigInt(i) / BigInt(steps);
    const price = px === 0n ? 1n : px;
    points.push([price, writerPayoff(kind, price, k, q)]);
  }
  const w = 480;
  const h = 210;
  const left = 78;
  const right = 12;
  const top = 16;
  const bottom = 16;
  const plotW = w - left - right;
  const plotH = h - top - bottom;
  const sx = (px) => left + Number(px - lo) / Number(hi - lo) * plotW;
  const sy = (y) => top + (1 - Number(y) / Number(q)) * plotH;
  const svg = svgEl("svg", {
    viewBox: `0 0 ${w} ${h}`,
    role: "img",
    "aria-label": `Writer payoff. Spot ${fmtUsdFromCents(spot)}, strike ${fmtUsdFromCents(k)} (${pctFromSpot(k)}). You keep between 0 and ${fmtBtc(q)} BTC of collateral.`,
  });
  const levels = [0n, q / 2n, q];
  for (const level of levels) {
    const y = sy(level);
    svg.append(svgEl("line", { x1: left, x2: w - right, y1: y, y2: y, class: "grid" }));
    svg.append(svgEl("text", { x: left - 8, y, class: "ylab" }, fmtBtc(level)));
  }
  svg.append(svgEl("line", { x1: sx(spot), x2: sx(spot), y1: top, y2: top + plotH, class: "spot-line" }));
  svg.append(svgEl("line", { x1: sx(k), x2: sx(k), y1: top, y2: top + plotH, class: "strike-line" }));
  const line = points.map(([px, y], i) => `${i ? "L" : "M"}${sx(px).toFixed(1)},${sy(y).toFixed(1)}`).join(" ");
  svg.append(svgEl("path", { d: line, class: "curve" }));
  const legend = document.createElement("div");
  legend.className = "payoff-legend";
  legend.append(
    legendItem("Spot", fmtUsdFromCents(spot)),
    legendItem("Strike", `${fmtUsdFromCents(k)} · ${pctFromSpot(k)}`),
  );
  host.append(svg, legend);
}

function legendItem(name, value) {
  const span = document.createElement("span");
  span.textContent = `${name} ${value}`;
  return span;
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
  renderPayoff();

  const deposit = shownDeposit();
  const position = deposit && state.positions.find((item) => item.address === deposit.address);
  const frozen = position && position.status !== "locking";
  const head = frozen
    ? { sats: position.premiumSats, name: position.solver || "Desk" }
    : headlineQuote();
  const days = selectedDays();
  if (!head || err) {
    $("premium").textContent = state.quoting && !err ? "…" : "—";
    $("premium-meta").textContent = err ? "" : (state.spotCents == null ? "Loading the price." : "");
  } else {
    const apy = frozen
      ? position.apy
      : annualized(head.sats, sats, days);
    $("premium").textContent = `${fmtBtc(head.sats)} BTC`;
    const source = frozen ? statusLabel(position) : (state.deskQuote ? "now" : "market");
    $("premium-meta").textContent = [fmtApy(apy), source].filter(Boolean).join(" · ");
  }

  const quote = liveQuote();
  const moved = Boolean(quote && deposit && !frozen && quote.sats !== deposit.premium);
  const confirm = $("confirm");
  const again = position && (position.status === "filled" || position.status === "refunded" || position.status === "expired");
  if (again) {
    confirm.hidden = false;
    confirm.textContent = state.confirming ? "Confirming" : "Sell again";
    const tooSmall = quote && quote.sats <= DUST;
    confirm.disabled = state.confirming || Boolean(err) || !quote || tooSmall;
  } else if (frozen) {
    confirm.hidden = true;
  } else if (!deposit || moved) {
    confirm.hidden = false;
    confirm.textContent = state.confirming ? "Confirming" : (moved ? "Confirm the new payout" : "Confirm");
    const tooSmall = quote && quote.sats <= DUST;
    confirm.disabled = state.confirming || Boolean(err) || !quote || tooSmall;
  } else {
    confirm.hidden = true;
  }

  const box = $("deposit");
  const settled = position && (position.status === "filled" || position.status === "refunded");
  if (!deposit || settled) {
    box.hidden = true;
  } else {
    box.hidden = false;
    const sent = position && position.status !== "locking";
    $("deposit-amount").textContent = sent
      ? `${fmtBtc(deposit.amountSats)} BTC is on this address`
      : `Send ${fmtBtc(deposit.amountSats)} BTC`;
    const apy = deposit.apy ?? annualized(deposit.premium, deposit.amountSats, selectedDays());
    $("deposit-fixed").textContent = frozen
      ? `This deposit pays ${fmtBtc(deposit.premium)} BTC · ${fmtApy(position.apy ?? apy)}`
      : `This deposit pays ${fmtBtc(deposit.premium)} BTC · ${fmtApy(apy)}`;
    $("deposit-address").textContent = deposit.address;
    $("copy-address").disabled = false;
  }

  let note = "";
  if (!frozen) {
    if (quote && quote.sats <= DUST) {
      note = dustNote(quote.sats);
    } else if (!quote && state.quoting) {
      note = state.market ? "Getting a quote." : "";
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
  const rows = visiblePositions();
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
  const expiry = Number(position.expiry) || 0;
  const now = Math.floor(Date.now() / 1000);
  if (position.status === "settled") {
    if (position.writerKeep) {
      const you = BigInt(position.writerKeep);
      const desk = BigInt(position.deskTake || 0);
      const price = position.settleCents ? ` Price $${fmtUsdFromCents(BigInt(position.settleCents))}.` : "";
      if (desk === 0n) return `You keep the collateral, ${fmtBtc(you)} BTC.${price}`;
      return `You keep ${fmtBtc(you)} BTC. The desk receives ${fmtBtc(desk)} BTC.${price}`;
    }
    return "The vault was settled. That transaction splits the collateral.";
  }
  if (position.status === "filled" && expiry && expiry <= now) {
    return "Expired. The collateral is still in the vault, so no one has won it yet.";
  }
  if (position.status === "filled") return "Premium paid. The collateral stays in the vault until expiry.";
  if (position.status === "refunded") return "The deposit came back to you. The trade did not fill.";
  return "";
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

function detail(position) {
  const box = document.createElement("div");
  box.className = "lab";
  const leadText = statusLead(position);
  if (leadText) {
    const lead = document.createElement("p");
    lead.className = "lock-note";
    lead.textContent = leadText;
    box.append(lead);
  }
  const pay = document.createElement("p");
  pay.className = "premium-meta";
  const apy = position.apyFrozen ? position.apy : annualized(position.premiumSats, position.collateral, tenorDays(position));
  pay.textContent = `Pays ${fmtBtc(position.premiumSats)} BTC · ${fmtApy(apy)} · expires ${fmtWhen(position.expiry)}`;
  box.append(pay);
  if (position.status === "locking" && position.marketSats && position.marketSats !== position.premiumSats) {
    const now = document.createElement("p");
    now.className = "market-now";
    now.textContent = `Market now ${fmtBtc(position.marketSats)} BTC · ${fmtApy(position.marketApy)}`;
    box.append(now);
  }
  if (position.address && !["filled", "refunded", "settled"].includes(position.status)) {
    box.append(depositBlock(position));
  }
  if (position.payoutAddress) {
    const where = document.createElement("p");
    where.className = "lock-note";
    where.textContent = position.status === "filled" ? "Premium paid to" : "Your address";
    const addr = document.createElement("p");
    addr.className = "deposit-address";
    addr.textContent = position.payoutAddress;
    box.append(where, addr);
  }
  const chart = document.createElement("details");
  chart.className = "more";
  const summary = document.createElement("summary");
  summary.textContent = "Payoff chart";
  const host = document.createElement("div");
  chart.append(summary);
  chart.addEventListener("toggle", () => {
    if (!chart.open) return;
    drawPayoff(host, {
      kind: position.kind,
      strike: position.strike,
      collateral: position.collateral,
      spot: state.spotCents,
    });
    if (!host.parentElement) chart.append(host);
  });
  box.append(chart);
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
  frag.append(amount, addr, copy);
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
  state.quoting = state.spotCents != null && !sizeError(sizeSats());
  clearTimeout(quoteTimer);
  const gen = ++quoteGen;
  renderSell();
  if (!state.quoting) return;
  quoteTimer = setTimeout(() => {
    void refreshLive(gen);
  }, 200);
}

async function refreshLive(gen) {
  if (state.view !== "sell") return;
  const sats = sizeSats();
  const err = state.spotCents == null ? "spot" : sizeError(sats);
  if (gen !== quoteGen || sats == null || err || state.spotCents == null || !state.address) {
    state.quoting = false;
    if (gen === quoteGen) renderSell();
    return;
  }
  const expiry = expiryUnix();
  const picked = strike();
  try {
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
    state.market = priced
      ? { sats: priced.sats, usd: priced.usd, iv: priced.iv, name: "Market" }
      : null;
    if (!priced && !state.deskQuote) state.quoteNote = "No market for this strike yet.";
    else if (priced) state.quoteNote = "";
  } catch {
    if (gen !== quoteGen) return;
    if (!state.deskQuote && !state.market) state.quoteNote = "The market did not answer.";
  }
  if (gen === quoteGen) renderSell();
  if (PINNED_DESKS.length === 0) {
    state.quoting = false;
    if (gen === quoteGen) renderSell();
    return;
  }
  try {
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
    if (best) {
      state.deskQuote = best;
      state.quoteNote = "";
    } else {
      clearStaleDeskQuote();
      if (!state.deskQuote) state.quoteNote = live.note || "The desk did not answer.";
    }
  } catch (err) {
    if (gen !== quoteGen) return;
    clearStaleDeskQuote();
    if (!state.deskQuote) {
      state.quoteNote = err instanceof Error ? err.message : "The desk did not answer.";
    }
  }
  state.quoting = false;
  if (gen === quoteGen) renderSell();
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
  const same = position.status === next
    && Boolean(position.refundable) === update.refundable
    && (position.fundingTxid || "") === fundingTxid
    && (position.closeTxid || "") === closeTxid
    && (position.settleTxid || "") === settleTxid;
  if (same) return;
  if (next === "deposited" || next === "filled" || next === "expired") freeze(position);
  position.status = next;
  position.refundable = update.refundable;
  position.fundingTxid = fundingTxid;
  position.closeTxid = closeTxid;
  position.settleTxid = settleTxid;
  persist();
  renderBlotter();
  renderSell();
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
    position.marketSats = priced.sats;
    position.marketApy = annualized(priced.sats, position.collateral, tenorDays(position));
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

function bind() {
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
  listen("confirm", "click", () => {
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
  document.querySelectorAll("[data-kind]").forEach((btn) => {
    btn.addEventListener("click", () => openSell(Number(btn.dataset.kind)));
  });
  listen("payoff-details", "toggle", renderPayoff);
}

async function loadSpot() {
  const sources = [
    ["Coinbase", "https://api.coinbase.com/v2/prices/BTC-USD/spot", (body) => body.data.amount],
    ["Binance", "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", (body) => body.price],
  ];
  const live = [];
  for (const [name, url, pick] of sources) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const price = Number(pick(await res.json()));
      if (price > 1000 && price < 10_000_000) live.push({ name, cents: BigInt(Math.round(price * 100)) });
    } catch {
      // try the next source
    }
  }
  if (live.length < 2) {
    state.spotCents = null;
    state.spotSource = "Spot unavailable";
    return;
  }
  state.spotCents = (live[0].cents + live[1].cents) / 2n;
  state.spotSource = live.map((item) => item.name).join(" · ");
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
  if (state.view === "sell") onTermsChanged();
  renderBlotter();
});
loadArtifact();
startWatch();
setInterval(tick, 1000);
setInterval(startWatch, 15_000);
setInterval(() => {
  if (state.view === "sell" && state.spotCents != null && state.address) {
    void refreshLive(++quoteGen);
  }
  void refreshPositionMarkets();
}, REFRESH_MS);
void hydrateMissing();
