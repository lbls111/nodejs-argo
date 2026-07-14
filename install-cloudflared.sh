#!/bin/sh
set -eux
arch=$(uname -m)
case "$arch" in
  x86_64|amd64) cfarch=amd64 ;;
  aarch64|arm64) cfarch=arm64 ;;
  *) cfarch=amd64 ;;
esac
cfver=$(curl -fsSL https://api.github.com/repos/cloudflare/cloudflared/releases/latest | grep -oE '"tag_name":[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)".*/\1/')
if [ -z "$cfver" ]; then cfver=2024.11.1; fi
url=https://github.com/cloudflare/cloudflared/releases/download/${cfver}/cloudflared-linux-${cfarch}
curl -fsSL "$url" -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared
cp /usr/local/bin/cloudflared /tmp/cloudflared
chmod +x /tmp/cloudflared
/usr/local/bin/cloudflared --version