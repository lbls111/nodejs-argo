#!/usr/bin/env python3
"""Unified CBC+HMAC patcher for go-openvpn. Fails hard if any patch does not apply."""
import os
import re
import sys


def die(msg):
    print(f"[PATCH FATAL] {msg}", file=sys.stderr)
    sys.exit(1)


def read(path):
    if not os.path.isfile(path):
        die(f"missing file: {path}")
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def write(path, content):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(content)


def must_replace(src, path, old, new, label):
    if old not in src:
        # Diagnostics: show nearby lines
        print(f"[PATCH FATAL] target not found for: {label}", file=sys.stderr)
        print(f"[PATCH FATAL] file: {path}", file=sys.stderr)
        print(f"[PATCH FATAL] looking for (repr): {old[:200]!r}", file=sys.stderr)
        needle = old.split("\n")[0][:40]
        for i, line in enumerate(src.splitlines(), 1):
            if needle[:20] in line or "AES-256-GCM" in line or "validateCiphers" in line or "buildSlot" in line or "NewSlot" in line:
                print(f"  L{i}: {line!r}", file=sys.stderr)
        die(f"replace failed: {label}")
    out = src.replace(old, new, 1)
    if out == src:
        die(f"replace produced no change: {label}")
    print(f"[patch] OK: {label}")
    return out


def must_contain(src, path, needle, label):
    if needle not in src:
        die(f"post-check failed for {label}: {needle!r} not in {path}")
    print(f"[patch] verified: {label}")


# ── 1. parse.go: validateCiphers ──────────────────────────────────────────
path = "pkg/ovpn/parse.go"
src = read(path)
old = '''\tfor _, c := range cs {
\t\tswitch c {
\t\tcase "AES-256-GCM", "AES-128-GCM", "CHACHA20-POLY1305":
\t\tdefault:
\t\t\treturn fmt.Errorf("cipher %q is not supported (AEAD only: AES-256-GCM, AES-128-GCM, CHACHA20-POLY1305)", c)
\t\t}
\t}'''
new = '''\tfor _, c := range cs {
\t\tswitch c {
\t\tcase "AES-256-GCM", "AES-128-GCM", "CHACHA20-POLY1305", "AES-128-CBC", "AES-256-CBC":
\t\tdefault:
\t\t\treturn fmt.Errorf("cipher %q is not supported (supported: AES-256-GCM, AES-128-GCM, CHACHA20-POLY1305, AES-128-CBC, AES-256-CBC)", c)
\t\t}
\t}'''
src = must_replace(src, path, old, new, "parse.go validateCiphers")
write(path, src)
must_contain(read(path), path, "AES-128-CBC", "parse.go has AES-128-CBC")
must_contain(read(path), path, "supported:", "parse.go error message updated")

# ── 2. keys.go: AEADKeyLen + append CBC helpers ───────────────────────────
path = "internal/control/keys.go"
src = read(path)
old = '''func AEADKeyLen(cipher string) (int, error) {
\tswitch cipher {
\tcase "AES-256-GCM", "CHACHA20-POLY1305":
\t\treturn 32, nil
\tcase "AES-128-GCM":
\t\treturn 16, nil
\tdefault:
\t\treturn 0, fmt.Errorf("control: unsupported data cipher %q", cipher)
\t}
}'''
new = '''func AEADKeyLen(cipher string) (int, error) {
\tswitch cipher {
\tcase "AES-256-GCM", "CHACHA20-POLY1305", "AES-256-CBC":
\t\treturn 32, nil
\tcase "AES-128-GCM", "AES-128-CBC":
\t\treturn 16, nil
\tdefault:
\t\treturn 0, fmt.Errorf("control: unsupported data cipher %q", cipher)
\t}
}

// IsCBCCipher reports whether the named cipher uses CBC+HMAC mode.
func IsCBCCipher(cipher string) bool {
\tswitch cipher {
\tcase "AES-128-CBC", "AES-256-CBC":
\t\treturn true
\t}
\treturn false
}

// HMACKeyLen returns the HMAC key length for the given auth digest.
// Empty string defaults to SHA1.
func HMACKeyLen(auth string) (int, error) {
\tswitch auth {
\tcase "SHA1", "":
\t\treturn 20, nil
\tcase "SHA256":
\t\treturn 32, nil
\tdefault:
\t\treturn 0, fmt.Errorf("control: unsupported auth digest %q for CBC+HMAC", auth)
\t}
}

// ClientToServerHMACKey returns the first keyLen bytes of the c->s HMAC slot.
func (m *DataKeyMaterial) ClientToServerHMACKey(keyLen int) []byte {
\treturn m[64 : 64+keyLen]
}

// ServerToClientHMACKey returns the first keyLen bytes of the s->c HMAC slot.
func (m *DataKeyMaterial) ServerToClientHMACKey(keyLen int) []byte {
\treturn m[192 : 192+keyLen]
}'''
src = must_replace(src, path, old, new, "keys.go AEADKeyLen + CBC helpers")
write(path, src)
must_contain(read(path), path, "IsCBCCipher", "keys.go has IsCBCCipher")
must_contain(read(path), path, "AES-128-CBC", "keys.go has AES-128-CBC")

# ── 3. slot.go ────────────────────────────────────────────────────────────
path = "internal/data/slot.go"
src = read(path)

old_slot = '''type Slot struct {
\tKeyID  uint8
\tPeerID uint32

\tsendAEAD *AEAD
\tsendIV   [ImplicitIVLen]byte
\tsendPID  atomic.Uint32

\trecvAEAD *AEAD
\trecvIV   [ImplicitIVLen]byte
\trecvWin  *ReplayWindow
}'''
new_slot = '''type Slot struct {
\tKeyID  uint8
\tPeerID uint32
\tisAEAD bool

\t// AEAD mode
\tsendAEAD *AEAD
\tsendIV   [ImplicitIVLen]byte
\trecvAEAD *AEAD
\trecvIV   [ImplicitIVLen]byte

\t// CBC+HMAC mode
\tsendCBC *CBCHMACState
\trecvCBC *CBCHMACState

\t// Common to both modes
\tsendPID atomic.Uint32
\trecvWin *ReplayWindow
}'''
src = must_replace(src, path, old_slot, new_slot, "slot.go Slot struct")

old_cfg = '''type SlotConfig struct {
\tKeyID      uint8
\tPeerID     uint32 // 24-bit; the upper 8 bits must be zero
\tCipher     string // e.g. "AES-256-GCM"
\tSendKey    []byte
\tSendIV     [ImplicitIVLen]byte
\tRecvKey    []byte
\tRecvIV     [ImplicitIVLen]byte
\tReplaySize uint // 0 ⇒ default 64
}'''
new_cfg = '''type SlotConfig struct {
\tKeyID      uint8
\tPeerID     uint32 // 24-bit; the upper 8 bits must be zero
\tCipher     string // e.g. "AES-256-GCM"
\tSendKey    []byte
\tSendIV     [ImplicitIVLen]byte // AEAD only
\tRecvKey    []byte
\tRecvIV     [ImplicitIVLen]byte // AEAD only
\tReplaySize uint // 0 ⇒ default 64

\t// CBC+HMAC fields (ignored when Cipher is AEAD)
\tAuthDigest  string // "SHA1", "SHA256"; "" defaults to SHA1
\tSendHMACKey []byte
\tRecvHMACKey []byte
}'''
src = must_replace(src, path, old_cfg, new_cfg, "slot.go SlotConfig")

old_newslot = '''func NewSlot(cfg SlotConfig) (*Slot, error) {
\tif cfg.PeerID&^0x00FFFFFF != 0 {
\t\treturn nil, fmt.Errorf("data: peer-id 0x%x exceeds 24 bits", cfg.PeerID)
\t}
\tsa, err := NewAEAD(cfg.Cipher, cfg.SendKey)
\tif err != nil {
\t\treturn nil, fmt.Errorf("data: send AEAD: %w", err)
\t}
\tra, err := NewAEAD(cfg.Cipher, cfg.RecvKey)
\tif err != nil {
\t\treturn nil, fmt.Errorf("data: recv AEAD: %w", err)
\t}
\treturn &Slot{
\t\tKeyID:    cfg.KeyID,
\t\tPeerID:   cfg.PeerID,
\t\tsendAEAD: sa,
\t\tsendIV:   cfg.SendIV,
\t\trecvAEAD: ra,
\t\trecvIV:   cfg.RecvIV,
\t\trecvWin:  NewReplayWindow(cfg.ReplaySize),
\t}, nil
}'''
new_newslot = '''func NewSlot(cfg SlotConfig) (*Slot, error) {
\tif cfg.PeerID&^0x00FFFFFF != 0 {
\t\treturn nil, fmt.Errorf("data: peer-id 0x%x exceeds 24 bits", cfg.PeerID)
\t}
\ts := &Slot{
\t\tKeyID:   cfg.KeyID,
\t\tPeerID:  cfg.PeerID,
\t\trecvWin: NewReplayWindow(cfg.ReplaySize),
\t}
\tswitch cfg.Cipher {
\tcase "AES-128-CBC", "AES-256-CBC":
\t\ts.isAEAD = false
\t\tsc, err := NewCBCHMAC(cfg.SendKey, cfg.SendHMACKey, cfg.AuthDigest)
\t\tif err != nil {
\t\t\treturn nil, fmt.Errorf("data: send CBC: %w", err)
\t\t}
\t\trc, err := NewCBCHMAC(cfg.RecvKey, cfg.RecvHMACKey, cfg.AuthDigest)
\t\tif err != nil {
\t\t\treturn nil, fmt.Errorf("data: recv CBC: %w", err)
\t\t}
\t\ts.sendCBC = sc
\t\ts.recvCBC = rc
\tdefault:
\t\ts.isAEAD = true
\t\tsa, err := NewAEAD(cfg.Cipher, cfg.SendKey)
\t\tif err != nil {
\t\t\treturn nil, fmt.Errorf("data: send AEAD: %w", err)
\t\t}
\t\tra, err := NewAEAD(cfg.Cipher, cfg.RecvKey)
\t\tif err != nil {
\t\t\treturn nil, fmt.Errorf("data: recv AEAD: %w", err)
\t\t}
\t\ts.sendAEAD = sa
\t\ts.sendIV = cfg.SendIV
\t\ts.recvAEAD = ra
\t\ts.recvIV = cfg.RecvIV
\t}
\treturn s, nil
}'''
src = must_replace(src, path, old_newslot, new_newslot, "slot.go NewSlot")

old_seal = '''func (s *Slot) Seal(plaintext []byte) ([]byte, error) {
\tpid := s.sendPID.Add(1)
\tif pid >= PacketIDRekeyThreshold {
\t\treturn nil, ErrPacketIDExhausted
\t}
\topcodeKID := proto.PackOpcodeKID(proto.PDataV2, s.KeyID)'''
new_seal = '''func (s *Slot) Seal(plaintext []byte) ([]byte, error) {
\tpid := s.sendPID.Add(1)
\tif pid >= PacketIDRekeyThreshold {
\t\treturn nil, ErrPacketIDExhausted
\t}
\tif !s.isAEAD {
\t\treturn sealCBC(s.sendCBC, s.KeyID, s.PeerID, pid, plaintext)
\t}
\topcodeKID := proto.PackOpcodeKID(proto.PDataV2, s.KeyID)'''
src = must_replace(src, path, old_seal, new_seal, "slot.go Seal")

old_open = '''func (s *Slot) Open(packet []byte) ([]byte, error) {
\thdr, body, err := proto.ParseDataV2Header(packet)'''
new_open = '''func (s *Slot) Open(packet []byte) ([]byte, error) {
\tif !s.isAEAD {
\t\tpayload, pid, err := openCBC(s.recvCBC, s.KeyID, s.PeerID, packet)
\t\tif err != nil {
\t\t\treturn nil, err
\t\t}
\t\tif !s.recvWin.Test(pid) {
\t\t\treturn nil, fmt.Errorf("data: replay or out-of-window pid %d", pid)
\t\t}
\t\tif !s.recvWin.Accept(pid) {
\t\t\treturn nil, fmt.Errorf("data: replay or out-of-window pid %d", pid)
\t\t}
\t\treturn payload, nil
\t}
\thdr, body, err := proto.ParseDataV2Header(packet)'''
src = must_replace(src, path, old_open, new_open, "slot.go Open")

old_openinto = '''func (s *Slot) OpenInto(dst, packet []byte) ([]byte, error) {
\thdr, body, err := proto.ParseDataV2Header(packet)'''
new_openinto = '''func (s *Slot) OpenInto(dst, packet []byte) ([]byte, error) {
\tif !s.isAEAD {
\t\tpayload, pid, err := openCBC(s.recvCBC, s.KeyID, s.PeerID, packet)
\t\tif err != nil {
\t\t\treturn nil, err
\t\t}
\t\tif !s.recvWin.Test(pid) {
\t\t\treturn nil, fmt.Errorf("data: replay or out-of-window pid %d", pid)
\t\t}
\t\tif !s.recvWin.Accept(pid) {
\t\t\treturn nil, fmt.Errorf("data: replay or out-of-window pid %d", pid)
\t\t}
\t\treturn append(dst, payload...), nil
\t}
\thdr, body, err := proto.ParseDataV2Header(packet)'''
src = must_replace(src, path, old_openinto, new_openinto, "slot.go OpenInto")

write(path, src)
must_contain(read(path), path, "isAEAD", "slot.go has isAEAD")
must_contain(read(path), path, "sealCBC", "slot.go has sealCBC call")
must_contain(read(path), path, "NewCBCHMAC", "slot.go has NewCBCHMAC")

# ── 4. session.go: buildSlot ──────────────────────────────────────────────
path = "internal/session/session.go"
src = read(path)

src = must_replace(
    src, path,
    "slot, err := buildSlot(0, result)",
    "slot, err := buildSlot(0, result, cfg.Auth)",
    "session.go buildSlot call site",
)

old_buildslot = '''func buildSlot(keyID uint8, r *control.Result) (*data.Slot, error) {
\tkeyLen, err := control.AEADKeyLen(r.Cipher)
\tif err != nil {
\t\treturn nil, err
\t}
\tslot, err := data.NewSlot(data.SlotConfig{
\t\tKeyID:   keyID,
\t\tPeerID:  r.PeerID,
\t\tCipher:  r.Cipher,
\t\tSendKey: r.KeyMaterial.ClientToServerCipherKey(keyLen),
\t\tSendIV:  r.KeyMaterial.ClientToServerImplicitIV(),
\t\tRecvKey: r.KeyMaterial.ServerToClientCipherKey(keyLen),
\t\tRecvIV:  r.KeyMaterial.ServerToClientImplicitIV(),
\t})
\tif err != nil {
\t\treturn nil, err
\t}
\t// Wipe the EKM exporter copy once it's been consumed by the AEAD ciphers.
\tclear(r.KeyMaterial[:])
\treturn slot, nil
}'''
new_buildslot = '''func buildSlot(keyID uint8, r *control.Result, auth string) (*data.Slot, error) {
\tkeyLen, err := control.AEADKeyLen(r.Cipher)
\tif err != nil {
\t\treturn nil, err
\t}
\tcfg := data.SlotConfig{
\t\tKeyID:   keyID,
\t\tPeerID:  r.PeerID,
\t\tCipher:  r.Cipher,
\t\tSendKey: r.KeyMaterial.ClientToServerCipherKey(keyLen),
\t\tRecvKey: r.KeyMaterial.ServerToClientCipherKey(keyLen),
\t}
\tif control.IsCBCCipher(r.Cipher) {
\t\thmacLen, err := control.HMACKeyLen(auth)
\t\tif err != nil {
\t\t\treturn nil, err
\t\t}
\t\tcfg.AuthDigest = auth
\t\tcfg.SendHMACKey = r.KeyMaterial.ClientToServerHMACKey(hmacLen)
\t\tcfg.RecvHMACKey = r.KeyMaterial.ServerToClientHMACKey(hmacLen)
\t} else {
\t\tcfg.SendIV = r.KeyMaterial.ClientToServerImplicitIV()
\t\tcfg.RecvIV = r.KeyMaterial.ServerToClientImplicitIV()
\t}
\tslot, err := data.NewSlot(cfg)
\tif err != nil {
\t\treturn nil, err
\t}
\t// Wipe the EKM exporter copy once it has been consumed.
\tclear(r.KeyMaterial[:])
\treturn slot, nil
}'''
src = must_replace(src, path, old_buildslot, new_buildslot, "session.go buildSlot func")
write(path, src)
must_contain(read(path), path, "IsCBCCipher", "session.go has IsCBCCipher")
must_contain(read(path), path, "buildSlot(0, result, cfg.Auth)", "session.go call site updated")

# ── 5. rekey.go ───────────────────────────────────────────────────────────
path = "internal/session/rekey.go"
src = read(path)

old_rekey = '''\tkeyLen, err := control.AEADKeyLen(s.cipher)
\tif err != nil {
\t\t_ = newTLS.Close()
\t\ts.retireLayer(newKID)
\t\treturn err
\t}

\t// 6. Build the new data slot.
\tnewSlot, err := data.NewSlot(data.SlotConfig{
\t\tKeyID:   newKID,
\t\tPeerID:  s.peerID,
\t\tCipher:  s.cipher,
\t\tSendKey: mat[0:keyLen],
\t\tSendIV:  [data.ImplicitIVLen]byte(mat[64 : 64+data.ImplicitIVLen]),
\t\tRecvKey: mat[128 : 128+keyLen],
\t\tRecvIV:  [data.ImplicitIVLen]byte(mat[192 : 192+data.ImplicitIVLen]),
\t})'''
new_rekey = '''\tkeyLen, err := control.AEADKeyLen(s.cipher)
\tif err != nil {
\t\t_ = newTLS.Close()
\t\ts.retireLayer(newKID)
\t\treturn err
\t}

\t// 6. Build the new data slot.
\tslotCfg := data.SlotConfig{
\t\tKeyID:   newKID,
\t\tPeerID:  s.peerID,
\t\tCipher:  s.cipher,
\t\tSendKey: mat[0:keyLen],
\t\tRecvKey: mat[128 : 128+keyLen],
\t}
\tif control.IsCBCCipher(s.cipher) {
\t\thmacLen, hmacErr := control.HMACKeyLen(s.cfg.Auth)
\t\tif hmacErr != nil {
\t\t\t_ = newTLS.Close()
\t\t\ts.retireLayer(newKID)
\t\t\treturn hmacErr
\t\t}
\t\tslotCfg.AuthDigest = s.cfg.Auth
\t\tslotCfg.SendHMACKey = mat[64 : 64+hmacLen]
\t\tslotCfg.RecvHMACKey = mat[192 : 192+hmacLen]
\t} else {
\t\tslotCfg.SendIV = [data.ImplicitIVLen]byte(mat[64 : 64+data.ImplicitIVLen])
\t\tslotCfg.RecvIV = [data.ImplicitIVLen]byte(mat[192 : 192+data.ImplicitIVLen])
\t}
\tnewSlot, err := data.NewSlot(slotCfg)'''
src = must_replace(src, path, old_rekey, new_rekey, "rekey.go NewSlot")
write(path, src)
must_contain(read(path), path, "IsCBCCipher", "rekey.go has IsCBCCipher")
must_contain(read(path), path, "slotCfg", "rekey.go uses slotCfg")

# ── 6. session.go: allow unprotected control channel (VPN Gate / SoftEther) ──
path = "internal/session/session.go"
src = read(path)

old_val = '''\tif set != 1 {
\t\treturn errors.New("session: exactly one control-channel key required (tls-crypt v1, tls-crypt-v2 or tls-auth)")
\t}
\treturn nil
}'''
new_val = '''\tif set > 1 {
\t\treturn errors.New("session: at most one control-channel key (tls-crypt v1, tls-crypt-v2 or tls-auth)")
\t}
\t// set == 0 is allowed: plain control channel (VPN Gate / SoftEther OpenVPN)
\treturn nil
}'''
src = must_replace(src, path, old_val, new_val, "session.go validateConfig allow plain")

old_bw = '''func buildWrapper(cfg Config) (controlWrapper, proto.Opcode, error) {
\tif len(cfg.TLSAuth) > 0 {
\t\trawKey, err := tlscrypt.ParseStaticKey(cfg.TLSAuth)
\t\tif err != nil {
\t\t\treturn nil, 0, fmt.Errorf("session: parse tls-auth key: %w", err)
\t\t}
\t\t// tls-auth clients use the Inverse orientation in every real-world
\t\t// profile (`key-direction 1`), mirroring the tls-crypt client. We do
\t\t// not yet distinguish a client-side `key-direction 0` (Normal); see
\t\t// Config.KeyDirection.
\t\tauth, err := tlsauth.New(rawKey, tlscrypt.DirectionInverse, cfg.Auth)
\t\tif err != nil {
\t\t\treturn nil, 0, fmt.Errorf("session: init tls-auth: %w", err)
\t\t}
\t\treturn auth, proto.PControlHardResetClientV2, nil
\t}
\tif len(cfg.TLSCryptV2) > 0 {
\t\tbundle, err := tlscrypt.ParseClientBundleV2(cfg.TLSCryptV2)
\t\tif err != nil {
\t\t\treturn nil, 0, fmt.Errorf("session: parse tls-crypt-v2 bundle: %w", err)
\t\t}
\t\tw, err := tlscrypt.New(bundle.Kc, tlscrypt.DirectionInverse)
\t\tif err != nil {
\t\t\treturn nil, 0, fmt.Errorf("session: init tls-crypt-v2: %w", err)
\t\t}
\t\tw.SetFirstWrapTrailer(bundle.WKc)
\t\treturn w, proto.PControlHardResetClientV3, nil
\t}
\trawKey, err := tlscrypt.ParseStaticKey(cfg.TLSCryptV1)
\tif err != nil {
\t\treturn nil, 0, fmt.Errorf("session: parse tls-crypt key: %w", err)
\t}
\tw, err := tlscrypt.New(rawKey, tlscrypt.DirectionInverse)
\tif err != nil {
\t\treturn nil, 0, fmt.Errorf("session: init tls-crypt: %w", err)
\t}
\treturn w, proto.PControlHardResetClientV2, nil
}'''
new_bw = '''func buildWrapper(cfg Config) (controlWrapper, proto.Opcode, error) {
\tif len(cfg.TLSAuth) > 0 {
\t\trawKey, err := tlscrypt.ParseStaticKey(cfg.TLSAuth)
\t\tif err != nil {
\t\t\treturn nil, 0, fmt.Errorf("session: parse tls-auth key: %w", err)
\t\t}
\t\t// tls-auth clients use the Inverse orientation in every real-world
\t\t// profile (`key-direction 1`), mirroring the tls-crypt client. We do
\t\t// not yet distinguish a client-side `key-direction 0` (Normal); see
\t\t// Config.KeyDirection.
\t\tauth, err := tlsauth.New(rawKey, tlscrypt.DirectionInverse, cfg.Auth)
\t\tif err != nil {
\t\t\treturn nil, 0, fmt.Errorf("session: init tls-auth: %w", err)
\t\t}
\t\treturn auth, proto.PControlHardResetClientV2, nil
\t}
\tif len(cfg.TLSCryptV2) > 0 {
\t\tbundle, err := tlscrypt.ParseClientBundleV2(cfg.TLSCryptV2)
\t\tif err != nil {
\t\t\treturn nil, 0, fmt.Errorf("session: parse tls-crypt-v2 bundle: %w", err)
\t\t}
\t\tw, err := tlscrypt.New(bundle.Kc, tlscrypt.DirectionInverse)
\t\tif err != nil {
\t\t\treturn nil, 0, fmt.Errorf("session: init tls-crypt-v2: %w", err)
\t\t}
\t\tw.SetFirstWrapTrailer(bundle.WKc)
\t\treturn w, proto.PControlHardResetClientV3, nil
\t}
\tif len(cfg.TLSCryptV1) > 0 {
\t\trawKey, err := tlscrypt.ParseStaticKey(cfg.TLSCryptV1)
\t\tif err != nil {
\t\t\treturn nil, 0, fmt.Errorf("session: parse tls-crypt key: %w", err)
\t\t}
\t\tw, err := tlscrypt.New(rawKey, tlscrypt.DirectionInverse)
\t\tif err != nil {
\t\t\treturn nil, 0, fmt.Errorf("session: init tls-crypt: %w", err)
\t\t}
\t\treturn w, proto.PControlHardResetClientV2, nil
\t}
\t// No control-channel key: plain OpenVPN (VPN Gate / SoftEther)
\treturn plainControlWrapper{}, proto.PControlHardResetClientV2, nil
}'''
src = must_replace(src, path, old_bw, new_bw, "session.go buildWrapper plain fallback")
write(path, src)
must_contain(read(path), path, "plainControlWrapper{}", "session.go uses plainControlWrapper")

# ── 7. openvpn.go: validateControlChannel allow zero keys ─────────────────
path = "openvpn.go"
src = read(path)
old_vcc = '''\tswitch {
\tcase set == 0:
\t\treturn errors.New("openvpn: a control-channel key is required (set one of TLSCryptV1, TLSCryptV2 or TLSAuth)")
\tcase set > 1:
\t\treturn errors.New("openvpn: only one control-channel key may be set (TLSCryptV1, TLSCryptV2 or TLSAuth)")
\t}
\treturn nil
}'''
new_vcc = '''\tswitch {
\tcase set > 1:
\t\treturn errors.New("openvpn: only one control-channel key may be set (TLSCryptV1, TLSCryptV2 or TLSAuth)")
\t}
\t// set == 0 allowed: plain control channel for SoftEther/VPN Gate profiles
\treturn nil
}'''
src = must_replace(src, path, old_vcc, new_vcc, "openvpn.go validateControlChannel allow plain")
write(path, src)
must_contain(read(path), path, "plain control channel for SoftEther", "openvpn.go plain allowed")

# ── 8. parse.go: finalize allow missing control-channel key ───────────────
path = "pkg/ovpn/parse.go"
src = read(path)
old_fin = '''\tswitch {
\tcase ctrlKeys == 0:
\t\treturn nil, errors.New("missing control-channel protection: provide tls-crypt, tls-crypt-v2 or tls-auth (this library requires a protected control channel)")
\tcase ctrlKeys > 1:
\t\treturn nil, errors.New("multiple control-channel keys set; use exactly one of tls-crypt, tls-crypt-v2 or tls-auth")
\t}'''
new_fin = '''\tswitch {
\tcase ctrlKeys > 1:
\t\treturn nil, errors.New("multiple control-channel keys set; use exactly one of tls-crypt, tls-crypt-v2 or tls-auth")
\t}
\t// ctrlKeys == 0 allowed: SoftEther/VPN Gate .ovpn has no tls-auth/tls-crypt'''
src = must_replace(src, path, old_fin, new_fin, "parse.go finalize allow plain")
write(path, src)
must_contain(read(path), path, "SoftEther/VPN Gate", "parse.go plain allowed")

print("[patch] ALL patches applied and verified successfully")
print("[patch] marker: CBC_PLAINCTRL_PATCH_V3_VERIFIED")
