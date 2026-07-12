#!/usr/bin/env python3
"""Patch internal/session/session.go: modify buildSlot to support CBC."""
import sys

path = sys.argv[1]
with open(path, 'r') as f:
    src = f.read()

# 1. Modify the buildSlot call site: pass cfg.Auth
src = src.replace(
    'slot, err := buildSlot(0, result)',
    'slot, err := buildSlot(0, result, cfg.Auth)'
)

# 2. Modify the buildSlot function itself
old_buildslot = '''func buildSlot(keyID uint8, r *control.Result) (*data.Slot, error) {
	keyLen, err := control.AEADKeyLen(r.Cipher)
	if err != nil {
		return nil, err
	}
	slot, err := data.NewSlot(data.SlotConfig{
		KeyID:   keyID,
		PeerID:  r.PeerID,
		Cipher:  r.Cipher,
		SendKey: r.KeyMaterial.ClientToServerCipherKey(keyLen),
		SendIV:  r.KeyMaterial.ClientToServerImplicitIV(),
		RecvKey: r.KeyMaterial.ServerToClientCipherKey(keyLen),
		RecvIV:  r.KeyMaterial.ServerToClientImplicitIV(),
	})
	if err != nil {
		return nil, err
	}
	// Wipe the EKM exporter copy once it's been consumed by the AEAD ciphers.
	clear(r.KeyMaterial[:])
	return slot, nil
}'''

new_buildslot = '''func buildSlot(keyID uint8, r *control.Result, auth string) (*data.Slot, error) {
	keyLen, err := control.AEADKeyLen(r.Cipher)
	if err != nil {
		return nil, err
	}
	cfg := data.SlotConfig{
		KeyID:   keyID,
		PeerID:  r.PeerID,
		Cipher:  r.Cipher,
		SendKey: r.KeyMaterial.ClientToServerCipherKey(keyLen),
		RecvKey: r.KeyMaterial.ServerToClientCipherKey(keyLen),
	}
	if control.IsCBCCipher(r.Cipher) {
		hmacLen, err := control.HMACKeyLen(auth)
		if err != nil {
			return nil, err
		}
		cfg.AuthDigest = auth
		cfg.SendHMACKey = r.KeyMaterial.ClientToServerHMACKey(hmacLen)
		cfg.RecvHMACKey = r.KeyMaterial.ServerToClientHMACKey(hmacLen)
	} else {
		cfg.SendIV = r.KeyMaterial.ClientToServerImplicitIV()
		cfg.RecvIV = r.KeyMaterial.ServerToClientImplicitIV()
	}
	slot, err := data.NewSlot(cfg)
	if err != nil {
		return nil, err
	}
	// Wipe the EKM exporter copy once it has been consumed.
	clear(r.KeyMaterial[:])
	return slot, nil
}'''

src = src.replace(old_buildslot, new_buildslot)

with open(path, 'w') as f:
    f.write(src)

print(f"[patch_session] patched {path}")
