---
name: covenant-viz
description: Visualize a Bitcoin covenant protocol (Arkade covenants, VTXO flows, emulator scripts, non-interactive swaps) as transaction diagrams with inputs, outputs, signers and balances taken from the code. Use when asked to explain, draw or review how a covenant moves funds between parties.
---

# Covenant visualization

Goal: the reader sees who funds each input, who owns each output, who signs, and what the script enforces. Every number comes from the code, never from prose.

## 1. Gather facts
1. Read the script builders (leaves, opcodes) and the transaction builders (output order, change, fares). Record the commit.
2. Fetch live parameters from the node (`/v1/info`: dust, vtxoMinAmount, maxOpReturnOutputs, fees). Test fixtures differ from mainnet. Say which set each diagram uses.
3. Read the server's output validation. Minimum amounts and OP_RETURN limits apply to every output, including sub-dust and exception paths.

## 2. Model
Transaction: `{id, name, inputs[], outputs[], totals}`.
Coin: owner, sats, asset, signers (inputs only), note, flags `subdust | short | rejected`.
Scenario: net balance per party, before → after.
Assert before drawing: sats in = sats out, asset in = asset out, and totals conserved across parties. The OP_RETURN extension is a 0-sat output.

## 3. Scenarios
Draw the happy path, each alternative claim leaf, refund, timelocked recovery, and the unclaimed path. Draw the exception paths with live parameters: that is where protocols break. Mark invalid transactions explicitly (rejected by the server, insufficient funds) instead of leaving them out.

## 4. Layout
Inputs column → spine (tx id, sats in = out, asset in = out) → outputs column. Stack vertically below 760px.
Give each party one colour. Hatch covenant outputs and add a lock icon. Draw OP_RETURN outputs dotted.
Between transactions, a band shows the covenant state (locked, pending).
Under each scenario, add a "what the script checks" list (one line per opcode group) and net balance cards.
Add one leaf table: leaf, signatures, used by, pinned outputs.

## 5. Wording
Name the sender. Keep the protocol's fare separate from business fees. A timelock gates only the leaves that carry it. Say "unprofitable" or "bounded" rather than "impossible" unless the script enforces it. Label partner and price data as unverified, with a date.

## 6. Verify
Before publishing, have independent reviewers try to refute each claim against the code, the live parameters and the arithmetic. Add a render check at phone and desktop widths, and a language check if the page is bilingual. Fix what they find, then publish.
