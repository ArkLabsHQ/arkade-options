# Deploy and bootstrap

The live Mutinynet oracle and desk are already up. Identifiers, addresses, and day-to-day steps are in the [README](../README.md). Use this when standing up a new one, or when a volume was replaced.

Order: oracle (fund, issue, deploy) → desk (`BEACON_TXID`) → fund the desk → pin the desk pubkey on the page → settler. The app provider runs the settler. Anyone else can run another one against the same vaults.

Never put `ORACLE_KEY`, `ORACLE_ADMIN`, or `DESK_KEY` in the repo.

## Oracle

`ORACLE_KEY` is the only key. It issues the identity asset, deploys the beacon coin, signs each BTCUSD sample, and publishes fixings. It is never auto-generated.

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

Dashboard: open `https://<oracle>/`, paste the admin token, then Issue → Deploy. Or curl the same order. Status is `GET /api/status`. The constructor in `args` (`keyLag` 60, `readFee` 1000, `exit` 2048, domain `BTCUSD-FIX`) is fixed in the service. `ORACLE_KEY` signs prices. No committee keys. The beacon already on Mutinynet is the old script. Issue a new one and point the desk at its `issueTxid`.

1. **Fund the oracle wallet.** `GET /api/status` returns `wallet` and `balance`. Send Mutinynet sats to `wallet` and wait until `balance` is at least 330 before Issue. An empty wallet returns `{"error":"fund wallet"}`. Keep enough left after issue for the 330-sat beacon coin at deploy.

2. **Issue** the identity asset (supply 1). `issueTxid` is the desk's `BEACON_TXID`.

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

3. **Deploy** the unit into the beacon script.

```bash
curl -k -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "content-type: application/json" \
  -d '{}' https://<oracle>/api/deploy
```

`/api/status` then shows `assetId`, `issueTxid`, `deployTxid`, `address` (the beacon), and `args`. Copy `issueTxid` into the desk env. `args.ctrlTxid` is that txid reversed.

### Prices and publish

The process samples Deribit BTCUSD about once a minute and stores the signature. History is public:

```bash
curl -k "https://<oracle>/api/prices?from=<unix>&to=<unix>"
```

A manual sample, if the feed is down, is one price at the current time. The server signs it:

```bash
curl -k -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "content-type: application/json" \
  -d '{"price":"10000000"}' https://<oracle>/api/samples
```

After `expiry + 60` the settler calls publish, or you can:

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

`GET /` returns `commit`, `pubkey`, `address`, `balance`, `beaconTxid`, `beaconGidx`, and the quote book. Paste `pubkey` into `app/rfq-config.js` and push `master` so the page asks this desk. Leave `PINNED_DESKS` empty to price from Deribit in the browser only. A filled vault is also a public event on nostr.arkade.sh, which is what a settler reads.

Fund `address` with Mutinynet sats for premiums. Collateral stays on the seller's side.

## Settler

The app provider runs this next to the oracle and the desk. An independent party runs the same process, with its own volume and its own key, and can settle the same contracts. `OptionVault.settle` is anyone-can-spend after expiry. The first valid spend wins. The other settler sees the vault already spent, records that txid, and stops.

The settler does not use `DESK_KEY`, `book.json`, the desk float, or a desk URL. The RFQ stays a sealed ephemeral message to the client. A third party cannot open it, and the relay does not keep it.

When a fill lands, the desk publishes the vault in the clear on `wss://nostr.arkade.sh`:

| | |
| --- | --- |
| Kind | `30078` (NIP-78, replaceable) |
| Tags | `t` = `arkade-option`, `d` = the rfq id |
| Signer | The desk holder key, the same key as `holder_pubkey` |

That event is the fill txid plus the contract parameters. Catching it is enough to settle with no further input. This is the path the provider's process uses, and the path any other process uses by subscribing to the same relay.

A vault txid on its own is not enough. The indexer coin is an amount and a tweaked taproot key. The spending leaf, which holds the terms, is not on the unspent coin. The fill transaction reveals the intent, not the vault. Settlement has to rebuild `OptionVault` with the same constructor, or the tweaked key will not match the coin.

The event carries:

| Field | Role |
| --- | --- |
| `fill_txid` | Transaction that created the vault output |
| `kind` | `0` covered call, `1` limited put |
| `strike` | USD cents |
| `expiry` | Unix time the vault may settle. Not the intent's fill deadline |
| `collateral` | Sats locked in the vault |
| `exit` | Exit delay, `2048` on Mutinynet |
| `writer_pubkey`, `writer_pk_script` | Seller key and the script the seller is paid to |
| `holder_pubkey` | Desk key. Must match the event signer |
| `beacon_txid`, `beacon_gidx` | Oracle identity asset |
| `vault_address` | Checked by rebuilding the contract. A mismatch is skipped |

The price is not in the event. The settler reads it from the beacon coin, the same state packet `OptionVault.settle` reads. The beacon script (signers, `readFee`, address) comes from the oracle `GET /api/status`.

### Run one

```bash
export ORACLE_URL=https://<oracle>
pnpm settle
```

```bash
docker build -f settle/Dockerfile -t arkade-options-settle .
docker run --rm -p 8790:8790 -e ORACLE_URL -e ORACLE_ADMIN -v settle-data:/data arkade-options-settle
```

Dokploy, building `master`:

- Docker File `settle/Dockerfile`. Docker Context Path `/` or `/settle`. The image clones the repo, so either context works.
- Port `8790`.
- Set `ORACLE_URL` to the oracle origin and `ORACLE_ADMIN` to the same bearer the oracle uses. Do not set `DESK_KEY`.
- Mount a volume at `/data`. Name it `arkade-options-settle-data`. It holds `progress.json` for this process only: events already seen, and vaults it has progressed. It does not write the desk book.
- The read fee is 1,000 sats, above dust, and comes out of the vault. The settler does not hold a key.
- `RELAYS` defaults to `wss://nostr.arkade.sh`. Leave it unset unless the desks publish somewhere else.
- `GET /status` returns `commit`, `oracle`, `relay`, `watching`, and `settled`.

One beacon coin settles one vault per pass. The next vault is the following tick, about two seconds later. A vault with no fixing yet does not block a later expiry. Settle before eight newer fixings replace that expiry on the beacon, or publish the expiry again.

### Hand it a vault

Same process. `POSITIONS` is a JSON file of the same records the event carries. The relay subscription stays on. Use the file when you already have the txid and the parameters and do not want to wait for the event. One object, an array, or `{ "positions": [ ... ] }` all work. Incomplete rows are skipped. The vault address is still checked before a spend.

```bash
export ORACLE_URL=https://<oracle>
export POSITIONS=./vaults.json
pnpm settle
```

```json
{
  "v": 1,
  "type": "option_position",
  "rfq_id": "<64-hex>",
  "pair": "arkade:BTC->arkade:BTC-OPTION",
  "kind": 0,
  "collateral": "20000",
  "strike": "9700000",
  "expiry": 1790463992,
  "exit": 2048,
  "writer_pubkey": "<32-byte hex>",
  "writer_pk_script": "<34-byte script hex>",
  "holder_pubkey": "<32-byte hex>",
  "beacon_txid": "<64-hex display txid>",
  "beacon_gidx": 0,
  "vault_address": "tark1...",
  "fill_txid": "<64-hex>"
}
```
