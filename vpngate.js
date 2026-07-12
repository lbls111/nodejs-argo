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
                    nodes.push({
                        ip: parts[1],
                        country: parts[6],
                        ping: parseInt(parts[3]) || 9999,
                        speed: parseInt(parts[4]) || 0,
                        score: parseInt(parts[2]) || 0,
                        ovpn: b64 ? Buffer.from(b64, 'base64').toString('utf-8') : ''
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
        // 过滤掉没有 tls-auth/tls-crypt 的节点（openvpn2socks 强制要求）
        const withTls = nodes.filter(n => /tls-auth|tls-crypt/.test(n.ovpn));
        const withoutTls = nodes.length - withTls.length;
        if (withoutTls > 0) {
            console.log(`[VPN-Gate] 过滤无 TLS 认证节点: ${withoutTls}/${nodes.length}`);
        }
        // 优先使用有 tls-auth 的节点；如果没有，回退到全部节点（尝试注入）
        const candidates = withTls.length > 0 ? withTls : nodes;

        const testCount = Math.min(candidates.length, 100);
        const toTest = candidates.slice(0, testCount);
        const alive = [];
        let tested = 0;

        for (let i = 0; i < toTest.length; i += BATCH_SIZE) {
            const batch = toTest.slice(i, i + BATCH_SIZE);
            const results = await Promise.all(batch.map(async (node) => {
                const ok = await this.tcpTest(node.ip);
                tested++;
                return ok ? node : null;
            }));
            results.filter(Boolean).forEach(n => alive.push(n));
            if (tested % 30 === 0) {
                console.log(`[VPN-Gate] Testing: ${tested}/${testCount}, alive: ${alive.length}`);
            }
        }

        alive.sort((a, b) => (b.score - a.score) || (a.ping - b.ping));
        return alive.slice(0, MAX_NODES);
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

            // 只保留目标国家（HK/US），过滤掉 JP/KR/SG/TW 等
            const ALLOWED_COUNTRIES = ['HK', 'US'];
            const nodes = allNodes.filter(n => ALLOWED_COUNTRIES.includes(n.country));
            console.log(`[VPN-Gate] 国家过滤后: ${nodes.length}/${allNodes.length} (${ALLOWED_COUNTRIES.join(',')})`);
            if (nodes.length === 0) {
                console.log('[VPN-Gate] 无目标国家节点，回退到全部节点');
                // 回退：至少用全部节点
                nodes.push(...allNodes);
            }

            const alive = await this.filterAlive(nodes);
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
