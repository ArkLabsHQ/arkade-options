package vm

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcutil/psbt"
)

// The transactions protocol/cospend.ts builds, written by scripts/beacon-fixture.mjs.
type fixtureFile struct {
	EmulatorKey string `json:"emulatorKey"`
	Settle      string `json:"settle"`
	Attest      string `json:"attest"`
}

func loadFixture(t *testing.T) (fixtureFile, *btcec.PublicKey) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "settle.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var file fixtureFile
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	keyBytes, err := hex.DecodeString(file.EmulatorKey)
	if err != nil {
		t.Fatalf("emulator key: %v", err)
	}
	key, err := btcec.ParsePubKey(keyBytes)
	if err != nil {
		t.Fatalf("emulator key: %v", err)
	}
	return file, key
}

func parsePSBT(t *testing.T, encoded string) *psbt.Packet {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("base64: %v", err)
	}
	ptx, err := psbt.NewFromRawBytes(bytes.NewReader(raw), false)
	if err != nil {
		t.Fatalf("psbt: %v", err)
	}
	return ptx
}

// The SDK-built settle spends the vault at input 0, the beacon at input 1 and a
// fee coin at input 2; output 0 continues the beacon with the fee added, the
// payouts follow, then the extension and the anchor.
func TestSdkBuiltSettle(t *testing.T) {
	file, emulatorKey := loadFixture(t)
	ptx := parsePSBT(t, file.Settle)
	tx := ptx.UnsignedTx
	if len(tx.TxIn) != 3 {
		t.Fatalf("inputs: %d", len(tx.TxIn))
	}
	if len(tx.TxOut) != 5 {
		t.Fatalf("outputs: %d", len(tx.TxOut))
	}
	if tx.TxOut[0].Value != beaconSats+readFee {
		t.Fatalf("beacon continuation carries %d sats", tx.TxOut[0].Value)
	}
	if tx.TxOut[1].Value != 600 || tx.TxOut[2].Value != 19_400 {
		t.Fatalf("payouts %d and %d", tx.TxOut[1].Value, tx.TxOut[2].Value)
	}
	if !bytes.Equal(tx.TxOut[4].PkScript, anchorScript) {
		t.Fatal("anchor is not last")
	}
	ext, err := extension.NewExtensionFromTx(tx)
	if err != nil {
		t.Fatalf("extension: %v", err)
	}
	if ext.GetAssetPacket() == nil {
		t.Fatal("asset packet missing")
	}
	if len(packetOf(t, tx)) != 329 {
		t.Fatal("state packet missing")
	}
	accept(t, ptx, emulatorKey)
}

func TestSdkBuiltAttest(t *testing.T) {
	file, emulatorKey := loadFixture(t)
	ptx := parsePSBT(t, file.Attest)
	if len(ptx.UnsignedTx.TxIn) != 1 {
		t.Fatalf("inputs: %d", len(ptx.UnsignedTx.TxIn))
	}
	accept(t, ptx, emulatorKey)
}
