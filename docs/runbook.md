# Deploy and bootstrap

The live Mutinynet oracle and desk are already up. Identifiers, addresses, and day-to-day steps are in the [README](../README.md). Use this when standing up a new one, or when a volume was replaced.

Order: oracle (five pubkeys, fund, issue, deploy) → desk (`BEACON_TXID`) → fund the desk → pin the desk pubkey on the page.

Never put `ORACLE_KEY`, the five source secrets, `ORACLE_ADMIN`, or `DESK_KEY` in the repo. The five source secrets stay off the server. Only their x-only pubkeys are stored.

## Oracle

The beacon is a 5-signer committee plus one admin key. `ORACLE_KEY` is the admin: it issues the identity asset, deploys the beacon coin, and signs each fixing write. It is never auto-generated.

| Key | Role |
| --- | --- |
| `ORACLE_KEY` | Admin. Wallet, issue, deploy, publish. One 32-byte hex secret. |
| Five source secrets | Sign price prints. Register the five x-only pubkeys once; keep the secrets for the print form. |

Env: `ORACLE_KEY` and `ORACLE_ADMIN` (bearer for admin routes; unset disables them). `ARK_URL` defaults to `https://mutinynet.arkade.sh`. `EMULATOR_URL` defaults to the Mutinynet emulator. `DATA_DIR` holds `oracle.json` and `arkade.sqlite` (SDK wallet, not an in-memory repository). `PORT` defaults to `8789`.

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

The image starts Node with `--experimental-eventsource`. Without that flag the contract watcher polls every 20 seconds.

Dokploy, building `master`:

- Build type Dockerfile. **Docker File** `oracle/Dockerfile`. **Docker Context Path** `/oracle` or `/`. The image clones the repo, so either context works. Do not use the repository-root `./Dockerfile`: that image is the desk (port `8788`) and will 502 behind an oracle domain on `8789`.
- Port `8789` behind the Dokploy HTTPS domain. The dashboard is `GET /`. Browsers only let it sign over HTTPS or localhost.
- Set `ORACLE_KEY` and `ORACLE_ADMIN`. Keep both. `ORACLE_KEY` is the only key that writes fixings on the beacon it deploys.
- Mount a volume at `/data`. The live name is `arkade-options-oracle-data`. A fresh volume means a new beacon; keys, issue, and deploy run again.
- If Traefik shows Bad Gateway, open Logs. Exited replicas mean the wrong image or a crash on boot. Confirm the container listens on `8789`.

### Bootstrap the beacon

Dashboard: open `https://<oracle>/`, paste the admin token, then Save keys → Issue → Deploy. Or curl the same order. Status is `GET /api/status`. The constructor that lands in `args` (`threshold` 3, `keyLag` 60, `minValue` 330, `exit` 2048, domain `BTCUSD-FIX`) is fixed in the service. `minValue` must be above 300. A read adds nothing. It is explained in the README. The beacon already on Mutinynet was deployed with `readFee` 100 and is a different script.

1. **Generate five source secrets** locally. Do not set them as env on the server.

```bash
for i in 1 2 3 4 5; do openssl rand -hex 32; done
```

2. **Derive each x-only pubkey** (32-byte hex). From the repo root after `pnpm install`:

```bash
node --input-type=module -e '
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
const secret = process.argv[1];
if (!/^[0-9a-fA-F]{64}$/.test(secret)) throw new Error("32-byte hex secret");
console.log(hex.encode(schnorr.getPublicKey(hex.decode(secret))));
' <secret>
```

3. **Register the five pubkeys** once. They lock after deploy.

```bash
curl -k -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "content-type: application/json" \
  -d '{"pubkeys":["<pk1>","<pk2>","<pk3>","<pk4>","<pk5>"]}' \
  https://<oracle>/api/keys
```

4. **Fund the oracle wallet.** `GET /api/status` returns `wallet` and `balance`. Send Mutinynet sats to `wallet` and wait until `balance` is at least 330 before Issue. An empty wallet returns `{"error":"fund wallet"}`. Keep enough left after issue for the 330-sat beacon coin at deploy.

5. **Issue** the identity asset (supply 1). `issueTxid` is the desk's `BEACON_TXID`.

```bash
curl -k -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "content-type: application/json" \
  -d '{}' https://<oracle>/api/issue
```

Issue uses the SDK submit-then-finalize path. If the process dies after `submitTx` and before `finalizeTx`, the explorer shows an unfinalized spend and `balance` stays `0`. The SQLite wallet keeps the pending flag. Boot calls finalize, or:

```bash
curl -k -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "content-type: application/json" \
  -d '{}' https://<oracle>/api/recover
```

`finalized` lists what the server still had pending. An empty `finalized` and `pending` means the server no longer has that spend. Fund the wallet again. Do not reuse an old `BEACON_TXID` unless that coin and this `ORACLE_KEY` still match.

6. **Deploy** the unit into the beacon script.

```bash
curl -k -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "content-type: application/json" \
  -d '{}' https://<oracle>/api/deploy
```

`/api/status` then shows `pubkeys`, `assetId`, `issueTxid`, `deployTxid`, `address` (the beacon), and `args`. Copy `issueTxid` into the desk env. `args.ctrlTxid` is that txid reversed.

### Prints and publish

```bash
curl -k -X POST -H "content-type: application/json" \
  -d '{"pubkey":"<xonly>","price":"<usd-cents>","time":<unix>,"sig":"<64-byte-hex>"}' \
  https://<oracle>/api/prints
```

A fixing needs nine prints: three distinct committee signers in each of the open, mid, and close windows. Threshold 3 means a solo simulation still needs all five secrets available, because each slice uses three of them. After `expiry + 60`:

```bash
curl -k -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "content-type: application/json" \
  -d '{"expiry":1790463992}' https://<oracle>/api/publish
```

## Desk

`BEACON_TXID` is the oracle `issueTxid`, 64 hex characters. `BEACON_GIDX` defaults to `0`.

```bash
pnpm install
export DESK_KEY=$(openssl rand -hex 32)
export BEACON_TXID=<64-hex issueTxid>
pnpm desk
```

```bash
export DESK_KEY=$(openssl rand -hex 32)
export BEACON_TXID=<64-hex issueTxid>
docker build -f desk/Dockerfile --build-arg GIT_COMMIT=$(git rev-parse HEAD) -t arkade-options-desk .
docker run --rm -p 8788:8788 -e DESK_KEY -e BEACON_TXID -v desk-data:/data arkade-options-desk
```

Dokploy, building `master`:

- Build the repository-root `Dockerfile`. That image is the desk.
- Port `8788`.
- Set `DESK_KEY` (32-byte hex) and keep it. Set `BEACON_TXID`. The process exits if the txid is missing or not 64 hex characters.
- Set `BEACON_GIDX` only when the identity asset is not at vout `0`.
- Optional: `DESK_STRIKE_CAP` (default 1 BTC), `DESK_TOTAL_CAP` (default 5 BTC), `DESK_VOL` (override the Deribit mark), `DESK_LOG=debug` (print each quote; default is the hourly digest).
- Mount a volume at `/data`. The live name is `arkade-options-desk-data`. It holds `book.json` and `arkade.sqlite`.
- `commit` in `GET /` must match the image you just built.

`GET /` returns `commit`, `pubkey`, `address`, `balance`, `beaconTxid`, `beaconGidx`, and the quote book. Paste `pubkey` into `app/rfq-config.js` and push `master` so the page asks this desk. Leave `PINNED_DESKS` empty to price from Deribit in the browser only.

Fund `address` with Mutinynet sats for premiums. Collateral stays on the seller's side.
