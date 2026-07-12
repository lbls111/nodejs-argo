#!/bin/sh
# ==========================================
# nodejs-argo + 公共 SOCKS5 干净出口
# ==========================================

HEALTH_CHECK_INTERVAL=60
FAILURE_THRESHOLD=3
CACHE_FILE="/tmp/exit-cache.json"
NODE_CACHE_MAX=8

# 与 nodejs-argo 共用运行目录（随机 web 二进制与配置都写在这里）
export FILE_PATH="${FILE_PATH:-/tmp}"
export OUTBOUND_TAG="${OUTBOUND_TAG:-clean-exit}"

echo "=========================================="
echo "  nodejs-argo + SOCKS5 exit (clean IP)"
echo "=========================================="

# ========== 1. 启动 nginx ==========
echo "[1] 启动 nginx..."
nginx

# ========== 2. 启动 nodejs-argo ==========
echo "[2] 启动 nodejs-argo (port 3002, FILE_PATH=$FILE_PATH)..."
PORT=3002 FILE_PATH="$FILE_PATH" node /tmp/index.js &
ARGO_PID=$!

# ========== 3. 启动 exit-proxy ==========
echo "[3] 启动 exit-proxy..."
node /tmp/exit-proxy.js &
EXIT_PID=$!

# ========== 4. 并行等待：argo 落盘 + SOCKS 池 ==========
echo "[4] 等待 xray 与出口池就绪..."

# 后台等 argo 产生可执行/配置（最多 120s）
wait_argo() {
    for i in $(seq 1 60); do
        # 有 >1MB ELF 或 含 inbounds 的 json 即认为 argo 已下载 xray
        FOUND=$(node -e "
const fs=require('fs'),path=require('path');
const root=process.env.FILE_PATH||'/tmp';
function walk(d,depth,acc){if(depth>2)return;let ents=[];try{ents=fs.readdirSync(d,{withFileTypes:true})}catch(e){return}
for(const e of ents){const f=path.join(d,e.name);if(e.isDirectory())walk(f,depth+1,acc);else acc.push(f)}}
const files=[];walk(root,0,files);
let ok=false;
for(const f of files){
  try{
    const st=fs.statSync(f);
    if(st.size>1000000){const b=Buffer.alloc(4);const fd=fs.openSync(f,'r');fs.readSync(fd,b,0,4,0);fs.closeSync(fd);
      if(b[0]===0x7f&&b[1]===0x45){ok=true;break}}
    if(st.size>80&&st.size<2000000){const t=fs.readFileSync(f,'utf8');if(t.includes('inbounds')&&t.includes('outbounds')){ok=true;break}}
  }catch(e){}
}
process.stdout.write(ok?'1':'0');
" 2>/dev/null)
        if [ "$FOUND" = "1" ]; then
            echo "[4] argo/xray 文件已就绪"
            return 0
        fi
        sleep 2
    done
    echo "[4] 警告: 120s 内未检测到 xray 文件"
    return 1
}

wait_exit_pool() {
    for i in $(seq 1 90); do
        STATUS=$(curl -s --max-time 3 http://127.0.0.1:3001/status 2>/dev/null)
        if [ -n "$STATUS" ]; then
            NODE_COUNT=$(echo "$STATUS" | node -e "const d=require('fs').readFileSync(0,'utf8');try{const j=JSON.parse(d);process.stdout.write(String(j.nodes||0))}catch(e){process.stdout.write('0')}" 2>/dev/null)
            if [ "$NODE_COUNT" != "0" ] && [ -n "$NODE_COUNT" ]; then
                echo "[5] exit-proxy 就绪，$NODE_COUNT 个 SOCKS5 可用"
                return 0
            fi
        fi
        sleep 2
    done
    echo "[5] 180 秒内无可用 SOCKS5"
    return 1
}

wait_argo &
WAIT_ARGO_PID=$!
wait_exit_pool
EXIT_READY=$?
wait $WAIT_ARGO_PID 2>/dev/null
ARGO_READY=$?

if [ "$EXIT_READY" != "0" ]; then
    EXIT_READY=0
else
    EXIT_READY=1
fi

apply_exit_node() {
    NODE_JSON="$1"
    if [ -z "$NODE_JSON" ]; then
        return 1
    fi

    HOST=$(echo "$NODE_JSON" | node -e "const d=require('fs').readFileSync(0,'utf8');try{const j=JSON.parse(d);process.stdout.write(j.host||j.ip||'')}catch(e){}" 2>/dev/null)
    PORTN=$(echo "$NODE_JSON" | node -e "const d=require('fs').readFileSync(0,'utf8');try{const j=JSON.parse(d);process.stdout.write(String(j.port||''))}catch(e){}" 2>/dev/null)
    EXITIP=$(echo "$NODE_JSON" | node -e "const d=require('fs').readFileSync(0,'utf8');try{const j=JSON.parse(d);process.stdout.write(j.exitIp||'')}catch(e){}" 2>/dev/null)
    USER=$(echo "$NODE_JSON" | node -e "const d=require('fs').readFileSync(0,'utf8');try{const j=JSON.parse(d);process.stdout.write(j.user||'')}catch(e){}" 2>/dev/null)
    PASS=$(echo "$NODE_JSON" | node -e "const d=require('fs').readFileSync(0,'utf8');try{const j=JSON.parse(d);process.stdout.write(j.pass||'')}catch(e){}" 2>/dev/null)

    if [ -z "$HOST" ] || [ -z "$PORTN" ]; then
        echo "[5] 节点字段无效"
        return 1
    fi

    export SOCKS5_ADDR="${HOST}:${PORTN}"
    export SOCKS5_USER="$USER"
    export SOCKS5_PASS="$PASS"
    export OUTBOUND_TAG="clean-exit"
    export FILE_PATH
    CURRENT_EXIT_IP="$EXITIP"
    CURRENT_EXIT_HOST="$HOST"
    CURRENT_EXIT_PORT="$PORTN"

    echo "[5] 选择出口: $SOCKS5_ADDR exitIp=${EXITIP:-unknown}"

    node -e "
const fs = require('fs');
const node = $NODE_JSON;
let cache = { nodes: [] };
try { cache = JSON.parse(fs.readFileSync('$CACHE_FILE','utf8')); } catch(e) {}
cache.nodes = (cache.nodes || []).filter(n => !(n.host === node.host && n.port === node.port));
cache.nodes.push({ ...node, last_success: Date.now() });
cache.nodes.sort((a,b) => (b.last_success||0) - (a.last_success||0));
cache.nodes = cache.nodes.slice(0, $NODE_CACHE_MAX);
fs.writeFileSync('$CACHE_FILE', JSON.stringify(cache, null, 2));
" 2>/dev/null

    # 同步执行修改，便于看结果
    if node /tmp/modify-xray.js; then
        echo "[5] xray 已改走 clean-exit"
        return 0
    fi
    echo "[5] xray 修改失败"
    return 1
}

load_cached_node() {
    if [ ! -f "$CACHE_FILE" ]; then
        return 1
    fi
    CACHED=$(node -e "
const fs = require('fs');
try {
  const cache = JSON.parse(fs.readFileSync('$CACHE_FILE','utf8'));
  if (cache.nodes && cache.nodes.length > 0) {
    cache.nodes.sort((a,b) => (b.last_success||0) - (a.last_success||0));
    console.log(JSON.stringify(cache.nodes[0]));
  }
} catch(e) {}
" 2>/dev/null)
    if [ -n "$CACHED" ]; then
        echo "[5] 从缓存读取节点"
        return 0
    fi
    return 1
}

SOCKS5_READY=0
CURRENT_EXIT_IP=""
CURRENT_EXIT_HOST=""
CURRENT_EXIT_PORT=""

if [ "$EXIT_READY" = "1" ]; then
    NODE_JSON=""
    if load_cached_node; then
        NODE_JSON="$CACHED"
    fi
    if [ -z "$NODE_JSON" ]; then
        NODE_JSON=$(curl -s --max-time 10 http://127.0.0.1:3001/node 2>/dev/null)
    fi
    if apply_exit_node "$NODE_JSON"; then
        SOCKS5_READY=1
    fi
fi

if [ "$SOCKS5_READY" != "1" ]; then
    echo "[*] 无可用出口或 xray 未改写，使用直连模式"
fi

echo "=========================================="
echo "  服务已启动"
echo "  VLESS/VMess 端口: 3000 (via nginx)"
echo "  订阅端点: /sub"
if [ "$SOCKS5_READY" = "1" ]; then
    echo "  出口: SOCKS5 $CURRENT_EXIT_HOST:$CURRENT_EXIT_PORT ($CURRENT_EXIT_IP)"
else
    echo "  出口: 直连 (Railway IP)"
fi
echo "=========================================="

FAILURE_COUNT=0

while true; do
    sleep $HEALTH_CHECK_INTERVAL

    if ! kill -0 $ARGO_PID 2>/dev/null; then
        echo "[restart] nodejs-argo crashed"
        PORT=3002 FILE_PATH="$FILE_PATH" node /tmp/index.js &
        ARGO_PID=$!
    fi

    if ! kill -0 $EXIT_PID 2>/dev/null; then
        echo "[restart] exit-proxy crashed"
        node /tmp/exit-proxy.js &
        EXIT_PID=$!
    fi

    if [ "$SOCKS5_READY" = "1" ] && [ -n "$CURRENT_EXIT_HOST" ]; then
        HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 --tlsv1.2 \
            --proxy "socks5h://${CURRENT_EXIT_HOST}:${CURRENT_EXIT_PORT}" \
            "https://cp.cloudflare.com/generate_204" 2>/dev/null)

        if [ "$HTTP_CODE" = "204" ] || [ "$HTTP_CODE" = "200" ]; then
            FAILURE_COUNT=0
        else
            FAILURE_COUNT=$((FAILURE_COUNT + 1))
            echo "[probe] 出口探活失败 ($FAILURE_COUNT/$FAILURE_THRESHOLD) code=$HTTP_CODE"

            if [ $FAILURE_COUNT -ge $FAILURE_THRESHOLD ]; then
                echo "[probe] 连续失败，切换出口..."
                FAILURE_COUNT=0
                NEW_NODE=$(curl -s --max-time 10 http://127.0.0.1:3001/node 2>/dev/null)
                if apply_exit_node "$NEW_NODE"; then
                    SOCKS5_READY=1
                    echo "[probe] 已切换到 $CURRENT_EXIT_HOST:$CURRENT_EXIT_PORT"
                else
                    echo "[probe] 切换失败，保持当前配置"
                fi
            fi
        fi
    fi
done
