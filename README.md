# Arkade Options desk

Cash-settled covered calls and limited puts. The writer locks BTC notional. At expiry the covenant reads three oracle slices, takes the median of each, and computes the settlement price with multiplies and a divide.

The covenants are `option_vault.ark` and `option_intent.ark` in the compiler at [`examples/arkade_options`](https://github.com/arkade-os/compiler/tree/cursor/arkade-options-contracts-9f6e/examples/arkade_options). This repo is the desk: the page, the simulated quotes, and the image that serves them.

## Run

```bash
python3 -m http.server 8765
```

Open `http://127.0.0.1:8765/app/`.

Sell or buy, pick a covered call or a limited put, choose one of five strikes and an expiry, enter a BTC notional, and take the best of three simulated desk quotes. Locking starts a 30-second intent. If the desk funds, the position opens. If it does not, the lock refunds when the clock passes. An open position settles from three oracle slices. "Pyth spikes the midpoint" shows the median dropping the bad print.

The page keeps positions in `localStorage`. It does not broadcast to an operator. The numbers it shows are the same integer arithmetic as `option_vault.ark`. The script commitment is a SHA-256 of the terms, standing in for the vault's 32-byte witness program until an SDK session builds the real output script.

Quotes are Black-Scholes with zero rates. A covered call is priced as a call. A limited put is priced as a put spread struck at K and K/2. The spot comes from Coinbase, then Binance, and otherwise a labeled simulated price.

## Deploy

The page, the quotes, and the settlement math are static. Cloudflare Pages or GitHub Pages can host this repository. There is no oracle service to run.

Leave the build command empty and publish the repository root. Open `/app/`. `desk.js` loads `../artifacts/`, so the publish root has to be this repository, not `app/` alone.

```bash
docker build -t arkade-options .
docker run --rm -p 8080:80 arkade-options
```

Open `http://127.0.0.1:8080/`. `/` redirects to `/app/`. The image is nginx plus this repository, including the committed artifacts.

## Artifacts

`artifacts/*.json` are compiler output the page loads. From a checkout of the compiler:

```bash
cargo run -- examples/arkade_options/option_vault.ark -o /path/to/arkade-options/artifacts/option_vault.json
cargo run -- examples/arkade_options/option_intent.ark -o /path/to/arkade-options/artifacts/option_intent.json
```

## Check

```bash
node --test app/settle-math.test.mjs
```
