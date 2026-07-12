#!/usr/bin/env python3
"""Patch internal/session/rekey.go: modify rekey NewSlot to support CBC."""
import sys

path = sys.argv[1]
with open(path, 'r') as f:
    src = f.read()

old_rekey = '''	keyLen, err := control.AEADKeyLen(s.cipher)
	if err != nil {
		_ = newTLS.Close()
		s.retireLayer(newKID)
		return err
	}

	// 6. Build the new data slot.
	newSlot, err := data.NewSlot(data.SlotConfig{
		KeyID:   newKID,
		PeerID:  s.peerID,
		Cipher:  s.cipher,
		SendKey: mat[0:keyLen],
		SendIV:  [data.ImplicitIVLen]byte(mat[64 : 64+data.ImplicitIVLen]),
		RecvKey: mat[128 : 128+keyLen],
		RecvIV:  [data.ImplicitIVLen]byte(mat[192 : 192+data.ImplicitIVLen]),
	})'''

new_rekey = '''	keyLen, err := control.AEADKeyLen(s.cipher)
	if err != nil {
		_ = newTLS.Close()
		s.retireLayer(newKID)
		return err
	}

	// 6. Build the new data slot.
	slotCfg := data.SlotConfig{
		KeyID:   newKID,
		PeerID:  s.peerID,
		Cipher:  s.cipher,
		SendKey: mat[0:keyLen],
		RecvKey: mat[128 : 128+keyLen],
	}
	if control.IsCBCCipher(s.cipher) {
		hmacLen, hmacErr := control.HMACKeyLen(s.cfg.Auth)
		if hmacErr != nil {
			_ = newTLS.Close()
			s.retireLayer(newKID)
			return hmacErr
		}
		slotCfg.AuthDigest = s.cfg.Auth
		slotCfg.SendHMACKey = mat[64 : 64+hmacLen]
		slotCfg.RecvHMACKey = mat[192 : 192+hmacLen]
	} else {
		slotCfg.SendIV = [data.ImplicitIVLen]byte(mat[64 : 64+data.ImplicitIVLen])
		slotCfg.RecvIV = [data.ImplicitIVLen]byte(mat[192 : 192+data.ImplicitIVLen])
	}
	newSlot, err := data.NewSlot(slotCfg)'''

src = src.replace(old_rekey, new_rekey)

with open(path, 'w') as f:
    f.write(src)

print(f"[patch_rekey] patched {path}")
