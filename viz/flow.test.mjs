import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { holderPayoff, settlementOutputs } from "../app/settle-math.js";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const Q = 20_000n;
const K = 9_700_000n;
const PREM = 1_000n;

function tx(name) {
  const match = html.match(new RegExp(`<section class="tx" data-name="${name}"([\\s\\S]*?)</section>`));
  assert.ok(match, name);
  return match[1];
}

function column(block, which) {
  const start = block.indexOf(`class="col ${which}"`);
  assert.ok(start >= 0, which);
  const rest = block.slice(start);
  if (which === "inputs") {
    const end = rest.indexOf('class="spine"');
    assert.ok(end > 0);
    return rest.slice(0, end);
  }
  return rest;
}

function sumSat(fragment) {
  return [...fragment.matchAll(/data-sat="(\d+)"/g)].reduce((sum, match) => sum + Number(match[1]), 0);
}

function assets(fragment) {
  const totals = new Map();
  for (const match of fragment.matchAll(/data-asset="([a-z]+):(\d+)"/g)) {
    totals.set(match[1], (totals.get(match[1]) ?? 0) + Number(match[2]));
  }
  return totals;
}

function scenario(id) {
  const match = html.match(new RegExp(`<article class="scenario[^"]*" id="${id}"([^>]*)>`));
  assert.ok(match, id);
  return {
    writer: Number(match[1].match(/data-writer="(-?\d+)"/)?.[1]),
    desk: Number(match[1].match(/data-desk="(-?\d+)"/)?.[1]),
  };
}

function optionNet(kind, settlement) {
  const outputs = settlementOutputs(holderPayoff(kind, settlement, K, Q), Q);
  return {
    writer: Number(PREM + outputs.writer - Q),
    desk: Number(outputs.holder - PREM),
  };
}

test("every drawn bitcoin transaction conserves sats", () => {
  const names = [...html.matchAll(/data-name="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(names.length >= 16);
  for (const name of names) {
    const block = tx(name);
    if (block.includes('data-assets="1"')) {
      const left = assets(column(block, "inputs"));
      const right = assets(column(block, "outputs"));
      const order = (map) => [...map].sort(([a], [b]) => a.localeCompare(b));
      assert.deepEqual(order(left), order(right), name);
      continue;
    }
    const inn = sumSat(column(block, "inputs"));
    const out = sumSat(column(block, "outputs"));
    if (block.includes('data-reject="short"')) {
      assert.equal(out - inn, 1, name);
      continue;
    }
    assert.equal(inn, out, `${name}: ${inn} vs ${out}`);
  }
});

test("scenario nets match the vault payoff", () => {
  assert.deepEqual(scenario("call-itm"), optionNet(0, 10_000_000n));
  assert.deepEqual(scenario("call-otm"), optionNet(0, K));
  assert.deepEqual(scenario("dust"), optionNet(0, 9_863_237n));
  assert.deepEqual(scenario("put-all"), optionNet(1, 4_849_878n));
  assert.deepEqual(scenario("refund"), { writer: 0, desk: 0 });

  const split = settlementOutputs(holderPayoff(0, 10_000_000n, K, Q), Q);
  const foldedWriter = Number(1_330n + split.writer - Q);
  const foldedDesk = Number(split.holder - 1_330n);
  assert.deepEqual(scenario("fill-dust"), { writer: foldedWriter, desk: foldedDesk });
  assert.equal(holderPayoff(0, 9_862_736n, K, Q), 330n);
  assert.equal(holderPayoff(0, 9_863_237n, K, Q), 331n);
  assert.equal(holderPayoff(1, 4_849_878n, K, Q), Q);
  assert.equal(split.holder, 600n);
  assert.equal(split.writer, 19_400n);
});

test("the page names the live parameters and the sources", () => {
  assert.match(html, /lang="en"/);
  assert.match(html, /5027bc786c7e0c313e2d4409fe629a0cc4af9882/);
  assert.match(html, /2026-09-26/);
  assert.match(html, /vtxoMinAmount/);
  assert.match(html, /maxOpReturnOutputs/);
  assert.match(html, /unilateralExitDelay/);
  for (const fact of ["330", "1", "3", "40,000", "2,048", "0.0"]) {
    assert.ok(html.includes(fact), fact);
  }
  const page = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
  assert.match(page, /href="\/viz\/"/);
  for (const file of ["../scripts/build.mjs", "../scripts/dev.mjs"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /viz\/index\.html/);
  }
  const vault = readFileSync(new URL("../contracts/option_vault.ark", import.meta.url), "utf8");
  assert.match(vault, /ph = collateral \* \(twap - strike\) \/ twap/);
  assert.match(vault, /if \(ph > collateral\)/);
  const intent = readFileSync(new URL("../contracts/option_intent.ark", import.meta.url), "utf8");
  assert.match(intent, /premium \+ change/);
  assert.match(intent, /checkTime\(deadline\)/);
});
