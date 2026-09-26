# Attestation beacon

A committee-signed registry that a covenant reads by spending it in the same transaction. The option vault is the first consumer. The pattern is the LayerZero endpoint shape, so a USDT0 endpoint can reuse it.

Contracts: `attestation_beacon.ark`, `beacon_option_vault.ark`. Read at the commit that adds this file.

## 1. What an oracle has to give a covenant

A covenant runs inside one transaction. It sees inputs, outputs, packets, and whatever the spender puts on the stack. Anything it cannot verify inside that transaction is trust in the spender. So a price must arrive in one of three forms:

1. Signed data on the stack. The covenant verifies signatures against keys baked into its own script. This is what `option_vault.ark` does: nine `checkSigFromStack` over three slices, five committee keys as constructor parameters. It works, and it welds the committee to every vault ever created. Rotating one key means every open vault keeps the old one.
2. A committed value in the covenant's own state. Only useful for values known at creation.
3. Data on another input of the same transaction, whose provenance the covenant can check. Then the verification lives in that other coin's script, and the consumer only has to answer one question: is this input the oracle?

Form 3 is the endpoint pattern. Arkade gives two tools that make the provenance check cheap:

- Asset provenance is enforced by arkd, not by any script. `asset.ValidateAssetTransaction` rejects a reissuance of an asset that has no control asset, and an issuance derives its id from the transaction that creates it. An asset issued once with supply 1 and no control asset exists as exactly one unit, forever, and every transaction that moves it is one that arkd validated against the previous coin's script.
- `tx.inputs[i].packet(type)` reads an extension packet from the transaction that created input `i`. A coin's state is the packet of its creating transaction. A covenant that requires the next packet to be a legal successor of the previous one makes that state a chain.

So: identity is an asset unit, state is a packet, and the covenant that holds the unit is the only thing that can advance the packet. A consumer that finds the unit on an input has found the oracle, whatever script currently holds it.

## 2. Design

### Identity

`AttestationBeacon(ctrlTxid, ctrlGidx, signers[5], threshold, domain, adminPk, exit)`. The beacon coin carries one unit of the asset `(ctrlTxid, ctrlGidx)`. That asset is issued once, uncontrolled, supply 1. The vault commits to `(beaconTxid, beaconGidx)` and nothing else about the oracle.

### State

Packet type 32 in the creating transaction. 169 bytes:

| offset | size | field |
| --- | --- | --- |
| 0 | 1 | version, `0x01` |
| 1 | 8 | round, `num2bin(round, 8)` |
| 9 | 40 | slot 0, newest: key `num2bin(key, 8)`, value 32 bytes |
| 49 | 40 | slot 1 |
| 89 | 40 | slot 2 |
| 129 | 40 | slot 3 |

Genesis is round 0 with four zero slots. For the option vault the key is the expiry and the first 8 bytes of the value are the settlement price in USD cents.

### Leaves

`attest(key, value, sigs[5])`. Beacon at input 0. `threshold` of the five signers sign `sha256(domain + num2bin(key, 8) + value)`. An absent signer passes an empty signature. A wrong non-empty signature fails the script (`OP_CHECKSIGFROMSTACK` returns false only for the empty vector). The new packet has round + 1, slot 0 = (key, value), slots 1..3 = old slots 0..2, and `key` is greater than the old slot 0 key, so a key is attested once in a lineage. Output 0 keeps the script, the value, and the asset unit.

`read()`. Beacon at input 1. The current transaction carries a packet equal to the beacon's own. Output 0 keeps the script, the value, and the asset unit. No signature: anyone may read.

`migrate(next, sigs[5])`. Beacon at input 0. `threshold` signers sign `sha256(domain + "migrate" + next)`. Output 0 pays the 32-byte program `next` with the asset unit and the value, and the packet is carried unchanged. This is the upgrade path. The consumer does not change.

`unilateral(adminSig)` tapscript. `older(exit)` and the admin key.

### Consumer: `BeaconOptionVault`

Same parameters as `OptionVault` with `oracles[5]` replaced by `(beaconTxid, beaconGidx)`. `settle()` takes no witness. It requires the emulator clock to have reached `expiry`, itself at input 0, exactly two inputs, one unit of the identity asset on input 1, and reads `tx.inputs[1].packet(32)`. The slot whose key equals `num2bin(expiry, 8)` gives the price. Payoff and dust folding are unchanged from `option_vault.ark`. Output 0 belongs to the beacon; payouts move to outputs 1 and 2.

`close` and `unilateral` are unchanged.

### Transaction layouts

Attest:

```
in 0  beacon (attest)            out 0  beacon, same script, 330 sats, 1 unit
                                 out 1  extension: asset packet, state packet, emulator packet
                                 out 2  anchor
```

Settle:

```
in 0  vault (settle)             out 0  beacon, same script, 330 sats, 1 unit
in 1  beacon (read)              out 1  holder or writer leg
                                 out 2  writer leg, when both legs are above dust
                                 out 3  extension: asset packet, state packet copy, emulator packet with two entries
                                 out 4  anchor
```

### LayerZero mapping

| LayerZero / USDT0 example | here |
| --- | --- |
| Endpoint state coin with control asset | beacon coin with identity asset |
| DVN 2-of-2 over the attested hash | threshold-of-5 over `sha256(domain + key + value)` |
| OApp reads the marker's previous packet | vault reads the beacon's previous packet |
| Marker minted per message and burned by the consumer | the beacon itself is co-spent and continued |
| DVN config change by the owner | `migrate` by the committee |
| inbound nonce | key, strictly increasing |

The marker design was not taken. A marker is an asset unit on a fresh coin. Whoever spends it can re-home the unit to a coin whose creating transaction carries any packet, unless the marker script forbids every spend but a burn inside a known consumer. That pins the consumer's closure hash into the marker, which is the coupling this design removes. Co-spending the singleton has one cost: two settlements cannot spend the same beacon coin. The loser rebuilds on the new outpoint.

For USDT0, key = inbound nonce and value = the 32-byte attested hash of the LzReceive header. The OApp reads the beacon the same way the vault does.

## 3. What each layer enforces

Script, `attestation_beacon.ark`:

- Quorum over the exact message. Round + 1. Key strictly increasing. Slot shift by 40 bytes. Version and size. Continuation of script, value, and asset unit on output 0. Position: attest and migrate at input 0, read at input 1. A read carries the packet unchanged.

Script, `beacon_option_vault.ark`:

- Two inputs. Vault at input 0. Identity asset on input 1. Packet version and size. A slot for `expiry`. Price in `1..1,000,000,000`. Clock at or after `expiry`. Payoff, dust, output scripts, output values.

arkd, `pkg/ark-lib/asset/tx_validation.go`:

- Every asset on a spent input appears in the packet with the right amount. An uncontrolled asset is never reissued. Output indexes point at real outputs.

Emulator:

- Runs both covenants of a settle transaction, one per emulator entry. Resolves `tx.inputs[1].packet` from the previous Arkade transaction attached to input 1. Supplies the clock for `checkTime`.

## 4. Threats

| attempt | blocked by |
| --- | --- |
| Consumer supplies a packet with a different price | `read`: `tx.packet(32) == tx.inputs[1].packet(32)`. The vault reads the input packet anyway. |
| Consumer claims a different asset is the beacon | vault: `tx.inputs[1].assets.lookup(beaconTxid, beaconGidx) == 1`; arkd checks the packet against the real prevout. |
| Someone mints a second identity unit | arkd: no control asset, so no reissuance. |
| Committee attests the same expiry twice with another price | `attest`: key strictly increasing. |
| Fixing published before expiry | committee behaviour. The vault adds `checkTime(expiry)`, so settlement waits, but an early fixing is not blocked by script. Not claimed. |
| Old beacon coin replayed | a spent coin is spent. The unit is on the newest coin only. |
| Two settlements race for the beacon | one is rejected by the operator, rebuilt on the new outpoint. Bounded, not impossible. |
| Reader spams `read` | same as above. Each read preserves the coin. |
| Migrate to a script that lies | threshold of the committee. That is the trust the consumer accepted by committing to the asset id. |
| Genesis packet forged by the deployer | the consumer must check the genesis transaction once when it binds the asset id: round 0, empty slots, known script. Off-chain check. |
| Emulator given a wrong previous transaction for input 1 | assumed: the emulator binds the attached previous transaction to the outpoint hash. The LayerZero example depends on the same assumption. Verify against the emulator before mainnet. |

Not claimed: committee honesty, committee liveness, hidden prices, settlement without the operator. Unilateral exit moves the unit to Bitcoin, where no covenant reads it.

## 5. Proven so far

Both contracts compile with `arkadec` at `5786b2f` (the option example commit) with no warnings. `settle` is 369 tokens; the nine-signature `OptionVault.settle` is about 1,700.

Run in the real Arkade VM (`github.com/arkade-os/emulator/pkg/arkade`) through the compiler's e2e harness:

- attest with 3 of 5 signatures accepted; 2 of 5 rejected.
- settle transaction with the vault at input 0 and the beacon at input 1, price 10,000,000 cents, strike 9,700,000, collateral 20,000: accepted with holder 600 and writer 19,400 at outputs 1 and 2, beacon continued at output 0.
- same transaction with a different price in the state packet: rejected by the beacon's `read`.
- same transaction with a different asset id on input 1: rejected by the vault.

## 6. Implementation

Files:

- `contracts/attestation_beacon.ark`, `contracts/attestation_beacon.artifact.json`
- `contracts/beacon_option_vault.ark`, `contracts/beacon_option_vault.artifact.json`
- `protocol/beacon.ts`: packet codec (`genesisState`, `nextState`, `decodeState`, `findFixing`), message digests (`attestDigest`, `migrateDigest`), `priceValue`, `bindBeacon`, `bindBeaconVault`, both through `secondsExit` in `protocol/programs.ts`.
- `protocol/cospend.ts`: build a two-covenant Arkade transaction: inputs with their leaf scripts, outputs, asset packet, state packet, emulator packet with one entry per covenant input, anchor, previous transactions on both inputs. `settleWithBeacon`, `attestBeacon`, `migrateBeacon`. Submit through `emulator.submitTx`.
- `contracts/vm/`: Go module. Reads the committed artifacts. Instantiates every leaf into one taproot tree per contract. Runs the VM on: genesis → attest → settle for the fixture prints (600/19,400 split, writer takes all at the strike, holder leg 330 folded, 331 split, put cap), and every row of the threat table that a script blocks. Runs the unilateral tapscripts.
- `protocol/beacon.test.ts`: codec round trips, slot search offsets equal the script constants, digests, artifacts load, asm counts, addresses, and the shape of the transactions `cospend.ts` builds, parsed back with `Extension`.
- `package.json`: `test` adds `protocol/beacon.test.ts`; `test:vm` runs `go test ./contracts/vm/...`.
- `.github/workflows/contracts.yml`: `pnpm test` and `test:vm` on push and pull request.

Out of scope for this change: issuing the identity asset on Mutinynet, running the committee, and moving the desk and the page from `OptionVault` to `BeaconOptionVault`. The existing contracts stay in place.

## 7. Decisions open to review

- Four slots. Enough for four expiries in flight per beacon. More slots cost 40 bytes each and one more comparison in every consumer.
- Five signers with a threshold parameter. Matches the current committee size.
- A 32-byte value. Prices use 8 bytes of it. The attested hash of a message uses all 32.
- `settle` requires exactly two inputs. Batch settlement is a later shape.
- `read` is permissionless. Reads preserve the coin; the cost is contention.
- `migrate` carries the packet unchanged. A new script with a new layout would bump the version byte and old vaults would fail closed and use `close`.
