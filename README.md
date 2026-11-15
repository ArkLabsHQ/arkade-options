# Arkade Options

The contracts are the engine. OptionVault and AttestationBeacon are what an external developer uses.

A pure order book lists both sides and matches two users. This repo's desk is optional. See [contracts/](contracts/).

This repo's desk, RFQ, Friday list, and sell-side page are one deployment on top of the engine. They are not required to use the contracts.

An order book imports `arkade-options/contracts`. It still needs the artifacts, a filled-vault announcement, and a beacon price for the expiry. See [contracts/README.md](contracts/README.md).

Buying is the same vault with the pubkeys swapped. Selling is the path this page implements.

A standing offer is separate from that desk. The writer funds a leg that names the vault and not the holder. A holder funds the other leg with an ordinary send. `buildStandingMatch` spends the two coins. The holder is named on that spend. The desk can fund either leg, and it can still pay the premium on a lone writer intent.

Day-to-day work is funding the desk. The oracle reads DIA and keeps that history. The settler publishes a fixing after expiry and settles the vault. A new beacon is a new identity. Deploy and bootstrap steps are in [docs/runbook.md](docs/runbook.md).

## Live

Traefik serves these domains with its default certificate. `curl` needs `-k`.

| | |
| --- | --- |
| Page | <https://arkade.trade/> |
| Fund flow | <https://arkade.trade/viz/> |
| Oracle | <https://app-input-bluetooth-program-he5gtr-bb8d3b-138-199-218-130.traefik.me/> |
| Desk | <https://app-quantify-cross-platform-bus-bwux4e-31e3a4-138-199-218-130.traefik.me/> |
| Settler | <https://app-back-up-redundant-system-a7rla7-995a33-138-199-218-130.traefik.me/> |
| Oracle volume | `oracle-dia-data` mounted at `/data` (`oracle.json`, `arkade.sqlite`) |
| Desk volume | `desk-dia-data` mounted at `/data` (`book.json`, `arkade.sqlite`) |
| Settler volume | `settler-dia-data` mounted at `/data` (`progress.json`) |

Beacon (Mutinynet). `BEACON_TXID` is the oracle's `issueTxid`. `ctrlTxid` is that same txid with the bytes reversed; the script compares the reversed form.

| | |
| --- | --- |
| `issueTxid` / `BEACON_TXID` | `58db69a7a8a64cd1b16fa7ec4dba2c49a62815d88d0f7a660e216c0206e975c2` |
| `assetId` | `58db69a7a8a64cd1b16fa7ec4dba2c49a62815d88d0f7a660e216c0206e975c20000` |
| `deployTxid` | `a58272ece0ca3b48e92483375e04b91e751f61cc0416c06f64dbbd7dc428aebf` |
| `ctrlTxid` | `c275e906026c210e667a0f8dd81528a6492cba4deca76fb1d14ca6a8a769db58` |
| Beacon address | `tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf849c8k9fmuplslxvex94jqct8d58l229c0jh2seve4ky0n3xy0rjwr978pd` |
| Oracle wallet | `tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf85q9pwqnt6gkk63gqu8kq6hn67g6rxft96nc3tschxa2mrxn8a63d3ltm5j` |
| Admin pubkey | `e96d459a88359d713db09e7b226644b84765ac33b0b84f4cb60bc9d39ffb5bbe` |
| Desk nostr pubkey | `eb36be79b231beeecbea9609767139974137d1f5dbaab56f19396bda3f07edc9` |
| Desk deposit address | `tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf85yqmhrwnt5zuhcr935nk7w7avtt3nf3kvvucn63tmrsx6q7h9x4txm6sw2` |

`ORACLE_KEY`, `ORACLE_ADMIN`, and `DESK_KEY` live in Dokploy, not on the volume. A redeploy keeps the beacon, the wallet, and the quote book. Replacing a volume, or rotating `ORACLE_KEY`, starts a different beacon. The page settles the beacon in this table. `app/src/beacon-status.ts` is a copy of the oracle `GET /api/status`, because the browser does not trust the Traefik certificate. Quotes use the desk nostr pubkey in `app/rfq-config.js`. The earlier beacons `71ae6a54…2802` and `c919606a…499d`, and the coin at `76ba2970…da89`, stay on chain. This table is the DIA beacon.

## Day to day

Oracle status is `GET /api/status`. Desk status is `GET /` (same body as `GET /status`). That body lists live quotes only, one page of 50. Finished quotes are not kept. `GET /quotes?status=live&limit=50&offset=0` is the next page (`status` is `live`, `open`, `filled`, or `all`).

```bash
curl -k https://app-input-bluetooth-program-he5gtr-bb8d3b-138-199-218-130.traefik.me/api/status
curl -k https://app-quantify-cross-platform-bus-bwux4e-31e3a4-138-199-218-130.traefik.me/
```

Oracle `balance` is spendable sats on the admin wallet. The beacon coin itself is separate. Desk `balance` is the float. The desk `BEACON_TXID` is the `issueTxid` in the table above.

Fund the desk at its deposit address. Send enough for premiums. The seller's collateral does not come from this float. `balance` stays `0` until the coins arrive. The desk refuses a quote it cannot pay and logs `float short`.

The publisher reads DIA `OracleUpdate` for `BTC/USD` and keeps that history for 24 hours. `GET /api/prices?from=<unix>&to=<unix>` returns the samples in USD cents. A fixing is the print inside `[expiry, expiry + 60]`. `attest` checks the DIA EIP-712 signature and stores those cents. It writes the fixing after `expiry + 60`. Reading the beacon costs 1,000 sats, above the dust line, paid by the vault:

```bash
curl -k -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "content-type: application/json" \
  -d '{"expiry":1790463992}' \
  https://app-input-bluetooth-program-he5gtr-bb8d3b-138-199-218-130.traefik.me/api/publish
```

The beacon keeps the eight newest fixings. Settle a vault before eight later expiries are published, or publish that expiry again.

The oracle watches the same filled-vault events. On its sample minute, once `expiry + 60` seconds have passed and a sample exists, it publishes that expiry. It does not settle. The settler still spends the vault. Once `expiry + 60` seconds have passed, about once a minute, it asks the oracle to publish that expiry and then spends the vault and the beacon together. A failed publish does not stop the other vaults. `409 already a fixing` is settled only when the slot's price and time are the sample the oracle would have chosen for that expiry. The 1,000-sat read fee comes out of the vault collateral. The settler does not keep a fee wallet and does not call the desk. Set `ORACLE_ADMIN` on the settler so it can publish. Anyone else can run the same process. The first valid spend wins.

A vault txid alone is not enough. The event (or a `POSITIONS` file of the same JSON) also has to carry the contract parameters: kind, strike, expiry, beacon, and the writer and holder keys. The price comes from the beacon coin. Deploy steps, the event fields, and the file are in [docs/runbook.md](docs/runbook.md).

```bash
export ORACLE_URL=https://<oracle>
export ORACLE_ADMIN=<the oracle admin bearer>
pnpm settle
```

Desk logs: one line per UTC hour, `hour N quotes, N filled, N premium paid, N collateral locked` (sats). A fill still logs immediately with its txid. `DESK_LOG=debug` prints each quote.

## Beacon args

`args` on `/api/status` is the constructor of the live beacon script. These values are fixed at deploy. They are not a fee schedule you can edit.

```json
{
  "ctrlTxid": "<issue txid reversed>",
  "domain": "4254435553442d464958",
  "expiryLag": 60,
  "readFee": 1000,
  "adminPk": "<ORACLE_KEY x-only pubkey>",
  "exit": 2048
}
```

| Field | Meaning |
| --- | --- |
| `ctrlTxid` | Identity of the beacon asset, as the script compares it: the display `issueTxid` reversed. The vault checks that input 1 holds one unit of this asset. |
| `domain` | Hex of the ASCII string `BTCUSD-FIX`. It is mixed into the migrate signature. |
| `expiryLag` | Seconds after the expiry before `attest` is allowed. `60` means a fixing waits until the close minute has ended. |
| `readFee` | Sats added to the beacon on every `read`. The service uses `1000`, above the 330-sat dust line. The vault pays it out of its collateral. |
| `adminPk` | X-only pubkey of `ORACLE_KEY`. It signs `migrate` and the unilateral exit. It does not sign prices. The beacon checks the pinned DIA key. |
| `exit` | Seconds the admin must wait before a unilateral exit of the beacon coin to Bitcoin. `2048` is Mutinynet's `unilateralExitDelay`. |

The status object omits `ctrlGidx` (it is `0`, the `0000` suffix on `assetId`).

## Page

```bash
pnpm install
pnpm dev
```

Open <http://127.0.0.1:4173/>. Quotes use `wss://nostr.arkade.sh`. The pinned desk is `app/rfq-config.js`. GitHub Pages publishes `dist/` on every push to `master`.

```bash
docker build -f site.Dockerfile -t arkade-options .
docker run --rm -p 8080:80 arkade-options
```

## Check

```bash
pnpm test
```

Local arkade regtest (Docker, bitcoin regtest + arkd + emulator):

```bash
pnpm smoke:regtest
```

That runs the option the contracts settle. The oracle service issues and deploys the beacon, one intent is finalized, the other is cancelled, the oracle publishes the strike, and the vault settles. It fails unless the beacon is deployed and the strike payout lands. The coins in that run are drawn at [viz/index.html](viz/index.html), also linked from the page as Fund flow. Details are in [docs/runbook.md](docs/runbook.md).
