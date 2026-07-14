# nodejs-argo + public SOCKS5 clean exit (jq-based, no node -e)
# (rebuild trigger)
HEALTH_CHECK_INTERVAL=60
FAILURE_THRESHOLD=2
CACHE_FILE="/tmp/exit-cache.json"
NODE_CACHE_MAX=8
export FILE_PATH="${FILE_PATH:-/tmp}"
export OUTBOUND_TAG="${OUTBOUND_TAG:-clean-exit}"
echo "=========================================="
echo "  nodejs-argo + SOCKS5 exit (clean IP)"
echo "[build] IMAGE_COMMIT=${COMMIT_SHA:-unknown} IMAGE_BUILT=${BUILD_TIME:-unknown}"
echo "=========================================="
echo "[1] starting nginx..."
nginx
echo "[2] starting nodejs-argo..."
PORT=3006 FILE_PATH="$FILE_PATH" node /tmp/index.js &
ARGO_PID=$!
echo "[3] starting exit-proxy..."
EXIT_PORT=3005 node /tmp/exit-proxy.js &
EXIT_PID=$!
is_elf() {
  [ -f "$1" ] || return 1
  head -c4 "$1" 2>/dev/null | od -An -tx1 | grep -q "7f 45 4c 46"
}
find_config() {
  local cfg
  cfg=$(ps auxww 2>/dev/null | grep -oE 'run -c [^ ]+\.json' | awk '{print $3}' | head -1)
  [ -n "$cfg" ] && [ -f "$cfg" ] && { echo "$cfg"; return 0; }
  for f in $(ls -t /tmp/*.json 2>/dev/null); do
    grep -q '"inbounds"' "$f" 2>/dev/null && { echo "$f"; return 0; }
  done
  return 1
}
find_bin() {
  for f in /tmp/*; do
    [ -f "$f" ] || continue
    local sz=0
    sz=$(stat -c%s "$f" 2>/dev/null || echo 0)
    [ "$sz" -lt 1000000 ] && continue
    local b; b=$(basename "$f" | tr 'A-Z' 'a-z')
    case "$b" in *bot*|*npm*|*php*|*node*) continue;; esac
    is_elf "$f" && { echo "$f"; return 0; }
  done
  [ -x /tmp/xray-custom ] && { echo "/tmp/xray-custom"; return 0; }
  [ -x /tmp/web ] && { echo "/tmp/web"; return 0; }
  return 1
}
modify_xray() {
  local cfg="$1" host="$2" port="$3" user="$4" pass="$5"
  local tag="${OUTBOUND_TAG:-clean-exit}"
  local server="{\"address\":\"$host\",\"port\":$port}"
  [ -n "$user" ] && [ -n "$pass" ] && server="{\"address\":\"$host\",\"port\":$port,\"users\":[{\"user\":\"$user\",\"pass\":\"$pass\"}]}"
  jq --arg tag "$tag" --argjson srv "$server" '
    def socks($t;$s):
      (.outbounds //= [])
      | (.outbounds |= map(
          if (.protocol=="dns" or .protocol=="blackhole") then .
          elif ((.tag // "") | test("^(dns|block|api|inbound-)")) then .
          else {protocol:"socks", settings:{servers:[$s]}, tag:.tag}
          end))
      | (if (.outbounds | any(.protocol=="socks")) then .
         else (.outbounds |= [{protocol:"socks",settings:{servers:[$s]},tag:$t}] + .) end)
      | (.routing //= {})
      | (.routing.rules //= [])
      | (.routing.rules |= map(
          if ((.outboundTag // "") | test("^(block|dns)$") | not) and (.outboundTag != null)
          then .outboundTag=$t else . end))
      | (if (.routing.rules | any(.outboundTag==$t)) then .
         else (.routing.rules += [{type:"field",network:"tcp,udp",outboundTag:$t}]) end)
    ;
    socks($tag;$srv)
  ' "$cfg" > "$cfg.tmp" && mv "$cfg.tmp" "$cfg"
}
kill_xray_by_config() {
  for i in 1 2 3; do
    pkill -f "/tmp/config.json" 2>/dev/null || true
    sleep 1
  done
}
start_xray() {
  # Own the client-facing xray ourselves using a uniquely-named binary copy
  # (/tmp/xray-custom) so nodejs-argo's "pkill -f <binname>" cannot kill ours.
  # We start OUR xray reading the SOCKS5-modified config. nodejs-argo may try to
  # respawn its own xray afterwards, but it will fail to bind the client ports
  # (we already hold them) and die - which is harmless; our xray serves clients.
  local bin="$1" cfg="$2"
  [ -z "$bin" ] && bin=$(find_bin)
  [ -z "$bin" ] && { echo "[xray] no xray binary found"; return 1; }
  cp "$bin" /tmp/xray-custom 2>/dev/null
  chmod +x /tmp/xray-custom 2>/dev/null
  echo "/tmp/xray-custom" > /tmp/xray.bin
  # kill nodejs-argo's xray so it releases the client ports
  kill_xray_by_config
  sleep 1
  nohup /tmp/xray-custom run -c "$cfg" >/tmp/xray.log 2>&1 &
  local pid=$!
  echo "$pid" > /tmp/xray.pid
  sleep 2
  if kill -0 "$pid" 2>/dev/null; then
    echo "[xray] started our xray PID $pid (SOCKS5 config) on $cfg"
    jq -r ".outbounds[]? | \"    \(.protocol // \"?\") tag=\(.tag // \"?\") -> \(.settings.servers[0].address // .settings.vnext[0].address // \"?\")\"" "$cfg" 2>/dev/null
    return 0
  fi
  echo "[xray] ERROR: our xray died on start"
  return 1
}
echo "[4] waiting for xray config + exit pool..."
wait_for_xray() {
  for i in $(seq 1 60); do
    if find_config >/dev/null 2>&1; then XRAY_CONFIG="$(find_config)"; echo "[4] xray config ready ($XRAY_CONFIG)"; return 0; fi
    sleep 2
  done
  echo "[4] WARN: no xray config in 120s"
  return 1
}
wait_exit_pool() {
  for i in $(seq 1 90); do
    local st; st=$(curl -s --max-time 3 http://127.0.0.1:3005/status 2>/dev/null)
    [ -n "$st" ] || { sleep 2; continue; }
    local n; n=$(echo "$st" | jq -r '.nodes // 0' 2>/dev/null)
    if [ "$n" != "0" ] && [ -n "$n" ]; then
      echo "[5] exit-proxy ready, $n SOCKS5 available"
      return 0
    fi
    sleep 2
  done
  echo "[5] no SOCKS5 in 180s"
  return 1
}
wait_for_xray &
wait_exit_pool
EXIT_READY=$?
wait $! 2>/dev/null
[ "$EXIT_READY" = "0" ] && EXIT_READY=1
pick_and_apply() {
  local node_json="$1"
  [ -z "$node_json" ] && return 1
  local host port user pass
  host=$(echo "$node_json" | jq -r '.host // .ip // empty' 2>/dev/null)
  port=$(echo "$node_json" | jq -r '.port // empty' 2>/dev/null)
  user=$(echo "$node_json" | jq -r '.user // empty' 2>/dev/null)
  pass=$(echo "$node_json" | jq -r '.pass // empty' 2>/dev/null)
  [ -z "$host" ] || [ -z "$port" ] && { echo "[5] invalid node"; return 1; }
  export SOCKS5_ADDR="${host}:${port}"
  export SOCKS5_USER="$user"
  export SOCKS5_PASS="$pass"
  CURRENT_EXIT_HOST="$host"
  CURRENT_EXIT_PORT="$port"
  echo "[5] using exit: $SOCKS5_ADDR"
  echo "$node_json" > /tmp/last-node.json 2>/dev/null
  local cfg
  if [ -n "$XRAY_CONFIG" ] && [ -f "$XRAY_CONFIG" ]; then
    cfg="$XRAY_CONFIG"
  else
    cfg=$(find_config) || { echo "[5] no xray config"; return 1; }
  fi
  XRAY_CONFIG="$cfg"
  echo "[xray-mod] found config: $cfg"
  jq -r '.inbounds[]? | "  inbound: \(.protocol // "?") port=\(.port // "?") listen=\(.listen // "?")"' "$cfg" 2>/dev/null
  modify_xray "$cfg" "$host" "$port" "$user" "$pass"
  echo "[xray-mod] config rewritten with SOCKS5 -> $host:$port"
  jq -r ".outbounds[]? | \"  outbound: \(.protocol // \"?\") tag=\(.tag // \"?\") -> \(.settings.servers[0].address // .settings.vnext[0].address // \"?\")\"" "$cfg" 2>/dev/null
  # Kill nodejs-argo's xray and start OUR xray (uniquely-named binary
  # /tmp/xray-custom) reading the SOCKS5-modified config. nodejs-argo may
  # respawn its own xray but will fail to bind the client ports (we hold them)
  # and die - harmless. Our xray serves the client inbounds with clean exit.
  local bin; bin=$(find_bin)
  start_xray "$bin" "$cfg"
}
probe_exit() {
  # returns 0 if the given SOCKS5 host:port currently exits via generate_204.
  # Retries up to 3x because free public SOCKS5 proxies are flaky (transient 000).
  local h="$1" p="$2" code tries=0
  [ -z "$h" ] || [ -z "$p" ] && return 1
  while [ $tries -lt 3 ]; do
    tries=$((tries + 1))
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 --tlsv1.2 \
      --proxy "socks5h://${h}:${p}" "https://cp.cloudflare.com/generate_204" 2>/dev/null)
    if [ "$code" = "204" ] || [ "$code" = "200" ]; then return 0; fi
    sleep 2
  done
  return 1
}
pick_working_exit() {
  # try up to 12 random verified nodes, apply only one that passes a LIVE probe
  local tries=0
  while [ $tries -lt 12 ]; do
    tries=$((tries + 1))
    local nj
    nj=$(curl -s --max-time 10 http://127.0.0.1:3005/node 2>/dev/null)
    [ -z "$nj" ] && { sleep 1; continue; }
    local h p
    h=$(echo "$nj" | jq -r '.host // .ip // empty' 2>/dev/null)
    p=$(echo "$nj" | jq -r '.port // empty' 2>/dev/null)
    [ -z "$h" ] || [ -z "$p" ] && { sleep 1; continue; }
    if probe_exit "$h" "$p"; then
      pick_and_apply "$nj" && return 0
    else
      echo "[pick] skip dead exit $h:$p (probe fail)"
    fi
  done
  return 1
}
SOCKS5_READY=0
CURRENT_EXIT_HOST=""
CURRENT_EXIT_PORT=""
if [ "$EXIT_READY" = "1" ]; then
  pick_working_exit && SOCKS5_READY=1 || {
    echo "[*] no live exit found, using direct (Railway IP)"
  }
fi
if [ "$SOCKS5_READY" = "1" ]; then
  echo "[xray-mod] xray SOCKS5 started, pid=$(cat /tmp/xray.pid 2>/dev/null)"
  nohup tail -f /tmp/xray.log 2>/dev/null &
else
  echo "[*] no exit: using direct (Railway IP)"
fi
echo "=========================================="
echo "  Service started"
echo "  Web: port 3000"
echo "  Subscribe: /sub"
[ "$SOCKS5_READY" = "1" ] && echo "  Exit: SOCKS5 $CURRENT_EXIT_HOST:$CURRENT_EXIT_PORT" || echo "  Exit: direct (Railway)"
echo "=========================================="
FAILURE_COUNT=0
while true; do
  sleep $HEALTH_CHECK_INTERVAL
  if [ -f /tmp/xray.pid ]; then
    XRAY_PID=$(cat /tmp/xray.pid 2>/dev/null)
    kill -0 "$XRAY_PID" 2>/dev/null || {
      echo "[restart] xray is dead (PID $XRAY_PID)"
      [ -s /tmp/xray.log ] && { echo "[restart] === last 15 lines of xray.log ==="; tail -15 /tmp/xray.log; }
      kill_xray_by_config
      XBIN=""
      [ -f /tmp/xray.bin ] && XBIN=$(cat /tmp/xray.bin 2>/dev/null)
      [ -z "$XBIN" ] && [ -x /tmp/xray-custom ] && { XBIN=/tmp/xray-custom; echo "/tmp/xray-custom" > /tmp/xray.bin; }
      if [ -n "$XBIN" ] && [ -x "$XBIN" ]; then
        cfg=${XRAY_CONFIG:-/tmp/config.json}; [ -f "$cfg" ] || cfg=$(find_config) || cfg="/tmp/config.json"
        start_xray "$XBIN" "$cfg"
      else
        echo "[restart] XBIN='$XBIN' not executable, trying recover"
        nb=$(find_bin)
        if [ -n "$nb" ] && [ -x "$nb" ]; then
          cp "$nb" /tmp/xray-custom 2>/dev/null; chmod +x /tmp/xray-custom 2>/dev/null
          echo "/tmp/xray-custom" > /tmp/xray.bin
          cfg=${XRAY_CONFIG:-/tmp/config.json}; [ -f "$cfg" ] || cfg=$(find_config) || cfg="/tmp/config.json"
          start_xray /tmp/xray-custom "$cfg"
        else
          echo "[restart] cannot find xray binary"
          [ ! -f /tmp/config.json ] && [ -f /tmp/config.json.backup ] && cp /tmp/config.json.backup /tmp/config.json
        fi
      fi
    }
  fi
  kill -0 "$EXIT_PID" 2>/dev/null || {
    echo "[restart] exit-proxy crashed"
    EXIT_PORT=3005 node /tmp/exit-proxy.js &
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
        if pick_working_exit; then
          SOCKS5_READY=1
          echo "[probe] switched to $CURRENT_EXIT_HOST:$CURRENT_EXIT_PORT"
        else
          echo "[probe] no live exit, keep current $CURRENT_EXIT_HOST:$CURRENT_EXIT_PORT"
        fi
      fi
    fi
  fi
done
