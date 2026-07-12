/**
 * xray 配置修改器
 * 等待 xray 配置 → 注入远程 SOCKS5 出站 → 路由改走 clean-exit → 重启 xray
 * 环境变量：
 *   SOCKS5_ADDR  host:port（默认 127.0.0.1:1080）
 *   SOCKS5_USER / SOCKS5_PASS 可选
 *   XRAY_CONFIG  默认 /tmp/config.json
 */

const fs = require('fs');
const { execSync, spawn } = require('child_process');

const CONFIG_PATH = process.env.XRAY_CONFIG || '/tmp/config.json';
const SOCKS5_ADDR = process.env.SOCKS5_ADDR || '127.0.0.1:1080';
const SOCKS5_USER = process.env.SOCKS5_USER || '';
const SOCKS5_PASS = process.env.SOCKS5_PASS || '';
const OUTBOUND_TAG = process.env.OUTBOUND_TAG || 'clean-exit';
const CHECK_INTERVAL = 3000;
const MAX_WAIT = 60000;

function log(msg) {
  console.log(`[xray-mod] ${msg}`);
}

function parseAddr(addr) {
  const i = addr.lastIndexOf(':');
  if (i <= 0) return { host: addr, port: 1080 };
  return {
    host: addr.slice(0, i),
    port: parseInt(addr.slice(i + 1), 10) || 1080
  };
}

function waitForConfig() {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (fs.existsSync(CONFIG_PATH)) {
        try {
          const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
          if (config.inbounds && config.inbounds.length > 0) {
            resolve(config);
            return;
          }
        } catch (_) {}
      }
      if (Date.now() - start > MAX_WAIT) {
        resolve(null);
        return;
      }
      setTimeout(check, CHECK_INTERVAL);
    };
    check();
  });
}

function addSocks5Outbound(config) {
  if (!config.outbounds) config.outbounds = [];

  // 移除旧 vpn-gate / clean-exit，避免残留
  config.outbounds = config.outbounds.filter(
    (o) => o.tag !== OUTBOUND_TAG && o.tag !== 'vpn-gate'
  );

  const { host, port } = parseAddr(SOCKS5_ADDR);
  const server = { address: host, port };
  if (SOCKS5_USER) {
    server.users = [{ user: SOCKS5_USER, pass: SOCKS5_PASS }];
  }

  config.outbounds.push({
    protocol: 'socks',
    tag: OUTBOUND_TAG,
    settings: { servers: [server] }
  });

  log(`Added SOCKS5 outbound: ${OUTBOUND_TAG} → ${host}:${port}`);
  return config;
}

function modifyRouting(config) {
  if (!config.routing) config.routing = {};
  if (!config.routing.rules) config.routing.rules = [];

  // 兼容旧 tag
  for (const r of config.routing.rules) {
    if (r.outboundTag === 'vpn-gate' || r.outboundTag === 'direct') {
      r.outboundTag = OUTBOUND_TAG;
    }
  }

  const hasExit = config.routing.rules.some((r) => r.outboundTag === OUTBOUND_TAG);
  if (!hasExit) {
    config.routing.rules.push({
      type: 'field',
      network: 'tcp,udp',
      outboundTag: OUTBOUND_TAG
    });
    log(`Added default routing: all → ${OUTBOUND_TAG}`);
  } else {
    log(`Routing already points to ${OUTBOUND_TAG}`);
  }

  // 默认出站也切到 clean-exit（若存在 protocol freedom 的 direct）
  if (Array.isArray(config.outbounds) && config.outbounds.length > 0) {
    const freedom = config.outbounds.find(
      (o) => o.protocol === 'freedom' || o.tag === 'direct'
    );
    // 不删 direct，仅确保规则优先 clean-exit
    if (freedom) log(`kept freedom outbound tag=${freedom.tag || 'n/a'}`);
  }

  return config;
}

function killXray() {
  try {
    execSync('pkill -f "xray run"', { stdio: 'ignore' });
    log('Killed existing xray process');
  } catch (_) {}
}

function startXray() {
  const xrayPath = '/tmp/web';
  if (!fs.existsSync(xrayPath)) {
    log('xray binary not found at ' + xrayPath);
    return;
  }
  log('Starting xray with clean-exit routing...');
  const child = spawn(xrayPath, ['run', '-c', CONFIG_PATH], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  log('xray started with PID: ' + child.pid);
}

async function main() {
  log('========== xray 配置修改器启动 ==========');
  log(`SOCKS5_ADDR=${SOCKS5_ADDR}`);
  log('等待 xray 配置文件生成...');

  const config = await waitForConfig();
  if (!config) {
    log('ERROR: xray 配置未生成');
    process.exit(1);
  }

  log('读取到 xray 配置');
  let modified = addSocks5Outbound(config);
  modified = modifyRouting(modified);

  const backupPath = CONFIG_PATH + '.backup';
  fs.copyFileSync(CONFIG_PATH, backupPath);
  log('原配置已备份到: ' + backupPath);

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(modified, null, 2), 'utf-8');
  log('新配置已写入: ' + CONFIG_PATH);

  killXray();
  await new Promise((r) => setTimeout(r, 2000));
  startXray();

  log('========== xray 配置修改完成 ==========');
}

main().catch((e) => {
  log('ERROR: ' + e.message);
  process.exit(1);
});
