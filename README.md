# Arkade Options

Cash-settled covered calls and limited puts on Mutinynet. The desk pays the premium. The seller sends collateral to the address on the page.

Deploy order: oracle (issue the beacon) → desk (`BEACON_TXID`) → fund the desk → pin the desk pubkey on the page.

## Live

- Page: <https://arkade.trade/>
- Fund flow: <https://arkade.trade/viz/>
- Desk: <https://arkadeoptions-desk-jxdh3j-37969b-138-199-218-130.traefik.me/>

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

## Oracle

The beacon is a 5-signer committee plus one admin key. `ORACLE_KEY` is the admin: it issues the identity asset, deploys the beacon coin, and signs each fixing write. It is never auto-generated. The five source secrets stay off the server; only their x-only pubkeys are stored. The process never holds those five private keys.

| Key | Role |
| --- | --- |
| `ORACLE_KEY` | Admin. Wallet, issue, deploy, publish. One 32-byte hex secret. |
| Five source secrets | Sign price prints. Register the five x-only pubkeys once; keep the secrets for the print form or `/api/prints`. |

Env: `ORACLE_KEY` and `ORACLE_ADMIN` (bearer for admin routes; unset disables them). `ARK_URL` defaults to `https://mutinynet.arkade.sh`. `EMULATOR_URL` defaults to the Mutinynet emulator. `DATA_DIR` holds `oracle.json` and `arkade.sqlite` (SDK wallet); `PORT` defaults to `8789`.

```bash
export ORACLE_KEY=$(openssl rand -hex 32)
export ORACLE_ADMIN=$(openssl rand -hex 16)
pnpm oracle
```

```bash
export ORACLE_KEY=$(openssl rand -hex 32)
export ORACLE_ADMIN=$(openssl rand -hex 16)
docker build -f oracle/Dockerfile -t arkade-options-oracle .
docker run --rm -p 8789:8789 -e ORACLE_KEY -e ORACLE_ADMIN -v oracle-data:/data arkade-options-oracle
```

Dokploy:

- Build type Dockerfile. **Docker File** `oracle/Dockerfile` (or `./Dockerfile` if the context is the oracle folder). **Docker Context Path** `/oracle` or `/`. Do not use the repository-root `./Dockerfile`: that image is the desk (port `8788`) and will 502 behind an oracle domain on `8789`.
- Port `8789` behind the Dokploy HTTPS domain. The dashboard is `GET /`; browsers only let it sign over HTTPS or localhost.
- Set `ORACLE_KEY` and `ORACLE_ADMIN`. Keep both. `ORACLE_KEY` is the only key that writes fixings on the beacon it deploys.
- Mount a volume at `/data` (keeps `oracle.json` and `arkade.sqlite`). A fresh volume means a new beacon; keys, issue, and deploy run again.
- If Traefik shows Bad Gateway, open Logs: exited replicas mean the wrong image or a crash on boot. Confirm the container listens on `8789` and that Advanced → Docker File is not the root desk `Dockerfile`.

### Bootstrap the beacon

Dashboard: open `https://<oracle>/`, paste the admin token, then Save keys → Issue → Deploy. Or curl the same order. Status is always `GET /api/status`.

1. **Generate five source secrets** (local; not env on the server):

```bash
for i in 1 2 3 4 5; do openssl rand -hex 32; done
```

2. **Derive each x-only pubkey** (32-byte hex) from its secret. From the repo root after `pnpm install`:

```bash
node --input-type=module -e '
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
const secret = process.argv[1];
if (!/^[0-9a-fA-F]{64}$/.test(secret)) throw new Error("32-byte hex secret");
console.log(hex.encode(schnorr.getPublicKey(hex.decode(secret))));
' <secret>
```

3. **Register the five pubkeys** (once; locked after deploy):

```bash
curl -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "content-type: application/json" \
  -d '{"pubkeys":["<pk1>","<pk2>","<pk3>","<pk4>","<pk5>"]}' \
  https://<oracle>/api/keys
```

4. **Fund the oracle wallet.** `GET /api/status` returns `wallet` and `balance`. Send Mutinynet sats to `wallet` and wait until `balance` is at least `330` before Issue. An empty wallet returns `{"error":"fund wallet"}` (not a Traefik failure). Keep enough left after issue for the 330-sat beacon coin at deploy.

5. **Issue** the identity asset (supply 1). `issueTxid` is the desk's `BEACON_TXID`:

```bash
curl -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "content-type: application/json" \
  -d '{}' https://<oracle>/api/issue
```

The oracle and desk persist the SDK wallet on SQLite (`DATA_DIR/arkade.sqlite`), never in memory. Issue uses the SDK submit+finalize path. If the process dies after `submitTx` and before `finalizeTx`, the explorer shows an unfinalized spend and `balance` stays `0`. Call recover (or redeploy — boot recovers automatically), then check `/api/status`:

```bash
curl -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "content-type: application/json" \
  -d '{}' https://<oracle>/api/recover
```

6. **Deploy** the unit into the beacon script:

```bash
curl -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "content-type: application/json" \
  -d '{}' https://<oracle>/api/deploy
```

`/api/status` then shows `pubkeys`, `assetId`, `issueTxid` (`BEACON_TXID`), `deployTxid`, and `address` (beacon). Copy `issueTxid` into the desk env.

A Mutinynet test beacon was already issued and settled once with test keys (see `contracts/beacon.md`). A new oracle volume or a new `ORACLE_KEY` issues a new identity asset; do not reuse an old `BEACON_TXID` unless that coin and admin key still match.

### Prints and publish

An oracle print is `sha256(BTCUSD || price_le64 || time_le64)`. The dashboard signs in the browser: the secret is cleared after submit and is never sent to the server. Or post a signed print:

```bash
curl -X POST -H "content-type: application/json" \
  -d '{"pubkey":"<xonly>","price":"<usd-cents>","time":<unix>,"sig":"<64-byte-hex>"}' \
  https://<oracle>/api/prints
```

A fixing needs nine prints: three distinct committee signers in each of the open, mid, and close windows around the expiry. Threshold is 3-of-5, so a solo simulation needs all five secrets available even though only three sign each slice.

After `expiry + 60`, publish:

```bash
curl -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "content-type: application/json" \
  -d '{"expiry":1790463992}' https://<oracle>/api/publish
```

The beacon keeps the eight newest fixings. Settle a vault before eight later expiries are published, or publish its expiry again.

## Desk

Requires a deployed beacon. Set `BEACON_TXID` to the oracle's `issueTxid`.

```bash
pnpm install
export DESK_KEY=$(openssl rand -hex 32)
export BEACON_TXID=<64-hex identity-asset txid from the oracle>
pnpm desk
```

```bash
export DESK_KEY=$(openssl rand -hex 32)
export BEACON_TXID=<64-hex identity-asset txid from the oracle>
docker build -f desk/Dockerfile --build-arg GIT_COMMIT=$(git rev-parse HEAD) -t arkade-options-desk .
docker run --rm -p 8788:8788 -e DESK_KEY -e BEACON_TXID -v desk-data:/data arkade-options-desk
```

Dokploy:

- Build the repository `Dockerfile`.
- Port `8788`.
- Set `DESK_KEY` to a 32-byte hex key and keep it.
- Set `BEACON_TXID` to the 64-hex display txid printed by the oracle (`BEACON_TXID …` on the dashboard, or `issueTxid` in `/api/status`). Required: the desk exits immediately if this is absent or malformed.
- Set `BEACON_GIDX` only if the identity asset is not at vout `0` (optional, default `0`).
- Mount a volume at `/data` (quote book + `arkade.sqlite`).
- Redeploy after a desk change. An older image refuses a pasted address.
- `commit` in `GET /` must change. A cached image can stay on `16d579f`.

`GET /` and `GET /status` return the same JSON: `commit`, `pubkey`, `address`, `balance`, `beaconTxid`, `beaconGidx`.

## Fund the desk

```bash
curl -k https://arkadeoptions-desk-jxdh3j-37969b-138-199-218-130.traefik.me/
```

- Send Mutinynet sats to `address`. That is the float.
- Send enough for premiums, not for the seller's collateral.
- `balance` stays `0` until the coins arrive.
- A quote can go out at `0`. Fill retries when float arrives; until then the desk logs `float short`.
- `beaconTxid` must match the oracle's identity asset. Copy it from the oracle dashboard or `/api/status`.

## Point the page at the desk

Paste `pubkey` from the curl into `app/rfq-config.js`, then push `master`.

```js
export const PINNED_DESKS = [
  { name: "Mutinynet", pubkey: "<pubkey>" },
];
```

Leave `PINNED_DESKS` empty to see Deribit prices in the browser. Selling needs a desk: its quote names the beacon.

## Check

```bash
pnpm test
```
