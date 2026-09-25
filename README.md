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

The page asks the pinned desk over Nostr. Relays are `wss://nostr.arkade.sh` and the public relays. For now that desk is the Mutinynet process at <https://prod-mutinynet-optionsdesk-gk1vzy-1e84a5-138-199-218-130.traefik.me/>. Its hostname uses the Traefik default certificate. `GET /` returns `commit`, the Nostr pubkey, the `tark1…` address to fund, the float, the spot, and the quote book. `app/rfq-config.js` pins that pubkey. An empty `PINNED_DESKS` prices the page from the Deribit mark on its own.

The desk prices a covered call from the Deribit call mark and a limited put from the put spread struck at K and K/2. The annualized figure is that premium divided by the collateral, scaled to a year. The spot on the chart comes from Coinbase, then Binance, and otherwise a labeled simulated price. The desk's own spot is the median of Coinbase, Kraken, and Binance.

## Deploy

[`.github/workflows/pages.yml`](.github/workflows/pages.yml) runs `pnpm test`, builds `dist/`, and publishes that directory to GitHub Pages on every push to `master`.

A repository admin turns the site on once: Settings → Pages → Build and deployment → Source: GitHub Actions. The site is [https://arklabshq.github.io/arkade-options/app/](https://arklabshq.github.io/arkade-options/app/).

```bash
docker build -f site.Dockerfile -t arkade-options .
docker run --rm -p 8080:80 arkade-options
```

Open `http://127.0.0.1:8080/app/`. The image serves the built page.

### Desk

The desk quotes over Nostr and pays the premium from its own Mutinynet coins. `DESK_KEY` is a 32-byte hex private key. Keep it. The process prints the matching Nostr pubkey and the `tark1…` address to fund.

```bash
export DESK_KEY=$(openssl rand -hex 32)
docker build -f desk/Dockerfile --build-arg GIT_COMMIT=$(git rev-parse HEAD) -t arkade-options-desk .
docker run --rm -p 8788:8788 -e DESK_KEY -v desk-data:/data arkade-options-desk
```

Dokploy builds the repository `Dockerfile`. That file clones this repo during the build and records `HEAD` in the image, so a context path of `desk` still produces the desk and `GET /` shows that commit. Set the container port to `8788` and set `DESK_KEY`. The page image is `site.Dockerfile`.

Send sats to the address from `GET /`. `GET /` and `GET /status` return the same JSON. The volume stores the quote book and `oracles.json` (five keys, written on first start). The process exits when the server's unilateral exit delay is not 2048 seconds.

Without Docker, from this repo: `DESK_KEY=<32-byte hex> pnpm desk`. `pnpm e2e` prints the Mutinynet addresses. `pnpm e2e -- --spend` finalizes one funded intent, cancels the other, and settles the vault.

Optional environment, with the defaults in parentheses: `RELAYS` (Arkade plus the public relays), `ARK_URL` (`https://mutinynet.arkade.sh`), `EMULATOR_URL` (`https://emulator.mutinynet.arkade.sh`), `DATA_DIR` (`/data` in the image, `./data` under `pnpm desk`), `PORT` (`8788`), `GIT_COMMIT` (the hash baked into the image, else `git rev-parse HEAD`), `DESK_STRIKE_CAP` (`100000000`), `DESK_TOTAL_CAP` (`500000000`), `DESK_VOL` (unset, so quotes use the Deribit mark).

After the desk key changes, copy `pubkey` from `GET /` into `app/rfq-config.js` and publish the page again.

## Artifacts

`contracts/*.artifact.json` are the compiler output `programFromArtifact` loads. `contracts/non_interactive_swap.ark` and the `contracts/single_sig.ark` it imports are the compiler's `examples/non_interactive_swap` and `examples/single_sig`, with the import path pointing at this directory. From a checkout of [arkade-os/compiler](https://github.com/arkade-os/compiler):

```bash
cargo run --release -- examples/arkade_options/option_vault.ark -o /path/to/arkade-options/contracts/option_vault.artifact.json
cargo run --release -- examples/arkade_options/option_intent.ark -o /path/to/arkade-options/contracts/option_intent.artifact.json
cargo run --release -- /path/to/arkade-options/contracts/non_interactive_swap.ark -o /path/to/arkade-options/contracts/non_interactive_swap.artifact.json
```

`pnpm check` loads every artifact and fails if anything but the `older(exit)` CSV type differs from what the compiler emitted. [PLAN.md](PLAN.md) is the design of the fill.

## Check

```bash
pnpm test
```
