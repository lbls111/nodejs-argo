#!/bin/sh
# apply.sh — 在 Docker 构建中对 go-openvpn 源码打 CBC+HMAC 补丁
# 用法: 在 go-openvpn 源码根目录运行
set -e

echo "[patch] 开始应用 CBC+HMAC 补丁..."

# 1. 复制新文件 cbchmac.go
cp /patches/cbchmac.go internal/data/cbchmac.go
echo "[patch] 已添加 internal/data/cbchmac.go"

# 2. parse.go — 扩展 validateCiphers 白名单
sed -i 's/case "AES-256-GCM", "AES-128-GCM", "CHACHA20-POLY1305":/case "AES-256-GCM", "AES-128-GCM", "CHACHA20-POLY1305", "AES-128-CBC", "AES-256-CBC":/' pkg/ovpn/parse.go
sed -i 's/(AEAD only: AES-256-GCM, AES-128-GCM, CHACHA20-POLY1305)/(supported: AES-256-GCM, AES-128-GCM, CHACHA20-POLY1305, AES-128-CBC, AES-256-CBC)/' pkg/ovpn/parse.go
echo "[patch] 已修改 pkg/ovpn/parse.go"

# 3. keys.go — 扩展 AEADKeyLen + 添加 IsCBCCipher/HMACKeyLen + HMAC key 方法
# 3a. 扩展 AEADKeyLen switch 加入 CBC
sed -i 's/case "AES-256-GCM", "CHACHA20-POLY1305":/case "AES-256-GCM", "CHACHA20-POLY1305", "AES-256-CBC":/' internal/control/keys.go
sed -i 's/case "AES-128-GCM":/case "AES-128-GCM", "AES-128-CBC":/' internal/control/keys.go

# 3b. 在文件末尾添加新函数和方法
cat >> internal/control/keys.go << 'GOEOF'

// IsCBCCipher reports whether the named cipher uses CBC+HMAC mode.
func IsCBCCipher(cipher string) bool {
	switch cipher {
	case "AES-128-CBC", "AES-256-CBC":
		return true
	}
	return false
}

// HMACKeyLen returns the HMAC key length for the given auth digest.
// Empty string defaults to SHA1.
func HMACKeyLen(auth string) (int, error) {
	switch auth {
	case "SHA1", "":
		return 20, nil
	case "SHA256":
		return 32, nil
	default:
		return 0, fmt.Errorf("control: unsupported auth digest %q for CBC+HMAC", auth)
	}
}

// ClientToServerHMACKey returns the first keyLen bytes of the c->s HMAC slot.
// Used for CBC+HMAC data channels.
func (m *DataKeyMaterial) ClientToServerHMACKey(keyLen int) []byte {
	return m[64 : 64+keyLen]
}

// ServerToClientHMACKey returns the first keyLen bytes of the s->c HMAC slot.
func (m *DataKeyMaterial) ServerToClientHMACKey(keyLen int) []byte {
	return m[192 : 192+keyLen]
}
GOEOF
echo "[patch] 已修改 internal/control/keys.go"

# 4. slot.go — 修改 Slot struct / SlotConfig / NewSlot / Seal / Open / OpenInto
# 这里用 Python 做精确的源码修改（Alpine 默认有 python3）
python3 /patches/patch_slot.py internal/data/slot.go
echo "[patch] 已修改 internal/data/slot.go"

# 5. session.go — 修改 buildSlot
python3 /patches/patch_session.py internal/session/session.go
echo "[patch] 已修改 internal/session/session.go"

# 6. rekey.go — 修改 rekey NewSlot 调用
python3 /patches/patch_rekey.py internal/session/rekey.go
echo "[patch] 已修改 internal/session/rekey.go"

echo "[patch] CBC+HMAC 补丁应用完成"
