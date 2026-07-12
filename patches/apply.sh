#!/bin/sh
# apply.sh — 在 Docker 构建中对 go-openvpn 源码打 CBC+HMAC 补丁
# 所有补丁通过 Python 统一处理，带验证，失败即中断构建
set -e

echo "[patch] ====== CBC+HMAC patch starting ======"
echo "[patch] pwd: $(pwd)"
echo "[patch] Checking source files exist..."
for f in pkg/ovpn/parse.go internal/control/keys.go internal/data/slot.go internal/session/session.go internal/session/rekey.go; do
    if [ ! -f "$f" ]; then
        echo "[PATCH FATAL] Missing source file: $f"
        ls -la "$(dirname "$f")" 2>/dev/null || true
        exit 1
    fi
    echo "[patch]   OK: $f ($(wc -c < "$f") bytes)"
done

# 1. Copy cbchmac.go
cp /patches/cbchmac.go internal/data/cbchmac.go
echo "[patch] Copied cbchmac.go"

# 2. Run unified Python patcher
python3 /patches/patch_all.py
echo "[patch] ====== CBC+HMAC patch complete ======"
