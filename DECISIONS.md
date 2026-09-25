# Decisions

## Contracts live here

`contracts/option_vault.ark` and `contracts/option_intent.ark` are the sources. The page loads `contracts/*.artifact.json` with `arkade.programFromArtifact`. `older(exit)` is switched from a block CSV to seconds, which is the only edit. Selling is the only side: the writer sends collateral to the intent address on Mutinynet. The desk does not lock that coin. Buying, and the simulated "desk does not fill" switch, are off.

## Three slices, fixed weights

A 30-minute TWAP of one print per minute would be ninety signatures. Three medians fit in one covenant: nine `OP_CHECKSIGFROMSTACK`, then `OP_MUL` / `OP_DIV`.

Witnessed gaps (`t1 - t0`) let the submitter move weight by picking the edge of a slice, and a print exactly at expiry would weigh zero. The weights are the bucket durations, 900, 900, and 60. Timestamps only have to land in the slice. The close slice is `[expiry, expiry+60]`, which is the oracle note's settlement window.

The median is the three-value sort written as returns, so one bad print in either direction drops out. Two of five oracles can be missing.

## Intent, not an imported swap

The fill pays a premium to one script and the notional to the option script. `NonInteractiveSwap` pays two single-sig outputs of preset assets, so importing it would not check the option script. `OptionIntent` copies that contract's three paths: finalize, cancel on `checkTime`, writer CSV. Finalize requires the clock to have not reached the deadline, so it cannot race the refund. Extra sats on the lock are paid back; cancel already refunded the whole coin, and finalize has to do the same.

The swap itself is in the repo as `contracts/non_interactive_swap.ark`, copied from the compiler's examples with `contracts/single_sig.ark`, and compiled here with `arkadec`. `pnpm check` loads its artifact through `programFromArtifact` next to the two option programs, so the pattern the intent copies is spendable with the same SDK. The compiler turns `new SingleSig(makerPk, exit)` into the `vtxo_SingleSig_makerPk_exit` parameter, the maker's SingleSig witness program.

## Desk is a process, not a page

Quotes and fills come from a Node or Bun process in a Docker container. It holds the desk key, listens on Nostr, and submits `finalize` with its own coins. The page only derives contracts, funds collateral, and cancels. VTXO renewal of the desk float is not handled.

## Static desk

The flow is one page: side, product, five strikes, size, three quotes, lock, settle. No framework and no build. The RFQ is simulated because the task asks for a simulated backend. Settlement uses the same integer functions as the covenant, covered by `settle-math.test.mjs`. Broadcast waits on an SDK session that can turn the artifact into a real witness program.
