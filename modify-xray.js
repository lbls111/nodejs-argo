/**
 * xray 配置修改器
 * 自动发现 nodejs-argo 的随机配置/二进制路径，注入 SOCKS5 出站 clean-exit
 *
 * 环境变量：
 *   SOCKS5_ADDR  host:port
 *   SOCKS5_USER / SOCKS5_PASS 可选
 *   FILE_PATH    默认 ./tmp（与 nodejs-argo 一致）
 *   XRAY_CONFIG  若指定则优先使用
 *   OUTBOUND_TAG 默认 clean-exit
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const FILE_PATH = process.env.FILE_PATH || './tmp';
const SOCKS5_ADDR = process.env.SOCKS5_ADDR || '127.0.0.1:1080';
const SOCKS5_USER = process.env.SOCKS5_USER || '';
const SOCKS5_PASS = process.env.SOCKS5_PASS || '';
const OUTBOUND_TAG = process.env.OUTBOUND_TAG || 'clean-exit';
const EXPLICIT_CONFIG = process.env.XRAY_CONFIG || '';
const CHECK_INTERVAL = 2000;
const MAX_WAIT = 120000;

function log(msg) {
  console.log(`[xray-mod] ${msg}`);
}

function parseAddr(addr) {
  const i = String(addr).lastIndexOf(':');
  if (i <= 0) return { host: addr, port: 1080 };
  return {
    host: addr.slice(0, i),
    port: parseInt(addr.slice(i + 1), 10) || 1080
  };
}

function safeReadJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw || raw[0] !== '{' && raw[0] !== '[') return null;
    const j = JSON.parse(raw);
    return j;
  } catch (_) {
    return null;
  }
}

function looksLikeXrayConfig(j) {
  if (!j || typeof j !== 'object') return false;
  if (Array.isArray(j.inbounds) && j.inbounds.length > 0) return true;
  if (Array.isArray(j.outbounds) && j.outbounds.some((o) => o && o.protocol)) return true;
  return false;
}

function listFilesRecursive(dir, depth = 0, acc = []) {
  if (depth > 3) return acc;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return acc;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) listFilesRecursive(full, depth + 1, acc);
    else acc.push(full);
  }
  return acc;
}

function discoverConfigFromFs() {
  const roots = [
    FILE_PATH,
    path.resolve(FILE_PATH),
    '/tmp',
    path.resolve('./tmp'),
    process.cwd()
  ];
  const seen = new Set();
  for (const root of roots) {
    const abs = path.resolve(root);
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (!fs.existsSync(abs)) continue;
    const files = listFilesRecursive(abs);
    // prefer recent json-looking files
    const candidates = files
      .filter((f) => {
        const base = path.basename(f).toLowerCase();
        return base.endsWith('.json') || !base.includes('.');
      })
      .map((f) => {
        try {
          const st = fs.statSync(f);
          return { f, mtime: st.mtimeMs, size: st.size };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);

    for (const c of candidates) {
      if (c.size < 50 || c.size > 5_000_000) continue;
      const j = safeReadJson(c.f);
      if (looksLikeXrayConfig(j)) return { path: c.f, config: j };
    }
  }
  return null;
}

function discoverFromProcess() {
  // 解析 ps：找带 -c / run 的 xray 类进程
  let out = '';
  try {
    out = execSync('ps auxww 2>/dev/null || ps -ef', { encoding: 'utf8', timeout: 5000 });
  } catch (_) {
    return null;
  }
  const lines = out.split(/\r?\n/);
  for (const line of lines) {
    if (!/(\s|^)(xray|web|sing-box)\b/i.test(line) && !/run\s+-c\s+/.test(line)) continue;
    // cmdline 里找 -c <path>
    const m = line.match(/(?:^|\s)(\S+)\s+run\s+-c\s+(\S+)/) || line.match(/\s-c\s+(\S+)/);
    if (m) {
      const bin = m[1] && m[1].includes('/') ? m[1] : null;
      const cfg = m[2] || m[1];
      if (cfg && fs.existsSync(cfg)) {
        const j = safeReadJson(cfg);
        if (looksLikeXrayConfig(j)) return { path: cfg, config: j, bin };
      }
    }
    // 尝试从绝对路径可执行文件反推同目录 json
    const paths = line.match(/(\/\S+)/g) || [];
    for (const p of paths) {
      if (p.endsWith('.json') && fs.existsSync(p)) {
        const j = safeReadJson(p);
        if (looksLikeXrayConfig(j)) return { path: p, config: j };
      }
    }
  }
  return null;
}

function discoverBinary(configPath) {
  const roots = [
    path.dirname(configPath || FILE_PATH),
    FILE_PATH,
    path.resolve(FILE_PATH),
    '/tmp',
    process.cwd()
  ];
  const seen = new Set();
  for (const root of roots) {
    const abs = path.resolve(root);
    if (seen.has(abs) || !fs.existsSync(abs)) continue;
    seen.add(abs);
    for (const f of listFilesRecursive(abs)) {
      try {
        const st = fs.statSync(f);
        if (!st.isFile() || st.size < 1_000_000) continue; // xray 通常 >1MB
        const fd = fs.openSync(f, 'r');
        const buf = Buffer.alloc(4);
        fs.readSync(fd, buf, 0, 4, 0);
        fs.closeSync(fd);
        // ELF magic
        if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
          // skip known non-xray
          const base = path.basename(f).toLowerCase();
          if (base.includes('bot') || base.includes('npm') || base.includes('php')) continue;
          return f;
        }
      } catch (_) {}
    }
  }
  // fallback known names
  for (const p of ['/tmp/web', path.join(FILE_PATH, 'web'), './web']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function waitForConfig() {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (EXPLICIT_CONFIG && fs.existsSync(EXPLICIT_CONFIG)) {
        const j = safeReadJson(EXPLICIT_CONFIG);
        if (looksLikeXrayConfig(j)) {
          resolve({ path: EXPLICIT_CONFIG, config: j });
          return;
        }
      }
      const fromPs = discoverFromProcess();
      if (fromPs) {
        resolve(fromPs);
        return;
      }
      const fromFs = discoverConfigFromFs();
      if (fromFs) {
        resolve(fromFs);
        return;
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
  config.outbounds = config.outbounds.filter(
    (o) => o.tag !== OUTBOUND_TAG && o.tag !== 'vpn-gate'
  );

  const { host, port } = parseAddr(SOCKS5_ADDR);
  const server = { address: host, port };
  if (SOCKS5_USER) {
    server.users = [{ user: SOCKS5_USER, pass: SOCKS5_PASS }];
  }

  // 插到 outbounds 最前，作为优先
  config.outbounds.unshift({
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

  for (const r of config.routing.rules) {
    if (r.outboundTag === 'vpn-gate' || r.outboundTag === 'direct' || r.outboundTag === 'freedom') {
      r.outboundTag = OUTBOUND_TAG;
    }
  }

  const hasExit = config.routing.rules.some((r) => r.outboundTag === OUTBOUND_TAG);
  if (!hasExit) {
    // 放到规则末尾作为兜底
    config.routing.rules.push({
      type: 'field',
      network: 'tcp,udp',
      outboundTag: OUTBOUND_TAG
    });
    log(`Added default routing: all → ${OUTBOUND_TAG}`);
  } else {
    log(`Routing already points to ${OUTBOUND_TAG}`);
  }

  // 部分配置用 domainStrategy + 默认 outbound 顺序：把 clean-exit 挪到第一位已在 unshift 完成
  return config;
}

function killXrayLike(binPath) {
  try {
    if (binPath) {
      const base = path.basename(binPath);
      try {
        execSync(`pkill -f "${base}"`, { stdio: 'ignore' });
      } catch (_) {}
    }
    execSync('pkill -f "xray run"', { stdio: 'ignore' });
  } catch (_) {}
  // 也尝试杀掉带 run -c 的进程
  try {
    execSync('pkill -f "run -c"', { stdio: 'ignore' });
  } catch (_) {}
}

function startXray(binPath, configPath) {
  if (!binPath || !fs.existsSync(binPath)) {
    log('xray binary not found: ' + binPath);
    return false;
  }
  try {
    fs.chmodSync(binPath, 0o755);
  } catch (_) {}

  log(`Starting xray: ${binPath} run -c ${configPath}`);
  const child = spawn(binPath, ['run', '-c', configPath], {
    detached: true,
    stdio: 'ignore',
    cwd: path.dirname(binPath)
  });
  child.unref();
  log('xray started with PID: ' + child.pid);
  return true;
}

async function main() {
  log('========== xray 配置修改器启动 ==========');
  log(`SOCKS5_ADDR=${SOCKS5_ADDR}`);
  log(`FILE_PATH=${FILE_PATH}`);
  log('等待 xray 配置文件生成...');

  const found = await waitForConfig();
  if (!found) {
    log('ERROR: xray 配置未生成（已扫描 FILE_PATH/tmp 与进程）');
    // dump hint
    try {
      const roots = [FILE_PATH, '/tmp'];
      for (const r of roots) {
        if (!fs.existsSync(r)) continue;
        const files = listFilesRecursive(r).slice(0, 40);
        log(`ls ${r}: ${files.map((f) => path.basename(f)).join(', ')}`);
      }
    } catch (_) {}
    process.exit(1);
  }

  const configPath = found.path;
  log('找到配置: ' + configPath);

  let modified = addSocks5Outbound(found.config);
  modified = modifyRouting(modified);

  const backupPath = configPath + '.backup';
  try {
    fs.copyFileSync(configPath, backupPath);
    log('原配置已备份到: ' + backupPath);
  } catch (e) {
    log('备份失败: ' + e.message);
  }

  fs.writeFileSync(configPath, JSON.stringify(modified, null, 2), 'utf-8');
  log('新配置已写入: ' + configPath);

  const bin = found.bin || discoverBinary(configPath);
  log('二进制: ' + (bin || 'NOT FOUND'));

  killXrayLike(bin);
  await new Promise((r) => setTimeout(r, 1500));
  if (bin) startXray(bin, configPath);
  else log('WARNING: 未找到二进制，仅写入配置（若 xray 支持热重载则生效）');

  log('========== xray 配置修改完成 ==========');
}

main().catch((e) => {
  log('ERROR: ' + e.message);
  process.exit(1);
});
