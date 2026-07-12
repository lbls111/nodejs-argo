/**
 * xray 配置修改器
 * 功能：等待 xray 启动 → 读取配置 → 添加 SOCKS5 出站 → 重启 xray
 * 让 VLESS/VMess 流量通过 VPN Gate 出去
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const CONFIG_PATH = process.env.XRAY_CONFIG || '/tmp/config.json';
const SOCKS5_ADDR = process.env.SOCKS5_ADDR || '127.0.0.1:1080';
const CHECK_INTERVAL = 3000;
const MAX_WAIT = 60000;

function log(msg) {
    console.log(`[xray-mod] ${msg}`);
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
                } catch (e) { }
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
    // 检查是否已有 SOCKS5 出站
    const existing = (config.outbounds || []).find(o => o.tag === 'vpn-gate');
    if (existing) {
        log('SOCKS5 outbound already exists');
        return config;
    }

    // 添加 SOCKS5 出站
    if (!config.outbounds) config.outbounds = [];

    config.outbounds.push({
        protocol: 'socks',
        tag: 'vpn-gate',
        settings: {
            servers: [{
                address: '127.0.0.1',
                port: 1080
            }]
        }
    });

    log('Added SOCKS5 outbound: vpn-gate → ' + SOCKS5_ADDR);
    return config;
}

function modifyRouting(config) {
    if (!config.routing) config.routing = {};
    if (!config.routing.rules) config.routing.rules = [];

    // 找到现有的直连规则，修改为走 VPN
    const directRule = config.routing.rules.find(r => r.outboundTag === 'direct');
    if (directRule) {
        directRule.outboundTag = 'vpn-gate';
        log('Modified routing: direct → vpn-gate');
    }

    // 如果没有找到，添加一条默认规则
    if (!directRule) {
        config.routing.rules.push({
            type: 'field',
            network: 'tcp,udp',
            outboundTag: 'vpn-gate'
        });
        log('Added default routing rule: all → vpn-gate');
    }

    return config;
}

function killXray() {
    try {
        execSync('pkill -f "xray run"', { stdio: 'ignore' });
        log('Killed existing xray process');
    } catch (e) { }
}

function startXray() {
    const xrayPath = '/tmp/web';
    if (!fs.existsSync(xrayPath)) {
        log('xray binary not found at ' + xrayPath);
        return;
    }

    log('Starting xray with VPN Gate routing...');
    const child = spawn(xrayPath, ['run', '-c', CONFIG_PATH], {
        detached: true,
        stdio: 'ignore'
    });
    child.unref();
    log('xray started with PID: ' + child.pid);
}

async function main() {
    log('========== xray 配置修改器启动 ==========');
    log('等待 xray 配置文件生成...');

    const config = await waitForConfig();
    if (!config) {
        log('ERROR: xray 配置未生成');
        process.exit(1);
    }

    log('读取到 xray 配置');

    // 修改配置
    let modified = addSocks5Outbound(config);
    modified = modifyRouting(modified);

    // 备份原配置
    const backupPath = CONFIG_PATH + '.backup';
    fs.copyFileSync(CONFIG_PATH, backupPath);
    log('原配置已备份到: ' + backupPath);

    // 写入新配置
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(modified, null, 2), 'utf-8');
    log('新配置已写入: ' + CONFIG_PATH);

    // 重启 xray
    killXray();
    await new Promise(r => setTimeout(r, 2000));
    startXray();

    log('========== xray 配置修改完成 ==========');
}

main().catch(e => {
    log('ERROR: ' + e.message);
    process.exit(1);
});
