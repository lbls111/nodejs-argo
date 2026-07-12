/**
 * VPN Gate HTTP 订阅服务器
 * 端口：3001（内部），通过 nginx:3000 对外
 * 功能：
 *   /sub      - Railway VLESS/VMess 订阅（客户端用）
 *   /connect  - 连接页面（QR码 + 复制按钮）
 *   /node     - 随机可用 VPN Gate 节点（start.sh 用）
 *   /status   - 状态信息
 *   /config   - 节点详情
 */

const http = require('http');
const path = require('path');
const VpngateCrawler = require('./vpngate');

const PORT = parseInt(process.env.VPNGATE_PORT || '3001');
const INTERVAL = parseInt(process.env.VPNGATE_INTERVAL || '3600') * 1000;
const OUTPUT_DIR = process.env.VPNGATE_OUTPUT || path.join(process.cwd(), 'vpngate');

// Railway 连接配置
const RAILWAY_DOMAIN = process.env.RAILWAY_DOMAIN || 'ccvs-production.up.railway.app';
const UUID = process.env.UUID || '13b1370d-2c66-456d-a99e-3e9a4d07ffd0';

const crawler = new VpngateCrawler(OUTPUT_DIR);

// ========== 生成 Railway VLESS/VMess 配置 ==========

function buildRailwaySub() {
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

    const lines = [
        `vmess://${Buffer.from(JSON.stringify(vmess)).toString('base64')}`,
        `vmess://${Buffer.from(JSON.stringify(vless)).toString('base64')}`
    ];

    return lines.join('\n');
}

// ========== HTTP 服务器 ==========

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    const url = req.url.split('?')[0];

    // --- /sub: Railway 订阅 ---
    if (url === '/sub' || url === '/sub/') {
        const sub = buildRailwaySub();
        res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-cache'
        });
        res.end(sub);
        return;
    }

    // --- /connect: 连接页面 ---
    if (url === '/connect' || url === '/connect/') {
        const sub = buildRailwaySub();
        const vlessLine = sub.split('\n')[1]; // VLESS
        const vmessLine = sub.split('\n')[0]; // VMess
        const vlessB64 = Buffer.from(vlessLine).toString('base64');
        const vmessB64 = Buffer.from(vmessLine).toString('base64');

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
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
<div class="sub">Railway VLESS/VMess</div>

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
        btn.textContent = '已复制 ✓';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = btn.textContent.replace(' ✓',''); btn.classList.remove('copied'); }, 1500);
    });
}
</script>
</body>
</html>`);
        return;
    }

    // --- /node: 可用节点（start.sh 用） ---
    if (url === '/node') {
        const nodes = crawler.usableNodes;
        if (nodes.length === 0) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'no nodes available' }));
            return;
        }
        const node = nodes[Math.floor(Math.random() * nodes.length)];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ip: node.ip,
            country: node.country,
            score: node.score,
            speed: node.speed,
            openvpn: node.ovpn ? Buffer.from(node.ovpn).toString('base64') : ''
        }));
        return;
    }

    // --- /config: 节点信息 ---
    if (url === '/config') {
        const info = crawler.getInfo();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(info, null, 2));
        return;
    }

    // --- /status: 状态 ---
    if (url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            last_update: crawler.lastUpdate ? crawler.lastUpdate.toISOString() : null,
            nodes: crawler.usableNodes.length
        }));
        return;
    }

    // --- /refresh: 手动刷新 ---
    if (url === '/refresh' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Refresh triggered');
        crawler.update().catch(e => console.error(e));
        return;
    }

    // --- 根路径: 重定向到 /connect ---
    res.writeHead(302, { 'Location': '/connect' });
    res.end();
});

// ========== 启动 ==========

async function main() {
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`[VPN-Gate] HTTP server on port ${PORT}`);

        // 后台首次爬取（不阻塞 HTTP server）
        console.log('[VPN-Gate] Starting crawler...');
        crawler.update().catch(e => console.error('[VPN-Gate] Crawler error:', e));
    });

    setInterval(() => {
        console.log('[VPN-Gate] Periodic update...');
        crawler.update();
    }, INTERVAL);
}

main().catch(e => {
    console.error('[VPN-Gate] Fatal:', e);
    process.exit(1);
});
