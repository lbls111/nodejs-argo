#!/bin/sh
# ==========================================
# nodejs-argo + VPN Gate 启动脚本
# 设计原则：低调行驶，避免触发平台滥用检测
# ==========================================

# ========== 配置 ==========
HEALTH_CHECK_INTERVAL=60
HEALTH_CHECK_URL="https://cp.cloudflare.com/generate_204"
HEALTH_CHECK_TIMEOUT=5
FAILURE_THRESHOLD=3
CACHE_FILE="/tmp/vpn-cache.json"
NODE_CACHE_MAX=5
RECONNECT_ATTEMPTS=3
SCAN_DELAY_MIN=200
SCAN_DELAY_MAX=500
SCAN_SAMPLE_SIZE=20

echo "=========================================="
echo "  nodejs-argo + VPN Gate (低调模式)"
echo "=========================================="

# ========== 1. 启动 nginx ==========
echo "[1] 启动 nginx..."
nginx

# ========== 2. 启动 nodejs-argo ==========
echo "[2] 启动 nodejs-argo (port 3002)..."
PORT=3002 node /tmp/index.js &
ARGO_PID=$!

# ========== 3. 启动 VPN Gate 订阅服务器 ==========
echo "[3] 启动 VPN Gate 订阅服务器..."
node /tmp/vpngate-server.js &
VPN_SERVER_PID=$!

# ========== 4. 等待 xray 配置生成 ==========
echo "[4] 等待 xray 配置生成..."
sleep 8

# ========== 5. 等待 VPN Gate 爬取完成 + 获取节点 ==========
echo "[5] 等待 VPN Gate 节点就绪..."

# 5a. 轮询 /status 直到有可用节点（最多等 120 秒）
VPN_READY=0
for i in $(seq 1 60); do
    STATUS=$(curl -s --max-time 3 http://127.0.0.1:3001/status 2>/dev/null)
    if [ -n "$STATUS" ]; then
        NODE_COUNT=$(echo "$STATUS" | node -e "const d=require('fs').readFileSync(0,'utf8');try{const j=JSON.parse(d);process.stdout.write(String(j.nodes||0))}catch(e){process.stdout.write('0')}" 2>/dev/null)
        if [ "$NODE_COUNT" != "0" ] && [ -n "$NODE_COUNT" ]; then
            echo "[5] VPN Gate 就绪，$NODE_COUNT 个节点可用"
            VPN_READY=1
            break
        fi
    fi
    sleep 2
done

if [ "$VPN_READY" = "0" ]; then
    echo "[5] VPN Gate 120 秒内未就绪，使用直连模式"
fi

# 5b. 先尝试从缓存读取
load_cached_node() {
    if [ -f "$CACHE_FILE" ]; then
        # 读取缓存中的节点，按 last_success 倒序
        CACHED_IP=$(node -e "
const fs = require('fs');
try {
    const cache = JSON.parse(fs.readFileSync('$CACHE_FILE','utf8'));
    if (cache.nodes && cache.nodes.length > 0) {
        cache.nodes.sort((a,b) => (b.last_success||0) - (a.last_success||0));
        const best = cache.nodes[0];
        console.log(JSON.stringify(best));
    }
} catch(e) {}
" 2>/dev/null)
        if [ -n "$CACHED_IP" ]; then
            echo "[5] 从缓存读取节点"
            return 0
        fi
    fi
    return 1
}

# 5b. 从 VPN Gate 爬取新节点（低并发、随机延迟、反扫描）
fetch_vpngate_node() {
    node -e "
const https = require('https');

// 随机延迟函数（反扫描特征）
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// 从 API 获取节点列表
function fetchNodes() {
    return new Promise((resolve, reject) => {
        https.get('https://www.vpngate.net/api/iphone/', { timeout: 15000 }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

// TCP 探测（单个节点，带超时）
function tcpProbe(ip, port = 443) {
    const net = require('net');
    return new Promise(resolve => {
        const sock = net.createConnection({ host: ip, port, timeout: 3000 });
        sock.on('connect', () => { sock.destroy(); resolve(true); });
        sock.on('timeout', () => { sock.destroy(); resolve(false); });
        sock.on('error', () => { sock.destroy(); resolve(false); });
    });
}

async function main() {
    const raw = await fetchNodes();
    const lines = raw.trim().split('\n');
    const allNodes = [];

    for (let i = 2; i < lines.length; i++) {
        const parts = lines[i].split(',');
        if (parts.length < 15) continue;
        const country = parts[5]?.trim();
        if (country !== 'HK' && country !== 'US') continue;
        const ip = parts[1]?.trim();
        const score = parseInt(parts[2]) || 0;
        const speed = parseInt(parts[4]) || 0;
        const openvpn = parts[14]?.trim();
        if (!ip || !openvpn) continue;
        allNodes.push({ ip, country, score, speed, openvpn });
    }

    if (allNodes.length === 0) {
        console.error('No HK/US nodes found');
        process.exit(1);
    }

    // 按 score 降序排序，取前 $SCAN_SAMPLE_SIZE 个候选
    allNodes.sort((a, b) => b.score - a.score);
    const candidates = allNodes.slice(0, $SCAN_SAMPLE_SIZE);

    // 串行探测，每个间隔 200-500ms 随机延迟（反扫描）
    for (const node of candidates) {
        const delay = $SCAN_DELAY_MIN + Math.random() * ($SCAN_DELAY_MAX - $SCAN_DELAY_MIN);
        await sleep(delay);

        const alive = await tcpProbe(node.ip);
        if (alive) {
            console.log(JSON.stringify(node));
            process.exit(0);
        }
    }

    console.error('No alive nodes found in sample');
    process.exit(1);
}

main().catch(e => { console.error(e.message); process.exit(1); });
" 2>/dev/null
}

# 5c. 获取节点：优先缓存，失败才从本地 vpngate-server 获取
NODE_JSON=""
if load_cached_node; then
    NODE_JSON="$CACHED_IP"
fi

if [ -z "$NODE_JSON" ]; then
    # 从本地 vpngate-server 获取（已确认有节点）
    NODE_JSON=$(curl -s --max-time 10 http://127.0.0.1:3001/node 2>/dev/null)
fi

if [ -z "$NODE_JSON" ]; then
    echo "[5] 无法获取节点，使用直连模式"
    VPN_FAILED=1
else
    # 解码 OpenVPN 配置
    OPENVPN_B64=$(echo "$NODE_JSON" | node -e "const d=require('fs').readFileSync(0,'utf8');const j=JSON.parse(d);process.stdout.write(j.openvpn||'')")
    
    if [ -z "$OPENVPN_B64" ]; then
        echo "[5] 解码配置失败，使用直连模式"
        VPN_FAILED=1
    else
        echo "$OPENVPN_B64" | node -e "const d=require('fs').readFileSync(0,'utf8');process.stdout.write(Buffer.from(d.trim(),'base64').toString('utf-8'))" > /tmp/vpn-config.ovpn

        NODE_IP=$(echo "$NODE_JSON" | node -e "const d=require('fs').readFileSync(0,'utf8');const j=JSON.parse(d);process.stdout.write(j.ip||'')")
        NODE_COUNTRY=$(echo "$NODE_JSON" | node -e "const d=require('fs').readFileSync(0,'utf8');const j=JSON.parse(d);process.stdout.write(j.country||'')")

        echo "[5] 选择节点: $NODE_IP ($NODE_COUNTRY)"

        # 提取 TLS 密钥到单独文件（openvpn2socks 要求）
        # VPN Gate 配置中 tls-auth key 是内联的，需要提取出来
        TLS_ARGS=""
        if grep -q "tls-auth" /tmp/vpn-config.ovpn 2>/dev/null; then
            # 提取 -----BEGIN OpenVPN Static key V1----- 到 -----END----- 之间的内容
            sed -n '/BEGIN OpenVPN Static key/,/END OpenVPN Static key/p' /tmp/vpn-config.ovpn > /tmp/ta.key
            if [ -s /tmp/ta.key ]; then
                TLS_ARGS="-tls-auth /tmp/ta.key"
                echo "[5] 检测到 tls-auth 密钥"
            fi
        elif grep -q "tls-crypt" /tmp/vpn-config.ovpn 2>/dev/null; then
            sed -n '/BEGIN OpenVPN Static/,/END OpenVPN Static/p' /tmp/vpn-config.ovpn > /tmp/tc.key
            if [ -s /tmp/tc.key ]; then
                TLS_ARGS="-tls-crypt /tmp/tc.key"
                echo "[5] 检测到 tls-crypt 密钥"
            fi
        fi

        # 启动 openvpn2socks
        openvpn2socks -listen 0.0.0.0:1080 -server /tmp/vpn-config.ovpn $TLS_ARGS &
        VPN_PID=$!

        # 等待 SOCKS5 就绪
        SOCKS5_READY=0
        for i in $(seq 1 15); do
            if nc -z 127.0.0.1 1080 2>/dev/null; then
                echo "[5] SOCKS5 代理就绪"
                SOCKS5_READY=1
                break
            fi
            sleep 2
        done

        # 更新缓存
        node -e "
const fs = require('fs');
const node = $NODE_JSON;
let cache = { nodes: [] };
try { cache = JSON.parse(fs.readFileSync('$CACHE_FILE','utf8')); } catch(e) {}
// 去重
cache.nodes = cache.nodes.filter(n => n.ip !== node.ip);
// 添加当前节点
cache.nodes.push({ ...node, last_success: Date.now() });
// 只保留最近 N 个
cache.nodes.sort((a,b) => (b.last_success||0) - (a.last_success||0));
cache.nodes = cache.nodes.slice(0, $NODE_CACHE_MAX);
fs.writeFileSync('$CACHE_FILE', JSON.stringify(cache, null, 2));
" 2>/dev/null
    fi
fi

# ========== 6. 修改 xray 配置 ==========
if [ "$SOCKS5_READY" = "1" ]; then
    echo "[*] 修改 xray 配置走 VPN Gate..."
    node /tmp/modify-xray.js &
else
    echo "[*] VPN Gate 未就绪，使用直连模式"
fi

echo "=========================================="
echo "  服务已启动"
echo "  VLESS/VMess 端口: 3000 (via nginx)"
echo "  订阅端点: /sub"
if [ "$SOCKS5_READY" = "1" ]; then
    echo "  出口: VPN Gate ($NODE_IP)"
else
    echo "  出口: 直连 (Railway IP)"
fi
echo "=========================================="

# ========== 监控循环（极轻量） ==========
FAILURE_COUNT=0

while true; do
    # 极轻量监控：每 60 秒检查一次
    sleep $HEALTH_CHECK_INTERVAL

    # 检查 nodejs-argo（进程存活即可）
    if ! kill -0 $ARGO_PID 2>/dev/null; then
        echo "[restart] nodejs-argo crashed"
        PORT=3002 node /tmp/index.js &
        ARGO_PID=$!
    fi

    # 检查 vpngate-server（进程存活即可）
    if ! kill -0 $VPN_SERVER_PID 2>/dev/null; then
        echo "[restart] VPN Gate server crashed"
        node /tmp/vpngate-server.js &
        VPN_SERVER_PID=$!
    fi

    # 仅在 VPN Gate 模式下做轻量探活
    if [ "$SOCKS5_READY" = "1" ]; then
        # 先检查 openvpn2socks 进程是否还活着
        if ! kill -0 $VPN_PID 2>/dev/null; then
            echo "[probe] openvpn2socks 进程已死，等待自动重连..."
            # openvpn2socks 有 AutoReconnect，先等它自己重连
            sleep 10
            if kill -0 $VPN_PID 2>/dev/null; then
                echo "[probe] openvpn2socks 已自动重连"
                FAILURE_COUNT=0
                continue
            fi
        fi

        # 极轻量 HTTPS 探活（TLS 握手无法伪造，防劫持）
        HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time $HEALTH_CHECK_TIMEOUT --tlsv1.2 --proxy socks5://127.0.0.1:1080 "$HEALTH_CHECK_URL" 2>/dev/null)

        if [ "$HTTP_CODE" = "204" ] || [ "$HTTP_CODE" = "200" ]; then
            FAILURE_COUNT=0
        else
            FAILURE_COUNT=$((FAILURE_COUNT + 1))
            echo "[probe] 探活失败 ($FAILURE_COUNT/$FAILURE_THRESHOLD)"

            if [ $FAILURE_COUNT -ge $FAILURE_THRESHOLD ]; then
                echo "[probe] 连续 $FAILURE_THRESHOLD 次失败，触发重选..."
                FAILURE_COUNT=0

                # 先尝试 openvpn2socks 内置重连
                if kill -0 $VPN_PID 2>/dev/null; then
                    kill $VPN_PID 2>/dev/null
                    sleep 3
                fi

                # 尝试缓存节点
                CACHED=$(load_cached_node && echo "$CACHED_IP" || echo "")
                if [ -n "$CACHED" ]; then
                    NEW_B64=$(echo "$CACHED" | node -e "const d=require('fs').readFileSync(0,'utf8');const j=JSON.parse(d);process.stdout.write(j.openvpn||'')")
                    if [ -n "$NEW_B64" ]; then
                        echo "$NEW_B64" | node -e "const d=require('fs').readFileSync(0,'utf8');process.stdout.write(Buffer.from(d.trim(),'base64').toString('utf-8'))" > /tmp/vpn-config.ovpn
                        # 提取 TLS 密钥
                        TLS_ARGS=""
                        if grep -q "tls-auth" /tmp/vpn-config.ovpn 2>/dev/null; then
                            sed -n '/BEGIN OpenVPN Static key/,/END OpenVPN Static key/p' /tmp/vpn-config.ovpn > /tmp/ta.key
                            [ -s /tmp/ta.key ] && TLS_ARGS="-tls-auth /tmp/ta.key"
                        elif grep -q "tls-crypt" /tmp/vpn-config.ovpn 2>/dev/null; then
                            sed -n '/BEGIN OpenVPN Static/,/END OpenVPN Static/p' /tmp/vpn-config.ovpn > /tmp/tc.key
                            [ -s /tmp/tc.key ] && TLS_ARGS="-tls-crypt /tmp/tc.key"
                        fi
                        openvpn2socks -listen 0.0.0.0:1080 -server /tmp/vpn-config.ovpn $TLS_ARGS &
                        VPN_PID=$!
                        sleep 5
                        if nc -z 127.0.0.1 1080 2>/dev/null; then
                            echo "[probe] 缓存节点连接成功"
                            node /tmp/modify-xray.js &
                            continue
                        fi
                    fi
                fi

                # 缓存失败，从本地 vpngate-server 获取新节点
                NEW_NODE=$(curl -s --max-time 10 http://127.0.0.1:3001/node 2>/dev/null)
                if [ -n "$NEW_NODE" ]; then
                    NEW_B64=$(echo "$NEW_NODE" | node -e "const d=require('fs').readFileSync(0,'utf8');const j=JSON.parse(d);process.stdout.write(j.openvpn||'')")
                    if [ -n "$NEW_B64" ]; then
                        echo "$NEW_B64" | node -e "const d=require('fs').readFileSync(0,'utf8');process.stdout.write(Buffer.from(d.trim(),'base64').toString('utf-8'))" > /tmp/vpn-config.ovpn
                        NEW_IP=$(echo "$NEW_NODE" | node -e "const d=require('fs').readFileSync(0,'utf8');const j=JSON.parse(d);process.stdout.write(j.ip||'')")
                        echo "[probe] 切换到新节点: $NEW_IP"
                        # 提取 TLS 密钥
                        TLS_ARGS=""
                        if grep -q "tls-auth" /tmp/vpn-config.ovpn 2>/dev/null; then
                            sed -n '/BEGIN OpenVPN Static key/,/END OpenVPN Static key/p' /tmp/vpn-config.ovpn > /tmp/ta.key
                            [ -s /tmp/ta.key ] && TLS_ARGS="-tls-auth /tmp/ta.key"
                        elif grep -q "tls-crypt" /tmp/vpn-config.ovpn 2>/dev/null; then
                            sed -n '/BEGIN OpenVPN Static/,/END OpenVPN Static/p' /tmp/vpn-config.ovpn > /tmp/tc.key
                            [ -s /tmp/tc.key ] && TLS_ARGS="-tls-crypt /tmp/tc.key"
                        fi
                        openvpn2socks -listen 0.0.0.0:1080 -server /tmp/vpn-config.ovpn $TLS_ARGS &
                        VPN_PID=$!
                        sleep 5
                        if nc -z 127.0.0.1 1080 2>/dev/null; then
                            node /tmp/modify-xray.js &
                        fi
                    fi
                fi
            fi
        fi
    fi
done
