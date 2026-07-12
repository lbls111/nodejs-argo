#!/usr/bin/env python3
"""Patch internal/data/slot.go to add CBC+HMAC support."""
import sys

path = sys.argv[1]
with open(path, 'r') as f:
    src = f.read()

# 1. Modify Slot struct — add isAEAD and CBC fields
old_slot = '''type Slot struct {
	KeyID  uint8
	PeerID uint32

	sendAEAD *AEAD
	sendIV   [ImplicitIVLen]byte
	sendPID  atomic.Uint32

	recvAEAD *AEAD
	recvIV   [ImplicitIVLen]byte
	recvWin  *ReplayWindow
}'''

new_slot = '''type Slot struct {
	KeyID  uint8
	PeerID uint32
	isAEAD bool

	// AEAD mode
	sendAEAD *AEAD
	sendIV   [ImplicitIVLen]byte
	recvAEAD *AEAD
	recvIV   [ImplicitIVLen]byte

	// CBC+HMAC mode
	sendCBC *CBCHMACState
	recvCBC *CBCHMACState

	// Common to both modes
	sendPID atomic.Uint32
	recvWin *ReplayWindow
}'''

src = src.replace(old_slot, new_slot)

# 2. Modify SlotConfig — add CBC fields
old_cfg = '''type SlotConfig struct {
	KeyID      uint8
	PeerID     uint32 // 24-bit; the upper 8 bits must be zero
	Cipher     string // e.g. "AES-256-GCM"
	SendKey    []byte
	SendIV     [ImplicitIVLen]byte
	RecvKey    []byte
	RecvIV     [ImplicitIVLen]byte
	ReplaySize uint // 0 ⇒ default 64
}'''

new_cfg = '''type SlotConfig struct {
	KeyID      uint8
	PeerID     uint32 // 24-bit; the upper 8 bits must be zero
	Cipher     string // e.g. "AES-256-GCM"
	SendKey    []byte
	SendIV     [ImplicitIVLen]byte // AEAD only
	RecvKey    []byte
	RecvIV     [ImplicitIVLen]byte // AEAD only
	ReplaySize uint // 0 ⇒ default 64

	// CBC+HMAC fields (ignored when Cipher is AEAD)
	AuthDigest  string // "SHA1", "SHA256"; "" defaults to SHA1
	SendHMACKey []byte
	RecvHMACKey []byte
}'''

src = src.replace(old_cfg, new_cfg)

# 3. Replace NewSlot to branch AEAD vs CBC
old_newslot = '''func NewSlot(cfg SlotConfig) (*Slot, error) {
	if cfg.PeerID&^0x00FFFFFF != 0 {
		return nil, fmt.Errorf("data: peer-id 0x%x exceeds 24 bits", cfg.PeerID)
	}
	sa, err := NewAEAD(cfg.Cipher, cfg.SendKey)
	if err != nil {
		return nil, fmt.Errorf("data: send AEAD: %w", err)
	}
	ra, err := NewAEAD(cfg.Cipher, cfg.RecvKey)
	if err != nil {
		return nil, fmt.Errorf("data: recv AEAD: %w", err)
	}
	return &Slot{
		KeyID:    cfg.KeyID,
		PeerID:   cfg.PeerID,
		sendAEAD: sa,
		sendIV:   cfg.SendIV,
		recvAEAD: ra,
		recvIV:   cfg.RecvIV,
		recvWin:  NewReplayWindow(cfg.ReplaySize),
	}, nil
}'''

new_newslot = '''func NewSlot(cfg SlotConfig) (*Slot, error) {
	if cfg.PeerID&^0x00FFFFFF != 0 {
		return nil, fmt.Errorf("data: peer-id 0x%x exceeds 24 bits", cfg.PeerID)
	}
	s := &Slot{
		KeyID:   cfg.KeyID,
		PeerID:  cfg.PeerID,
		recvWin: NewReplayWindow(cfg.ReplaySize),
	}
	switch cfg.Cipher {
	case "AES-128-CBC", "AES-256-CBC":
		s.isAEAD = false
		sc, err := NewCBCHMAC(cfg.SendKey, cfg.SendHMACKey, cfg.AuthDigest)
		if err != nil {
			return nil, fmt.Errorf("data: send CBC: %w", err)
		}
		rc, err := NewCBCHMAC(cfg.RecvKey, cfg.RecvHMACKey, cfg.AuthDigest)
		if err != nil {
			return nil, fmt.Errorf("data: recv CBC: %w", err)
		}
		s.sendCBC = sc
		s.recvCBC = rc
	default:
		s.isAEAD = true
		sa, err := NewAEAD(cfg.Cipher, cfg.SendKey)
		if err != nil {
			return nil, fmt.Errorf("data: send AEAD: %w", err)
		}
		ra, err := NewAEAD(cfg.Cipher, cfg.RecvKey)
		if err != nil {
			return nil, fmt.Errorf("data: recv AEAD: %w", err)
		}
		s.sendAEAD = sa
		s.sendIV = cfg.SendIV
		s.recvAEAD = ra
		s.recvIV = cfg.RecvIV
	}
	return s, nil
}'''

src = src.replace(old_newslot, new_newslot)

# 4. Modify Seal — add CBC branch at the top
old_seal_start = '''func (s *Slot) Seal(plaintext []byte) ([]byte, error) {
	pid := s.sendPID.Add(1)
	if pid >= PacketIDRekeyThreshold {
		return nil, ErrPacketIDExhausted
	}
	opcodeKID := proto.PackOpcodeKID(proto.PDataV2, s.KeyID)'''

new_seal_start = '''func (s *Slot) Seal(plaintext []byte) ([]byte, error) {
	pid := s.sendPID.Add(1)
	if pid >= PacketIDRekeyThreshold {
		return nil, ErrPacketIDExhausted
	}
	if !s.isAEAD {
		return sealCBC(s.sendCBC, s.KeyID, s.PeerID, pid, plaintext)
	}
	opcodeKID := proto.PackOpcodeKID(proto.PDataV2, s.KeyID)'''

src = src.replace(old_seal_start, new_seal_start)

# 5. Modify Open — add CBC branch at the top
old_open_start = '''func (s *Slot) Open(packet []byte) ([]byte, error) {
	hdr, body, err := proto.ParseDataV2Header(packet)'''

new_open_start = '''func (s *Slot) Open(packet []byte) ([]byte, error) {
	if !s.isAEAD {
		payload, pid, err := openCBC(s.recvCBC, s.KeyID, s.PeerID, packet)
		if err != nil {
			return nil, err
		}
		if !s.recvWin.Test(pid) {
			return nil, fmt.Errorf("data: replay or out-of-window pid %d", pid)
		}
		if !s.recvWin.Accept(pid) {
			return nil, fmt.Errorf("data: replay or out-of-window pid %d", pid)
		}
		return payload, nil
	}
	hdr, body, err := proto.ParseDataV2Header(packet)'''

src = src.replace(old_open_start, new_open_start)

# 6. Modify OpenInto — add CBC branch at the top
old_openinto_start = '''func (s *Slot) OpenInto(dst, packet []byte) ([]byte, error) {
	hdr, body, err := proto.ParseDataV2Header(packet)'''

new_openinto_start = '''func (s *Slot) OpenInto(dst, packet []byte) ([]byte, error) {
	if !s.isAEAD {
		payload, pid, err := openCBC(s.recvCBC, s.KeyID, s.PeerID, packet)
		if err != nil {
			return nil, err
		}
		if !s.recvWin.Test(pid) {
			return nil, fmt.Errorf("data: replay or out-of-window pid %d", pid)
		}
		if !s.recvWin.Accept(pid) {
			return nil, fmt.Errorf("data: replay or out-of-window pid %d", pid)
		}
		return append(dst, payload...), nil
	}
	hdr, body, err := proto.ParseDataV2Header(packet)'''

src = src.replace(old_openinto_start, new_openinto_start)

with open(path, 'w') as f:
    f.write(src)

print(f"[patch_slot] patched {path}")
