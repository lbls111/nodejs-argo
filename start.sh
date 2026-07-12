#!/bin/sh
# ==========================================
# nodejs-argo + VPN Gate 完整启动脚本
# 架构：客户端 → VLESS/VMess → Railway → VPN Gate → 互联网
# ==========================================

echo "=========================================="
echo "  nodejs-argo + VPN Gate"
echo "  Exit IP: VPN Gate Node"
echo "=========================================="

# 1. 启动 VPN Gate SOCKS5 代理（后台）
echo "[1/4] 启动 VPN Gate SOCKS5 代理..."
/usr/local/bin/vpngate-runner &
VPN_PID=$!
echo "[1/4] VPN Gate PID: $VPN_PID"

# 2. 等待 SOCKS5 代理就绪
echo "[2/4] 等待 SOCKS5 代理就绪..."
for i in $(seq 1 30); do
    if nc -z 127.0.0.1 1080 2>/dev/null; then
        echo "[2/4] SOCKS5 代理就绪"
        break
    fi
    sleep 2
done

# 3. 启动 nodejs-argo（后台）
echo "[3/4] 启动 nodejs-argo..."
node /tmp/index.js &
ARGO_PID=$!
echo "[3/4] nodejs-argo PID: $ARGO_PID"

# 4. 等待 xray 配置生成，然后修改配置走 SOCKS5
echo "[4/4] 等待 xray 配置生成..."
sleep 10
node /tmp/modify-xray.js &
MODIFY_PID=$!
echo "[4/4] 配置修改器 PID: $MODIFY_PID"

echo "=========================================="
echo "  所有服务已启动"
echo "  VLESS/VMess 端口: 3000"
echo "  SOCKS5 代理端口: 1080"
echo "  出口 IP: VPN Gate Node"
echo "=========================================="

# 监控循环：崩溃自动重启
while true; do
    sleep 20

    # 检查 VPN Gate
    if ! kill -0 $VPN_PID 2>/dev/null; then
        echo "[restart] VPN Gate crashed, restarting..."
        /usr/local/bin/vpngate-runner &
        VPN_PID=$!
    fi

    # 检查 nodejs-argo
    if ! kill -0 $ARGO_PID 2>/dev/null; then
        echo "[restart] nodejs-argo crashed, restarting..."
        node /tmp/index.js &
        ARGO_PID=$!
        # 重新修改 xray 配置
        sleep 10
        node /tmp/modify-xray.js &
    fi
done
