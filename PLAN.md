# Plan: live fills

Happy path only. Arkade and the emulator are online. A quote is filled by the desk, or the seller cancels after the deadline. Nothing else is designed for.

## What is reused

| Piece | Source | Here |
| --- | --- | --- |
| Rendezvous | Nostr kind `24859`, NIP-44 to the desk key, `p`-tagged. Envelopes `rfq_request`, `rfq_quote`, `rfq_refusal`, `rfq_status`. | As is. `nostrRfqTransport` from `@arkade-os/swap/nostr` on the client if it passes the option profile through, otherwise a short transport over `nostr-tools`. |
| Pair and profile | Any `pair` is allowed on the wire. | Own pair `arkade:BTC->arkade:BTC-OPTION`. No registry. Desks are pinned in the app. |
| Settlement contract | `NonInteractiveSwap` pays the deposit to the taker. | `OptionIntent`. Collateral must land in `OptionVault`, the premium must go to the writer, `cancel` after `deadline`. |
| Fill | `fillOffer` in `@arkade-os/swap` is the taker side. | Same shape on `OptionIntent.finalize`: `.from(intentCoin).fund(deskCoins).to(...).change(...).send()`. |
| Desk runtime | `intent-solver` is Node, LND, SQLite. | `desk/`, one TypeScript process that runs on Node 22 or Bun, shipped as a Docker container. It holds the relay socket, the quote book, and the fill loop. |

## Contracts in this repo

Every covenant the desk touches is a `.ark` source here, compiled with `arkadec` from `arkade-os/compiler`, and loaded with `arkade.programFromArtifact`. Nothing compiles at runtime.

| Source | Artifact | Role |
| --- | --- | --- |
| `contracts/option_vault.ark` | `contracts/option_vault.artifact.json` | The option. Three oracle slices, settle, close, writer CSV. |
| `contracts/option_intent.ark` | `contracts/option_intent.artifact.json` | The fill. Collateral in, premium to the writer, collateral to the vault. |
| `contracts/non_interactive_swap.ark` | `contracts/non_interactive_swap.artifact.json` | The reference the intent copies. Brought from `examples/non_interactive_swap` in the compiler, with `contracts/single_sig.ark` it imports. |

Compile from a compiler checkout, then run `pnpm check`, which loads every artifact and flips only the `older(exit)` CSV to seconds:

```bash
cargo run --release -- /path/to/arkade-options/contracts/non_interactive_swap.ark -o /path/to/arkade-options/contracts/non_interactive_swap.artifact.json
```

## Wire

Request, client to desk:

```json
{
  "v": 1, "type": "rfq_request", "rfq_id": "<32 random bytes, hex>",
  "pair": "arkade:BTC->arkade:BTC-OPTION",
  "amount_side": "from", "amount": "10000000",
  "profile": {
    "kind": 0, "strike": 9700000, "expiry": 1790000000,
    "writer_pubkey": "<x-only>", "writer_pk_script": "5120…"
  }
}
```

Quote, desk to client:

```json
{
  "v": 1, "type": "rfq_quote", "rfq_id": "…", "pair": "arkade:BTC->arkade:BTC-OPTION",
  "from_amount": "10000000", "to_amount": "235647",
  "solver_pubkey": "<desk x-only>", "valid_until": 1790000030,
  "profile": {
    "holder_pubkey": "<desk x-only>", "holder_pk_script": "5120…",
    "oracle_pubkeys": ["…", "…", "…", "…", "…"],
    "deadline": 1790000210, "exit": 2048,
    "intent_address": "tark1…", "vault_address": "tark1…"
  }
}
```

Binding: the amounts (`to_amount` is the premium in sats), `solver_pubkey`, `valid_until`, `holder_pubkey`, the oracle set, `deadline`, `exit`. Compare-only: the two addresses. The client derives `OptionVault` and `OptionIntent` from its own key, the operator key, and the binding fields, and refuses a mismatch. The desk's `holder_pubkey` is the vault's holder, so the desk pays the premium for an option it owns.

The fill the desk submits before `deadline`:

- input 0: the intent coin, `finalize` path, server and emulator cosign
- inputs 1..n: desk coins through `.fund()`, signed by the desk key
- output 0: premium plus any excess collateral, to `writer_pk_script`
- output 1: collateral, to the vault script
- output 2: desk change

No fill by `deadline`: the seller submits `cancel`. The whole coin returns to the writer script. No desk signature.

## Phases

### 0. Spend the covenants on Mutinynet

`scripts/e2e-mutinynet.ts`. Fund an intent from a faucet-funded key. Finalize through the emulator with a second key paying the premium. Fund another intent and cancel it after `deadline`. Fund a vault and run `settle` with nine signatures from three test oracle keys. Fund a `NonInteractiveSwap` and take it with `swap`, so the reference pattern is proven with the same SDK. The script prints the addresses to fund on first run.

### 1. Shared protocol package

`protocol/`, used by the browser and the desk: message types with strict validation, the Nostr framing (kind `24859`, NIP-44, `p` tag), `deriveContracts(terms)` returning the intent and the vault, pricing moved from `app/quote.js`, golden tests pinning the derived addresses for fixed inputs. A premium at or below 330 sats is a refusal.

### 2. Desk process

`desk/`, TypeScript on Node 22 or Bun, one container:

- connects to the relays with `nostr-tools`, subscribes to kind `24859` tagged to the desk pubkey, decrypts, validates
- prices from the Deribit BTC option mark, interpolated in strike and expiry, with spot from a median of Coinbase, Kraken, and Binance, per-strike and total exposure caps, answers `rfq_quote` or `rfq_refusal`
- keeps the quote book in memory and in a JSON file under `/data`; every 2 s it polls `intent.getUtxos()` for open quotes; when the collateral is there, it builds the fill and submits
- answers `rfq_status_request`; a small HTTP route on the container shows the desk address, float balance, open quotes, and fills
- configuration: `DESK_KEY`, `RELAYS`, `ARK_URL`, `EMULATOR_URL`, `DATA_DIR`. No key reaches the page.

Kind `24859` is ephemeral. The process keeps one live subscription and reconnects when a relay drops. A request with no answer inside the client timeout is sent again. Float renewal is out of scope.

### 3. Browser

Replace the simulated desks in `app/quote.js` with addressed requests to the pinned desks, one transport key per negotiation. Show quotes with a `valid_until` countdown. The best quote is the ticket, and the deposit address is the locally derived intent. Position states: quoted, funded, filled (intent spent through `finalize`, vault funded), expired (cancel button submits `cancel`), settled. Premium payout stays on the writer address.

### 4. Oracles and settlement

`attestor/`: a loop per oracle key in the same container signs `sha256("BTCUSD" || price || time)` every minute and publishes the print as an addressable Nostr event keyed by minute. Three keys to start, run by the desk operator. At expiry the desk collects three prints per slice, builds `settle` with nine signatures, and submits. The writer page can settle from the same prints.

### 5. After the first fills

Exposure and P&L reporting, then buying (side 1). No VTXO renewal; OP_TUNNEL or UTXO execution covers the float later.

## Notes

- `@arkade-os/swap@rc` pins SDK `0.5.0-rc.11`; this repo vendors a patched `0.4.74`. The browser imports only `@arkade-os/swap/nostr` and `nostr-tools`, which do not touch the SDK.
- Quote `valid_until` is 30 s after the quote. `deadline` is at least 180 s after the quote, so the deposit is preconfirmed and seen by the poller before it.
