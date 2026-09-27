# Attestation beacon

A committee-signed registry that a covenant reads by spending it in the same transaction. The option vault is the first consumer. The shape is the LayerZero endpoint from the compiler examples: a verifier coin identified by an asset, consumers that read its packet.

Contracts: `attestation_beacon.ark`, `option_vault.ark`. This document was reviewed against the code once; the review's findings are folded in below and the open ones are listed at the end.

## 1. What an oracle has to give a covenant

A covenant runs inside one transaction. It sees inputs, outputs, packets, and whatever the spender puts on the stack. Anything it cannot verify inside that transaction is trust in the spender. So a price arrives in one of three forms:

1. Signed data on the stack. The covenant verifies signatures against keys baked into its own script. The previous `option_vault.ark` did this: nine `checkSigFromStack` over three slices, five committee keys as constructor parameters. That welds the committee to every vault ever created. Rotating one key leaves every open vault on the old one.
2. A committed value in the covenant's own state. Only for values known at creation.
3. Data on another input of the same transaction, whose provenance the covenant can check. The verification lives in that other coin's script. The consumer answers one question: is this input the oracle?

Form 3 is the endpoint pattern. Two Arkade rules make the provenance check cheap:

- Asset provenance is arkd's job, not a script's. `pkg/ark-lib/asset/tx_validation.go` rejects a reissuance of an asset that has no control asset, derives an issuance id from the transaction that creates it, and requires every asset on a spent input to appear in the packet with its real amount. An asset issued once, uncontrolled, with supply 1 exists as exactly one unit, and every transaction that moves it is one arkd validated against the previous coin's script.
- `tx.inputs[i].packet(type)` reads an extension packet from the transaction that created input `i`. A coin's state is that packet. A covenant that requires the next packet to be a legal successor of the previous one turns the state into a chain.

Identity is an asset unit, state is a packet, and the covenant holding the unit is the only cooperative path that advances the packet. A consumer that finds the unit on an input has found the oracle, whatever script holds it today.

## 2. Design

### Identity

`AttestationBeacon(ctrlTxid, ctrlGidx, signers[5], threshold, domain, keyLag, readFee, adminPk, exit)`. The beacon coin carries one unit of the asset `(ctrlTxid, ctrlGidx)`. The vault commits to `(beaconTxid, beaconGidx)` and to nothing else about the oracle.

The script cannot see the issuance. The desk trusts the asset id it is given (see §4, a second identity unit).

### State

Packet type 32 in the creating transaction. 329 bytes:

| offset | size | field |
| --- | --- | --- |
| 0 | 1 | version, `0x01` |
| 1 | 8 | round, `num2bin(round, 8)` |
| 9 + 40·n | 40 | slot n, n = 0..7, newest first: key `num2bin(key, 8)`, value 32 bytes |

Genesis is round 0 with eight zero slots. For the option vault the key is the expiry and the 32-byte value is `num2bin(twap, 32)`. The vault reads the first 8 bytes, the settlement price in USD cents.

The packet is one stack element. `OP_INSPECTINPUTPACKET` rejects more than 520 bytes, so 9 + 40·n ≤ 520 gives at most 12 slots. Past that the state must become a Merkle root.

### Leaves

`attest(key, price0, time0, who0, sig0, price1, time1, who1, sig1, price2, time2, who2, sig2, opSig)`. Beacon at input 0. Each of the nine prints is `sha256(0x425443555344 || num2bin(price, 8) || num2bin(time, 8))`. That message names no beacon. Three distinct indexes in `0..4` sign each slice. The slices are `[key-1800, key-1740]`, `[key-960, key-900]`, and `[key, key+60]`, with `max(time) - min(time) <= 60`. The stored value is `num2bin(twap, 32)` for `twap = (mOpen*900 + mMid*900 + mClose*60) / 1860`. `key > 1800` and the key is not in any current slot. When `keyLag ≥ 0`, the emulator clock must have reached `key + keyLag`; a price beacon sets 60 so a fixing cannot be published before its settlement minute closes. `adminPk` signs `sha256(ctrlTxid || nextPacket)` and is the only key that writes the slot. The five oracle keys cannot move the coin. The new packet has round + 1, slot 0 = (key, twap), slots 1..7 = old slots 0..6. Output 0 keeps the script, at least the value, and the asset unit.

A key that fell off the eight slots may be attested again. The oracle signatures still verify. The oracle-service signature (`adminPk`, the `ORACLE_KEY` pubkey, not the Arkade Service) covers the whole next packet, so it has to be made again for the new history.

`read(selfIndex)`. `selfIndex` is the beacon's own input index. The current transaction carries a packet equal to the beacon's own. Output 0 keeps the script and the asset unit and gains `readFee` sats. No signature: anyone may read. A read pins nothing else about its transaction: not the number of inputs, not who else is in it.

`migrate(next, sigs[5])`. Beacon at input 0. `threshold` signers sign `sha256(domain + "migrate" + ctrlTxid + num2bin(ctrlGidx, 4) + num2bin(round, 8) + next)`, with `round` read from the current packet, so a migrate signature is good for one state only. Output 0 pays the 32-byte program `next` with the asset unit and at least the value; the packet is carried unchanged. The consumer does not change.

`distinctSigners` requires the ten pairwise inequalities and is called from both `attest` and `migrate`. `quorum`, used by `migrate`, requires `1 ≤ threshold ≤ 5`.

`unilateral(adminSig)` tapscript. `older(exit)` and the admin key.

### Consumer: `OptionVault`

`oracles[5]` is not a parameter. The vault commits to `(beaconTxid, beaconGidx)`. `settle()` takes no witness. It requires the emulator clock at or past `expiry`, itself at input 0, at least two inputs, one unit of the identity asset on input 1, and reads `tx.inputs[1].packet(32)`. The newest slot whose key equals `num2bin(expiry, 8)` gives the price. Payoff and dust folding pay outputs 1 and 2; output 0 belongs to the beacon. An expiry of 0 matches only empty slots, whose price 0 then fails `st > 0`.

`close` and `unilateral` are unchanged.

### Transaction layouts

Attest:

```
in 0  beacon (attest)            out 0  beacon, same script, ≥ 330 sats, 1 unit
                                 out 1  extension: asset packet, state packet, emulator packet
                                 out 2  anchor
```

Settle:

```
in 0  vault (settle)             out 0  beacon, same script, 330 + readFee sats, 1 unit
in 1  beacon (read, selfIndex 1) out 1  holder or writer leg
in 2  fee coin, when readFee > 0 out 2  writer leg, when both legs are above dust
                                 out 3  extension: asset packet, state packet copy, emulator packet with two entries
                                 out 4  anchor
```

### Relation to the LayerZero example

| LayerZero / USDT0 example | here |
| --- | --- |
| Endpoint state coin with control asset | beacon coin with identity asset |
| DVN 2-of-2 over the attested hash | nine oracle prints plus `adminPk` over `sha256(ctrlTxid \|\| next)` |
| OApp reads the marker's previous packet | vault reads the beacon's previous packet |
| Marker minted per message and burned by the consumer | the beacon itself is co-spent and continued |
| DVN config change by the owner | `migrate` by the committee |
| inbound nonce | key |

The beacon is a reusable attestation registry, not a drop-in endpoint. An OApp built on it must carry the message body on its own stack and hash-match it to the 32-byte slot value, keep its own inbound-nonce state for exactly-once consumption (the beacon consumes nothing, so two spends can read one key), and consume each key while it is in a slot. It does not replace the example's marker, which transports the body and burns once. What it gives an OApp is the same thing it gives the vault: the verifier set changes without touching the consumer.

The marker design was not taken here because a marker unit can be re-homed by whoever spends it unless the marker script forbids every spend but a burn inside a known consumer, which pins the consumer's closure hash into the oracle, the coupling this design removes.

## 3. What each layer enforces

Script, `attestation_beacon.ark`:

- Nine oracle signatures over `sha256(BTCUSD || price || time)`, three distinct signers in each slice, the TWAP, and `adminPk` over `sha256(ctrlTxid || next)`. Distinct signers. Round + 1. Key above 1800 and absent from the slots. Clock past `key + keyLag` when enabled. Slot value `num2bin(twap, 32)`. History shift of 280 bytes. Continuation of script, value, and asset unit on output 0. Attest and migrate at input 0. A read carries the packet unchanged and pays `readFee`. `migrate` is still a threshold of the five signers.

Script, `option_vault.ark`:

- Vault at input 0. Identity asset on input 1. Packet version and size. A slot for `expiry`, newest wins. Price in `1..1,000,000,000`. Clock at or past `expiry`. Payoff, dust, output scripts, output values.

arkd, `pkg/ark-lib/asset/tx_validation.go`:

- Every asset on a spent input appears in the packet with the right amount. An uncontrolled asset is never reissued. `assets.lookup` in a script reads the packet's claims; arkd is what ties those claims to real prevouts.

Emulator:

- Runs both covenants of a settle transaction, one per emulator entry. Resolves `tx.inputs[1].packet` from the previous Arkade transaction attached to input 1. Supplies the wall clock for `checkTime`.

## 4. Threats

| attempt | outcome |
| --- | --- |
| Consumer supplies a packet with a different price | blocked: `read` requires `tx.packet(32) == tx.inputs[selfIndex].packet(32)`; the vault reads the input packet anyway. |
| Consumer claims a different asset is the beacon | blocked: vault `tx.inputs[1].assets.lookup(beaconTxid, beaconGidx) == 1`; arkd checks the claim against the prevout. |
| A second identity unit | blocked by arkd only if the issuance was uncontrolled with supply 1. The oracle service issues with `assetManager.issue({ amount: 1n })` and no control asset. The script cannot see the issuance, and the desk trusts `BEACON_TXID` as given. |
| Committee attests the same expiry twice while it is in a slot | blocked: `absent`. |
| A fixing is evicted before a vault settles | recoverable: after it falls off, anyone may re-attest it with the original signatures. A vault has no fallback of its own until then. |
| Fixing published before the settlement minute closes | blocked when `keyLag ≥ 0`: `checkTime(key + keyLag)`. Lateness is not bounded. |
| Consumer attaches a forged previous transaction for input 1 | not blocked by any script. The VM's `OP_INSPECTINPUTPACKET` takes the previous transaction from its fetcher without comparing a hash; the compiler's test harness maps it by outpoint with no check, and a probe against that harness accepted a forged previous transaction. Whether the emulator service binds the attached transaction to the input, through the checkpoint hop, is unverified here. Everything that reads a previous packet, this design and the LayerZero example alike, rests on it. |
| Two settlements race for the beacon | one is rejected and rebuilt on the new outpoint. Bounded, not impossible. |
| Someone reads the beacon to move it | costs `readFee` per read. Bounded, not blocked. Each read also lengthens the beacon's off-chain ancestry, which every payout that read it inherits at exit; the oracle service renews the beacon coin to keep that short. |
| Oracle prints replayed on another beacon | not blocked: the print digest names no beacon. The oracle service's digest names `ctrlTxid` and the next packet, so the write itself does not replay. |
| Old migrate signatures replayed | blocked: the digest names the round. |
| Migrate to a script that lies | threshold of the committee. That is the trust a consumer accepts by committing to the asset id. |
| Layout version bumped while vaults are open | not blocked. An old vault's `settle` fails, `close` needs both parties, and the writer's `unilateral` then takes the whole coin after the CSV. Do not bump the version while vaults bound to the old layout are open. |
| Admin exits the coin to Bitcoin | the unit leaves Arkade. Whether an on-chain unit can re-enter as an asset claim is unverified here. |

Not claimed: committee honesty, committee liveness, hidden prices, settlement without arkd, any bound on how late a fixing is published.

The nine prints are checked again inside `attest`. The oracle service cannot store a TWAP the prints do not support. What stays off-chain is whether those prints match the market.

## 5. Checked

Both contracts compile with `arkadec` from `arkade-os/compiler` at `5786b2f` with no warnings. The artifacts are committed. `AttestationBeacon.attest` has 10 `CHECKSIGFROMSTACK`. `OptionVault.settle` is unchanged: no `CHECKSIGFROMSTACK`, one `INSPECTINASSETLOOKUP`, one `INSPECTINPUTPACKET`.

`pnpm test` covers the state codec, `publishDigest`, the artifacts, the bindings, the deploy outputs, `fixing`, the oracle service, and the layout of the transactions `cospend.ts` builds.

On Mutinynet, 2026-09-26 and 2026-09-27, the oracle service issued the unit (`9b183c62…50e0`), deployed the beacon (`291705fc…36ca`), and published a fixing from nine prints (`2fb520f0…0636`). A covered call then settled against it with the vault at input 0 and the beacon read at input 1 (`ff7dfad4…0206`): holder 600, writer 19,400. The five oracle keys were test keys.

## 6. Implementation

An Arkade transaction's inputs spend checkpoint outputs, not the coins themselves. `tx.input.current.scriptPubKey` and `tx.inputs[i].packet` reach the coin through the previous Arkade transaction attached to the input, which is what the continuation and the packet read rely on. The deploy is not a covenant spend; it goes through the wallet's `buildAndSubmitOffchainTx`.

The desk and the page bind `OptionVault` to the beacon id they are given (`BEACON_TXID` on the desk, `beacon_txid` on the quote). `messages.ts` does not yet refuse expiries off the daily 08:00 UTC grid, so one-off expiries can fill the eight slots.

## 7. Verify before mainnet

- The emulator service binds the attached previous transaction of each input to that input, across the checkpoint hop. Submit a settle with a forged previous transaction to Mutinynet and require rejection.
- Asset claims are rejected on boarding inputs and on any input whose prevout is not an Arkade transaction output.
- An asset-bearing coin survives a batch refresh, and which spend does it. `read` at input 0 is the intended renewal shape. Server key rotation (`deprecatedSigners` in `/v1/info`) needs a `migrate` to a script with the new server key before each cutoff.
- A two-covenant settle with no user-signed input is accepted by `RestEmulatorProvider.submitTx`. The Mutinynet settle had one, the fee coin.
- Operator rate limits on `read`, and the measured exit chain length after N reads.
