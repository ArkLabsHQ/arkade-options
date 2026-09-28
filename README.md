# Arkade Options

Cash-settled covered calls and limited puts on Mutinynet. The desk pays the premium. The seller sends collateral to the address on the page.

The live oracle and desk are already issued and deployed. Day-to-day work is funding the desk, signing prints, and publishing a fixing after expiry. A new beacon is a new identity: do that only on a fresh volume. Deploy and bootstrap steps are in [docs/runbook.md](docs/runbook.md).

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

Committee x-only pubkeys, in order. The five source secrets are not on the server.

```
8b839812711b1e8c0f3599d198cf0b1b1156a8632a992523a6f136ec1e31a8d7
40f855e05bb2f95ca83757f8b48016725181385851abbf4b2142ad12ba60fb0b
afd2ad5556dbb7a3485218d4acd86c5ed4a3e5f3c1cbdd7ecf1e26e34c0aa164
07fc9faaf31b49549b3bab719c3837987cd5aec026f93a017bdf8816705963bb
1c37841579dc5cecfe9fdcf43ed2c701b3d634e953a840aadb1a4804ac915e5c
```

`ORACLE_KEY`, `ORACLE_ADMIN`, and `DESK_KEY` live in Dokploy, not on the volume. A redeploy keeps the beacon, the wallet, and the quote book. Replacing a volume, or rotating `ORACLE_KEY`, starts a different beacon.

## Day to day

Oracle status is `GET /api/status`. Desk status is `GET /` (same body as `GET /status`).

```bash
curl -k https://arkadeoptions-oracle-bhuczu-39c492-138-199-218-130.traefik.me/api/status
curl -k https://arkadeoptions-desk-jxdh3j-37969b-138-199-218-130.traefik.me/
```

Oracle `balance` is spendable sats on the admin wallet. The beacon coin itself is separate. Desk `balance` is the float. `beaconTxid` on the desk must stay `76ba2970…da89` until a new beacon is deployed.

Fund the desk at its deposit address. Send enough for premiums. The seller's collateral does not come from this float. `balance` stays `0` until the coins arrive. A quote can go out at `0`; the fill waits and the desk logs `float short`.

An oracle print is `sha256(BTCUSD || price_le64 || time_le64)`. Sign it in the oracle dashboard. The secret stays in the browser. A fixing needs nine prints: three distinct committee signers in the open, mid, and close windows around the expiry. Publish only after `expiry + 60`:

```bash
curl -k -X POST -H "Authorization: Bearer $ORACLE_ADMIN" -H "content-type: application/json" \
  -d '{"expiry":1790463992}' \
  https://arkadeoptions-oracle-bhuczu-39c492-138-199-218-130.traefik.me/api/publish
```

The beacon keeps the eight newest fixings. Settle a vault before eight later expiries are published, or publish that expiry again.

Desk logs: one line per UTC hour, `hour N quotes, N filled, N premium paid, N collateral locked` (sats). A fill still logs immediately with its txid. `DESK_LOG=debug` prints each quote.

## Beacon args

`args` on `/api/status` is the constructor of the live beacon script. These values are fixed at deploy. They are not a fee schedule you can edit.

```json
{
  "ctrlTxid": "89da61e71871b60055380685fb3cd368af6e2b6fc33a6a695fe601767029ba76",
  "threshold": 3,
  "domain": "4254435553442d464958",
  "keyLag": 60,
  "readFee": 100,
  "adminPk": "e96d459a88359d713db09e7b226644b84765ac33b0b84f4cb60bc9d39ffb5bbe",
  "exit": 2048
}
```

| Field | Meaning |
| --- | --- |
| `ctrlTxid` | Identity of the beacon asset, as the script compares it: the display `issueTxid` reversed. The vault checks that input 1 holds one unit of this asset. |
| `threshold` | How many of the five committee keys must sign a `migrate`. Attest is separate: each of the three price slices needs three distinct signers. |
| `domain` | Hex of the ASCII string `BTCUSD-FIX`. It is mixed into the migrate signature so a signature for this beacon cannot authorize a move of another one. Price prints use `BTCUSD`, not this string. |
| `keyLag` | Seconds after the expiry key before `attest` is allowed. `60` means a fixing cannot be published until the close window has ended. |
| `readFee` | On this deployed coin only: 100 sats added to the beacon on every `read`. The contract in this repo no longer has this field. |
| `adminPk` | X-only pubkey of `ORACLE_KEY`. The only key that may write a fixing. It signs `sha256(ctrlTxid \|\| nextPacket)`. |
| `exit` | Seconds the admin must wait before a unilateral exit of the beacon coin to Bitcoin. `2048` is Mutinynet's `unilateralExitDelay`. |

The coin at `76ba2970…da89` was deployed with `readFee` 100. A settlement of that coin still attaches 100 sats, and those sats stay on the beacon. They are not paid to the admin wallet.

The contract in this repo replaced that field with `minValue`. A read copies the price packet and adds nothing. Output 0 must be worth at least the input and at least `minValue`, and `minValue` must be above the 300-sat subdust line. The service sets it to 330, the same as the beacon coin. That script is a different address. Publishing or settling against `76ba2970…da89` with this build will not match the coin. Issue and deploy a new beacon, then point the desk at the new `issueTxid`, before using it.

The status object omits `ctrlGidx` (it is `0`, the `0000` suffix on `assetId`) and the five signers (they are the top-level `pubkeys`).

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
