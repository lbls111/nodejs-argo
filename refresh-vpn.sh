#!/bin/sh
# ==========================================
# VPN Gate 节点刷新脚本
# 定期调用以切换到新的 VPN Gate 节点
# ==========================================

echo "[$(date)] 刷新 VPN Gate 节点..."

# 停止旧的 openvpn2socks
if [ -n "$VPN_PID" ] && kill -0 $VPN_PID 2>/dev/null; then
    echo "[$(date)] 停止旧的 openvpn2socks..."
    kill $VPN_PID 2>/dev/null
    sleep 2
fi

# 获取新节点
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
    echo "[$(date)] 获取节点失败"
    exit 1
fi

# 解码配置
NODE_DATA=$(cat /tmp/vpngate-node.json)
OPENVPN_B64=$(echo "$NODE_DATA" | node -e "const d=require('fs').readFileSync(0,'utf8');const j=JSON.parse(d);process.stdout.write(j.openvpn)")

if [ -z "$OPENVPN_B64" ]; then
    echo "[$(date)] 解码配置失败"
    exit 1
fi

# 解码 base64
echo "$OPENVPN_B64" | base64 -d > /tmp/vpn-config.ovpn 2>/dev/null

# 确保使用 TCP 模式
sed -i 's/^proto udp/proto tcp/' /tmp/vpn-config.ovpn 2>/dev/null || \
sed -i '1a proto tcp' /tmp/vpn-config.ovpn 2>/dev/null

# 移除需要 TUN 的配置行
sed -i '/^dev /d' /tmp/vpn-config.ovpn 2>/dev/null
sed -i '/^dev-type /d' /tmp/vpn-config.ovpn 2>/dev/null

# 添加必要的配置
echo "dev null" >> /tmp/vpn-config.ovpn

NODE_IP=$(echo "$NODE_DATA" | node -e "const d=require('fs').readFileSync(0,'utf8');const j=JSON.parse(d);process.stdout.write(j.ip)")
NODE_COUNTRY=$(echo "$NODE_DATA" | node -e "const d=require('fs').readFileSync(0,'utf8');const j=JSON.parse(d);process.stdout.write(j.country)")

echo "[$(date)] 切换到节点: $NODE_IP ($NODE_COUNTRY)"

# 启动新的 openvpn2socks
if [ -s /tmp/ta.key ]; then
    openvpn2socks -listen 0.0.0.0:1080 -config /tmp/vpn-config.ovpn -tls-auth /tmp/ta.key &
else
    openvpn2socks -listen 0.0.0.0:1080 -config /tmp/vpn-config.ovpn &
fi
VPN_PID=$!

# 等待就绪
for i in $(seq 1 10); do
    if nc -z 127.0.0.1 1080 2>/dev/null; then
        echo "[$(date)] 新节点就绪: $NODE_IP"
        exit 0
    fi
    sleep 1
done

echo "[$(date)] 节点启动超时"
exit 1
