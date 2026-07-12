/**
 * VPN Gate HTTP 订阅服务器
 * 独立端口运行，不干扰原有 nodejs-argo
 */

const http = require('http');
const path = require('path');
const VpngateCrawler = require('./vpngate');

const PORT = parseInt(process.env.VPNGATE_PORT || '3001');
const INTERVAL = parseInt(process.env.VPNGATE_INTERVAL || '3600') * 1000;
const OUTPUT_DIR = process.env.VPNGATE_OUTPUT || path.join(process.cwd(), 'vpngate');

const crawler = new VpngateCrawler(OUTPUT_DIR);

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    const url = req.url.split('?')[0];

    if (url === '/sub' || url === '/sub/') {
        const sub = crawler.getSub();
        if (sub) {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(sub);
        } else {
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end('Updating... Please wait.');
        }
        return;
    }

    if (url === '/config') {
        const info = crawler.getInfo();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(info, null, 2));
        return;
    }

    if (url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            last_update: crawler.lastUpdate ? crawler.lastUpdate.toISOString() : null,
            nodes: crawler.usableNodes.length
        }));
        return;
    }

    if (url === '/refresh' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Refresh triggered');
        crawler.update().catch(e => console.error(e));
        return;
    }

    // 根路径 - 返回简单状态页
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Service Status</title>
<style>body{font-family:monospace;background:#0a0a0a;color:#0f0;padding:40px;max-width:600px;margin:0 auto}
h1{color:#0ff;border-bottom:1px solid #0ff;padding-bottom:10px}
.info{background:#111;padding:15px;border-left:3px solid #0f0;margin:10px 0}
a{color:#0ff}</style></head><body>
<h1>Node Service</h1>
<div class="info"><b>Status:</b> Running</div>
<div class="info"><b>Endpoints:</b><br>
<a href="/sub">/sub</a> - Subscription<br>
<a href="/config">/config</a> - Node info<br>
<a href="/status">/status</a> - Status</div>
</body></html>`);
});

async function main() {
    // 先启动 HTTP server（暴露 /status），再后台爬取
    // 这样 start.sh 可以轮询 /status 等待节点就绪
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
