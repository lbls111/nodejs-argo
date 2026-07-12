/**
 * 干净出口：公共 SOCKS5 池
 * - 多源拉取 → TCP 探活 → HTTPS 经代理探活 → 维护可用列表
 * - HTTP API 供 start.sh / modify-xray / nginx 使用
 *
 * 设计前提：Railway 无 /dev/net/tun、无 privileged，不能跑官方 OpenVPN。
 * 目标：任意非 Railway 出口 IP，不绑定 VPN Gate。
 */

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');

const PORT = parseInt(process.env.EXIT_PORT || process.env.VPNGATE_PORT || '3001', 10);
const INTERVAL = parseInt(process.env.EXIT_INTERVAL || process.env.VPNGATE_INTERVAL || '1800', 10) * 1000;
const MAX_KEEP = parseInt(process.env.EXIT_MAX_NODES || '20', 10);
const TCP_TIMEOUT = 3000;
const HTTPS_TIMEOUT = 8000;
const BATCH = 40;

const SOURCES = [
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
  'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
  'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=5000&country=all&ssl=all&anonymity=all'
];

const RAILWAY_DOMAIN = process.env.RAILWAY_DOMAIN || 'ccvs-production.up.railway.app';
const UUID = process.env.UUID || '13b1370d-2c66-456d-a99e-3e9a4d07ffd0';

function log(msg) {
  console.log(`[exit-proxy] ${msg}`);
}

function httpGet(url, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout, headers: { 'User-Agent': 'exit-proxy/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpGet(res.headers.location, timeout).then(resolve, reject);
        res.resume();
        return;
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function tcpProbe(host, port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port, timeout: TCP_TIMEOUT });
    sock.on('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('timeout', () => {
      sock.destroy();
      resolve(false);
    });
    sock.on('error', () => {
      sock.destroy();
      resolve(false);
    });
  });
}

/** 经 SOCKS5 做 HTTPS GET，返回 { ok, exitIp } */
function socks5HttpsProbe(host, port) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        sock.destroy();
      } catch (_) {}
      done({ ok: false, reason: 'timeout' });
    }, HTTPS_TIMEOUT);

    const sock = net.createConnection({ host, port, timeout: TCP_TIMEOUT });
    let stage = 'connect';
    let buf = Buffer.alloc(0);

    const fail = (reason) => {
      try {
        sock.destroy();
      } catch (_) {}
      done({ ok: false, reason });
    };

    sock.on('timeout', () => fail('tcp-timeout'));
    sock.on('error', (e) => fail(e.message));
    sock.on('connect', () => {
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
      stage = 'greeting';
    });

    sock.on('data', (chunk) => {
      if (settled) return;
      buf = Buffer.concat([buf, chunk]);
      try {
        if (stage === 'greeting') {
          if (buf.length < 2) return;
          if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail('auth');
          buf = Buffer.alloc(0);
          const dest = 'api.ipify.org';
          const req = Buffer.alloc(4 + 1 + dest.length + 2);
          req[0] = 0x05;
          req[1] = 0x01;
          req[2] = 0x00;
          req[3] = 0x03;
          req[4] = dest.length;
          Buffer.from(dest).copy(req, 5);
          req.writeUInt16BE(443, 5 + dest.length);
          sock.write(req);
          stage = 'reply';
          return;
        }
        if (stage === 'reply') {
          if (buf.length < 4) return;
          if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail('connect-denied');
          let need = 4;
          if (buf[3] === 0x01) need += 4 + 2;
          else if (buf[3] === 0x03) {
            if (buf.length < 5) return;
            need += 1 + buf[4] + 2;
          } else if (buf[3] === 0x04) need += 16 + 2;
          else return fail('addr-type');
          if (buf.length < need) return;
          buf = buf.slice(need);
          stage = 'done';
          const tlsSock = tls.connect(
            {
              socket: sock,
              servername: 'api.ipify.org',
              rejectUnauthorized: true,
              timeout: HTTPS_TIMEOUT
            },
            () => {
              tlsSock.write(
                'GET /?format=json HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n'
              );
            }
          );
          let body = '';
          tlsSock.on('data', (d) => (body += d.toString()));
          tlsSock.on('end', () => {
            const m = body.match(/\{[^}]*"ip"\s*:\s*"([^"]+)"/);
            if (m) done({ ok: true, exitIp: m[1] });
            else done({ ok: false, reason: 'bad-body' });
          });
          tlsSock.on('error', (e) => done({ ok: false, reason: e.message }));
          tlsSock.on('timeout', () => {
            tlsSock.destroy();
            done({ ok: false, reason: 'tls-timeout' });
          });
        }
      } catch (e) {
        fail(e.message);
      }
    });
  });
}

function parseHostPort(line) {
  const t = line.trim();
  const m = t.match(/(?:([^:@\s]+):([^@\s]+)@)?(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})/);
  if (!m) return null;
  return { host: m[3], port: parseInt(m[4], 10), user: m[1] || '', pass: m[2] || '' };
}

class ExitPool {
  constructor() {
    this.nodes = [];
    this.lastUpdate = null;
    this.isUpdating = false;
    this.railwayIp = null;
  }

  async fetchSources() {
    const all = new Map();
    await Promise.all(
      SOURCES.map(async (url) => {
        try {
          const raw = await httpGet(url);
          let n = 0;
          for (const line of raw.split(/\r?\n/)) {
            const p = parseHostPort(line);
            if (!p || p.port < 1 || p.port > 65535) continue;
            const key = `${p.host}:${p.port}`;
            if (!all.has(key)) {
              all.set(key, p);
              n++;
            }
          }
          log(`source ok: ${url.split('/').slice(-2).join('/')} +${n}`);
        } catch (e) {
          log(`source fail: ${url} (${e.message})`);
        }
      })
    );
    return [...all.values()];
  }

  async update() {
    if (this.isUpdating) {
      log('already updating, skip');
      return false;
    }
    this.isUpdating = true;
    log('========== Update Start ==========');
    try {
      const candidates = await this.fetchSources();
      log(`candidates: ${candidates.length}`);
      if (candidates.length === 0) return false;

      for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      }
      const toProbe = candidates.slice(0, Math.min(candidates.length, 200));

      const tcpOk = [];
      for (let i = 0; i < toProbe.length; i += BATCH) {
        const batch = toProbe.slice(i, i + BATCH);
        const results = await Promise.all(
          batch.map(async (p) => ((await tcpProbe(p.host, p.port)) ? p : null))
        );
        results.filter(Boolean).forEach((p) => tcpOk.push(p));
        log(`TCP probe ${Math.min(i + BATCH, toProbe.length)}/${toProbe.length}, open=${tcpOk.length}`);
        if (tcpOk.length >= MAX_KEEP * 3) break;
      }

      if (tcpOk.length === 0) {
        log('no TCP-open proxies');
        return false;
      }

      const good = [];
      const httpsBatch = 8;
      for (let i = 0; i < tcpOk.length && good.length < MAX_KEEP; i += httpsBatch) {
        const batch = tcpOk.slice(i, i + httpsBatch);
        const results = await Promise.all(
          batch.map(async (p) => {
            const r = await socks5HttpsProbe(p.host, p.port);
            if (!r.ok) return null;
            if (this.railwayIp && r.exitIp === this.railwayIp) return null;
            return { ...p, exitIp: r.exitIp, lastOk: Date.now() };
          })
        );
        results.filter(Boolean).forEach((n) => good.push(n));
        log(`HTTPS via SOCKS ${Math.min(i + httpsBatch, tcpOk.length)}/${tcpOk.length}, good=${good.length}`);
      }

      if (good.length === 0) {
        log('no HTTPS-capable SOCKS5');
        return false;
      }

      this.nodes = good.slice(0, MAX_KEEP);
      this.lastUpdate = new Date();
      log(`========== Done: ${this.nodes.length} clean exits ==========`);
      this.nodes.slice(0, 5).forEach((n) => log(`  ${n.host}:${n.port} exit=${n.exitIp}`));
      return true;
    } catch (e) {
      log(`update error: ${e.message}`);
      return false;
    } finally {
      this.isUpdating = false;
    }
  }

  pick() {
    if (this.nodes.length === 0) return null;
    return this.nodes[Math.floor(Math.random() * this.nodes.length)];
  }

  status() {
    return {
      status: 'ok',
      mode: 'socks5-exit',
      last_update: this.lastUpdate ? this.lastUpdate.toISOString() : null,
      nodes: this.nodes.length,
      railwayIp: this.railwayIp,
      sample: this.nodes.slice(0, 5).map((n) => ({
        host: n.host,
        port: n.port,
        exitIp: n.exitIp
      }))
    };
  }
}

const pool = new ExitPool();

function buildRailwaySub() {
  const vmess = {
    v: '2',
    ps: 'VMess-Railway',
    add: RAILWAY_DOMAIN,
    port: '443',
    id: UUID,
    aid: '0',
    scy: 'auto',
    net: 'tcp',
    type: 'none',
    host: '',
    path: '',
    tls: 'tls',
    sni: RAILWAY_DOMAIN,
    alpn: ''
  };
  const vless = {
    v: '2',
    ps: 'VLESS-Railway',
    add: RAILWAY_DOMAIN,
    port: '443',
    id: UUID,
    aid: '0',
    scy: 'auto',
    net: 'tcp',
    type: 'none',
    host: '',
    path: '',
    tls: 'tls',
    sni: RAILWAY_DOMAIN,
    alpn: ''
  };
  return [
    `vmess://${Buffer.from(JSON.stringify(vmess)).toString('base64')}`,
    `vmess://${Buffer.from(JSON.stringify(vless)).toString('base64')}`
  ].join('\n');
}

function buildConnectPage() {
  const sub = buildRailwaySub();
  const vlessLine = sub.split('\n')[1];
  const vmessLine = sub.split('\n')[0];
  const vlessB64 = Buffer.from(vlessLine).toString('base64');
  const vmessB64 = Buffer.from(vmessLine).toString('base64');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VPN Connect</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#e0e0e0;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:20px}
h1{font-size:1.5rem;color:#00d4ff;margin-bottom:8px}
.sub{font-size:0.85rem;color:#666;margin-bottom:24px}
.card{background:#111;border:1px solid #222;border-radius:12px;padding:20px;width:100%;max-width:420px;margin-bottom:16px}
.card h2{font-size:1.1rem;color:#00d4ff;margin-bottom:12px}
.qr{text-align:center;margin:12px 0}
.qr img{border-radius:8px;background:#fff;padding:8px}
.btn{display:block;width:100%;padding:12px;border:none;border-radius:8px;font-size:0.9rem;font-weight:600;cursor:pointer;margin-top:10px;transition:all .2s}
.btn-copy{background:#00d4ff;color:#000}
.btn-copy:hover{background:#00b8e6}
.btn-sub{background:#1a1a2e;color:#00d4ff;border:1px solid #00d4ff}
.btn-sub:hover{background:#00d4ff22}
.copied{background:#00cc44 !important;color:#fff !important}
.field{background:#0a0a0a;border:1px solid #333;border-radius:6px;padding:10px;font-family:monospace;font-size:0.75rem;color:#888;word-break:break-all;margin:8px 0;max-height:80px;overflow-y:auto}
</style>
</head>
<body>
<h1>VPN Connect</h1>
<div class="sub">Railway VLESS/VMess · socks5-exit</div>
<div class="card">
<h2>VLESS</h2>
<div class="qr"><img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(vlessLine)}" alt="VLESS QR"></div>
<div class="field" id="vless-uri">${vlessLine}</div>
<button class="btn btn-copy" onclick="copyText('vless-uri', this)">复制 VLESS 链接</button>
<button class="btn btn-sub" onclick="copyText('vless-b64', this)">复制 Base64（订阅用）</button>
<div class="field" id="vless-b64" style="display:none">${vlessB64}</div>
</div>
<div class="card">
<h2>VMess</h2>
<div class="qr"><img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(vmessLine)}" alt="VMess QR"></div>
<div class="field" id="vmess-uri">${vmessLine}</div>
<button class="btn btn-copy" onclick="copyText('vmess-uri', this)">复制 VMess 链接</button>
<button class="btn btn-sub" onclick="copyText('vmess-b64', this)">复制 Base64（订阅用）</button>
<div class="field" id="vmess-b64" style="display:none">${vmessB64}</div>
</div>
<div class="card">
<h2>订阅地址</h2>
<div class="field" id="sub-url">https://${RAILWAY_DOMAIN}/sub</div>
<button class="btn btn-copy" onclick="copyText('sub-url', this)">复制订阅地址</button>
</div>
<script>
function copyText(id, btn) {
  const el = document.getElementById(id);
  const text = el.textContent || el.innerText;
  navigator.clipboard.writeText(text).then(() => {
    const old = btn.textContent;
    btn.textContent = '已复制';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = old; btn.classList.remove('copied'); }, 1500);
  });
}
</script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = (req.url || '/').split('?')[0];

  if (url === '/status' || url === '/vpngate/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(pool.status()));
    return;
  }

  if (url === '/node') {
    const n = pool.pick();
    if (!n) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no exit proxies' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        host: n.host,
        port: n.port,
        exitIp: n.exitIp,
        ip: n.host,
        country: 'PROXY',
        openvpn: '',
        type: 'socks5',
        user: n.user || '',
        pass: n.pass || ''
      })
    );
    return;
  }

  if (url === '/sub' || url === '/sub/') {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
    res.end(buildRailwaySub());
    return;
  }

  if (url === '/connect' || url === '/connect/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildConnectPage());
    return;
  }

  if ((url === '/refresh' || url === '/vpngate/refresh') && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    pool.update().catch((e) => log(e.message));
    return;
  }

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, nodes: pool.nodes.length, mode: 'socks5-exit' }));
    return;
  }

  if (url === '/' || url === '') {
    res.writeHead(302, { Location: '/connect' });
    res.end();
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(pool.status(), null, 2));
});

async function main() {
  try {
    const raw = await httpGet('https://api.ipify.org?format=json', 8000);
    const j = JSON.parse(raw);
    pool.railwayIp = j.ip;
    log(`railway exit IP: ${pool.railwayIp}`);
  } catch (e) {
    log(`cannot detect railway IP: ${e.message}`);
  }

  server.listen(PORT, '0.0.0.0', () => {
    log(`HTTP on :${PORT}`);
    pool.update().catch((e) => log(e.message));
  });

  setInterval(() => {
    log('periodic update...');
    pool.update().catch((e) => log(e.message));
  }, INTERVAL);
}

main().catch((e) => {
  console.error('[exit-proxy] fatal', e);
  process.exit(1);
});
