# Arkade Options

Cash-settled covered calls and limited puts on Mutinynet.

Page: <https://arklabshq.github.io/arkade-options/app/>
Desk: <https://prod-mutinynet-optionsdesk-gk1vzy-1e84a5-138-199-218-130.traefik.me/>

## After the desk is deployed

Fund it. The desk pays the premium from its own Mutinynet coins. The seller's collateral is a different address, the one on the page.

1. Open the desk URL. `GET /` returns `commit`, `pubkey`, `address`, and `balance`. The hostname uses the Traefik default certificate.
2. Send Mutinynet sats to `address`. `balance` stays `0` until those coins show up. Send enough to cover the premiums you expect to pay, not the collateral.
3. If `pubkey` is not the one in `app/rfq-config.js`, replace it and push `master`. The page asks that key over Nostr.

A quote can go out while `balance` is `0`. Finalize then logs `float short`, and the seller's collateral sits until they cancel.

## Locally

```bash
pnpm install
pnpm test
pnpm dev
```

The page is <http://127.0.0.1:4173/app/>. The desk is `DESK_KEY=<32-byte hex> pnpm desk`.

Dokploy builds the repository `Dockerfile`. Set `DESK_KEY` and port `8788`. The page image is `site.Dockerfile`. GitHub Pages publishes on every push to `master`.
