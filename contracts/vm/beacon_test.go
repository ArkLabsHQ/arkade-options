package vm

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"testing"
	"time"

	"github.com/arkade-os/arkd/pkg/ark-lib/asset"
	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcutil/psbt"
	"github.com/btcsuite/btcd/chaincfg/chainhash"
	"github.com/btcsuite/btcd/wire"
)

const (
	stateType  = 32
	slotCount  = 8
	expiry     = 1_700_000_000
	strike     = 9_700_000
	collateral = 20_000
	beaconSats = 330
	readFee    = 100
	keyLag     = 60
	priceMax   = 1_000_000_000
)

type slot struct {
	key   uint64
	value []byte
}

func le(v uint64, size int) []byte {
	out := make([]byte, 8)
	binary.LittleEndian.PutUint64(out, v)
	return out[:size]
}

// state lays out the beacon packet: version, round, eight slots newest first.
func state(round uint64, slots ...slot) []byte {
	out := []byte{0x01}
	out = append(out, le(round, 8)...)
	for i := 0; i < slotCount; i++ {
		var s slot
		if i < len(slots) {
			s = slots[i]
		}
		out = append(out, le(s.key, 8)...)
		value := make([]byte, 32)
		copy(value, s.value)
		out = append(out, value...)
	}
	return out
}

// next is the state attest must produce from prev.
func next(prev []byte, key uint64, value []byte) []byte {
	round := binary.LittleEndian.Uint64(prev[1:9])
	out := []byte{0x01}
	out = append(out, le(round+1, 8)...)
	out = append(out, le(key, 8)...)
	v := make([]byte, 32)
	copy(v, value)
	out = append(out, v...)
	out = append(out, prev[9:9+(slotCount-1)*40]...)
	return out
}

func statePacket(data []byte) extension.Packet {
	return extension.UnknownPacket{PacketType: stateType, Data: data}
}

func priceValue(cents uint64) []byte {
	v := make([]byte, 32)
	copy(v, le(cents, 8))
	return v
}

type fixture struct {
	server, emulator *btcec.PrivateKey
	signers          [5]*btcec.PrivateKey
	admin            *btcec.PrivateKey
	writer, holder   *btcec.PrivateKey
	ctrl             asset.AssetId
	domain           []byte
	beaconArt        artifact
	vaultArt         artifact
	writerScript     []byte
	holderScript     []byte
}

func newFixture(t *testing.T) *fixture {
	f := &fixture{
		server:       fixedPrivateKey(1),
		emulator:     fixedPrivateKey(2),
		admin:        fixedPrivateKey(9),
		writer:       fixedPrivateKey(21),
		holder:       fixedPrivateKey(22),
		ctrl:         asset.AssetId{Txid: chainhash.Hash{7}, Index: 0},
		domain:       []byte("BTCUSD-FIX"),
		beaconArt:    loadArtifact(t, "attestation_beacon"),
		vaultArt:     loadArtifact(t, "beacon_option_vault"),
		writerScript: bytes.Repeat([]byte{0x21}, 32),
		holderScript: bytes.Repeat([]byte{0x22}, 32),
	}
	for i := range f.signers {
		f.signers[i] = fixedPrivateKey(byte(11 + i))
	}
	return f
}

func (f *fixture) signerKeys() [5][]byte {
	var out [5][]byte
	for i, k := range f.signers {
		out[i] = xonly(k)
	}
	return out
}

func (f *fixture) beaconValues(t *testing.T, threshold int64, keys [5][]byte) map[string][]byte {
	values := map[string][]byte{
		"ctrlTxid":  f.ctrl.Txid[:],
		"ctrlGidx":  scriptInt(t, int64(f.ctrl.Index)),
		"threshold": scriptInt(t, threshold),
		"domain":    f.domain,
		"keyLag":    scriptInt(t, keyLag),
		"readFee":   scriptInt(t, readFee),
		"adminPk":   xonly(f.admin),
		"exit":      scriptInt(t, 2048),
	}
	for i, k := range keys {
		values[fmt.Sprintf("signers.%d", i)] = k
	}
	return values
}

func (f *fixture) beacon(t *testing.T) *instance {
	return instantiate(t, f.beaconArt, f.beaconValues(t, 3, f.signerKeys()), f.server.PubKey(), f.emulator.PubKey())
}

func (f *fixture) vault(t *testing.T, kind int64) *instance {
	values := map[string][]byte{
		"kind":         scriptInt(t, kind),
		"writerPk":     xonly(f.writer),
		"holderPk":     xonly(f.holder),
		"writerScript": f.writerScript,
		"holderScript": f.holderScript,
		"strike":       scriptInt(t, strike),
		"collateral":   scriptInt(t, collateral),
		"expiry":       scriptInt(t, expiry),
		"beaconTxid":   f.ctrl.Txid[:],
		"beaconGidx":   scriptInt(t, int64(f.ctrl.Index)),
		"exit":         scriptInt(t, 2048),
	}
	return instantiate(t, f.vaultArt, values, f.server.PubKey(), f.emulator.PubKey())
}

func (f *fixture) idBytes() []byte {
	out := append([]byte{}, f.ctrl.Txid[:]...)
	return append(out, le(uint64(f.ctrl.Index), 4)...)
}

func (f *fixture) attestDigest(key uint64, value []byte) []byte {
	msg := append([]byte{}, f.domain...)
	msg = append(msg, f.idBytes()...)
	msg = append(msg, le(key, 8)...)
	msg = append(msg, value...)
	h := sha256.Sum256(msg)
	return h[:]
}

func (f *fixture) migrateDigest(round uint64, nextProgram []byte) []byte {
	msg := append([]byte{}, f.domain...)
	msg = append(msg, []byte("migrate")...)
	msg = append(msg, f.idBytes()...)
	msg = append(msg, le(round, 8)...)
	msg = append(msg, nextProgram...)
	h := sha256.Sum256(msg)
	return h[:]
}

// sigs signs the digest with the first count committee keys; the rest are empty.
func (f *fixture) sigs(t *testing.T, digest []byte, count int) map[string][]byte {
	out := map[string][]byte{}
	for i := 0; i < 5; i++ {
		name := fmt.Sprintf("sigs.%d", i)
		if i < count {
			out[name] = signDigest(t, f.signers[i], digest)
		} else {
			out[name] = []byte{}
		}
	}
	return out
}

func merge(maps ...map[string][]byte) map[string][]byte {
	out := map[string][]byte{}
	for _, m := range maps {
		for k, v := range m {
			out[k] = v
		}
	}
	return out
}

type attestParams struct {
	beacon   *instance
	prev     *wire.MsgTx
	key      uint64
	value    []byte
	sigs     map[string][]byte
	next     []byte // defaults to next(prevState, key, value)
	outputs  []*wire.TxOut
	assetOut uint16
}

// attest builds the attest transaction: beacon at input 0, continuation at output 0.
func (f *fixture) attest(t *testing.T, p attestParams) (*wire.MsgTx, []byte) {
	t.Helper()
	prevState := packetOf(t, p.prev)
	nextState := p.next
	if nextState == nil {
		nextState = next(prevState, p.key, p.value)
	}
	outputs := p.outputs
	if outputs == nil {
		outputs = []*wire.TxOut{{Value: beaconSats, PkScript: p.beacon.pkScript}}
	}
	witness := p.beacon.witness(t, "attest", merge(map[string][]byte{
		"key":   scriptInt(t, int64(p.key)),
		"value": p.value,
	}, p.sigs))
	ptx := buildTx(t,
		[]vmInput{{prev: p.prev, leaf: p.beacon.leaves["attest"], witness: witness}},
		outputs,
		moveUnit(f.ctrl, 0, p.assetOut), statePacket(nextState),
	)
	if err := runVM(ptx, f.emulator.PubKey()); err != nil {
		return nil, nil
	}
	return ptx.UnsignedTx, nextState
}

// packetOf returns the state packet carried by the transaction that created the coin.
func packetOf(t *testing.T, tx *wire.MsgTx) []byte {
	t.Helper()
	ext, err := extension.NewExtensionFromTx(tx)
	if err != nil {
		t.Fatalf("extension: %v", err)
	}
	for _, p := range ext {
		if p.Type() == stateType {
			data, err := p.Serialize()
			if err != nil {
				t.Fatal(err)
			}
			return data
		}
	}
	t.Fatal("state packet missing")
	return nil
}

type settleParams struct {
	vault      *instance
	beacon     *instance
	beaconPrev *wire.MsgTx
	outputs    []*wire.TxOut // payouts, output 1 onward
	beaconOut  int64
	packet     []byte // state packet in the settle tx; defaults to the beacon's own
	unit       asset.Packet
	swap       bool  // beacon at input 0, vault at input 1
	selfIndex  int64 // read witness; -1 means the beacon's real index
	noFee      bool
}

// settle builds the settle transaction: vault, beacon, fee coin; beacon
// continuation at output 0, payouts after it.
func (f *fixture) settle(t *testing.T, p settleParams) *psbt.Packet {
	t.Helper()
	vaultPrev := coinTx(p.vault.pkScript, collateral)
	feePrev := coinTx(p2tr(bytes.Repeat([]byte{0x33}, 32)), readFee)
	beaconOut := p.beaconOut
	if beaconOut == 0 {
		beaconOut = beaconSats + readFee
	}
	packet := p.packet
	if packet == nil {
		packet = packetOf(t, p.beaconPrev)
	}
	beaconIndex := int64(1)
	if p.swap {
		beaconIndex = 0
	}
	selfIndex := p.selfIndex
	if selfIndex == -1 || (selfIndex == 0 && !p.swap) {
		selfIndex = beaconIndex
	}
	unit := p.unit
	if unit == nil {
		unit = moveUnit(f.ctrl, uint16(beaconIndex), 0)
	}
	vaultIn := vmInput{prev: vaultPrev, leaf: p.vault.leaves["settle"]}
	beaconIn := vmInput{prev: p.beaconPrev, leaf: p.beacon.leaves["read"], witness: p.beacon.witness(t, "read", map[string][]byte{"selfIndex": scriptInt(t, selfIndex)})}
	inputs := []vmInput{vaultIn, beaconIn}
	if p.swap {
		inputs = []vmInput{beaconIn, vaultIn}
	}
	if !p.noFee {
		inputs = append(inputs, vmInput{prev: feePrev})
	}
	outputs := append([]*wire.TxOut{{Value: beaconOut, PkScript: p.beacon.pkScript}}, p.outputs...)
	return buildTx(t, inputs, outputs, unit, statePacket(packet))
}

func (f *fixture) split(holder, writer int64) []*wire.TxOut {
	return []*wire.TxOut{
		{Value: holder, PkScript: p2tr(f.holderScript)},
		{Value: writer, PkScript: p2tr(f.writerScript)},
	}
}

func (f *fixture) writerAll() []*wire.TxOut {
	return []*wire.TxOut{{Value: collateral, PkScript: p2tr(f.writerScript)}}
}

func (f *fixture) holderAll() []*wire.TxOut {
	return []*wire.TxOut{{Value: collateral, PkScript: p2tr(f.holderScript)}}
}

// fixedBeacon is a beacon coin whose creating transaction carries the given fixings.
func (f *fixture) fixedBeacon(beacon *instance, round uint64, slots ...slot) *wire.MsgTx {
	return coinTx(beacon.pkScript, beaconSats, statePacket(state(round, slots...)))
}

func TestAttest(t *testing.T) {
	f := newFixture(t)
	beacon := f.beacon(t)
	genesis := coinTx(beacon.pkScript, beaconSats, statePacket(state(0)))
	value := priceValue(10_000_000)
	digest := f.attestDigest(expiry, value)

	base := func() attestParams {
		return attestParams{beacon: beacon, prev: genesis, key: expiry, value: value, sigs: f.sigs(t, digest, 3)}
	}
	run := func(t *testing.T, p attestParams) error {
		t.Helper()
		prevState := packetOf(t, p.prev)
		nextState := p.next
		if nextState == nil {
			nextState = next(prevState, p.key, p.value)
		}
		outputs := p.outputs
		if outputs == nil {
			outputs = []*wire.TxOut{{Value: beaconSats, PkScript: p.beacon.pkScript}}
		}
		witness := p.beacon.witness(t, "attest", merge(map[string][]byte{"key": scriptInt(t, int64(p.key)), "value": p.value}, p.sigs))
		ptx := buildTx(t, []vmInput{{prev: p.prev, leaf: p.beacon.leaves["attest"], witness: witness}}, outputs, moveUnit(f.ctrl, 0, p.assetOut), statePacket(nextState))
		return runVM(ptx, f.emulator.PubKey())
	}
	mustAccept := func(t *testing.T, p attestParams) {
		t.Helper()
		if err := run(t, p); err != nil {
			t.Fatalf("VM rejected: %v", err)
		}
	}
	mustReject := func(t *testing.T, p attestParams) {
		t.Helper()
		if err := run(t, p); err == nil {
			t.Fatal("VM accepted an invalid attest")
		}
	}

	t.Run("three of five", func(t *testing.T) { mustAccept(t, base()) })
	t.Run("five of five", func(t *testing.T) {
		p := base()
		p.sigs = f.sigs(t, digest, 5)
		mustAccept(t, p)
	})
	t.Run("two of five", func(t *testing.T) {
		p := base()
		p.sigs = f.sigs(t, digest, 2)
		mustReject(t, p)
	})
	t.Run("wrong signature aborts even with a quorum", func(t *testing.T) {
		p := base()
		p.sigs = f.sigs(t, digest, 3)
		p.sigs["sigs.3"] = signDigest(t, f.signers[3], f.attestDigest(expiry, priceValue(1)))
		mustReject(t, p)
	})
	t.Run("signature over another beacon's id", func(t *testing.T) {
		other := *f
		other.ctrl = asset.AssetId{Txid: chainhash.Hash{8}, Index: 0}
		p := base()
		p.sigs = f.sigs(t, other.attestDigest(expiry, value), 3)
		mustReject(t, p)
	})
	t.Run("threshold zero", func(t *testing.T) {
		zero := instantiate(t, f.beaconArt, f.beaconValues(t, 0, f.signerKeys()), f.server.PubKey(), f.emulator.PubKey())
		p := base()
		p.beacon = zero
		p.prev = coinTx(zero.pkScript, beaconSats, statePacket(state(0)))
		p.sigs = f.sigs(t, digest, 0)
		mustReject(t, p)
	})
	t.Run("duplicate signer", func(t *testing.T) {
		keys := f.signerKeys()
		keys[1] = keys[0]
		dup := instantiate(t, f.beaconArt, f.beaconValues(t, 3, keys), f.server.PubKey(), f.emulator.PubKey())
		p := base()
		p.beacon = dup
		p.prev = coinTx(dup.pkScript, beaconSats, statePacket(state(0)))
		mustReject(t, p)
	})
	t.Run("key already in a slot", func(t *testing.T) {
		p := base()
		p.prev = f.fixedBeacon(beacon, 1, slot{expiry, value})
		mustReject(t, p)
	})
	t.Run("skipped round", func(t *testing.T) {
		p := base()
		n := next(state(0), expiry, value)
		copy(n[1:9], le(2, 8))
		p.next = n
		mustReject(t, p)
	})
	t.Run("history not shifted", func(t *testing.T) {
		prev := f.fixedBeacon(beacon, 1, slot{expiry - 86_400, priceValue(9_000_000)})
		p := base()
		p.prev = prev
		p.next = state(2, slot{expiry, value})
		mustReject(t, p)
	})
	t.Run("unit not on output 0", func(t *testing.T) {
		p := base()
		p.outputs = []*wire.TxOut{{Value: beaconSats, PkScript: beacon.pkScript}, {Value: beaconSats, PkScript: p2tr(bytes.Repeat([]byte{0x44}, 32))}}
		p.assetOut = 1
		mustReject(t, p)
	})
	t.Run("script changed", func(t *testing.T) {
		p := base()
		p.outputs = []*wire.TxOut{{Value: beaconSats, PkScript: p2tr(bytes.Repeat([]byte{0x44}, 32))}}
		mustReject(t, p)
	})
	t.Run("value shrinks", func(t *testing.T) {
		p := base()
		p.outputs = []*wire.TxOut{{Value: beaconSats - 1, PkScript: beacon.pkScript}}
		mustReject(t, p)
	})
	t.Run("fixing before its time", func(t *testing.T) {
		future := uint64(time.Now().Unix()) + 100_000
		p := base()
		p.key = future
		p.sigs = f.sigs(t, f.attestDigest(future, value), 3)
		mustReject(t, p)
	})
}

func TestEviction(t *testing.T) {
	f := newFixture(t)
	beacon := f.beacon(t)
	prev := coinTx(beacon.pkScript, beaconSats, statePacket(state(0)))
	first := uint64(expiry)
	firstValue := priceValue(10_000_000)
	firstSigs := f.sigs(t, f.attestDigest(first, firstValue), 3)

	for i := uint64(0); i <= slotCount; i++ {
		key := first + i*86_400
		value := priceValue(10_000_000 + i)
		sigs := firstSigs
		if i > 0 {
			sigs = f.sigs(t, f.attestDigest(key, value), 3)
		}
		tx, _ := f.attest(t, attestParams{beacon: beacon, prev: prev, key: key, value: value, sigs: sigs})
		if tx == nil {
			t.Fatalf("attest %d rejected", i)
		}
		prev = tx
	}
	current := packetOf(t, prev)
	for i := 0; i < slotCount; i++ {
		if binary.LittleEndian.Uint64(current[9+40*i:17+40*i]) == first {
			t.Fatal("first key still in a slot after eight newer fixings")
		}
	}
	restored, _ := f.attest(t, attestParams{beacon: beacon, prev: prev, key: first, value: firstValue, sigs: firstSigs})
	if restored == nil {
		t.Fatal("evicted fixing could not be re-attested with the original signatures")
	}
	if binary.LittleEndian.Uint64(packetOf(t, restored)[9:17]) != first {
		t.Fatal("re-attested fixing is not in slot 0")
	}
}

func TestSettle(t *testing.T) {
	f := newFixture(t)
	beacon := f.beacon(t)
	call := f.vault(t, 0)
	put := f.vault(t, 1)
	fixing := func(cents uint64) *wire.MsgTx {
		return f.fixedBeacon(beacon, 1, slot{expiry, priceValue(cents)})
	}
	accepts := func(t *testing.T, p settleParams) {
		t.Helper()
		accept(t, f.settle(t, p), f.emulator.PubKey())
	}
	rejects := func(t *testing.T, p settleParams, vin int) {
		t.Helper()
		reject(t, f.settle(t, p), f.emulator.PubKey(), vin)
	}

	t.Run("call in the money splits 600 and 19400", func(t *testing.T) {
		accepts(t, settleParams{vault: call, beacon: beacon, beaconPrev: fixing(10_000_000), outputs: f.split(600, 19_400)})
	})
	t.Run("holder short by one sat", func(t *testing.T) {
		rejects(t, settleParams{vault: call, beacon: beacon, beaconPrev: fixing(10_000_000), outputs: f.split(599, 19_401)}, 0)
	})
	t.Run("call at the strike pays the writer everything", func(t *testing.T) {
		accepts(t, settleParams{vault: call, beacon: beacon, beaconPrev: fixing(strike), outputs: f.writerAll()})
	})
	t.Run("holder leg of 330 is folded", func(t *testing.T) {
		accepts(t, settleParams{vault: call, beacon: beacon, beaconPrev: fixing(9_862_736), outputs: f.writerAll()})
	})
	t.Run("holder leg of 331 splits", func(t *testing.T) {
		accepts(t, settleParams{vault: call, beacon: beacon, beaconPrev: fixing(9_863_237), outputs: f.split(331, 19_669)})
		rejects(t, settleParams{vault: call, beacon: beacon, beaconPrev: fixing(9_863_237), outputs: f.writerAll()}, 0)
	})
	t.Run("put capped at collateral pays the holder everything", func(t *testing.T) {
		accepts(t, settleParams{vault: put, beacon: beacon, beaconPrev: fixing(4_849_878), outputs: f.holderAll()})
	})
	t.Run("fixing in an older slot", func(t *testing.T) {
		prev := f.fixedBeacon(beacon, 3, slot{expiry + 86_400, priceValue(1)}, slot{expiry + 2*86_400, priceValue(2)}, slot{expiry, priceValue(10_000_000)})
		accepts(t, settleParams{vault: call, beacon: beacon, beaconPrev: prev, outputs: f.split(600, 19_400)})
	})
	t.Run("newest slot wins", func(t *testing.T) {
		prev := f.fixedBeacon(beacon, 2, slot{expiry, priceValue(10_000_000)}, slot{expiry, priceValue(strike)})
		accepts(t, settleParams{vault: call, beacon: beacon, beaconPrev: prev, outputs: f.split(600, 19_400)})
		rejects(t, settleParams{vault: call, beacon: beacon, beaconPrev: prev, outputs: f.writerAll()}, 0)
	})
	t.Run("no fixing for the expiry", func(t *testing.T) {
		prev := f.fixedBeacon(beacon, 1, slot{expiry + 86_400, priceValue(10_000_000)})
		rejects(t, settleParams{vault: call, beacon: beacon, beaconPrev: prev, outputs: f.writerAll()}, 0)
	})
	t.Run("price zero", func(t *testing.T) {
		rejects(t, settleParams{vault: call, beacon: beacon, beaconPrev: fixing(0), outputs: f.writerAll()}, 0)
	})
	t.Run("price above the cap", func(t *testing.T) {
		rejects(t, settleParams{vault: call, beacon: beacon, beaconPrev: fixing(priceMax + 1), outputs: f.holderAll()}, 0)
	})
	t.Run("price at the cap folds the 194-sat writer leg", func(t *testing.T) {
		accepts(t, settleParams{vault: call, beacon: beacon, beaconPrev: fixing(priceMax), outputs: f.holderAll()})
		rejects(t, settleParams{vault: call, beacon: beacon, beaconPrev: fixing(priceMax), outputs: f.split(19_806, 194)}, 0)
	})
	t.Run("forged price in the settle packet", func(t *testing.T) {
		rejects(t, settleParams{vault: call, beacon: beacon, beaconPrev: fixing(10_000_000), outputs: f.split(600, 19_400), packet: state(1, slot{expiry, priceValue(20_000_000)})}, 1)
	})
	t.Run("wrong asset on the beacon input", func(t *testing.T) {
		other := asset.AssetId{Txid: chainhash.Hash{8}, Index: 0}
		rejects(t, settleParams{vault: call, beacon: beacon, beaconPrev: fixing(10_000_000), outputs: f.split(600, 19_400), unit: moveUnit(other, 1, 0)}, 0)
	})
	t.Run("beacon at input 0", func(t *testing.T) {
		rejects(t, settleParams{vault: call, beacon: beacon, beaconPrev: fixing(10_000_000), outputs: f.split(600, 19_400), swap: true, selfIndex: 0}, 1)
	})
	t.Run("read fee short", func(t *testing.T) {
		rejects(t, settleParams{vault: call, beacon: beacon, beaconPrev: fixing(10_000_000), outputs: f.split(600, 19_400), beaconOut: beaconSats + readFee - 1}, 1)
	})
	t.Run("wrong self index", func(t *testing.T) {
		rejects(t, settleParams{vault: call, beacon: beacon, beaconPrev: fixing(10_000_000), outputs: f.split(600, 19_400), selfIndex: 2}, 1)
	})
	t.Run("stale state version", func(t *testing.T) {
		stale := state(1, slot{expiry, priceValue(10_000_000)})
		stale[0] = 0x02
		prev := coinTx(beacon.pkScript, beaconSats, statePacket(stale))
		rejects(t, settleParams{vault: call, beacon: beacon, beaconPrev: prev, outputs: f.split(600, 19_400)}, 0)
	})
}

func TestMigrate(t *testing.T) {
	f := newFixture(t)
	beacon := f.beacon(t)
	current := state(4, slot{expiry, priceValue(10_000_000)})
	prev := coinTx(beacon.pkScript, beaconSats, statePacket(current))
	nextProgram := bytes.Repeat([]byte{0x55}, 32)
	digest := f.migrateDigest(4, nextProgram)

	build := func(t *testing.T, sigs map[string][]byte, outputs []*wire.TxOut, unit asset.Packet) error {
		t.Helper()
		witness := beacon.witness(t, "migrate", merge(map[string][]byte{"next": nextProgram}, sigs))
		ptx := buildTx(t, []vmInput{{prev: prev, leaf: beacon.leaves["migrate"], witness: witness}}, outputs, unit, statePacket(current))
		return runVM(ptx, f.emulator.PubKey())
	}
	continuation := []*wire.TxOut{{Value: beaconSats, PkScript: p2tr(nextProgram)}}

	t.Run("quorum moves the unit to the next program", func(t *testing.T) {
		if err := build(t, f.sigs(t, digest, 3), continuation, moveUnit(f.ctrl, 0, 0)); err != nil {
			t.Fatalf("VM rejected: %v", err)
		}
	})
	t.Run("two of five", func(t *testing.T) {
		if build(t, f.sigs(t, digest, 2), continuation, moveUnit(f.ctrl, 0, 0)) == nil {
			t.Fatal("accepted")
		}
	})
	t.Run("signatures over another round", func(t *testing.T) {
		if build(t, f.sigs(t, f.migrateDigest(3, nextProgram), 3), continuation, moveUnit(f.ctrl, 0, 0)) == nil {
			t.Fatal("accepted")
		}
	})
	t.Run("unit left behind", func(t *testing.T) {
		outputs := []*wire.TxOut{{Value: beaconSats, PkScript: p2tr(nextProgram)}, {Value: beaconSats, PkScript: beacon.pkScript}}
		if build(t, f.sigs(t, digest, 3), outputs, moveUnit(f.ctrl, 0, 1)) == nil {
			t.Fatal("accepted")
		}
	})
	t.Run("wrong next program", func(t *testing.T) {
		outputs := []*wire.TxOut{{Value: beaconSats, PkScript: p2tr(bytes.Repeat([]byte{0x56}, 32))}}
		if build(t, f.sigs(t, digest, 3), outputs, moveUnit(f.ctrl, 0, 0)) == nil {
			t.Fatal("accepted")
		}
	})
}

func TestUnilateral(t *testing.T) {
	f := newFixture(t)
	beacon := f.beacon(t)
	vault := f.vault(t, 0)
	const csv = 2048

	t.Run("beacon admin after the delay", func(t *testing.T) {
		prev := coinTx(beacon.pkScript, beaconSats)
		if err := runTapscript(prev, beacon, "unilateral", csv, []*btcec.PrivateKey{f.admin}); err != nil {
			t.Fatalf("rejected: %v", err)
		}
		if runTapscript(prev, beacon, "unilateral", csv-1, []*btcec.PrivateKey{f.admin}) == nil {
			t.Fatal("accepted before the delay")
		}
		if runTapscript(prev, beacon, "unilateral", csv, []*btcec.PrivateKey{f.signers[0]}) == nil {
			t.Fatal("accepted a committee key")
		}
	})
	t.Run("vault writer after the delay", func(t *testing.T) {
		prev := coinTx(vault.pkScript, collateral)
		if err := runTapscript(prev, vault, "unilateral", csv, []*btcec.PrivateKey{f.writer}); err != nil {
			t.Fatalf("rejected: %v", err)
		}
		if runTapscript(prev, vault, "unilateral", csv, []*btcec.PrivateKey{f.holder}) == nil {
			t.Fatal("accepted the holder")
		}
	})
}
