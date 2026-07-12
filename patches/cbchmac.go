// SPDX-License-Identifier: AGPL-3.0-or-later

package data

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"hash"

	"github.com/n0madic/go-openvpn/internal/proto"
)

// CBCHMACState holds per-direction CBC + HMAC state for non-AEAD data channels
// (e.g. AES-128-CBC + HMAC-SHA1, which is the VPN Gate default).
type CBCHMACState struct {
	block   cipher.Block
	hmacKey []byte
	newHash func() hash.Hash
	hmacLen int
}

// CBCBlockSize is the AES block size (16 bytes).
const CBCBlockSize = aes.BlockSize

// NewCBCHMAC constructs a directional CBC+HMAC state.
// authDigest: "SHA1" (or ""), "SHA256".
func NewCBCHMAC(cipherKey, hmacKey []byte, authDigest string) (*CBCHMACState, error) {
	block, err := aes.NewCipher(cipherKey)
	if err != nil {
		return nil, fmt.Errorf("data: AES cipher: %w", err)
	}
	var newHash func() hash.Hash
	var hmacLen int
	switch authDigest {
	case "SHA1", "":
		newHash = sha1.New
		hmacLen = sha1.Size
	case "SHA256":
		newHash = sha256.New
		hmacLen = sha256.Size
	default:
		return nil, fmt.Errorf("data: unsupported auth digest %q", authDigest)
	}
	return &CBCHMACState{
		block:   block,
		hmacKey: append([]byte(nil), hmacKey...),
		newHash: newHash,
		hmacLen: hmacLen,
	}, nil
}

// HMACLen returns the HMAC output length in bytes.
func (c *CBCHMACState) HMACLen() int { return c.hmacLen }

// sealCBC encrypts plaintext and produces a P_DATA_V2 packet in CBC+HMAC layout:
//
//	opcode_kid(1) | peer_id(3) | HMAC(hmacLen) | IV(16) | AES-CBC(packet_id(4) || plaintext, PKCS7-padded)
//
// The HMAC covers IV || ciphertext (everything after the HMAC field).
func sealCBC(
	cbc *CBCHMACState, keyID uint8, peerID, packetID uint32,
	plaintext []byte,
) ([]byte, error) {
	opcodeKID := proto.PackOpcodeKID(proto.PDataV2, keyID)

	// Inner plaintext: packet_id(4) || original_payload
	innerLen := 4 + len(plaintext)
	padLen := CBCBlockSize - (innerLen % CBCBlockSize)
	paddedLen := innerLen + padLen
	inner := make([]byte, paddedLen)
	binary.BigEndian.PutUint32(inner[:4], packetID)
	copy(inner[4:], plaintext)
	// PKCS7 pad
	for i := innerLen; i < paddedLen; i++ {
		inner[i] = byte(padLen)
	}

	// Random IV
	iv := make([]byte, CBCBlockSize)
	if _, err := rand.Read(iv); err != nil {
		return nil, fmt.Errorf("data: CBC IV: %w", err)
	}

	// Encrypt
	ct := make([]byte, paddedLen)
	cipher.NewCBCEncrypter(cbc.block, iv).CryptBlocks(ct, inner)

	// HMAC over IV || ciphertext
	mac := hmac.New(cbc.newHash, cbc.hmacKey)
	mac.Write(iv)
	mac.Write(ct)
	hmacSum := mac.Sum(nil)

	// Assemble wire packet: header(4) + hmac + iv + ct
	hmacL := cbc.hmacLen
	pktLen := 4 + hmacL + CBCBlockSize + len(ct)
	buf := make([]byte, pktLen)
	buf[0] = opcodeKID
	buf[1] = byte(peerID >> 16)
	buf[2] = byte(peerID >> 8)
	buf[3] = byte(peerID)
	copy(buf[4:4+hmacL], hmacSum)
	copy(buf[4+hmacL:4+hmacL+CBCBlockSize], iv)
	copy(buf[4+hmacL+CBCBlockSize:], ct)
	return buf, nil
}

// ErrCBCHMACVerify signals a CBC+HMAC authentication failure.
var ErrCBCHMACVerify = errors.New("data: CBC HMAC verification failed")

// openCBC decrypts a P_DATA_V2 CBC+HMAC packet and returns the plaintext
// payload (sans packet_id). The returned packetID is for replay checking.
func openCBC(
	cbc *CBCHMACState, keyID uint8, peerID uint32,
	packet []byte,
) (payload []byte, packetID uint32, err error) {
	// Header: opcode_kid(1) | peer_id(3)
	if len(packet) < 4 {
		return nil, 0, fmt.Errorf("data: CBC packet too short: %d", len(packet))
	}
	_, kid := proto.UnpackOpcodeKID(packet[0])
	wirePeerID := uint32(packet[1])<<16 | uint32(packet[2])<<8 | uint32(packet[3])
	if kid != keyID {
		return nil, 0, fmt.Errorf("data: key-id %d != slot %d", kid, keyID)
	}
	if wirePeerID != peerID {
		return nil, 0, fmt.Errorf("data: peer-id %d != slot %d", wirePeerID, peerID)
	}

	body := packet[4:]
	hmacL := cbc.hmacLen
	minBody := hmacL + CBCBlockSize + CBCBlockSize // HMAC + IV + at least 1 block
	if len(body) < minBody {
		return nil, 0, fmt.Errorf("data: CBC body too short: %d (min %d)", len(body), minBody)
	}

	receivedMAC := body[:hmacL]
	ivAndCt := body[hmacL:]

	// Verify HMAC over IV || ciphertext
	mac := hmac.New(cbc.newHash, cbc.hmacKey)
	mac.Write(ivAndCt)
	if !hmac.Equal(receivedMAC, mac.Sum(nil)) {
		return nil, 0, ErrCBCHMACVerify
	}

	iv := ivAndCt[:CBCBlockSize]
	ct := ivAndCt[CBCBlockSize:]
	if len(ct) == 0 || len(ct)%CBCBlockSize != 0 {
		return nil, 0, fmt.Errorf("data: CBC ciphertext not block-aligned: %d", len(ct))
	}

	// Decrypt in-place (ct is a sub-slice of the wire buffer, which is
	// overwritten on the next ReadPacket anyway)
	cipher.NewCBCDecrypter(cbc.block, iv).CryptBlocks(ct, ct)

	// PKCS7 unpad
	padByte := ct[len(ct)-1]
	padN := int(padByte)
	if padN < 1 || padN > CBCBlockSize || padN > len(ct) {
		return nil, 0, fmt.Errorf("data: bad PKCS7 pad: %d", padN)
	}
	for i := len(ct) - padN; i < len(ct); i++ {
		if ct[i] != padByte {
			return nil, 0, errors.New("data: corrupt PKCS7 padding")
		}
	}
	plain := ct[:len(ct)-padN]

	// Extract packet_id
	if len(plain) < 4 {
		return nil, 0, errors.New("data: CBC decrypted too short for packet_id")
	}
	pid := binary.BigEndian.Uint32(plain[:4])
	return plain[4:], pid, nil
}
