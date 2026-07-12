// SPDX-License-Identifier: AGPL-3.0-or-later

package session

import (
	"encoding/binary"
	"fmt"
)

// plainControlWrapper implements an unprotected control channel: the wire
// layout is simply opcode_kid(1) || session_id(8) || ControlPayload.
//
// This matches stock OpenVPN clients connecting without tls-auth/tls-crypt,
// which is how SoftEther/VPN Gate publishes its .ovpn profiles.
type plainControlWrapper struct{}

func (plainControlWrapper) Wrap(opcodeKID byte, sessionID uint64, plaintext []byte) []byte {
	out := make([]byte, 1+8+len(plaintext))
	out[0] = opcodeKID
	binary.BigEndian.PutUint64(out[1:9], sessionID)
	copy(out[9:], plaintext)
	return out
}

func (plainControlWrapper) Unwrap(pkt []byte) (opcodeKID byte, sessionID uint64, packetID uint32, plaintext []byte, err error) {
	if len(pkt) < 9 {
		return 0, 0, 0, nil, fmt.Errorf("session: plain control packet too short: %d", len(pkt))
	}
	opcodeKID = pkt[0]
	sessionID = binary.BigEndian.Uint64(pkt[1:9])
	plaintext = append([]byte(nil), pkt[9:]...)
	return opcodeKID, sessionID, 0, plaintext, nil
}
