---
name: covenant-viz
description: Visualize a Bitcoin covenant protocol (Arkade covenants, VTXO flows, emulator scripts, non-interactive swaps) as a short story of transactions, with inputs, outputs, signers, deltas and balances taken from the code. Use when asked to explain, draw or review how a covenant moves funds between parties.
---

# Covenant visualization

Goal: a reader can follow one coin from start to finish and see who funds each input, who owns each output, who signs, what changed, and what the script enforces. Every amount and every formula comes from the code. A caption may be short. A number may not be invented.

Publish one static page. When the script's payment is a function of a public input, add controls on that same page. The controls recompute the picture. They are not a second design.

## 1. Gather facts
1. Read the script builders (leaves, opcodes, committed fields) and the transaction builders (output order, change, fares, canonical anchor and extension). Record the commit.
2. Fetch live parameters from the node (`/v1/info`: dust, vtxoMinAmount, maxOpReturnOutputs, fees). Test fixtures differ from mainnet. Say which set each diagram uses.
3. Read the server's output validation. Minimum amounts and OP_RETURN limits apply to every output, including sub-dust and exception paths.
4. Separate three kinds of fact: committed state (what the script reads back), amounts (sats and assets), and labels (names a human needs). Only the first two may appear as numbers.

## 2. Model
Transaction: `{id, name, shape, inputs[], outputs[], tail[], totals}`.
Shape is `n in → m out`, counting value outputs only. The extension and the anchor are the tail, not part of that count.
Coin: owner, sats, asset, signers (inputs only), state (committed fields), delta `gain | loss | unchanged`, note, flags `subdust | short | rejected | unpinned`.
Scenario: one claim, the transactions that prove it, net balance per party, before → after.
Assert before drawing: sats in = sats out, asset in = asset out, and a gain names the same units as its loss. Totals are conserved across parties. The OP_RETURN extension is a 0-sat output. An unpinned output is drawn at the input amount and flagged, so the picture balances without pretending the script chose the destination.

## 3. Story, then the catalog
Write numbered chapters. Each chapter is one claim a reader can check ("the premium arrives before settlement", "a miss moves no asset"). The story follows the coin a person actually sends: funding, the cooperative spend, the alternative outcomes, refund, timelocked recovery, the unclaimed pause.
A variant that does not change who is paid (an extra fee input, a 1-sat overfund, folded dust) is a second shape under the same chapter, not a new chapter.
After the story, one catalog: the leaf table (leaf, signatures, used by, pinned outputs), the rejected transactions, and contention. Draw rejected transactions (server, script, insufficient funds). Do not leave them out. When two spends share an input, say who wins and what the loser must rebuild.

## 4. One picture, one invariant
The picture is the transaction. The caption is one sentence: what changed, and the invariant.
Coins show amount, owner, signers, and the committed state that matters. Unchanged state stays quiet. A recreated covenant shows the fields that moved and does not restate the fields that did not.
Give a gain a distinct border and the matching loss the opposite border. Party color answers who owns the coin. The border answers what changed. Those are different questions.
The spine names the shape, the tx, and the conservation (`sats in = out`, `asset in = out`).
Group the 0-sat extension and the anchor as a protocol tail under the value outputs. Draw that tail once per transaction. Do not let it repeat as if it were a payment.

## 5. Draw the function once
If the script pays from a public input (a price, a roll, a deadline), draw that function once. Mark the dust kink and the fixture points on it. State the formula and the expected result next to the picture.
Redraw the transaction only when the output shape changes (one output becomes two, a leg disappears). Do not draw a new transaction for every sample of the same shape.
An interactive control may set only an input the script reads. It calls the same function the tests use. Show the input that produced the picture (the price, the seed) so a reader can reproduce it. A control never introduces a second set of amounts.

## 6. Layout
Prose sits in a narrow column. The transaction is inputs → spine → outputs, and stacks vertically below 760px.
Give each party one colour. Hatch covenant outputs and add a lock icon. Draw the protocol tail dotted.
Between transactions, a band shows the covenant state (locked, pending, unclaimed).
Under a chapter, a "what the script checks" list is one line per opcode group. When two covenants inspect the same transaction, that list is a table: one row per check, one column per contract.
Net balance cards sit under the chapter, before → after.
Comparison tables are for checks, recipes, renewal, and contention. They are not a substitute for the picture of the transaction.

## 7. Wording
Name the sender. Keep the protocol's fare separate from business fees. A timelock gates only the leaves that carry it. Say "unprofitable" or "bounded" rather than "impossible" unless the script enforces it. Label partner and price data as unverified, with a date.
Close with two lists. Enforced: the invariants the script actually checks. Not claimed: oracle honesty, liveness, pinned destinations the script does not check, paths no caller sends, and anything that is only a client policy.

## 8. Verify
Before publishing, have independent reviewers try to refute each claim against the code, the live parameters and the arithmetic. Check that every gain has a matching loss, that the function chart uses the tested formula, and that a control cannot display an amount the formula does not produce. Add a render check at phone and desktop widths, and a language check if the page is bilingual. Fix what they find, then publish.
