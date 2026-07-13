# ==========================================
# nodejs-argo + 公共 SOCKS5 干净出口（inline modify）
# ==========================================

HEALTH_CHECK_INTERVAL=60
FAILURE_THRESHOLD=3
CACHE_FILE="/tmp/exit-cache.json"
NODE_CACHE_MAX=8

export FILE_PATH="${FILE_PATH:-/tmp}"
export OUTBOUND_TAG="${OUTBOUND_TAG:-clean-exit}"

echo "=========================================="
echo "  nodejs-argo + SOCKS5 exit (clean IP)"
echo "=========================================="

echo "[1] 启动 nginx..."
nginx

echo "[2] 启动 nodejs-argo..."
PORT=3002 FILE_PATH="$FILE_PATH" node /tmp/index.js &
ARGO_PID=$!

echo "[3] 启动 exit-proxy..."
node /tmp/exit-proxy.js &
EXIT_PID=$!

# ============================================================
# modify-xray 内联实现（不依赖 /tmp/modify-xray.js 文件）
# ============================================================
modify_xray_inline() {
    SOCKS5_HOST="$1"
    SOCKS5_PORT="$2"
    SOCKS5_USER="${3:-}"
    SOCKS5_PASS="${4:-}"
    TAG="${5:-clean-exit}"

    node -e "
const fs=require('fs'),path=require('path'),{execSync,spawn}=require('child_process');
const root=process.env.FILE_PATH||'/tmp';
const tag='$TAG';
const socksAddr='$SOCKS5_HOST:$SOCKS5_PORT';

function log(m){console.log('[xray-mod] '+m)}

function safeReadJson(f){
  try{const r=fs.readFileSync(f,'utf8');if(!r||(r[0]!=='{'&&r[0]!=='['))return null;return JSON.parse(r)}catch(e){return null}
}

function isXrayConfig(j){
  return j&&typeof j==='object'&&Array.isArray(j.inbounds)&&j.inbounds.length>0
}

function walk(d,depth,acc){
  if(depth>2)return;
  let ents=[];
  try{ents=fs.readdirSync(d,{withFileTypes:true})}catch(e){return}
  for(const e of ents){const f=path.join(d,e.name);if(e.isDirectory())walk(f,depth+1,acc);else acc.push(f)}
}

// 1) Detect config
function findConfig(){
  // Pars from ps aux
  try{
    const out=execSync('ps auxww 2>/dev/null||ps -ef',{encoding:'utf8',timeout:3000});
    for(const line of out.split(/\\r?\\n/)){
      const m=line.match(/\\s(\\S+)\\s+run\\s+-c\\s+(\\S+)/)||line.match(/\\s-c\\s+(\\S+)/);
      if(m){
        const cfg=m[2]||m[1];
        if(cfg&&fs.existsSync(cfg)){const j=safeReadJson(cfg);if(isXrayConfig(j)){return{path:cfg,config:j,bin:m[1]}}}
      }
      const paths=line.match(/(\\/\\S+)/g)||[];
      for(const p of paths){if(p.endsWith('.json')&&fs.existsSync(p)){const j=safeReadJson(p);if(isXrayConfig(j))return{path:p,config:j}}}
    }
  }catch(e){}

  // Scan filesystem
  const files=[];
  walk(root,0,files);
  const cands=files
    .filter(f=>{const b=path.basename(f).toLowerCase();return b.endsWith('.json')})
    .map(f=>{try{const s=fs.statSync(f);return{f,mtime:s.mtimeMs}}catch(e){return null}})
    .filter(Boolean)
    .sort((a,b)=>b.mtime-a.mtime);
  for(const c of cands){
    if(c.mtime<Date.now()-300000){continue} // only recent
    const j=safeReadJson(c.f);
    if(isXrayConfig(j)){log('found config: '+c.f);return{path:c.f,config:j}}
  }
  return null
}

// 2) Detect ELF binary (xray)
function findBin(configPath){
  const roots=[path.dirname(configPath||root),root,'/tmp'];
  const seen={};
  for(const base of roots){
    const abs=path.resolve(base);
    if(seen[abs]||!fs.existsSync(abs))continue;
    seen[abs]=true;
    const files=[];
    walk(abs,0,files);
    for(const f of files){
      try{
        const st=fs.statSync(f);
        if(!st.isFile()||st.size<1000000)continue;
        const fd=fs.openSync(f,'r');const buf=Buffer.alloc(4);fs.readSync(fd,buf,0,4,0);fs.closeSync(fd);
        if(buf[0]===0x7f&&buf[1]===0x45&&buf[2]===0x4c&&buf[3]===0x46){ //ELF
          const bn=path.basename(f).toLowerCase();
          if(!bn.includes('bot')&&!bn.includes('npm')&&!bn.includes('php')){log('found bin: '+f);return f}
        }
      }catch(e){}
    }
  }
  // fallback
  for(const p of['/tmp/web',path.join(root,'web')]){if(fs.existsSync(p)){log('found bin(web): '+p);return p}}
  return null
}

// 3) Reuse existing egress outbound（保留入站端口不变）
function modifyConfig(cfg){
  const server={address:'$SOCKS5_HOST',port:$SOCKS5_PORT};
  const u='$SOCKS5_USER',p='$SOCKS5_PASS';
  const socks={protocol:'socks',settings:{servers:[server]}};
  if(u&&p)socks.settings.servers[0].users=[{user:u,pass:p}];
  if(!cfg.outbounds)cfg.outbounds=[];

  const skipTags=['dns','block','api','inbound-'];
  for(let i=0;i<cfg.outbounds.length;i++){
    const o=cfg.outbounds[i];
    if(!o)continue;
    if(o.protocol==='dns'||o.protocol==='blackhole')continue;
    if(o.tag&&skipTags.some(k=>o.tag.startsWith(k)))continue;
    // 替换协议与设置，保留原 tag
    log('outbound: replace ['+o.tag+'] ('+o.protocol+') -> socks -> '+server.address+':'+server.port);
    cfg.outbounds[i]={...socks,tag:o.tag};
    log('done: '+o.tag+' -> SOCKS5');
    return cfg
  }
  // fallback：没有可替换的出站，追加新出站
  cfg.outbounds.unshift({...socks,tag:tag});
  log('done: added SOCKS5 outbound (no egress found)');
  return cfg
}
// Ensure SOCKS outbound is at index 0 (default egress for unmatched routing)
function ensureSocksFirst(cfg){
  const idx=cfg.outbounds.findIndex(o=>o&&o.protocol==='socks');
  if(idx>0){
    const our=cfg.outbounds.splice(idx,1)[0];
    cfg.outbounds.unshift(our);
    log('moved SOCKS5 to index 0 (default egress)')
  }
}

// 4) Restart xray (nohup + $! for reliable PID)
function restartXray(bin,cfgPath){
  try{execSync('pkill -f \"'+path.basename(bin)+'\"',{stdio:'ignore'})}catch(e){}
  try{execSync('pkill -f \"xray run\"',{stdio:'ignore'})}catch(e){}
  try{execSync('sleep 1',{stdio:'ignore'})}catch(e){}
  try{fs.chmodSync(bin,0o755)}catch(e){}
  log('starting: '+bin+' run -c '+cfgPath);
  try{
    const out=execSync(bin+' run -c '+cfgPath+' >/dev/null 2>&1 & echo \$!',{encoding:'utf8',timeout:5000}).trim();
    const pid=out.split(/\\s/).filter(Boolean).pop();
    if(pid&&/^\\d+$/.test(pid)){
      log('started PID: '+pid);
      try{fs.writeFileSync('/tmp/xray.pid',String(pid),'utf8');log('pid written: /tmp/xray.pid='+pid)}catch(e){}
    } else{log('WARNING: xray PID not found, pgrep output: '+out)}
  }catch(e){log('start error: '+e.message)}
}

const found=findConfig();
if(!found){
  log('ERROR: no xray config found')
  process.exit(1)
}
// 打印入站端口用于诊断
if(found.config&&found.config.inbounds){
  found.config.inbounds.forEach(function(ib,i){
    var info=ib.protocol||'?';
    if(ib.port!==undefined)info+=' port='+ib.port;
    if(ib.listen)info+=' listen='+ib.listen;
    log('inbound['+i+']: '+info)
  })
}
const modified=modifyConfig(found.config);
ensureSocksFirst(modified);
const backup=found.path+'.backup';
try{fs.copyFileSync(found.path,backup);log('backed up: '+backup)}catch(e){log('backup fail: '+e.message)}
fs.writeFileSync(found.path,JSON.stringify(modified,null,2),'utf-8');
log('config written: '+found.path);
const bin=found.bin||findBin(found.path);
if(bin){
  try{fs.writeFileSync('/tmp/xray.bin',String(bin),'utf8')}catch(e){}
  restartXray(bin,found.path)
}
else{log('WARNING: bin not found, config written only');log('Hint: xray may be named differently or at /tmp/web')}
log('========== xray-mod done ==========')
" 2>&1
}

# ============================================================
# ============================================================

echo "[4] 等待 xray 与出口池就绪..."

wait_argo() {
    for i in $(seq 1 60); do
        FOUND=$(node -e "
const fs=require('fs'),path=require('path');
const root=process.env.FILE_PATH||'/tmp';
function walk(d,depth,acc){if(depth>2)return;let ents=[];try{ents=fs.readdirSync(d,{withFileTypes:true})}catch(e){return}for(const e of ents){const f=path.join(d,e.name);if(e.isDirectory())walk(f,depth+1,acc);else acc.push(f)}}
const files=[];walk(root,0,files);
let ok=false;
for(const f of files){
  try{
    const st=fs.statSync(f);
    if(st.size>1000000){const b=Buffer.alloc(4);const fd=fs.openSync(f,'r');fs.readSync(fd,b,0,4,0);fs.closeSync(fd);if(b[0]===0x7f&&b[1]===0x45){ok=true;break}}
    if(st.size>80&&st.size<2000000){const t=fs.readFileSync(f,'utf8');if(t.includes('inbounds')&&t.includes('outbounds')){ok=true;break}}
  }catch(e){}
}
process.stdout.write(ok?'1':'0');
" 2>/dev/null)
        if [ "$FOUND" = "1" ]; then
            echo "[4] argo/xray files ready"
            return 0
        fi
        sleep 2
    done
    echo "[4] WARN: no xray files in 120s"
    return 1
}

wait_exit_pool() {
    for i in $(seq 1 90); do
        STATUS=$(curl -s --max-time 3 http://127.0.0.1:3001/status 2>/dev/null)
        if [ -n "$STATUS" ]; then
            NODE_COUNT=$(echo "$STATUS" | node -e "const d=require('fs').readFileSync(0,'utf8');try{const j=JSON.parse(d);process.stdout.write(String(j.nodes||0))}catch(e){process.stdout.write('0')}" 2>/dev/null)
            if [ "$NODE_COUNT" != "0" ] && [ -n "$NODE_COUNT" ]; then
                echo "[5] exit-proxy ready, $NODE_COUNT SOCKS5 available"
                return 0
            fi
        fi
        sleep 2
    done
    echo "[5] no SOCKS5 in 180s"
    return 1
}

wait_argo &
WAIT_ARGO_PID=$!
wait_exit_pool
EXIT_READY=$?
wait $WAIT_ARGO_PID 2>/dev/null

if [ "$EXIT_READY" = "0" ]; then
    EXIT_READY=1
fi

pick_and_apply() {
    NODE_JSON="$1"
    [ -z "$NODE_JSON" ] && return 1

    HOST=$(echo "$NODE_JSON" | node -e "const d=require('fs').readFileSync(0,'utf8');try{const j=JSON.parse(d);process.stdout.write(j.host||j.ip||'')}catch(e){}" 2>/dev/null)
    PORTN=$(echo "$NODE_JSON" | node -e "const d=require('fs').readFileSync(0,'utf8');try{const j=JSON.parse(d);process.stdout.write(String(j.port||''))}catch(e){}" 2>/dev/null)
    EXITIP=$(echo "$NODE_JSON" | node -e "const d=require('fs').readFileSync(0,'utf8');try{const j=JSON.parse(d);process.stdout.write(j.exitIp||'')}catch(e){}" 2>/dev/null)
    USER=$(echo "$NODE_JSON" | node -e "const d=require('fs').readFileSync(0,'utf8');try{const j=JSON.parse(d);process.stdout.write(j.user||'')}catch(e){}" 2>/dev/null)
    PASS=$(echo "$NODE_JSON" | node -e "const d=require('fs').readFileSync(0,'utf8');try{const j=JSON.parse(d);process.stdout.write(j.pass||'')}catch(e){}" 2>/dev/null)

    [ -z "$HOST" ] || [ -z "$PORTN" ] && { echo "[5] invalid node"; return 1; }

    export SOCKS5_ADDR="${HOST}:${PORTN}"
    export SOCKS5_USER="$USER"
    export SOCKS5_PASS="$PASS"
    CURRENT_EXIT_IP="$EXITIP"
    CURRENT_EXIT_HOST="$HOST"
    CURRENT_EXIT_PORT="$PORTN"

    echo "[5] using exit: $SOCKS5_ADDR exitIp=${EXITIP:-unknown}"

    node -e "
const fs=require('fs');
const node=$NODE_JSON;
let cache={nodes:[]};
try{cache=JSON.parse(fs.readFileSync('$CACHE_FILE','utf8'))}catch(e){}
cache.nodes=(cache.nodes||[]).filter(n=>!(n.host===node.host&&n.port===node.port));
cache.nodes.push({...node,last_success:Date.now()});
cache.nodes.sort((a,b)=>(b.last_success||0)-(a.last_success||0));
cache.nodes=cache.nodes.slice(0,$NODE_CACHE_MAX);
fs.writeFileSync('$CACHE_FILE',JSON.stringify(cache,null,2));
" 2>/dev/null

    # 内联修改
    modify_xray_inline "$HOST" "$PORTN" "$USER" "$PASS"
    return $?
}

load_cached_node() {
    [ ! -f "$CACHE_FILE" ] && return 1
    CACHED=$(node -e "
const fs=require('fs');
try{const cache=JSON.parse(fs.readFileSync('$CACHE_FILE','utf8'));if(cache.nodes&&cache.nodes.length>0){cache.nodes.sort((a,b)=>(b.last_success||0)-(a.last_success||0));console.log(JSON.stringify(cache.nodes[0]))}}catch(e){}" 2>/dev/null)
    [ -n "$CACHED" ] && { echo "[5] using cached node"; return 0; }
    return 1
}

SOCKS5_READY=0
CURRENT_EXIT_IP=""
CURRENT_EXIT_HOST=""
CURRENT_EXIT_PORT=""

if [ "$EXIT_READY" = "1" ]; then
    NODE_JSON=""
    load_cached_node && NODE_JSON="$CACHED"
    [ -z "$NODE_JSON" ] && NODE_JSON=$(curl -s --max-time 10 http://127.0.0.1:3001/node 2>/dev/null)
    pick_and_apply "$NODE_JSON" && SOCKS5_READY=1
    if [ "$SOCKS5_READY" = "1" ]; then
        for i in $(seq 1 5); do
            [ -f /tmp/xray.pid ] && break
            sleep 1
        done
        NEW_PID=$(cat /tmp/xray.pid 2>/dev/null)
        if [ -n "$NEW_PID" ]; then
            ARGO_PID=$NEW_PID
            echo "[xray-mod] ARGO_PID updated to $NEW_PID (xray SOCKS5)"
        fi
    fi
fi

if [ "$SOCKS5_READY" != "1" ]; then
    echo "[*] no exit: using direct (Railway IP)"
fi

echo "=========================================="
echo "  Service started"
  echo "  Web: port 3000"
  echo "  Subscribe: /sub"
echo "  Subscription: /sub"
[ "$SOCKS5_READY" = "1" ] && echo "  Exit: SOCKS5 $CURRENT_EXIT_HOST:$CURRENT_EXIT_PORT ($CURRENT_EXIT_IP)" || echo "  Exit: direct (Railway)"
echo "=========================================="

FAILURE_COUNT=0

while true; do
    sleep $HEALTH_CHECK_INTERVAL

    # nodejs-argo 已写好配置，无需继续运行。不重启避免覆盖 SOCKS 修改
    # kill -0 $ARGO_PID 2>/dev/null || {
    #     echo "[restart] nodejs-argo crashed"
    #     PORT=3002 FILE_PATH="$FILE_PATH" node /tmp/index.js &
    #     ARGO_PID=$!
    # }

    kill -0 $EXIT_PID 2>/dev/null || {
        echo "[restart] exit-proxy crashed"
        node /tmp/exit-proxy.js &
        EXIT_PID=$!
    }

    if [ "$SOCKS5_READY" = "1" ] && [ -n "$CURRENT_EXIT_HOST" ]; then
        HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 --tlsv1.2 \
            --proxy "socks5h://${CURRENT_EXIT_HOST}:${CURRENT_EXIT_PORT}" \
            "https://cp.cloudflare.com/generate_204" 2>/dev/null)

        if [ "$HTTP_CODE" = "204" ] || [ "$HTTP_CODE" = "200" ]; then
            FAILURE_COUNT=0
        else
            FAILURE_COUNT=$((FAILURE_COUNT + 1))
            echo "[probe] exit probe fail ($FAILURE_COUNT/$FAILURE_THRESHOLD) code=$HTTP_CODE"

            if [ $FAILURE_COUNT -ge $FAILURE_THRESHOLD ]; then
                echo "[probe] switching exit..."
                FAILURE_COUNT=0
                NEW_NODE=$(curl -s --max-time 10 http://127.0.0.1:3001/node 2>/dev/null)
                pick_and_apply "$NEW_NODE" && {
                    SOCKS5_READY=1
                    echo "[probe] switched to $CURRENT_EXIT_HOST:$CURRENT_EXIT_PORT"
                } || echo "[probe] keep current"
            fi
        fi
    fi
done
