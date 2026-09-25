# Arkade Options

Cash-settled covered calls and limited puts on Mutinynet. The desk pays the premium. The seller sends collateral to the address on the page.

## Live

- Page: <https://arklabshq.github.io/arkade-options/app/>
- Desk: <https://prod-mutinynet-optionsdesk-gk1vzy-1e84a5-138-199-218-130.traefik.me/>

## Fund the desk

```bash
curl -k https://prod-mutinynet-optionsdesk-gk1vzy-1e84a5-138-199-218-130.traefik.me/
```

- Send Mutinynet sats to `address`. That is the float.
- Send enough for premiums, not for the seller's collateral.
- `balance` stays `0` until the coins arrive.
- A quote can still go out at `0`. Finalize then logs `float short`.

## Point the page at the desk

Paste `pubkey` from the curl into `app/rfq-config.js`, then push `master`.

```js
export const PINNED_DESKS = [
  { name: "Mutinynet", pubkey: "<pubkey>" },
];
```

Leave `PINNED_DESKS` empty to price from Deribit in the browser instead.

## Page

```bash
pnpm install
pnpm dev
```

- Open <http://127.0.0.1:4173/app/>
- Paste a Mutinynet address from <https://mutinynet.arkade.money>
- Quotes use `wss://nostr.arkade.sh`

```bash
docker build -f site.Dockerfile -t arkade-options .
docker run --rm -p 8080:80 arkade-options
```

- Open <http://127.0.0.1:8080/app/>
- GitHub Pages publishes `dist/` on every push to `master`.

## Desk

```bash
pnpm install
export DESK_KEY=$(openssl rand -hex 32)
pnpm desk
```

```bash
export DESK_KEY=$(openssl rand -hex 32)
docker build -f desk/Dockerfile --build-arg GIT_COMMIT=$(git rev-parse HEAD) -t arkade-options-desk .
docker run --rm -p 8788:8788 -e DESK_KEY -v desk-data:/data arkade-options-desk
```

Dokploy:

- Build the repository `Dockerfile`.
- Port `8788`.
- Set `DESK_KEY` to a 32-byte hex key and keep it.
- Mount a volume at `/data`.
- Redeploy after a desk change. An older image refuses a pasted address.
- `commit` in `GET /` must change. A cached image can stay on `16d579f`.

`GET /` and `GET /status` return the same JSON: `commit`, `pubkey`, `address`, `balance`.

## Check

```bash
pnpm test
```
