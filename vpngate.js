/**
 * VPN Gate 自动节点爬取模块
 * 功能：爬取 → TCP探测 → 筛选存活 → 淘汰失效 → 输出订阅
 * 纯 Node.js，无外部依赖
 */

const https = require('https');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const VPNGATE_API = 'https://www.vpngate.net/api/iphone/';
const TCP_TIMEOUT = 3000;
const BATCH_SIZE = 30;
const MAX_NODES = 20;

class VpngateCrawler {
    constructor(outputDir) {
        this.outputDir = outputDir || path.join(process.cwd(), 'vpngate');
        this.usableNodes = [];
        this.subContent = '';
        this.lastUpdate = null;
        this.isUpdating = false;

        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }
    }

    httpGet(url, timeout = 30000) {
        return new Promise((resolve, reject) => {
            const client = url.startsWith('https') ? https : http;
            const req = client.get(url, { timeout }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => resolve(data));
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        });
    }

    tcpTest(ip, port = 443) {
        return new Promise(resolve => {
            const sock = net.createConnection({ host: ip, port, timeout: TCP_TIMEOUT });
            sock.on('connect', () => { sock.destroy(); resolve(true); });
            sock.on('timeout', () => { sock.destroy(); resolve(false); });
            sock.on('error', () => { sock.destroy(); resolve(false); });
        });
    }

    parseOvpnPort(ovpn) {
        if (!ovpn) return 443;
        const m = ovpn.match(/^remote\s+\S+\s+(\d+)/m);
        if (m) return parseInt(m[1], 10) || 443;
        const p = ovpn.match(/^port\s+(\d+)/m);
        if (p) return parseInt(p[1], 10) || 443;
        return 443;
    }

    async fetchNodes() {
        try {
            const raw = await this.httpGet(VPNGATE_API);
            const lines = raw.trim().split('\n');
            const nodes = [];

            for (let i = 2; i < lines.length; i++) {
                const parts = lines[i].split(',');
                if (parts.length < 15) continue;
                try {
                    const b64 = parts[parts.length - 1].trim();
                    const ovpn = b64 ? Buffer.from(b64, 'base64').toString('utf-8') : '';
                    const ip = (parts[1] || '').trim();
                    if (!ip || !ovpn) continue;
                    nodes.push({
                        ip,
                        country: (parts[6] || '').trim() || 'XX',
                        ping: parseInt(parts[3]) || 9999,
                        speed: parseInt(parts[4]) || 0,
                        score: parseInt(parts[2]) || 0,
                        port: this.parseOvpnPort(ovpn),
                        ovpn
                    });
                } catch (_) { }
            }

            return nodes;
        } catch (e) {
            console.error(`[VPN-Gate] Fetch failed: ${e.message}`);
            return [];
        }
    }

    async filterAlive(nodes) {
        // VPN Gate 多为 UDP OpenVPN：TCP 探活仅作软偏好，全失败时回退高分节点
        // tls-auth 由 start.sh 注入 ta.key，不在此硬过滤
        const sorted = [...nodes].sort((a, b) => (b.score - a.score) || (a.ping - b.ping));
        const testCount = Math.min(sorted.length, 100);
        const toTest = sorted.slice(0, testCount);
        const alive = [];
        let tested = 0;

        console.log(`[VPN-Gate] Probing ${testCount}/${nodes.length} nodes (TCP soft-check on real ports)...`);

        for (let i = 0; i < toTest.length; i += BATCH_SIZE) {
            const batch = toTest.slice(i, i + BATCH_SIZE);
            const results = await Promise.all(batch.map(async (node) => {
                const ok = await this.tcpTest(node.ip, node.port || 443);
                tested++;
                return ok ? node : null;
            }));
            results.filter(Boolean).forEach(n => alive.push(n));
            if (tested % 30 === 0 || tested === testCount) {
                console.log(`[VPN-Gate] Testing: ${tested}/${testCount}, tcp-alive: ${alive.length}`);
            }
        }

        if (alive.length > 0) {
            alive.sort((a, b) => (b.score - a.score) || (a.ping - b.ping));
            return alive.slice(0, MAX_NODES);
        }

        // TCP 全失败（常见：UDP-only）：直接取高分节点，交给 openvpn2socks 真连接
        const fallback = sorted.slice(0, MAX_NODES);
        console.log(`[VPN-Gate] TCP 全失败，回退高分节点 ${fallback.length} 个（UDP OpenVPN 正常）`);
        return fallback;
    }

    buildSub(nodes) {
        return nodes.map(n => {
            const vmess = {
                v: '2',
                ps: `VG-${n.country}-${n.ip}`,
                add: n.ip,
                port: '443',
                id: '00000000-0000-0000-0000-000000000000',
                aid: '0',
                scy: 'auto',
                net: 'tcp',
                type: 'none',
                host: '',
                path: '',
                tls: '',
                sni: '',
                alpn: ''
            };
            return `vmess://${Buffer.from(JSON.stringify(vmess)).toString('base64')}`;
        }).join('\n');
    }

    async update() {
        if (this.isUpdating) {
            console.log('[VPN-Gate] Already updating, skip');
            return false;
        }

        this.isUpdating = true;
        console.log('[VPN-Gate] ========== Update Start ==========');

        try {
            const allNodes = await this.fetchNodes();
            if (allNodes.length === 0) {
                console.log('[VPN-Gate] No nodes fetched');
                return false;
            }
            console.log(`[VPN-Gate] Fetched ${allNodes.length} nodes`);

            // 不限国家：任意连通节点均可（VPN Gate 多数为 JP）
            const byCountry = {};
            for (const n of allNodes) {
                byCountry[n.country] = (byCountry[n.country] || 0) + 1;
            }
            console.log(`[VPN-Gate] 国家分布: ${Object.entries(byCountry).map(([k, v]) => `${k}:${v}`).join(', ')}`);

            const alive = await this.filterAlive(allNodes);
            if (alive.length === 0) {
                console.log('[VPN-Gate] No alive nodes');
                return false;
            }

            this.usableNodes = alive;
            this.subContent = this.buildSub(alive);
            this.lastUpdate = new Date();

            // Save files
            const subFile = path.join(this.outputDir, 'sub.txt');
            fs.writeFileSync(subFile, this.subContent, 'utf-8');

            const b64File = path.join(this.outputDir, 'sub_b64.txt');
            fs.writeFileSync(b64File, Buffer.from(this.subContent).toString('base64'), 'utf-8');

            const info = {
                update_time: this.lastUpdate.toISOString(),
                total_nodes: alive.length,
                nodes: alive.map(n => ({
                    ip: n.ip, country: n.country,
                    ping: n.ping, speed: n.speed, score: n.score
                }))
            };
            fs.writeFileSync(path.join(this.outputDir, 'config.json'),
                JSON.stringify(info, null, 2), 'utf-8');

            // Save OpenVPN configs
            const ovpnDir = path.join(this.outputDir, 'openvpn');
            if (!fs.existsSync(ovpnDir)) fs.mkdirSync(ovpnDir, { recursive: true });
            alive.filter(n => n.ovpn).forEach(n => {
                fs.writeFileSync(path.join(ovpnDir, `${n.country}_${n.ip}.ovpn`), n.ovpn);
            });

            console.log(`[VPN-Gate] ========== Update Done: ${alive.length} nodes ==========`);
            return true;
        } catch (e) {
            console.error(`[VPN-Gate] Update error: ${e.message}`);
            return false;
        } finally {
            this.isUpdating = false;
        }
    }

    getSub() { return this.subContent; }
    getInfo() {
        return {
            update_time: this.lastUpdate ? this.lastUpdate.toISOString() : null,
            total_nodes: this.usableNodes.length,
            nodes: this.usableNodes.map(n => ({
                ip: n.ip, country: n.country,
                ping: n.ping, speed: n.speed, score: n.score
            }))
        };
    }
}

module.exports = VpngateCrawler;
