# Mutinynet user test (Dokploy)

Use this after `pnpm smoke:regtest` has passed. This week is one oracle, one beacon, and one desk on Mutinynet. Operate the two services already in the Dokploy project `Arkade-Options`: **Oracle** and **Desk**. Do not add a service.

The public HTTPS origin is the one already on that service (the globe). This repo does not store those origins. `curl` against a Traefik default certificate needs `-k`, as noted in the [README](../README.md).

Never put `ORACLE_KEY`, `ORACLE_ADMIN`, or `DESK_KEY` in the repo.

## What not to change

- Do not add a Dokploy service. Settlement for testers is the existing page, not a third container. `pnpm settle` ([settle/main.ts](../settle/main.ts)) is an operator process, not this project's stack.
- Do not change the image, port, or data path. Oracle is [oracle/Dockerfile](../oracle/Dockerfile) (port `8789`, `DATA_DIR=/data`). Desk on Dokploy is the repository-root [Dockerfile](../Dockerfile) (port `8788`, `DATA_DIR=/data`). That root image is the desk. Do not point the Oracle service at it.
- Do not replace the Oracle volume (`arkade-options-oracle-data` at `/data`) or the Desk volume (`arkade-options-desk-data` at `/data`). Do not rotate `ORACLE_KEY` or `DESK_KEY`. A new volume or a new `ORACLE_KEY` is a different beacon. The identity asset recorded in the README (`76ba2970…da89`) was deployed with the old script; this build will not spend it. Issue a new beacon instead of reusing that txid.
- Do not change `EXIT`, `DUST_SATS`, or `BEACON_READ_FEE` in [protocol/constants.ts](../protocol/constants.ts). There is no env var for them. Do not zero the beacon dust or the read fee. The zeros in [.env.regtest](../.env.regtest) are arkade-regtest intent fees for the smoke stack only. They are not Oracle or Desk settings, and this deploy does not copy them onto Mutinynet.
- Do not point `ARK_URL` at the regtest ports from the smoke test.
- Do not add a price feed. The week's price is `POST /api/samples`, then `POST /api/publish`.
- Do not change the wallet target. The page already uses `https://mutinynet.arkade.money` ([app/src/fund.ts](../app/src/fund.ts), [app/index.html](../app/index.html)).

## Exit delay

Contracts use `EXIT = 2048` seconds ([protocol/constants.ts](../protocol/constants.ts)). BIP68 seconds must be a multiple of 512, and arkd refuses a vtxo whose shortest exit leaf is below `unilateralExitDelay`. The desk calls `assertServerExit` on boot and exits if the server delay is not `2048` ([protocol/contracts.ts](../protocol/contracts.ts), [desk/main.ts](../desk/main.ts)).

The repo does not record a live Mutinynet `/v1/info`. Before issue, open the existing Oracle or Desk service only after this check passes:

```bash
curl -fsS https://mutinynet.arkade.sh/v1/info
```

`network` must be `mutinynet` (the name [protocol/network.ts](../protocol/network.ts) accepts) and `unilateralExitDelay` must be `2048`. If it is not, stop. Do not edit `EXIT` to match the server. The smoke stack forces the same delay with `ARKD_UNILATERAL_EXIT_DELAY=2048` in [.env.regtest](../.env.regtest). That file does not configure the public arkd.

## Environment

Set these on the **existing** service. Defaults below are what the process uses when the variable is unset.

### Oracle service

From [oracle/main.ts](../oracle/main.ts) and [oracle/Dockerfile](../oracle/Dockerfile).

| Env | This week |
| --- | --- |
| `ORACLE_KEY` | Already set. 32-byte hex. Leave it. It is the wallet, the issuer, and the price signer. |
| `ORACLE_ADMIN` | Already set. Bearer for `/api/issue`, `/api/deploy`, `/api/recover`, `/api/samples`, and `/api/publish`. Unset disables those routes. |
| `ARK_URL` | `https://mutinynet.arkade.sh` (the code default). |
| `EMULATOR_URL` | `https://emulator.mutinynet.arkade.sh` (the code default). |
| `SAMPLE_MS` | `0`. Default is `60000`, which stores a Deribit BTCUSD sample every minute ([oracle/price.ts](../oracle/price.ts)). `0` turns that sampler off so the only samples are the ones you post. **Operator choice for this week, not a contract value.** |
| `DATA_DIR` | Leave the image value `/data`. |
| `PORT` | Leave `8789`. |
| `ORACLE_SIGNERS`, `ORACLE_THRESHOLD` | Leave unset. One `ORACLE_KEY` is the signer, threshold 1. |

Build type stays Dockerfile. **Docker File** `oracle/Dockerfile`. **Docker Context Path** `/oracle` or `/`. The image clones the repo, so either context works. Port `8789` behind the domain already on this service. The dashboard is `GET /`.

### Desk service

From [desk/main.ts](../desk/main.ts) and the root [Dockerfile](../Dockerfile).

| Env | This week |
| --- | --- |
| `DESK_KEY` | Already set. 32-byte hex. Leave it. Nostr pubkey and the option holder key. |
| `BEACON_TXID` | The new oracle `issueTxid`, 64 hex characters. The process exits if this is missing or not 64 hex. |
| `BEACON_GIDX` | Leave unset (`0`) unless status shows the identity asset at another vout. |
| `ARK_URL` | `https://mutinynet.arkade.sh`. |
| `EMULATOR_URL` | `https://emulator.mutinynet.arkade.sh`. |
| `RELAYS` | Leave unset. Default is `wss://nostr.arkade.sh`. |
| `DATA_DIR` | Leave `/data`. |
| `PORT` | Leave `8788`. |
| `DESK_STRIKE_CAP`, `DESK_TOTAL_CAP`, `DESK_VOL`, `DESK_LOG` | Leave unset unless you already rely on them. Defaults are 1 BTC per strike, 5 BTC total, Deribit vol, and an hourly log line. |

Build the repository-root `Dockerfile`. Port `8788`. Both Dockerfiles clone `master`, so a redeploy follows GitHub `master`, not a side branch.

`ARK_URL` and `EMULATOR_URL` select the host. The network name comes from arkd `GET /v1/info`. The same two variables are how both services point at Mutinynet.

## Beacon fees

These are fixed in [protocol/constants.ts](../protocol/constants.ts) and copied into the beacon at deploy ([oracle/service.ts](../oracle/service.ts)). They are not a schedule you edit in Dokploy.

| | Value | Where |
| --- | --- | --- |
| Dust on the beacon coin | `330` sats (`DUST_SATS`) | Deploy pays this onto the beacon ([protocol/beacon.ts](../protocol/beacon.ts)). Issue refuses a wallet under 330 sats. |
| Read fee | `1000` sats (`BEACON_READ_FEE`) | `args.readFee`. The vault pays it out of collateral at settle. The regtest smoke test asserts both numbers. |

`GET /api/status` then shows `args.exit` `2048`, `args.readFee` `1000`, `args.keyLag` `60`, and `args.domain` hex of `BTCUSD-FIX`. `keyLag` is 60 seconds in [oracle/service.ts](../oracle/service.ts), not an env var.

## Fund, issue, deploy

Restart the Oracle service after `SAMPLE_MS=0` is set. `GET /api/status` returns `wallet` and `balance`.

1. **Fund the oracle wallet.** Send Mutinynet sats to `wallet`. Issue requires `balance` of at least 330. An empty wallet returns `{"error":"fund wallet"}`. Deploy puts 330 sats on the beacon coin and, when the remainder is at least 330, returns the rest as change. The smoke test funds `Q_MIN` (10_000 sats) so that split can happen. **That 10_000 figure is the smoke-test funding amount, not a Mutinynet fee.**

2. **Issue** the identity asset (supply 1). `issueTxid` is the desk's `BEACON_TXID`.

```bash
curl -k -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "content-type: application/json" \
  -d '{}' https://<oracle>/api/issue
```

`<oracle>` is the existing Oracle service origin. The dashboard at `GET /` can Issue and Deploy with the same admin token.

Issue uses submit-then-finalize. If the process dies after submit and before finalize, `balance` stays `0` and the wallet keeps a pending flag. Boot finalizes, or:

```bash
curl -k -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "content-type: application/json" \
  -d '{}' https://<oracle>/api/recover
```

An empty `finalized` and `pending` means the server no longer has that spend. Fund the wallet again.

3. **Deploy** the unit into the beacon script.

```bash
curl -k -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "content-type: application/json" \
  -d '{}' https://<oracle>/api/deploy
```

Status then includes `assetId`, `issueTxid`, `deployTxid`, `address` (the beacon), and `args`. Copy `issueTxid` into `BEACON_TXID` on the **existing Desk service** and restart it. `GET /` on the desk must show that `beaconTxid`. `commit` must match the image you built. `args.ctrlTxid` is the issue txid reversed.

## Fund the desk

`GET /` returns `address` and `balance`. Send Mutinynet sats to `address`. That float pays premiums. Collateral does not come from it. `balance` stays `0` until the coins are indexed. The desk refuses a quote it cannot pay and logs `float short`. A premium at or below 330 sats is refused (`premium below dust` in [protocol/messages.ts](../protocol/messages.ts)). There is no other desk funding amount in the repo.

Confirm `pubkey` equals the Mutinynet entry in [app/rfq-config.js](../app/rfq-config.js). Leave that file alone when they match. Change it only when `DESK_KEY` changed, then push `master` so GitHub Pages republishes the page.

## Price for the week

No new feed. With `SAMPLE_MS=0`, post one BTCUSD price in integer cents (`"10000000"` is $100,000.00, the shape already used by this API). The server stamps it with its own clock. You do not send a timestamp.

```bash
curl -k -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "content-type: application/json" \
  -d '{"price":"<integer cents>"}' https://<oracle>/api/samples
```

Publish is allowed only after `expiry + 60` (`keyLag`). It uses a sample inside `[expiry, expiry + 60]`, or, if that minute was missed, the latest sample at or before `expiry + 60` ([oracle/service.ts](../oracle/service.ts)). Post before that window ends. If the Deribit sampler is left on, a later automatic sample inside the window replaces an earlier manual one. That is why this week sets `SAMPLE_MS=0`.

`<expiry>` is the unix expiry on the filled position, not a new clock.

```bash
curl -k -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "content-type: application/json" \
  -d '{"expiry":<unix expiry>}' https://<oracle>/api/publish
```

`GET /api/status` lists `fixings`. The beacon keeps eight slots. Settle before eight newer fixings replace this expiry, or publish it again. History is `GET /api/prices?from=<unix>&to=<unix>`.

## Testers

Testers use the existing page ([README](../README.md) records <https://arkade.trade/>). Quotes go to `wss://nostr.arkade.sh`. **Open Arkade wallet** and the "get one" link both go to `https://mutinynet.arkade.money`. The page talks to Mutinynet arkd at the same default `ARK_URL` and `EMULATOR_URL` as the services ([app/src/fund.ts](../app/src/fund.ts)).

The seller pays collateral to the intent address the page shows. The desk pays the premium to the seller's Mutinynet address. Who supplies testers with Mutinynet sats is not in this repo.

Page settlement reads a baked copy of oracle status in [app/src/beacon-status.ts](../app/src/beacon-status.ts), not a live `GET /api/status`. After the new beacon is deployed, replace that object with the new status (`issueTxid`, `assetId`, `address`, `pubkeys`, `args`) and push `master`. Until that ships, **Settle** answers that the option is on a different beacon. Do not change the wallet URL in the same edit.

## Checks

Use one small option. Collateral must be at least `Q_MIN` (10_000 sats). Pick an expiry inside the week so you can wait it out. The fill deadline is the quote's deadline, which is not the expiry.

**Fill.** On the page, take a quote from the pinned desk and send the collateral to the intent address before the deadline. The desk finalizes. The page shows the position filled. `GET /` on the desk includes that quote with a `fillTxid` while it is still live (finished quotes are not kept). A fill also logs a txid. `GET /quotes?status=filled` is the filled page.

**Cancel.** Fund an intent and let the deadline pass without a fill. The page marks it expired and shows **Refund** when the coin is still unspent ([protocol/intent-state.ts](../protocol/intent-state.ts)). Refund spends `cancel` back to the seller. The button is not a fill. Cancel before the deadline is **Cancel trade**, which drops the row only while the intent is still open.

**Settle.** Wait until the position expiry. Post the sample if you have not, then `POST /api/publish` with that expiry after `expiry + 60`. On the page, **Settle** appears once the position is filled and expiry has passed ([app/desk.js](../app/desk.js)). A settled row stores a settle txid. "The oracle has not published this expiry yet" means publish did not land. "This option is on a different beacon" means [app/src/beacon-status.ts](../app/src/beacon-status.ts) is still the previous coin. The 1,000-sat read fee comes out of the vault collateral. The settler does not need a fee wallet.

`scripts/e2e-mutinynet.ts` (`pnpm e2e`) is the scripted Mutinynet fill and cancel against `BEACON_TXID`. It is not the tester path, and its default keys are not the Dokploy `DESK_KEY`.

## Local regtest

The smoke test is the gate before this deploy, not a second production stack. From this repo, with Docker running:

```bash
pnpm smoke:regtest
```

[.env.regtest](../.env.regtest) sets `ARKD_UNILATERAL_EXIT_DELAY=2048` and zero intent fees, then starts bitcoin regtest, arkd, and the emulator. The test issues, deploys, fills one intent, cancels the other, publishes the strike, and settles. `ARK_URL` and `EMULATOR_URL` override the endpoints (defaults `http://127.0.0.1:7070` and `http://127.0.0.1:7073`). Leave those overrides off the Dokploy services.
