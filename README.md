# Arkade Options

Cash-settled covered calls and limited puts on Mutinynet. The desk pays the premium. The seller sends collateral to the address on the page.

Day-to-day work is funding the desk. The oracle signs BTCUSD itself and keeps the history. The settler publishes a fixing after expiry and settles the vault. A new beacon is a new identity. Deploy and bootstrap steps are in [docs/runbook.md](docs/runbook.md).

## Live

Traefik serves these domains with its default certificate. `curl` needs `-k`.

| | |
| --- | --- |
| Page | <https://arkade.trade/> |
| Fund flow | <https://arkade.trade/viz/> |
| Oracle | <https://arkadeoptions-oracle-bhuczu-39c492-138-199-218-130.traefik.me/> |
| Desk | <https://arkadeoptions-desk-jxdh3j-37969b-138-199-218-130.traefik.me/> |
| Oracle volume | `arkade-options-oracle-data` mounted at `/data` (`oracle.json`, `arkade.sqlite`) |
| Desk volume | `arkade-options-desk-data` mounted at `/data` (`book.json`, `arkade.sqlite`) |

Beacon (Mutinynet). `BEACON_TXID` is the oracle's `issueTxid`. `ctrlTxid` is that same txid with the bytes reversed; the script compares the reversed form.

| | |
| --- | --- |
| `issueTxid` / `BEACON_TXID` | `76ba29707601e65f696a3ac36f2b6eaf68d33cfb8506385500b67118e761da89` |
| `assetId` | `76ba29707601e65f696a3ac36f2b6eaf68d33cfb8506385500b67118e761da890000` |
| `deployTxid` | `e7a1c7a30ed54992617a96b5617ad11cfaf6699bb00a8a9c772d25769a96973b` |
| `ctrlTxid` | `89da61e71871b60055380685fb3cd368af6e2b6fc33a6a695fe601767029ba76` |
| Beacon address | `tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf85kzzx3q8kt4h9krw7w36wz6yxucn2pzrts4c0tty5nzgth9nj39y2v8p8v` |
| Oracle wallet | `tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf85q9pwqnt6gkk63gqu8kq6hn67g6rxft96nc3tschxa2mrxn8a63d3ltm5j` |
| Admin pubkey | `e96d459a88359d713db09e7b226644b84765ac33b0b84f4cb60bc9d39ffb5bbe` |
| Desk nostr pubkey | `eb36be79b231beeecbea9609767139974137d1f5dbaab56f19396bda3f07edc9` |
| Desk deposit address | `tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf85yqmhrwnt5zuhcr935nk7w7avtt3nf3kvvucn63tmrsx6q7h9x4txm6sw2` |

`ORACLE_KEY`, `ORACLE_ADMIN`, and `DESK_KEY` live in Dokploy, not on the volume. A redeploy keeps the beacon, the wallet, and the quote book. Replacing a volume, or rotating `ORACLE_KEY`, starts a different beacon. The coin at `76ba2970…da89` was deployed with the old five-key script. This build will not spend it. Issue and deploy a new beacon, then point the desk at that `issueTxid`.

## Day to day

Oracle status is `GET /api/status`. Desk status is `GET /` (same body as `GET /status`). That body lists live quotes only, one page of 50. Finished quotes are not kept. `GET /quotes?status=live&limit=50&offset=0` is the next page (`status` is `live`, `open`, `filled`, or `all`).

```bash
curl -k https://arkadeoptions-oracle-bhuczu-39c492-138-199-218-130.traefik.me/api/status
curl -k https://arkadeoptions-desk-jxdh3j-37969b-138-199-218-130.traefik.me/
```

Oracle `balance` is spendable sats on the admin wallet. The beacon coin itself is separate. Desk `balance` is the float. After the new beacon is deployed, set the desk `BEACON_TXID` to that `issueTxid`.

Fund the desk at its deposit address. Send enough for premiums. The seller's collateral does not come from this float. `balance` stays `0` until the coins arrive. The desk refuses a quote it cannot pay and logs `float short`.

The aggregator holds one to five oracle keys (`ORACLE_SIGNERS`, or just `ORACLE_KEY` when testing with one). Every minute it signs a BTCUSD sample with each of them and keeps those signatures for 24 hours. `GET /api/prices?from=<unix>&to=<unix>` returns that history, signatures included, so anyone can use them. A fixing is the sample inside `[expiry, expiry + 60]`, or, if that minute was missed, the latest sample at or before `expiry + 60`. The aggregator writes that fixing in one beacon transaction after `expiry + 60`. Reading the beacon costs 1,000 sats, above the dust line, paid by the vault:

```bash
curl -k -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "content-type: application/json" \
  -d '{"expiry":1790463992}' \
  https://arkadeoptions-oracle-bhuczu-39c492-138-199-218-130.traefik.me/api/publish
```

The beacon keeps the eight newest fixings. Settle a vault before eight later expiries are published, or publish that expiry again.

The settler watches filled vaults on nostr.arkade.sh. Once an option has expired it asks the oracle to publish the stored price, then spends the vault and the beacon together. The 1,000-sat read fee comes out of the vault collateral. The settler does not keep a fee wallet and does not call the desk. Set `ORACLE_ADMIN` on the settler so it can publish. Anyone else can run the same process. The first valid spend wins.

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
  "keyLag": 60,
  "readFee": 1000,
  "adminPk": "<ORACLE_KEY x-only pubkey>",
  "exit": 2048
}
```

| Field | Meaning |
| --- | --- |
| `ctrlTxid` | Identity of the beacon asset, as the script compares it: the display `issueTxid` reversed. The vault checks that input 1 holds one unit of this asset. |
| `domain` | Hex of the ASCII string `BTCUSD-FIX`. It is mixed into the migrate signature. |
| `keyLag` | Seconds after the expiry before `attest` is allowed. `60` means a fixing waits until the close minute has ended. |
| `readFee` | Sats added to the beacon on every `read`. The service uses `1000`, above the 330-sat dust line. The vault pays it out of its collateral. |
| `adminPk` | X-only pubkey of `ORACLE_KEY`. It signs `sha256(ctrlTxid \|\| BTCUSD \|\| price \|\| time)`. |
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

That command is the options flow: fund an intent, finalize it into a vault, and cancel a second intent. It fails if those coins do not land. Details are in [docs/runbook.md](docs/runbook.md).
