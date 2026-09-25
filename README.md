# Arkade Options desk

Cash-settled covered calls and limited puts. The writer locks BTC notional. At expiry the covenant reads three oracle slices, takes the median of each, and computes the settlement price with multiplies and a divide.

The covenants are `contracts/option_vault.ark` and `contracts/option_intent.ark`. The page loads the committed artifacts with `arkade.programFromArtifact`. It does not compile the sources, and it does not rebuild them inside the compiler.

## Run

```bash
pnpm install
pnpm test
pnpm dev
```

Open http://127.0.0.1:4173/app/. The network is Mutinynet. Buying is off. You sell a covered call or a limited put, and the ticket shows the `tark1…` address that receives your collateral. Copy BIP21 puts `bitcoin:?ark=<address>&amount=<btc>` on the clipboard, on the quote and on the open position. The deposit is only the collateral. The premium is paid to the writer address already stored in this browser when the intent is finalized, and a cancel refunds the collateral there too. The desk does not lock that coin. The chart is the writer's collateral: spot, strike and its distance from spot, and 0, 1/4, 1/2, and the full notional. Positions is a separate page and draws that same chart for the position you open.

A premium of 330 sats or less cannot be enforced by `option_intent.ark`, so that strike has no deposit address. A far, short-dated strike is the case that hits it. A closer strike is above the line.

`scripts/options-example.ts` prints one address:

```bash
node --experimental-strip-types scripts/options-example.ts
```

The page keeps positions in `localStorage`. The deposit address is the OptionIntent output, built with `programFromArtifact` against the Mutinynet operator. Settlement numbers on an open position use the same integer arithmetic as `option_vault.ark`.

Quotes follow the Deribit BTC option mark. A covered call uses the call mark. A limited put is the put spread struck at K and K/2. The annualized figure is that premium divided by the collateral, scaled to a year. The spot on the chart comes from Coinbase, then Binance, and otherwise a labeled simulated price. Relays are `wss://nostr.arkade.sh` and the public Nostr relays.

## Deploy

[`.github/workflows/pages.yml`](.github/workflows/pages.yml) runs `pnpm test`, builds `dist/`, and publishes that directory to GitHub Pages on every push to `master`.

A repository admin turns the site on once: Settings → Pages → Build and deployment → Source: GitHub Actions. The site is [https://arklabshq.github.io/arkade-options/app/](https://arklabshq.github.io/arkade-options/app/).

```bash
docker build -t arkade-options .
docker run --rm -p 8080:80 arkade-options
```

Open `http://127.0.0.1:8080/app/`. The image serves the built page.

### Desk

The desk quotes over Nostr and pays the premium from its own Mutinynet coins. `DESK_KEY` is a 32-byte hex private key. Keep it. The process prints the matching Nostr pubkey and the `tark1…` address to fund.

```bash
export DESK_KEY=$(openssl rand -hex 32)
docker build -f desk/Dockerfile -t arkade-options-desk .
docker run --rm -p 8788:8788 -e DESK_KEY -v desk-data:/data arkade-options-desk
```

Send sats to the printed address. `GET http://127.0.0.1:8788/status` returns the float, the spot, and the quote book. The volume stores that book and `oracles.json` (five keys, written on first start). The process exits when the server's unilateral exit delay is not 2048 seconds.

Without Docker, from this repo: `DESK_KEY=<32-byte hex> pnpm desk`.

Optional environment, with the defaults in parentheses: `RELAYS` (Arkade plus the public relays), `ARK_URL` (`https://mutinynet.arkade.sh`), `EMULATOR_URL` (`https://emulator.mutinynet.arkade.sh`), `DATA_DIR` (`/data` in the image, `./data` under `pnpm desk`), `PORT` (`8788`), `DESK_STRIKE_CAP` (`100000000`), `DESK_TOTAL_CAP` (`500000000`), `DESK_VOL` (unset, so quotes use the Deribit mark).

The page asks this process for quotes after the pubkey is listed in `app/rfq-config.js` and the page is published again:

```js
export const PINNED_DESKS = [{ name: "Desk", pubkey: "<x-only printed at startup>" }];
```

With `PINNED_DESKS` empty, the page prices from the Deribit mark on its own.

## Artifacts

`contracts/*.artifact.json` are the compiler output `programFromArtifact` loads. `contracts/non_interactive_swap.ark` and the `contracts/single_sig.ark` it imports are the compiler's `examples/non_interactive_swap` and `examples/single_sig`, with the import path pointing at this directory. From a checkout of [arkade-os/compiler](https://github.com/arkade-os/compiler):

```bash
cargo run --release -- examples/arkade_options/option_vault.ark -o /path/to/arkade-options/contracts/option_vault.artifact.json
cargo run --release -- examples/arkade_options/option_intent.ark -o /path/to/arkade-options/contracts/option_intent.artifact.json
cargo run --release -- /path/to/arkade-options/contracts/non_interactive_swap.ark -o /path/to/arkade-options/contracts/non_interactive_swap.artifact.json
```

`pnpm check` loads every artifact and fails if anything but the `older(exit)` CSV type differs from what the compiler emitted. [PLAN.md](PLAN.md) is the path to live fills.

## Check

```bash
node --test app/settle-math.test.mjs
```
