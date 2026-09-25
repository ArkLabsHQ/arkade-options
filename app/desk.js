import { depositAddress, hasDeposit, writerHex } from "./src/fund.ts";
import { artifactLine } from "./src/program.ts";
import { bestQuote, deskQuotes } from "./quote.js";
import {
  DUST,
  PRICE_MAX,
  Q_MAX,
  Q_MIN,
  settle,
  windows,
  writerPayoff,
} from "./settle-math.js";

const ORACLES = ["Chainlink", "DIA", "Pyth", "Stork", "Band"];
const STORE = "arkade-options-desk-v1";

const state = {
  spotCents: null,
  spotSource: "Loading",
  side: 0,
  kind: 0,
  days: 30,
  strikeIndex: 2,
  quotes: null,
  deposit: null,
  quoting: false,
  view: "quote",
  positions: loadPositions(),
  selected: null,
  settleText: "",
  spike: false,
};

let quoteGen = 0;
let quoteTimer = 0;

const $ = (id) => document.getElementById(id);

function loadPositions() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || "[]");
    return raw.map(revive);
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
  };
  if (position.settlement) {
    position.settlement = {
      twap: BigInt(position.settlement.twap),
      holder: BigInt(position.settlement.holder),
      writer: BigInt(position.settlement.writer),
      mode: position.settlement.mode,
    };
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
    uri: p.uri,
    deadline: p.deadline,
    commitment: p.commitment,
    settlement: p.settlement && {
      twap: p.settlement.twap.toString(),
      holder: p.settlement.holder.toString(),
      writer: p.settlement.writer.toString(),
      mode: p.settlement.mode,
    },
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
  const v = neg ? -sats : sats;
  const whole = (v / 100_000_000n).toString();
  const frac = (v % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
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

function btcToSats(text) {
  const s = text.trim();
  if (!/^\d+(\.\d{0,8})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * 100_000_000n + BigInt((frac + "00000000").slice(0, 8));
}

function usdToCents(text) {
  const s = text.trim().replaceAll(",", "");
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * 100n + BigInt((frac + "00").slice(0, 2));
}

function expiryUnix(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(8, 0, 0, 0);
  return BigInt(Math.floor(d.getTime() / 1000));
}

function ladder() {
  const steps = state.kind === 0 ? [105n, 110n, 115n, 125n, 140n] : [95n, 90n, 85n, 75n, 60n];
  const grid = state.spotCents >= 10_000_000n ? 100_000n : 50_000n;
  const seen = new Set();
  return steps.map((step) => {
    let cents = ((state.spotCents * step) / 100n + grid / 2n) / grid * grid;
    const bump = state.kind === 0 ? grid : -grid;
    while (seen.has(cents.toString())) cents += bump;
    seen.add(cents.toString());
    return cents;
  });
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

function copy() {
  if (state.kind === 0) {
    return "You sell the call and send the BTC collateral on Mutinynet. At expiry the holder is paid only the fraction of that collateral by which the TWAP finishes above the strike.";
  }
  return "You sell the put and send the BTC collateral on Mutinynet. The holder is paid the fraction the TWAP finishes below the strike, and the claim stops at the collateral.";
}

function productName() {
  return state.kind === 0 ? "Covered call" : "Limited put";
}

let strikeKey = "";

function renderStrikes() {
  const host = $("strikes");
  if (state.spotCents == null) return;
  const rows = ladder();
  if (state.strikeIndex >= rows.length) state.strikeIndex = 2;
  const key = rows.join(",");
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
  const delta = Number((cents - state.spotCents) * 10000n / state.spotCents) / 100;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta.toFixed(1)}%`;
}

function renderPayoff() {
  const sats = sizeSats();
  if (state.spotCents == null || sats == null || sizeError(sats)) {
    $("payoff").replaceChildren();
    return;
  }
  drawPayoff($("payoff"), {
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
  const top = 28;
  const bottom = 46;
  const plotW = w - left - right;
  const plotH = h - top - bottom;
  const sx = (px) => left + Number(px - lo) / Number(hi - lo) * plotW;
  const sy = (y) => top + (1 - Number(y) / Number(q)) * plotH;
  const svg = svgEl("svg", {
    viewBox: `0 0 ${w} ${h}`,
    role: "img",
    "aria-label": `Writer payoff. Spot ${fmtUsdFromCents(spot)}, strike ${fmtUsdFromCents(k)} (${pctFromSpot(k)}). You keep between 0 and ${fmtBtc(q)} BTC of collateral.`,
  });
  const levels = [0n, q / 4n, q / 2n, q];
  for (const level of levels) {
    const y = sy(level);
    svg.append(svgEl("line", { x1: left, x2: w - right, y1: y, y2: y, class: "grid" }));
    svg.append(svgEl("text", { x: left - 8, y, class: "ylab" }, fmtBtc(level)));
  }
  const spotX = sx(spot);
  const strikeX = sx(k);
  svg.append(svgEl("line", { x1: spotX, x2: spotX, y1: top, y2: top + plotH, class: "spot-line" }));
  svg.append(svgEl("line", { x1: strikeX, x2: strikeX, y1: top, y2: top + plotH, class: "strike-line" }));
  const line = points.map(([px, y], i) => `${i ? "L" : "M"}${sx(px).toFixed(1)},${sy(y).toFixed(1)}`).join(" ");
  svg.append(svgEl("path", { d: line, class: "curve" }));
  const crowded = Math.abs(spotX - strikeX) < 96;
  svg.append(svgEl("text", {
    x: clamp(spotX, left + 28, w - right - 28),
    y: top + plotH + 16,
    class: "xlab spot-label",
  }, fmtUsdFromCents(spot)));
  svg.append(svgEl("text", {
    x: clamp(spotX, left + 28, w - right - 28),
    y: top + plotH + 30,
    class: "xlab spot-label sub",
  }, "spot"));
  const strikeAnchorX = crowded ? clamp(strikeX + (strikeX >= spotX ? 54 : -54), left + 36, w - right - 36) : clamp(strikeX, left + 36, w - right - 36);
  const strikeY = crowded ? top - 6 : top + plotH + 16;
  svg.append(svgEl("text", { x: strikeAnchorX, y: strikeY, class: "xlab strike-label" }, fmtUsdFromCents(k)));
  svg.append(svgEl("text", {
    x: strikeAnchorX,
    y: crowded ? top + 10 : top + plotH + 30,
    class: "xlab strike-label sub",
  }, `strike ${pctFromSpot(k)}`));
  host.append(svg);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function svgEl(name, attrs, text) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text != null) node.textContent = text;
  return node;
}

function renderTicket() {
  $("kind-copy").textContent = copy();
  $("expiry-when").textContent = state.spotCents == null ? "" : fmtWhen(expiryUnix(state.days));
  $("ticket-kicker").textContent = `${state.side === 0 ? "Sell" : "Buy"} · ${productName()}`;
  const sats = sizeSats();
  const err = state.spotCents == null ? "" : sizeError(sats);
  $("size-error").textContent = err;
  const best = state.quotes && bestQuote(state.quotes, state.side);
  const host = $("quotes");
  host.replaceChildren();
  if (state.quoting) {
    const p = document.createElement("p");
    p.className = "lock-note";
    p.textContent = "Asking Northbridge, Harbor, and Kestrel.";
    host.append(p);
  } else if (best) {
    state.quotes.forEach((row, index) => {
      const line = document.createElement("div");
      line.className = `quote-row${row.name === best.name ? " best" : ""}`;
      line.style.animationDelay = `${index * 40}ms`;
      const name = document.createElement("span");
      name.textContent = row.name;
      const prem = document.createElement("span");
      prem.textContent = `${fmtBtc(row.sats)} BTC`;
      const flag = document.createElement("span");
      if (row.name === best.name) {
        flag.className = "mark";
        flag.textContent = "Best";
      }
      line.append(name, prem, flag);
      host.append(line);
    });
  }
  if (!best || err) {
    $("premium").textContent = "—";
    $("premium-meta").textContent = err ? "" : "Enter a size. The desks answer with a premium.";
    $("lock-note").textContent = "";
  } else {
    $("premium").textContent = `${fmtBtc(best.sats)} BTC`;
    const notionalUsd = Number(sats) / 1e8 * Number(state.spotCents) / 100;
    const ann = notionalUsd > 0 ? best.usd / notionalUsd * (365 / state.days) * 100 : 0;
    $("premium-meta").textContent = `$${best.usd.toLocaleString("en-US", { maximumFractionDigits: 2 })} · ${ann.toFixed(1)}% annualized · ${best.name}`;
    $("lock-note").textContent = `You send ${fmtBtc(sats)} BTC on Mutinynet. ${best.name} pays ${fmtBtc(best.sats)} BTC if the intent finalizes.`;
  }
  renderDeposit(best, err);
  const locking = state.positions.some((p) => p.status === "locking");
  const ready = state.deposit?.status === "ready";
  $("lock").disabled = !ready || Boolean(err) || state.quoting || locking;
  $("lock").textContent = "Track this deposit";
}

function renderDeposit(best, err) {
  const box = $("deposit");
  const tooSmall = best && best.sats <= DUST;
  if (!best || err || state.quoting) {
    box.hidden = true;
    if (!state.positions.some((p) => p.status === "locking")) $("status").textContent = "";
    return;
  }
  if (tooSmall) {
    box.hidden = true;
    $("status").textContent = `Premium is ${best.sats} sats. Finalize only enforces a premium above ${DUST} sats, so this strike has no Mutinynet deposit. A closer strike does.`;
    return;
  }
  const deposit = state.deposit;
  if (!deposit || deposit.status === "loading") {
    box.hidden = false;
    $("deposit-amount").textContent = "Fetching the Mutinynet address…";
    $("deposit-address").textContent = "";
    $("copy-address").disabled = true;
    $("deposit-clock").textContent = "";
    $("status").textContent = "";
    return;
  }
  if (deposit.status === "error") {
    box.hidden = true;
    $("status").textContent = deposit.message;
    return;
  }
  box.hidden = false;
  $("deposit-amount").textContent = `${fmtBtc(deposit.amountSats)} BTC`;
  $("deposit-address").textContent = deposit.address;
  $("copy-address").disabled = false;
  $("deposit-clock").dataset.deadline = String(deposit.deadline);
  $("deposit-clock").textContent = `Send it on Mutinynet. ${countdown(deposit.deadline)}`;
  if (!state.positions.some((p) => p.status === "locking")) $("status").textContent = "";
}

function renderBlotter() {
  const host = $("blotter");
  host.replaceChildren();
  $("blotter-count").textContent = state.positions.length ? `${state.positions.length} on the desk` : "";
  if (!state.positions.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Nothing locked. A quote you accept shows up here, then settles from three oracle slices.";
    host.append(p);
    return;
  }
  const columns = document.createElement("div");
  columns.className = "position-head tag";
  for (const label of ["Contract", "Strike", "Expiry", "Notional", "Status"]) {
    columns.append(textCell(label));
  }
  host.append(columns);
  for (const position of state.positions) {
    const wrap = document.createElement("article");
    wrap.className = "position";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "position-head";
    head.addEventListener("click", () => {
      if (state.selected === position.id) return;
      state.selected = position.id;
      state.settleText = fmtUsdFromCents(state.spotCents);
      state.spike = false;
      renderBlotter();
    });
    const kind = document.createElement("span");
    kind.className = `tag ${position.kind === 0 ? "call" : "put"}`;
    kind.textContent = `${position.side === 0 ? "Sell" : "Buy"} ${position.kind === 0 ? "covered call" : "limited put"}`;
    const cells = [
      kind,
      textCell(fmtUsdFromCents(position.strike)),
      textCell(fmtWhen(position.expiry)),
      textCell(`${fmtBtc(position.collateral)} BTC`),
      statusCell(position),
    ];
    head.append(...cells);
    wrap.append(head);
    if (state.selected === position.id) wrap.append(detail(position));
    host.append(wrap);
  }
}

function textCell(value) {
  const span = document.createElement("span");
  span.textContent = value;
  return span;
}

function statusCell(position) {
  const span = document.createElement("span");
  if (position.status === "locking") {
    span.dataset.deadline = String(position.deadline);
    span.textContent = countdown(position.deadline);
    return span;
  }
  span.textContent = statusLabel(position);
  return span;
}

function statusLabel(position) {
  if (position.status === "locking") return countdown(position.deadline);
  if (position.status === "deposited") return "Deposited";
  if (position.status === "expired") return "Window closed";
  if (position.status === "refunded") return "Refunded";
  if (position.status === "settled") return "Settled";
  return "Open";
}

function countdown(deadline) {
  const left = Math.max(0, deadline - Math.floor(Date.now() / 1000));
  const m = Math.floor(left / 60);
  const s = left % 60;
  return `Closes in ${m}:${s.toString().padStart(2, "0")}`;
}

function positionChart(position) {
  const chart = document.createElement("figure");
  chart.className = "payoff";
  const caption = document.createElement("figcaption");
  caption.textContent = "Writer payoff in BTC for this position, at the current spot.";
  const host = document.createElement("div");
  drawPayoff(host, {
    kind: position.kind,
    strike: position.strike,
    collateral: position.collateral,
    spot: state.spotCents,
  });
  chart.append(caption, host);
  return chart;
}

function detail(position) {
  const box = document.createElement("div");
  box.className = "lab";
  box.append(positionChart(position));
  if (position.status === "locking" || position.status === "deposited" || position.status === "expired") {
    box.append(depositDetail(position));
    return box;
  }
  if (position.status === "refunded") {
    const p = document.createElement("p");
    p.textContent = "The deposit window closed before a coin arrived.";
    box.append(p);
    return box;
  }
  if (position.status === "settled") {
    box.append(resultLine(position.settlement));
    return box;
  }
  box.append(settleLab(position));
  return box;
}

function depositDetail(position) {
  const frag = document.createDocumentFragment();
  const net = document.createElement("p");
  net.className = "lock-note";
  if (position.status === "deposited") {
    net.textContent = "Collateral is on this Mutinynet address.";
  } else if (position.status === "expired") {
    net.textContent = "The deposit window closed. A coin sent here refunds with cancel once this time has passed.";
  } else {
    net.textContent = `Send ${fmtBtc(position.collateral)} BTC to this address on Mutinynet. You lock the collateral. The desk does not.`;
  }
  const addr = document.createElement("p");
  addr.className = "deposit-address";
  addr.textContent = position.address || "Address unavailable.";
  frag.append(net, addr);
  return frag;
}

function resultLine(settlement) {
  const row = document.createElement("div");
  row.className = "result";
  row.append(stat("TWAP", `$${fmtUsdFromCents(settlement.twap)}`), stat("Holder", `${fmtBtc(settlement.holder)} BTC`), stat("Writer", `${fmtBtc(settlement.writer)} BTC`));
  return row;
}

function stat(label, value) {
  const wrap = document.createElement("div");
  const name = document.createElement("span");
  name.className = "tag";
  name.textContent = label;
  const strong = document.createElement("strong");
  strong.textContent = value;
  wrap.append(name, strong);
  return wrap;
}

function settleLab(position) {
  const box = document.createDocumentFragment();
  const who = document.createElement("p");
  who.className = "lock-note";
  who.textContent = position.side === 0
    ? `You are the writer. ${position.solver} paid ${fmtBtc(position.premiumSats)} BTC for the option.`
    : `You are the holder. You paid ${fmtBtc(position.premiumSats)} BTC. ${position.solver} locked the collateral.`;
  const controls = document.createElement("div");
  controls.className = "lab-controls";
  const label = document.createElement("label");
  label.textContent = "Settlement spot";
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "decimal";
  input.value = state.settleText || fmtUsdFromCents(state.spotCents);
  input.addEventListener("input", () => {
    state.settleText = input.value;
    renderPreview(position, previewHost, button);
  });
  label.append(input);
  const spike = document.createElement("label");
  spike.className = "miss";
  const check = document.createElement("input");
  check.type = "checkbox";
  check.checked = state.spike;
  check.addEventListener("change", () => {
    state.spike = check.checked;
    renderPreview(position, previewHost, button);
  });
  spike.append(check, document.createTextNode("Pyth spikes the midpoint"));
  controls.append(label, spike);
  const previewHost = document.createElement("div");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "settle";
  button.textContent = "Settle";
  button.addEventListener("click", () => commitSettle(position));
  const note = document.createElement("p");
  note.className = "lock-note";
  note.textContent = "ST = (900·open + 900·mid + 60·settle) / 1860. Each print is the median of three oracles inside a one-minute slice. A spiked print loses the median.";
  box.append(who, controls, previewHost, button, note);
  renderPreview(position, previewHost, button);
  return box;
}

function slicesFor(expiry, settleCents, spike) {
  const bounds = windows(expiry);
  const bases = [settleCents * 995n / 1000n, settleCents, settleCents];
  const who = [[0n, 1n, 2n], [1n, 2n, 3n], [2n, 3n, 4n]];
  const time = [bounds.open, bounds.mid, bounds.close].map(([lo]) => [lo + 20n, lo + 30n, lo + 40n]);
  return bases.map((base, i) => {
    const price = [base > 5n ? base - 5n : base, base, base + 5n];
    if (spike && i === 1) {
      const pyth = who[i].findIndex((id) => id === 2n);
      price[pyth] = base * 3n > PRICE_MAX ? PRICE_MAX : base * 3n;
    }
    return { price, time: time[i], who: who[i] };
  });
}

function renderPreview(position, host, button) {
  host.replaceChildren();
  const cents = usdToCents(state.settleText || fmtUsdFromCents(state.spotCents));
  if (cents == null || cents <= 0n) {
    button.disabled = true;
    const p = document.createElement("p");
    p.className = "error";
    p.textContent = "Enter a settlement spot in dollars.";
    host.append(p);
    return;
  }
  const slices = slicesFor(position.expiry, cents, state.spike);
  const names = ["Open, 30m prior", "Mid, 15m prior", "Settle, at expiry"];
  slices.forEach((slice, i) => {
    const row = document.createElement("div");
    row.className = "slice";
    const title = document.createElement("span");
    title.textContent = names[i];
    const prints = document.createElement("span");
    prints.textContent = slice.who.map((id, n) => `${ORACLES[Number(id)]} ${fmtUsdFromCents(slice.price[n])}`).join("  ·  ");
    const med = document.createElement("b");
    const ordered = [...slice.price].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    med.textContent = fmtUsdFromCents(ordered[1]);
    row.append(title, prints, med);
    host.append(row);
  });
  const result = settle(position, slices);
  if (result.error) {
    button.disabled = true;
    const p = document.createElement("p");
    p.className = "error";
    p.textContent = result.error;
    host.append(p);
    return;
  }
  button.disabled = false;
  host.append(resultLine({
    twap: result.settlement,
    holder: result.outputs.holder,
    writer: result.outputs.writer,
  }));
  position.preview = result;
}

function commitSettle(position) {
  if (!position.preview || position.preview.error) return;
  position.status = "settled";
  position.settlement = {
    twap: position.preview.settlement,
    holder: position.preview.outputs.holder,
    writer: position.preview.outputs.writer,
    mode: position.preview.outputs.mode,
  };
  delete position.preview;
  persist();
  renderBlotter();
}

function onTermsChanged() {
  state.quotes = null;
  state.deposit = null;
  const sats = sizeSats();
  const ready = state.spotCents != null && !sizeError(sats);
  state.quoting = ready;
  renderStrikes();
  renderPayoff();
  renderTicket();
  clearTimeout(quoteTimer);
  if (!ready) return;
  const gen = ++quoteGen;
  quoteTimer = setTimeout(() => ask(gen), 900);
}

async function ask(gen) {
  const sats = sizeSats();
  if (gen !== quoteGen || sats == null) return;
  const years = state.days / 365;
  state.quotes = deskQuotes({
    kind: state.kind,
    spotCents: Number(state.spotCents),
    strikeCents: Number(strike()),
    years,
    collateralSats: sats,
  });
  state.quoting = false;
  if (gen === quoteGen) {
    renderTicket();
    void loadDeposit(gen);
  }
}

async function loadDeposit(gen) {
  const sats = sizeSats();
  const best = state.quotes && bestQuote(state.quotes, 0);
  if (gen !== quoteGen || !best || sats == null || best.sats <= DUST) return;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60);
  state.deposit = { status: "loading" };
  renderTicket();
  try {
    const deposit = await depositAddress({
      kind: state.kind,
      strike: strike(),
      collateral: sats,
      premium: best.sats,
      expiry: expiryUnix(state.days),
      deadline,
      writerHex: await writerHex(),
    });
    if (gen !== quoteGen) return;
    state.deposit = { status: "ready", ...deposit, deadline: Number(deadline), premium: best.sats };
  } catch (err) {
    if (gen !== quoteGen) return;
    state.deposit = { status: "error", message: err instanceof Error ? err.message : "Could not build the Mutinynet address." };
  }
  renderTicket();
}

async function lock() {
  const deposit = state.deposit;
  const sats = sizeSats();
  const best = state.quotes && bestQuote(state.quotes, 0);
  if (!deposit || deposit.status !== "ready" || sats == null || !best) return;
  if (state.positions.some((p) => p.status === "locking" && p.address === deposit.address)) return;
  const position = {
    id: crypto.randomUUID(),
    side: 0,
    kind: state.kind,
    strike: strike(),
    expiry: expiryUnix(state.days),
    collateral: sats,
    premiumSats: best.sats,
    premiumUsd: best.usd,
    solver: best.name,
    status: "locking",
    deadline: deposit.deadline,
    address: deposit.address,
    uri: deposit.uri,
    commitment: deposit.address,
  };
  state.positions.unshift(position);
  state.selected = position.id;
  state.settleText = fmtUsdFromCents(state.spotCents);
  persist();
  setView("positions");
  renderTicket();
  renderBlotter();
}

function setView(view) {
  state.view = view;
  document.body.dataset.view = view;
  $("view-quote").setAttribute("aria-pressed", String(view === "quote"));
  $("view-positions").setAttribute("aria-pressed", String(view === "positions"));
  const n = state.positions.length;
  $("view-positions").textContent = n ? `Positions (${n})` : "Positions";
  if (view === "positions" && n && !state.positions.some((p) => p.id === state.selected)) {
    state.selected = state.positions[0].id;
    renderBlotter();
  }
}

function tick() {
  const now = Math.floor(Date.now() / 1000);
  let changed = false;
  for (const position of state.positions) {
    if (position.status === "locking" && now >= position.deadline) {
      position.status = "expired";
      changed = true;
    }
  }
  if (state.deposit?.status === "ready" && now >= state.deposit.deadline) {
    onTermsChanged();
    return;
  }
  if (changed) {
    persist();
    renderTicket();
    renderBlotter();
  }
  const clock = $("deposit-clock");
  if (clock && state.deposit?.status === "ready") {
    clock.textContent = `Send it on Mutinynet. ${countdown(state.deposit.deadline)}`;
  }
  for (const node of document.querySelectorAll("[data-deadline]")) {
    if (node === clock) continue;
    node.textContent = countdown(Number(node.dataset.deadline));
  }
  if (now - lastPoll >= 4) {
    lastPoll = now;
    void pollDeposits();
  }
}

let lastPoll = 0;

function reconcileLocks() {
  const now = Math.floor(Date.now() / 1000);
  let changed = false;
  for (const position of state.positions) {
    if (position.status !== "locking") continue;
    if (now >= position.deadline) {
      position.status = "expired";
      changed = true;
    }
  }
  if (changed) persist();
}

async function pollDeposits() {
  for (const position of state.positions) {
    if (position.status !== "locking" || !position.address) continue;
    try {
      const seen = await hasDeposit({
        kind: position.kind,
        strike: position.strike,
        collateral: position.collateral,
        premium: position.premiumSats,
        expiry: position.expiry,
        deadline: BigInt(position.deadline),
        writerHex: await writerHex(),
      });
      if (seen && position.status === "locking") {
        position.status = "deposited";
        persist();
        renderBlotter();
      }
    } catch {
      // The address stays on screen. The next poll tries again.
    }
  }
}

function press(id, pressed) {
  $(id).setAttribute("aria-pressed", String(pressed));
}

function bind() {
  $("side-sell").addEventListener("click", () => {
    state.side = 0;
    press("side-sell", true);
  });
  $("kind-call").addEventListener("click", () => {
    state.kind = 0;
    press("kind-call", true);
    press("kind-put", false);
    onTermsChanged();
  });
  $("kind-put").addEventListener("click", () => {
    state.kind = 1;
    press("kind-call", false);
    press("kind-put", true);
    onTermsChanged();
  });
  document.querySelectorAll("[data-days]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.days = Number(btn.dataset.days);
      document.querySelectorAll("[data-days]").forEach((other) => {
        other.setAttribute("aria-pressed", String(other === btn));
      });
      onTermsChanged();
    });
  });
  $("strikes").addEventListener("click", (event) => {
    const btn = event.target.closest("button");
    if (!btn) return;
    state.strikeIndex = Number(btn.dataset.index);
    onTermsChanged();
  });
  $("size").addEventListener("input", onTermsChanged);
  $("lock").addEventListener("click", lock);
  $("view-quote").addEventListener("click", () => setView("quote"));
  $("view-positions").addEventListener("click", () => setView("positions"));
  $("copy-address").addEventListener("click", async () => {
    const address = state.deposit?.address;
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      $("copy-address").textContent = "Copied";
    } catch {
      $("copy-address").textContent = "Copy failed";
    }
  });
}

async function loadSpot() {
  const sources = [
    ["Coinbase", "https://api.coinbase.com/v2/prices/BTC-USD/spot", (body) => body.data.amount],
    ["Binance", "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", (body) => body.price],
  ];
  for (const [name, url, pick] of sources) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const price = Number(pick(await res.json()));
      if (price > 1000 && price < 10_000_000) {
        state.spotCents = BigInt(Math.round(price * 100));
        state.spotSource = name;
        return;
      }
    } catch {
      // try the next source, then the labeled fallback
    }
  }
  state.spotCents = 10_000_000n;
  state.spotSource = "Simulated spot";
}

function loadArtifact() {
  const node = $("artifact");
  try {
    node.textContent = artifactLine();
  } catch (err) {
    node.textContent = err instanceof Error ? err.message : "The option programs did not load.";
  }
}

bind();
setView("quote");
reconcileLocks();
renderTicket();
renderBlotter();
loadSpot().then(() => {
  $("spot-source").textContent = state.spotSource;
  $("spot-px").textContent = fmtUsdFromCents(state.spotCents);
  state.settleText = fmtUsdFromCents(state.spotCents);
  onTermsChanged();
  renderBlotter();
});
loadArtifact();
setInterval(tick, 250);
