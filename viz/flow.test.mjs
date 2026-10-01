import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { fixing, holderPayoff, settlementOutputs } from "../app/settle-math.js";

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
  const order = (map) => [...map].sort(([a], [b]) => a.localeCompare(b));
  for (const name of names) {
    const block = tx(name);
    if (block.includes("data-asset=")) {
      const left = assets(column(block, "inputs"));
      const minted = block.match(/data-mint="([a-z]+):(\d+)"/);
      if (minted) left.set(minted[1], (left.get(minted[1]) ?? 0) + Number(minted[2]));
      const right = assets(column(block, "outputs"));
      assert.deepEqual(order(left), order(right), name);
    }
    if (block.includes('data-assets="1"') && !block.includes('data-sat="')) continue;
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
  assert.match(html, /1f38cc34c3064c2e3fb03068c69586952d772d0f/);
  assert.match(html, /2026-09-27/);
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
    assert.match(source, /settle-math\.js/);
  }
  const vault = readFileSync(new URL("../contracts/option_vault.ark", import.meta.url), "utf8");
  assert.match(vault, /ph = collateral \* \(st - strike\) \/ st/);
  assert.match(vault, /if \(ph > collateral\)/);
  assert.match(vault, /beaconTxid/);
  assert.doesNotMatch(vault, /twap/);
  const intent = readFileSync(new URL("../contracts/option_intent.ark", import.meta.url), "utf8");
  assert.match(intent, /premium \+ change/);
  assert.match(intent, /checkTime\(deadline\)/);
  const beacon = readFileSync(new URL("../contracts/attestation_beacon.ark", import.meta.url), "utf8");
  assert.match(beacon, /readFee/);
  assert.match(beacon, /sample after close/);
  assert.doesNotMatch(beacon, /minValue/);
  assert.match(html, /holderPayoff/);
  assert.match(html, /settlementOutputs/);
  assert.match(html, /Enforced/);
  assert.match(html, /Not claimed/);
  const links = [...html.matchAll(/explorer\.mutinynet\.arkade\.sh\/tx\/([0-9a-f]+)"/g)].map((match) => match[1]);
  assert.ok(links.length >= 7);
  for (const id of links) assert.equal(id.length, 64, id);
});

test("the prints table is the TWAP attest computes", () => {
  const table = html.match(/<table id="prints" data-expiry="(\d+)" data-twap="(\d+)">/);
  assert.ok(table);
  const expiry = BigInt(table[1]);
  const slices = [0, 1, 2].map(() => ({ price: [], time: [], who: [] }));
  for (const [, slice, who, price, offset] of html.matchAll(/data-print="(\d):(\d):(\d+):(-?\d+)"/g)) {
    slices[Number(slice)].price.push(BigInt(price));
    slices[Number(slice)].time.push(expiry + BigInt(offset));
    slices[Number(slice)].who.push(BigInt(who));
  }
  assert.equal(fixing(expiry, slices).twap, BigInt(table[2]));
  assert.equal(fixing(expiry - 10n, slices).error, undefined);
  assert.equal(fixing(expiry + 30n, slices).error, undefined);
  assert.ok(fixing(expiry - 11n, slices).error);
  assert.ok(fixing(expiry + 31n, slices).error);
  assert.match(html, /1,790,463,982 to 1,790,464,022/);
});
