# Arkade Options

Cash-settled covered calls and limited puts on Mutinynet. The desk pays the premium. The seller sends collateral to the address on the page.

## Live

- Page: <https://arkade.trade/>
- Fund flow: <https://arkade.trade/viz/>
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

- Open <http://127.0.0.1:4173/>
- Paste a Mutinynet address from <https://mutinynet.arkade.money>
- Quotes use `wss://nostr.arkade.sh`

```bash
docker build -f site.Dockerfile -t arkade-options .
docker run --rm -p 8080:80 arkade-options
```

- Open <http://127.0.0.1:8080/>
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

## Oracle

`ORACLE_KEY` is an optional 32-byte hex key and is never generated. Its x-only pubkey is the beacon admin key. `ORACLE_ADMIN` is an optional bearer token; leave it unset to disable the admin routes. `ARK_URL` defaults to `https://mutinynet.arkade.sh`. `EMULATOR_URL` defaults to the Mutinynet emulator. `DATA_DIR` is the store directory and `PORT` defaults to `8789`.

```bash
pnpm oracle
```

```bash
docker build -f oracle/Dockerfile -t arkade-options-oracle .
docker run --rm -p 8789:8789 -e ORACLE_KEY -e ORACLE_ADMIN -v oracle-data:/data arkade-options-oracle
```

Dokploy:

- Dockerfile `oracle/Dockerfile`, build context the repository root.
- Port `8789`. The dashboard is `GET /` on the same port.
- Set `ORACLE_KEY` and `ORACLE_ADMIN`. Keep `ORACLE_KEY`: it is the only key that writes fixings on the beacon it deploys.
- Mount a volume at `/data`.

An oracle print is `sha256(BTCUSD || price_le64 || time_le64)`. After `expiry + 60`, publish the fixing:

```bash
curl -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -d '{"expiry":1790463992}' https://<oracle>/api/publish
```

## Check

```bash
pnpm test
```
