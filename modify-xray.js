/**
 * xray config modifier (/opt/modify-xray.js)
 * Auto-discover nodejs-argo random config/binary, inject SOCKS5 clean-exit outbound.
 * Force ALL client traffic through SOCKS5 (replace all outbounds + routing fallback).
 *
 * Env:
 *   SOCKS5_ADDR  host:port
 *   SOCKS5_USER / SOCKS5_PASS  optional
 *   FILE_PATH    default /tmp
 *   XRAY_CONFIG optional explicit config
 *   OUTBOUND_TAG default clean-exit
 *   XRAY_CUSTOM_BIN default /tmp/xray-custom
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const FILE_PATH = process.env.FILE_PATH || '/tmp';
const SOCKS5_ADDR = process.env.SOCKS5_ADDR || '127.0.0.1:1080';
const SOCKS5_USER = process.env.SOCKS5_USER || '';
const SOCKS5_PASS = process.env.SOCKS5_PASS || '';
const OUTBOUND_TAG = process.env.OUTBOUND_TAG || 'clean-exit';
const EXPLICIT_CONFIG = process.env.XRAY_CONFIG || '';
const XRAY_CUSTOM_BIN = process.env.XRAY_CUSTOM_BIN || '/tmp/xray-custom';
const CONFIG_PATH = '/tmp/config.json';
const CHECK_INTERVAL = 2000;
const MAX_WAIT = 120000;

function log(msg) { console.log('[xray-mod] ' + msg); }

function parseAddr(addr) {
  const i = String(addr).lastIndexOf(':');
  if (i <= 0) return { host: addr, port: 1080 };
  return { host: addr.slice(0, i), port: parseInt(addr.slice(i + 1), 10) || 1080 };
}

function safeReadJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw || (raw[0] !== '{' && raw[0] !== '[')) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
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
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return acc; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) listFilesRecursive(full, depth + 1, acc);
    else acc.push(full);
  }
  return acc;
}

function discoverConfigFromFs() {
  const roots = [FILE_PATH, path.resolve(FILE_PATH), CONFIG_PATH, '/tmp', process.cwd()];
  const seen = new Set();
  for (const root of roots) {
    const abs = path.resolve(root);
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (!fs.existsSync(abs)) continue;
    const files = listFilesRecursive(abs, 2);
    const candidates = files
      .filter((f) => { const b = path.basename(f).toLowerCase(); return b.endsWith('.json') || !b.includes('.'); })
      .map((f) => { try { const st = fs.statSync(f); return { f, mtime: st.mtimeMs, size: st.size }; } catch (_) { return null; } })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    for (const c of candidates) {
      if (c.size < 50 || c.size > 5000000) continue;
      const j = safeReadJson(c.f);
      if (looksLikeXrayConfig(j)) return { path: c.f, config: j };
    }
  }
  return null;
}

function discoverFromProcess() {
  let out = '';
  try { out = execSync('ps auxww 2>/dev/null || ps -ef', { encoding: 'utf8', timeout: 5000 }); } catch (_) { return null; }
  const lines = out.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/(\S+)\s+run\s+-c\s+(\S+\.json)/);
    if (m) {
      const cfg = m[2];
      if (cfg && fs.existsSync(cfg)) {
        const j = safeReadJson(cfg);
        if (looksLikeXrayConfig(j)) return { path: cfg, config: j, bin: m[1] };
      }
      continue;
    }
    const m2 = line.match(/\s-c\s+(\S+\.json)\b/);
    if (m2) {
      const cfg = m2[1];
      if (cfg && fs.existsSync(cfg)) {
        const j = safeReadJson(cfg);
        if (looksLikeXrayConfig(j)) return { path: cfg, config: j };
      }
    }
    const paths = line.match(/(\/\S+\.json)/g) || [];
    for (const p of paths) {
      if (fs.existsSync(p)) {
        const j = safeReadJson(p);
        if (looksLikeXrayConfig(j)) return { path: p, config: j };
      }
    }
  }
  return null;
}

function isElf(f) {
  try {
    const fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
  } catch (_) { return false; }
}

function discoverBinary(configPath) {
  const roots = [path.dirname(configPath || CONFIG_PATH), FILE_PATH, path.resolve(FILE_PATH), '/tmp'];
  const seen = new Set();
  for (const root of roots) {
    const abs = path.resolve(root);
    if (seen.has(abs) || !fs.existsSync(abs)) continue;
    seen.add(abs);
    for (const f of listFilesRecursive(abs, 1)) {
      try {
        const st = fs.statSync(f);
        if (!st.isFile() || st.size < 1000000) continue;
        if (!isElf(f)) continue;
        const base = path.basename(f).toLowerCase();
        if (base.includes('bot') || base.includes('npm') || base.includes('php') || base.includes('node')) continue;
        return f;
      } catch (_) {}
    }
  }
  for (const p of [XRAY_CUSTOM_BIN, '/tmp/web', path.join(FILE_PATH, 'web')]) {
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
        if (looksLikeXrayConfig(j)) { resolve({ path: EXPLICIT_CONFIG, config: j }); return; }
      }
      const fromPs = discoverFromProcess();
      if (fromPs) { resolve(fromPs); return; }
      const fromFs = discoverConfigFromFs();
      if (fromFs) { resolve(fromFs); return; }
      if (Date.now() - start > MAX_WAIT) { resolve(null); return; }
      setTimeout(check, CHECK_INTERVAL);
    };
    check();
  });
}

function ensureCustomBin(srcBin) {
  if (!srcBin || !isElf(srcBin)) { log('source binary not valid ELF: ' + srcBin); return srcBin; }
  for (let i = 0; i < 3; i++) {
    try {
      fs.copyFileSync(srcBin, XRAY_CUSTOM_BIN);
      fs.chmodSync(XRAY_CUSTOM_BIN, 0o755);
      if (isElf(XRAY_CUSTOM_BIN)) { log('copied xray to: ' + XRAY_CUSTOM_BIN + ' (ELF verified)'); return XRAY_CUSTOM_BIN; }
      log('corrupt copy attempt ' + (i + 1) + ', retrying...');
    } catch (e) { log('copy error: ' + e.message); }
    try { fs.unlinkSync(XRAY_CUSTOM_BIN); } catch (_) {}
    try { execSync('sleep 1', { stdio: 'ignore' }); } catch (_) {}
  }
  log('copy failed after 3 attempts, using original');
  return srcBin;
}

function killAllXrayByConfig() {
  for (let i = 0; i < 3; i++) {
    try { execSync('pkill -f "run -c ' + CONFIG_PATH.replace(/\//g, '\\/') + '"', { stdio: 'ignore' }); } catch (_) {}
    try { execSync('sleep 1', { stdio: 'ignore' }); } catch (_) {}
  }
}

function startXrayNohup(binPath, configPath) {
  if (!binPath || !fs.existsSync(binPath)) { log('xray binary not found: ' + binPath); return false; }
  try { fs.chmodSync(binPath, 0o755); } catch (_) {}
  const cmd = 'nohup ' + binPath + ' run -c ' + configPath + ' >/tmp/xray.log 2>&1 & echo $!';
  try {
    const out = execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim();
    const pid = out.split(/\s/).filter(Boolean).pop();
    if (pid && /^\d+$/.test(pid)) {
      try { fs.writeFileSync('/tmp/xray.pid', String(pid), 'utf8'); } catch (_) {}
      log('started PID: ' + pid);
      return true;
    }
    log('WARNING: xray PID not found, output: ' + out);
  } catch (e) { log('start error: ' + e.message); }
  return false;
}

function injectSocks(config) {
  const { host, port } = parseAddr(SOCKS5_ADDR);
  const server = { address: host, port };
  if (SOCKS5_USER) server.users = [{ user: SOCKS5_USER, pass: SOCKS5_PASS }];
  const socks = { protocol: 'socks', settings: { servers: [server] } };

  if (!config.outbounds) config.outbounds = [];
  let replaced = 0;
  config.outbounds.forEach((o, i) => {
    if (!o) return;
    if (o.protocol === 'dns' || o.protocol === 'blackhole') return;
    if (o.tag && ['dns', 'block', 'api', 'inbound-'].some((k) => o.tag.startsWith(k))) return;
    config.outbounds[i] = { ...socks, tag: o.tag };
    replaced++;
    log('outbound replaced: [' + o.tag + '] -> socks -> ' + host + ':' + port);
  });
  if (replaced === 0) {
    config.outbounds.unshift({ ...socks, tag: OUTBOUND_TAG });
    log('no egress found, added: ' + OUTBOUND_TAG);
  }

  const socksTag = config.outbounds.find((o) => o && o.protocol === 'socks').tag;
  if (!config.routing) config.routing = {};
  if (!config.routing.rules) config.routing.rules = [];
  config.routing.rules.forEach((r) => {
    if (r.outboundTag && !['block', 'dns'].includes(r.outboundTag)) r.outboundTag = socksTag;
  });
  const hasExit = config.routing.rules.some((r) => r.outboundTag === socksTag);
  if (!hasExit) {
    config.routing.rules.push({ type: 'field', network: 'tcp,udp', outboundTag: socksTag });
    log('added default routing: all -> ' + socksTag);
  } else {
    log('routing already points to ' + socksTag);
  }
  return config;
}

async function main() {
  log('========== xray config modifier start ==========');
  log('SOCKS5_ADDR=' + SOCKS5_ADDR);
  log('FILE_PATH=' + FILE_PATH);

  const found = await waitForConfig();
  if (!found) { log('ERROR: xray config not found'); process.exit(1); }

  const configPath = found.path;
  log('found config: ' + configPath);

  if (found.config && Array.isArray(found.config.inbounds)) {
    found.config.inbounds.forEach((ib, i) => {
      let info = ib.protocol || '?';
      if (ib.port !== undefined) info += ' port=' + ib.port;
      if (ib.listen) info += ' listen=' + ib.listen;
      log('inbound[' + i + ']: ' + info);
    });
  }

  let modified = injectSocks(found.config);

  const backupPath = configPath + '.backup';
  try { fs.copyFileSync(configPath, backupPath); log('backed up: ' + backupPath); } catch (e) { log('backup fail: ' + e.message); }

  fs.writeFileSync(configPath, JSON.stringify(modified, null, 2), 'utf-8');
  log('config written: ' + configPath);

  let bin = found.bin;
  if (bin && path.extname(bin) === '.json') { log('WARNING: found.bin is a .json, ignoring'); bin = null; }
  if (!bin) bin = discoverBinary(configPath);
  log('binary: ' + (bin || 'NOT FOUND'));

  killAllXrayByConfig();
  const customBin = ensureCustomBin(bin);
  try { fs.writeFileSync('/tmp/xray.bin', String(customBin), 'utf8'); } catch (_) {}
  if (customBin) startXrayNohup(customBin, configPath);
  else log('WARNING: bin not found, config written only');

  log('========== xray config modifier done ==========');
}

main().catch((e) => { log('ERROR: ' + e.message); process.exit(1); });