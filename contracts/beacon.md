# Attestation beacon

A committee-signed registry that a covenant reads by spending it in the same transaction. The option vault is the first consumer. The shape is the LayerZero endpoint from the compiler examples: a verifier coin identified by an asset, consumers that read its packet.

Contracts: `attestation_beacon.ark`, `beacon_option_vault.ark`. This document was reviewed against the code once; the review's findings are folded in below and the open ones are listed at the end.

## 1. What an oracle has to give a covenant

A covenant runs inside one transaction. It sees inputs, outputs, packets, and whatever the spender puts on the stack. Anything it cannot verify inside that transaction is trust in the spender. So a price arrives in one of three forms:

1. Signed data on the stack. The covenant verifies signatures against keys baked into its own script. `option_vault.ark` does this: nine `checkSigFromStack` over three slices, five committee keys as constructor parameters. It welds the committee to every vault ever created. Rotating one key leaves every open vault on the old one.
2. A committed value in the covenant's own state. Only for values known at creation.
3. Data on another input of the same transaction, whose provenance the covenant can check. The verification lives in that other coin's script. The consumer answers one question: is this input the oracle?

Form 3 is the endpoint pattern. Two Arkade rules make the provenance check cheap:

- Asset provenance is arkd's job, not a script's. `pkg/ark-lib/asset/tx_validation.go` rejects a reissuance of an asset that has no control asset, derives an issuance id from the transaction that creates it, and requires every asset on a spent input to appear in the packet with its real amount. An asset issued once, uncontrolled, with supply 1 exists as exactly one unit, and every transaction that moves it is one arkd validated against the previous coin's script.
- `tx.inputs[i].packet(type)` reads an extension packet from the transaction that created input `i`. A coin's state is that packet. A covenant that requires the next packet to be a legal successor of the previous one turns the state into a chain.

Identity is an asset unit, state is a packet, and the covenant holding the unit is the only cooperative path that advances the packet. A consumer that finds the unit on an input has found the oracle, whatever script holds it today.

## 2. Design

### Identity

`AttestationBeacon(ctrlTxid, ctrlGidx, signers[5], threshold, domain, keyLag, readFee, adminPk, exit)`. The beacon coin carries one unit of the asset `(ctrlTxid, ctrlGidx)`. The vault commits to `(beaconTxid, beaconGidx)` and to nothing else about the oracle.

The script cannot see the issuance. A consumer must check it once, when it binds the asset id (see §4, genesis).

### State

Packet type 32 in the creating transaction. 329 bytes:

| offset | size | field |
| --- | --- | --- |
| 0 | 1 | version, `0x01` |
| 1 | 8 | round, `num2bin(round, 8)` |
| 9 + 40·n | 40 | slot n, n = 0..7, newest first: key `num2bin(key, 8)`, value 32 bytes |

Genesis is round 0 with eight zero slots. For the option vault the key is the expiry and the first 8 bytes of the value are the settlement price in USD cents; the remaining 24 bytes hold the first 24 bytes of `sha256` over the committee's evidence (the signed prints the fixing was computed from), published off-chain beside every attest.

The packet is one stack element. `OP_INSPECTINPUTPACKET` rejects more than 520 bytes, so 9 + 40·n ≤ 520 gives at most 12 slots. Past that the state must become a Merkle root.

### Leaves

`attest(key, value, sigs[5])`. Beacon at input 0. `threshold` of the five signers sign `sha256(domain + ctrlTxid + num2bin(ctrlGidx, 4) + num2bin(key, 8) + value)`. An absent signer passes an empty signature; a wrong non-empty signature fails the script, because `OP_CHECKSIGFROMSTACK` returns false only for the empty vector. `key` is positive and is not in any current slot. When `keyLag ≥ 0`, the emulator clock must have reached `key + keyLag`; a price beacon sets 60 so a fixing cannot be published before its settlement minute closes, and a nonce beacon sets −1. The new packet has round + 1, slot 0 = (key, value), slots 1..7 = old slots 0..6. Output 0 keeps the script, at least the value, and the asset unit.

A key that fell off the eight slots may be attested again. The original signatures still verify, so anyone who kept them can restore an evicted fixing without the committee.

`read(selfIndex)`. `selfIndex` is the beacon's own input index. The current transaction carries a packet equal to the beacon's own. Output 0 keeps the script and the asset unit and gains `readFee` sats. No signature: anyone may read. A read pins nothing else about its transaction: not the number of inputs, not who else is in it.

`migrate(next, sigs[5])`. Beacon at input 0. `threshold` signers sign `sha256(domain + "migrate" + ctrlTxid + num2bin(ctrlGidx, 4) + num2bin(round, 8) + next)`, with `round` read from the current packet, so a migrate signature is good for one state only. Output 0 pays the 32-byte program `next` with the asset unit and at least the value; the packet is carried unchanged. The consumer does not change.

`quorum` also requires `1 ≤ threshold ≤ 5` and five distinct signers on every attest and migrate.

`unilateral(adminSig)` tapscript. `older(exit)` and the admin key.

### Consumer: `BeaconOptionVault`

Same parameters as `OptionVault` with `oracles[5]` replaced by `(beaconTxid, beaconGidx)`. `settle()` takes no witness. It requires the emulator clock at or past `expiry`, itself at input 0, at least two inputs, one unit of the identity asset on input 1, and reads `tx.inputs[1].packet(32)`. The newest slot whose key equals `num2bin(expiry, 8)` gives the price. Payoff and dust folding are the lines of `option_vault.ark` with the output indices moved up by one: output 0 belongs to the beacon, payouts are outputs 1 and 2. The old `expiry > 1800` check is gone; an expiry of 0 matches only empty slots, whose price 0 then fails `st > 0`.

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
| DVN 2-of-2 over the attested hash | threshold-of-5 over `sha256(domain + id + key + value)` |
| OApp reads the marker's previous packet | vault reads the beacon's previous packet |
| Marker minted per message and burned by the consumer | the beacon itself is co-spent and continued |
| DVN config change by the owner | `migrate` by the committee |
| inbound nonce | key |

The beacon is a reusable attestation registry, not a drop-in endpoint. An OApp built on it must carry the message body on its own stack and hash-match it to the 32-byte slot value, keep its own inbound-nonce state for exactly-once consumption (the beacon consumes nothing, so two spends can read one key), and consume each key while it is in a slot. It does not replace the example's marker, which transports the body and burns once. What it gives an OApp is the same thing it gives the vault: the verifier set changes without touching the consumer.

The marker design was not taken here because a marker unit can be re-homed by whoever spends it unless the marker script forbids every spend but a burn inside a known consumer, which pins the consumer's closure hash into the oracle, the coupling this design removes.

## 3. What each layer enforces

Script, `attestation_beacon.ark`:

- Quorum over the exact message, threshold in 1..5, distinct signers. Round + 1. Key positive and absent from the slots. Clock past `key + keyLag` when enabled. Slot shift by 40 bytes; every byte of the next packet is pinned. Continuation of script, value, and asset unit on output 0. Attest and migrate at input 0. A read carries the packet unchanged and pays `readFee`.

Script, `beacon_option_vault.ark`:

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
| A second identity unit | blocked by arkd only if the issuance was uncontrolled with supply 1. The script cannot see the issuance. The binder must check the genesis transaction: issuance group at `ctrlGidx` with no control asset, output sum exactly 1, that output paying the beacon script, state packet version 1 with round 0 and eight zero slots, `1 ≤ threshold ≤ 5`, five distinct signers. |
| Committee attests the same expiry twice while it is in a slot | blocked: `absent`. |
| A fixing is evicted before a vault settles | recoverable: after it falls off, anyone may re-attest it with the original signatures. A vault has no fallback of its own until then. |
| Fixing published before the settlement minute closes | blocked when `keyLag ≥ 0`: `checkTime(key + keyLag)`. Lateness is not bounded. |
| Consumer attaches a forged previous transaction for input 1 | not blocked by any script. The VM's `OP_INSPECTINPUTPACKET` takes the previous transaction from its fetcher without comparing a hash; the compiler's test harness maps it by outpoint with no check, and a probe against that harness accepted a forged previous transaction. Whether the emulator service binds the attached transaction to the input, through the checkpoint hop, is unverified here. Everything that reads a previous packet, this design and the LayerZero example alike, rests on it. |
| Two settlements race for the beacon | one is rejected and rebuilt on the new outpoint. Bounded, not impossible. |
| Someone reads the beacon to move it | costs `readFee` per read. Bounded, not blocked. Each read also lengthens the beacon's off-chain ancestry, which every payout that read it inherits at exit; the operator refreshes the beacon coin to keep that short. |
| Signatures replayed on another beacon with the same committee and domain | blocked: the digest names `(ctrlTxid, ctrlGidx)`. |
| Old migrate signatures replayed | blocked: the digest names the round. |
| Migrate to a script that lies | threshold of the committee. That is the trust a consumer accepts by committing to the asset id. |
| Layout version bumped while vaults are open | not blocked. An old vault's `settle` fails, `close` needs both parties, and the writer's `unilateral` then takes the whole coin after the CSV. Do not bump the version while vaults bound to the old layout are open. |
| Admin exits the coin to Bitcoin | the unit leaves Arkade. Whether an on-chain unit can re-enter as an asset claim is unverified here. |

Not claimed: committee honesty, committee liveness, hidden prices, settlement without the operator, any bound on how late a fixing is published.

What moved off-chain: `option_vault.ark` verified nine signed prints from three distinct oracles per slice, with the observation times inside the slices. Here the committee signs one number and the evidence hash beside it. The script no longer proves how the number was made.

## 5. Proven

Both contracts compile with `arkadec` from `arkade-os/compiler` at `5786b2f` with no warnings. `settle` is 550 tokens; `OptionVault.settle` is about 1,650.

`contracts/vm` runs the committed artifacts in the real Arkade VM (`github.com/arkade-os/emulator/pkg/arkade`), every leaf in one taproot tree per contract, `pnpm test:vm`:

- attest: 3 of 5 and 5 of 5 accepted; 2 of 5, a wrong non-empty signature beside a quorum, signatures over another beacon's id, threshold 0, a duplicated signer, a key already in a slot, a skipped round, an unshifted history, the unit left off output 0, a changed script, a shrunk value, and a fixing before `key + keyLag` all rejected.
- eviction: nine fixings push the first off the eight slots; the first is re-attested with its original signatures.
- settle, vault at input 0, beacon at input 1, fee coin at input 2: 600/19,400 at price 10,000,000; writer takes all at the strike; holder leg 330 folded, 331 split; put capped to the whole coin; price at the cap folds a 194-sat writer leg; a fixing in an older slot is found; the newest of two equal keys wins. Rejected: holder short by one sat, no slot for the expiry, price 0, price above the cap, a forged price in the settle packet (by the beacon), a wrong asset on input 1 (by the vault), the beacon at input 0, a read fee short by one sat, a wrong `selfIndex`, a stale version byte.
- migrate: quorum accepted with the unit on the next program; 2 of 5, signatures over another round, the unit left behind, and a wrong next program rejected.
- both unilateral tapscripts: the right key after the delay accepted; before the delay or with another key rejected.
- the settle and attest transactions that `protocol/cospend.ts` builds through the SDK, with checkpoints and previous transactions attached, are accepted by the same VM (`contracts/vm/testdata/settle.json`, regenerated by `pnpm beacon:fixture`).

`pnpm test` covers the codec, the digests, the artifacts, the bindings, `verifyGenesis`, and the transaction layout.

Not run here: anything against the emulator service or arkd. See §7.

## 6. Implementation

- `contracts/attestation_beacon.ark`, `contracts/beacon_option_vault.ark` and their `*.artifact.json`.
- `protocol/beacon.ts`: state codec (`genesisState`, `nextState`, `decodeState`, `findFixing`), `priceValue`, `attestDigest`, `migrateDigest`, `beaconIdOf` (the script compares the display txid reversed), `verifyGenesis` (the §4 checklist), `bindBeacon`, `bindBeaconVault`. Programs load through `secondsExit` in `protocol/programs.ts`.
- `protocol/cospend.ts`: Arkade transactions with more than one covenant input. One checkpoint per input through `buildOffchainTx`, one emulator entry per covenant, the previous transaction on every input, one extension with the asset packet, the state packet and the emulator packet ahead of the anchor. `buildSettle`, `buildAttest`, `buildMigrate`, `submit`. The SDK's builder and `attachExtension` are single-covenant and private; everything else is exported.
- `contracts/vm/`: the Go harness and the scenarios above. `protocol/beacon.test.ts`: the Node tests. `.github/workflows/contracts.yml` runs both.

One detail the harness makes visible: an Arkade transaction's inputs spend checkpoint outputs, not the coins themselves. `tx.input.current.scriptPubKey` and `tx.inputs[i].packet` therefore reach the coin through the previous Arkade transaction attached to the input, which is what the continuation and the packet read rely on.

Out of scope for this change: issuing the identity asset on Mutinynet, running the committee, and moving the desk and the page from `OptionVault` to `BeaconOptionVault`. The existing contracts stay in place. Before that cutover, `messages.ts` must refuse expiries off the daily 08:00 UTC grid the page produces, or the eight slots fill with one-off expiries.

## 7. Verify before mainnet

- The emulator service binds the attached previous transaction of each input to that input, across the checkpoint hop. Submit a settle with a forged previous transaction to Mutinynet and require rejection.
- Asset claims are rejected on boarding inputs and on any input whose prevout is not an Arkade transaction output.
- An asset-bearing coin survives a batch refresh, and which spend does it. `read` at input 0 is the intended renewal shape. Server key rotation (`deprecatedSigners` in `/v1/info`) needs a `migrate` to a script with the new server key before each cutoff.
- A two-covenant transaction with no user signature is accepted by `RestEmulatorProvider.submitTx`.
- Operator rate limits on `read`, and the measured exit chain length after N reads.
