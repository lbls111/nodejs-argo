#!/bin/sh
# ==========================================
# nodejs-argo + VPN Gate 启动脚本
# 关键：使用 openvpn2socks（用户态，无 TUN/TAP）
# ==========================================

echo "=========================================="
echo "  nodejs-argo + VPN Gate (openvpn2socks)"
echo "=========================================="

# 1. 启动 nginx（端口复用：3000 → nodejs-argo + vpngate-server）
echo "[1] 启动 nginx..."
nginx
echo "[1] nginx 已启动"

# 2. 启动 nodejs-argo（最重要，使用端口 3002 避免与 nginx 冲突）
echo "[2] 启动 nodejs-argo..."
PORT=3002 node /tmp/index.js &
ARGO_PID=$!
echo "[2] nodejs-argo PID: $ARGO_PID (port 3002)"

# 3. 启动 VPN Gate 订阅服务器
echo "[3] 启动 VPN Gate 订阅服务器..."
node /tmp/vpngate-server.js &
VPN_SERVER_PID=$!
echo "[3] VPN Gate 订阅服务器 PID: $VPN_SERVER_PID"

# 4. 等待 xray 配置生成（给 index.js 时间）
echo "[4] 等待 xray 配置生成..."
sleep 8

# 5. 获取 VPN Gate 节点并启动 openvpn2socks
echo "[5] 获取 VPN Gate 节点..."

# 使用 Node.js 脚本获取节点并选择 HK/US 节点
node -e "
const https = require('https');

const url = 'https://www.vpngate.net/api/iphone/';

https.get(url, (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
        const lines = data.split('\n');
        const nodes = [];
        
        for (let i = 2; i < lines.length; i++) {
            const parts = lines[i].split(',');
            if (parts.length < 15) continue;
            
            const countryShort = parts[5]?.trim();
            if (countryShort !== 'HK' && countryShort !== 'US') continue;
            
            const ip = parts[1]?.trim();
            const score = parseInt(parts[2]) || 0;
            const speed = parseInt(parts[4]) || 0;
            const openvpnData = parts[14]?.trim();
            
            if (!ip || !openvpnData) continue;
            
            nodes.push({
                ip,
                country: countryShort,
                score,
                speed,
                openvpn: openvpnData
            });
        }
        
        // 按速度排序，取最快的
        nodes.sort((a, b) => b.speed - a.speed);
        
        if (nodes.length === 0) {
            console.error('No HK/US nodes found');
            process.exit(1);
        }
        
        const best = nodes[0];
        console.log(JSON.stringify(best));
    });
}).on('error', (e) => {
    console.error('Failed to fetch VPN Gate:', e.message);
    process.exit(1);
});
" > /tmp/vpngate-node.json 2>&1

if [ $? -ne 0 ] || [ ! -s /tmp/vpngate-node.json ]; then
    echo "[5] 获取节点失败，使用直连模式"
    VPN_FAILED=1
else
    # 解码 OpenVPN 配置
    NODE_DATA=$(cat /tmp/vpngate-node.json)
    OPENVPN_B64=$(echo "$NODE_DATA" | node -e "const d=require('fs').readFileSync(0,'utf8');const j=JSON.parse(d);process.stdout.write(j.openvpn)")
    
    if [ -z "$OPENVPN_B64" ]; then
        echo "[5] 解码配置失败，使用直连模式"
        VPN_FAILED=1
    else
        # 解码 base64（使用 Node.js 处理，避免 shell base64 问题）
        echo "$OPENVPN_B64" | node -e "const d=require('fs').readFileSync(0,'utf8');process.stdout.write(Buffer.from(d.trim(),'base64').toString('utf-8'))" > /tmp/vpn-config.ovpn
        
        NODE_IP=$(echo "$NODE_DATA" | node -e "const d=require('fs').readFileSync(0,'utf8');const j=JSON.parse(d);process.stdout.write(j.ip)")
        NODE_COUNTRY=$(echo "$NODE_DATA" | node -e "const d=require('fs').readFileSync(0,'utf8');const j=JSON.parse(d);process.stdout.write(j.country)")
        
        echo "[5] 选择节点: $NODE_IP ($NODE_COUNTRY)"
        
        # 启动 openvpn2socks（用户态，无 TUN/TAP，自动处理 gVisor netstack）
        openvpn2socks -listen 0.0.0.0:1080 /tmp/vpn-config.ovpn &
        VPN_PID=$!
        echo "[5] openvpn2socks PID: $VPN_PID"
        
        # 等待 SOCKS5 代理就绪（最多等 30 秒）
        SOCKS5_READY=0
        for i in $(seq 1 15); do
            if nc -z 127.0.0.1 1080 2>/dev/null; then
                echo "[5] SOCKS5 代理就绪"
                SOCKS5_READY=1
                break
            fi
            sleep 2
        done
    fi
fi

# 修改 xray 配置走 VPN Gate（如果就绪）
if [ "$SOCKS5_READY" = "1" ]; then
    echo "[*] 修改 xray 配置走 VPN Gate..."
    node /tmp/modify-xray.js &
else
    echo "[*] VPN Gate 未就绪，使用直连模式"
fi

echo "=========================================="
echo "  服务已启动"
echo "  VLESS/VMess 端口: 3000"
echo "  订阅端点: http://your-railway-url/sub"
if [ "$SOCKS5_READY" = "1" ]; then
    echo "  出口: VPN Gate 节点 ($NODE_IP)"
else
    echo "  出口: 直连 (Railway IP)"
fi
echo "=========================================="

# 监控循环：崩溃自动重启
while true; do
    sleep 15

    # 检查 nodejs-argo（必须运行）
    if ! kill -0 $ARGO_PID 2>/dev/null; then
        echo "[restart] nodejs-argo crashed, restarting..."
        PORT=3002 node /tmp/index.js &
        ARGO_PID=$!
    fi

    # 检查 VPN Gate 订阅服务器（必须运行）
    if ! kill -0 $VPN_SERVER_PID 2>/dev/null; then
        echo "[restart] VPN Gate 订阅服务器 crashed, restarting..."
        node /tmp/vpngate-server.js &
        VPN_SERVER_PID=$!
    fi

    # 检查 openvpn2socks（可选，失败不重启）
    if [ "$SOCKS5_READY" = "1" ] && ! kill -0 $VPN_PID 2>/dev/null; then
        echo "[restart] openvpn2socks crashed, using direct mode..."
        SOCKS5_READY=0
    fi
done
