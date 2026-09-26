package vm

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/arkade-os/arkd/pkg/ark-lib/asset"
	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
	"github.com/arkade-os/arkd/pkg/ark-lib/txutils"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	"github.com/btcsuite/btcd/btcutil/psbt"
	"github.com/btcsuite/btcd/txscript"
	"github.com/btcsuite/btcd/wire"
)

// The committed compiler artifacts, one directory up.

type artifact struct {
	Name              string          `json:"contractName"`
	Structs           []structDef     `json:"structs"`
	ConstructorInputs []abiInput      `json:"constructorInputs"`
	Functions         []functionGroup `json:"functions"`
}

type structDef struct {
	Name   string     `json:"name"`
	Fields []abiInput `json:"fields"`
}

type abiInput struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

type functionGroup struct {
	Name   string     `json:"name"`
	Arkade *assembly  `json:"arkade"`
	Leaves []leafSpec `json:"leaves"`
}

type assembly struct {
	Inputs []abiInput `json:"inputs"`
	ASM    []string   `json:"asm"`
}

type leafSpec struct {
	Name string   `json:"name"`
	ASM  []string `json:"asm"`
}

func loadArtifact(t *testing.T, name string) artifact {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", name+".artifact.json"))
	if err != nil {
		t.Fatalf("read artifact: %v", err)
	}
	var art artifact
	if err := json.Unmarshal(data, &art); err != nil {
		t.Fatalf("decode artifact: %v", err)
	}
	return art
}

// A leaf of an instantiated contract. covenant is nil for a pure tapscript.
type leaf struct {
	covenant []byte
	script   []byte
	tapLeaf  *psbt.TaprootTapLeafScript
}

// One taproot tree holding every leaf of the contract, as arkd sees it.
type instance struct {
	art      artifact
	pkScript []byte
	leaves   map[string]*leaf
}

var internalKey = fixedPublicKey(3)

func instantiate(t *testing.T, art artifact, values map[string][]byte, serverKey, emulatorKey *btcec.PublicKey) *instance {
	t.Helper()
	inst := &instance{art: art, leaves: map[string]*leaf{}}
	var order []string
	var scripts [][]byte
	for _, group := range art.Functions {
		for _, spec := range group.Leaves {
			leafValues := map[string][]byte{}
			for k, v := range values {
				leafValues[k] = v
			}
			leafValues["SERVER_KEY"] = schnorr.SerializePubKey(serverKey)
			item := &leaf{}
			if group.Arkade != nil && spec.Name == group.Name {
				item.covenant = assemble(t, group.Arkade.ASM, values)
				leafValues["EMULATOR_KEY:"+group.Name] = schnorr.SerializePubKey(
					arkade.ComputeArkadeScriptPublicKey(emulatorKey, arkade.ArkadeScriptHash(item.covenant)),
				)
			}
			item.script = assemble(t, spec.ASM, leafValues)
			inst.leaves[spec.Name] = item
			order = append(order, spec.Name)
			scripts = append(scripts, item.script)
		}
	}
	tapLeaves := make([]txscript.TapLeaf, len(scripts))
	for i, script := range scripts {
		tapLeaves[i] = txscript.NewBaseTapLeaf(script)
	}
	tree := txscript.AssembleTaprootScriptTree(tapLeaves...)
	root := tree.RootNode.TapHash()
	outputKey := txscript.ComputeTaprootOutputKey(internalKey, root[:])
	pkScript, err := txscript.PayToTaprootScript(outputKey)
	if err != nil {
		t.Fatalf("taproot output: %v", err)
	}
	inst.pkScript = pkScript
	for i, name := range order {
		control := tree.LeafMerkleProofs[i].ToControlBlock(internalKey)
		controlBytes, err := control.ToBytes()
		if err != nil {
			t.Fatalf("control block: %v", err)
		}
		inst.leaves[name].tapLeaf = &psbt.TaprootTapLeafScript{
			ControlBlock: controlBytes,
			Script:       inst.leaves[name].script,
			LeafVersion:  txscript.BaseLeafVersion,
		}
	}
	return inst
}

func (inst *instance) group(t *testing.T, name string) *functionGroup {
	t.Helper()
	for i := range inst.art.Functions {
		if inst.art.Functions[i].Name == name {
			return &inst.art.Functions[i]
		}
	}
	t.Fatalf("%s.%s not found", inst.art.Name, name)
	return nil
}

// witness lays the covenant inputs out the way the artifact documents: reverse
// declaration order, arrays and structs expanded to their scalar leaves.
func (inst *instance) witness(t *testing.T, name string, values map[string][]byte) wire.TxWitness {
	t.Helper()
	group := inst.group(t, name)
	if group.Arkade == nil {
		return nil
	}
	var out wire.TxWitness
	for i := len(group.Arkade.Inputs) - 1; i >= 0; i-- {
		names := flatten(group.Arkade.Inputs[i].Name, group.Arkade.Inputs[i].Type, inst.art.Structs)
		slices.Reverse(names)
		for _, item := range names {
			value, ok := values[item]
			if !ok {
				t.Fatalf("missing witness value %q", item)
			}
			out = append(out, value)
		}
	}
	return out
}

func flatten(name, typeName string, structs []structDef) []string {
	switch typeName {
	case "AssetId":
		return []string{name + ".txid", name + ".gidx"}
	case "Outpoint":
		return []string{name + ".txid", name + ".vout"}
	case "ECPoint":
		return []string{name + ".x", name + ".y"}
	}
	for _, def := range structs {
		if def.Name != typeName {
			continue
		}
		var names []string
		for _, field := range def.Fields {
			names = append(names, flatten(name+"."+field.Name, field.Type, structs)...)
		}
		return names
	}
	open := strings.IndexByte(typeName, '[')
	if open < 0 || !strings.HasSuffix(typeName, "]") {
		return []string{name}
	}
	length, err := strconv.Atoi(typeName[open+1 : len(typeName)-1])
	if err != nil || length <= 0 {
		return []string{name}
	}
	names := make([]string, 0, length)
	for i := range length {
		names = append(names, fmt.Sprintf("%s.%d", name, i))
	}
	return names
}

func assemble(t *testing.T, tokens []string, values map[string][]byte) []byte {
	t.Helper()
	builder := txscript.NewScriptBuilder()
	for i, token := range tokens {
		if opcode, ok := arkade.OpcodeByName[token]; ok {
			builder.AddOp(opcode)
			continue
		}
		var data []byte
		switch {
		case strings.HasPrefix(token, "<") && strings.HasSuffix(token, ">"):
			value, ok := values[token[1:len(token)-1]]
			if !ok {
				t.Fatalf("token %d: unresolved %s", i, token)
			}
			data = value
		case strings.HasPrefix(token, "0x"):
			decoded, err := hex.DecodeString(token[2:])
			if err != nil {
				t.Fatalf("token %d: %v", i, err)
			}
			data = decoded
		default:
			number, err := strconv.ParseInt(token, 10, 64)
			if err != nil {
				t.Fatalf("token %d: unsupported %q", i, token)
			}
			builder.AddInt64(number)
			continue
		}
		if len(data) == 1 && data[0] == 0 {
			builder.AddOps([]byte{txscript.OP_DATA_1, 0})
		} else {
			builder.AddData(data)
		}
	}
	script, err := builder.Script()
	if err != nil {
		t.Fatalf("assemble: %v", err)
	}
	return script
}

// A transaction input for the VM: the coin, the leaf it is spent through (nil
// for a plain coin), and the covenant witness.
type vmInput struct {
	prev    *wire.MsgTx
	vout    uint32
	leaf    *leaf
	witness wire.TxWitness
}

var anchorScript = []byte{0x51, 0x02, 0x4e, 0x73}

// buildTx assembles an Arkade transaction: value outputs, the extension with
// the given packets and one emulator entry per covenant input, then the anchor.
func buildTx(t *testing.T, inputs []vmInput, outputs []*wire.TxOut, packets ...extension.Packet) *psbt.Packet {
	t.Helper()
	tx := wire.NewMsgTx(3)
	var entries []arkade.EmulatorEntry
	for i, in := range inputs {
		tx.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Hash: in.prev.TxHash(), Index: in.vout}})
		if in.leaf != nil && in.leaf.covenant != nil {
			entries = append(entries, arkade.EmulatorEntry{Vin: uint16(i), Script: in.leaf.covenant, Witness: in.witness})
		}
	}
	for _, out := range outputs {
		tx.AddTxOut(out)
	}
	if len(entries) > 0 {
		emu, err := arkade.NewPacket(entries...)
		if err != nil {
			t.Fatalf("emulator packet: %v", err)
		}
		packets = append(packets, emu)
	}
	ext := extension.Extension(packets)
	extOut, err := ext.TxOut()
	if err != nil {
		t.Fatalf("extension: %v", err)
	}
	tx.AddTxOut(extOut)
	tx.AddTxOut(&wire.TxOut{Value: 0, PkScript: anchorScript})

	ptx, err := psbt.NewFromUnsignedTx(tx)
	if err != nil {
		t.Fatalf("psbt: %v", err)
	}
	for i, in := range inputs {
		ptx.Inputs[i].WitnessUtxo = in.prev.TxOut[in.vout]
		if in.leaf != nil {
			ptx.Inputs[i].TaprootLeafScript = []*psbt.TaprootTapLeafScript{in.leaf.tapLeaf}
		}
		if err := txutils.SetArkPsbtField(ptx, i, arkade.PrevArkTxField, *in.prev); err != nil {
			t.Fatalf("prev ark tx: %v", err)
		}
	}
	return ptx
}

type prevOutFetcher struct {
	txscript.PrevOutputFetcher
	arkTxs map[wire.OutPoint]*wire.MsgTx
}

func (f *prevOutFetcher) FetchPrevOutArkTx(outpoint wire.OutPoint) *wire.MsgTx {
	return f.arkTxs[outpoint]
}

func (f *prevOutFetcher) FetchVtxoPrevOutPkScript(outpoint wire.OutPoint) []byte {
	tx := f.arkTxs[outpoint]
	if tx == nil || int(outpoint.Index) >= len(tx.TxOut) {
		return nil
	}
	return tx.TxOut[outpoint.Index].PkScript
}

func fetcherFor(ptx *psbt.Packet) (arkade.ArkPrevOutFetcher, error) {
	prevouts := make(map[wire.OutPoint]*wire.TxOut, len(ptx.Inputs))
	arkTxs := make(map[wire.OutPoint]*wire.MsgTx, len(ptx.Inputs))
	for i, input := range ptx.Inputs {
		outpoint := ptx.UnsignedTx.TxIn[i].PreviousOutPoint
		prevouts[outpoint] = input.WitnessUtxo
		fields, err := txutils.GetArkPsbtFields(ptx, i, arkade.PrevArkTxField)
		if err != nil {
			return nil, err
		}
		if len(fields) != 1 {
			return nil, fmt.Errorf("input %d has %d previous transactions", i, len(fields))
		}
		prev := fields[0]
		arkTxs[outpoint] = &prev
	}
	return &prevOutFetcher{PrevOutputFetcher: txscript.NewMultiPrevOutFetcher(prevouts), arkTxs: arkTxs}, nil
}

// runVM executes every emulator entry of the transaction against the VM.
func runVM(ptx *psbt.Packet, emulatorKey *btcec.PublicKey, options ...arkade.ExecuteOption) error {
	fetcher, err := fetcherFor(ptx)
	if err != nil {
		return err
	}
	packet, err := arkade.FindEmulatorPacket(ptx.UnsignedTx)
	if err != nil {
		return fmt.Errorf("emulator packet: %w", err)
	}
	if len(packet) == 0 {
		return fmt.Errorf("emulator packet missing")
	}
	for _, entry := range packet {
		script, err := arkade.ReadArkadeScript(ptx, emulatorKey, entry)
		if err != nil {
			return fmt.Errorf("input %d script: %w", entry.Vin, err)
		}
		if err := script.Execute(ptx.UnsignedTx, fetcher, int(entry.Vin), options...); err != nil {
			return fmt.Errorf("input %d: %w", entry.Vin, err)
		}
	}
	return nil
}

func accept(t *testing.T, ptx *psbt.Packet, emulatorKey *btcec.PublicKey) {
	t.Helper()
	if err := runVM(ptx, emulatorKey); err != nil {
		t.Fatalf("VM rejected: %v", err)
	}
}

func reject(t *testing.T, ptx *psbt.Packet, emulatorKey *btcec.PublicKey, vin int) {
	t.Helper()
	err := runVM(ptx, emulatorKey)
	if err == nil {
		t.Fatal("VM accepted an invalid transaction")
	}
	if !strings.HasPrefix(err.Error(), fmt.Sprintf("input %d:", vin)) {
		t.Fatalf("expected input %d to fail, got %v", vin, err)
	}
}

// runTapscript spends the coin through a pure tapscript leaf on the Bitcoin
// engine, signing input 0 with each key.
func runTapscript(prev *wire.MsgTx, inst *instance, name string, sequence uint32, keys []*btcec.PrivateKey) error {
	item := inst.leaves[name]
	prevOut := prev.TxOut[0]
	tx := wire.NewMsgTx(2)
	tx.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Hash: prev.TxHash(), Index: 0}, Sequence: sequence})
	tx.AddTxOut(&wire.TxOut{Value: prevOut.Value, PkScript: inst.pkScript})
	fetcher := txscript.NewCannedPrevOutputFetcher(prevOut.PkScript, prevOut.Value)
	sigHashes := txscript.NewTxSigHashes(tx, fetcher)
	tapLeaf := txscript.NewTapLeaf(item.tapLeaf.LeafVersion, item.tapLeaf.Script)
	var witness wire.TxWitness
	for i := len(keys) - 1; i >= 0; i-- {
		sig, err := txscript.RawTxInTapscriptSignature(tx, sigHashes, 0, prevOut.Value, prevOut.PkScript, tapLeaf, txscript.SigHashDefault, keys[i])
		if err != nil {
			return err
		}
		witness = append(witness, sig)
	}
	witness = append(witness, item.tapLeaf.Script, item.tapLeaf.ControlBlock)
	tx.TxIn[0].Witness = witness
	engine, err := txscript.NewEngine(prevOut.PkScript, tx, 0, txscript.StandardVerifyFlags, nil, sigHashes, prevOut.Value, fetcher)
	if err != nil {
		return err
	}
	return engine.Execute()
}

// A coin created by an earlier transaction, with the packets that transaction carried.
func coinTx(pkScript []byte, amount int64, packets ...extension.Packet) *wire.MsgTx {
	tx := wire.NewMsgTx(2)
	tx.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Index: 1}})
	tx.AddTxOut(&wire.TxOut{Value: amount, PkScript: pkScript})
	if len(packets) > 0 {
		ext := extension.Extension(packets)
		out, err := ext.TxOut()
		if err != nil {
			panic(err)
		}
		tx.AddTxOut(out)
	}
	return tx
}

func moveUnit(id asset.AssetId, vin, vout uint16) asset.Packet {
	return asset.Packet{{
		AssetId: &id,
		Inputs:  []asset.AssetInput{{Type: asset.AssetInputTypeLocal, Vin: vin, Amount: 1}},
		Outputs: []asset.AssetOutput{{Type: asset.AssetOutputTypeLocal, Vout: vout, Amount: 1}},
	}}
}

func scriptInt(t *testing.T, value int64) []byte {
	t.Helper()
	encoded, err := arkade.BigNumFromInt64(value).Bytes()
	if err != nil {
		t.Fatalf("script int %d: %v", value, err)
	}
	return encoded
}

func signDigest(t *testing.T, key *btcec.PrivateKey, digest []byte) []byte {
	t.Helper()
	sig, err := schnorr.Sign(key, digest)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return sig.Serialize()
}

func fixedPrivateKey(value byte) *btcec.PrivateKey {
	key, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{value}, 32))
	return key
}

func fixedPublicKey(value byte) *btcec.PublicKey {
	return fixedPrivateKey(value).PubKey()
}

func xonly(key *btcec.PrivateKey) []byte {
	return schnorr.SerializePubKey(key.PubKey())
}

func p2tr(program []byte) []byte {
	return append([]byte{0x51, 0x20}, program...)
}
