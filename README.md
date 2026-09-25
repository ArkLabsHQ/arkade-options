# Arkade Options desk

Cash-settled covered calls and limited puts. The writer locks BTC notional. At expiry the covenant reads three oracle slices, takes the median of each, and computes the settlement price with multiplies and a divide.

The covenants are `contracts/option_vault.ark` and `contracts/option_intent.ark`. The page loads the committed artifacts with `arkade.programFromArtifact`. It does not compile the sources, and it does not rebuild them inside the compiler.

## Run

```bash
pnpm install
pnpm test
pnpm dev
```

Open http://127.0.0.1:4173. The network is Mutinynet. Buying is off. You sell a covered call or a limited put, and the ticket shows the `tark1…` address that receives your collateral. The desk does not lock that coin.

A premium of 330 sats or less cannot be enforced by `option_intent.ark`, so that strike has no deposit address. A 7-day covered call at the farthest strike is the case that hits it. A closer strike is above the line.

`scripts/options-example.ts` prints one address:

```bash
node --experimental-strip-types scripts/options-example.ts
```

The page keeps positions in `localStorage`. The deposit address is the OptionIntent output, built with `programFromArtifact` against the Mutinynet operator. Settlement numbers on an open position use the same integer arithmetic as `option_vault.ark`.

Quotes are Black-Scholes with zero rates. A covered call is priced as a call. A limited put is priced as a put spread struck at K and K/2. The spot comes from Coinbase, then Binance, and otherwise a labeled simulated price.

## Deploy

[`.github/workflows/pages.yml`](.github/workflows/pages.yml) runs `pnpm test`, builds `dist/`, and publishes that directory to GitHub Pages on every push to `master`.

A repository admin turns the site on once: Settings → Pages → Build and deployment → Source: GitHub Actions. The site is [https://arklabshq.github.io/arkade-options/](https://arklabshq.github.io/arkade-options/).

```bash
docker build -t arkade-options .
docker run --rm -p 8080:80 arkade-options
```

Open `http://127.0.0.1:8080/`. The image serves the built page.

## Artifacts

`contracts/*.artifact.json` are the compiler output `programFromArtifact` loads. From a checkout of the compiler:

```bash
cargo run -- examples/arkade_options/option_vault.ark -o /path/to/arkade-options/contracts/option_vault.artifact.json
cargo run -- examples/arkade_options/option_intent.ark -o /path/to/arkade-options/contracts/option_intent.artifact.json
```

## Check

```bash
node --test app/settle-math.test.mjs
```
