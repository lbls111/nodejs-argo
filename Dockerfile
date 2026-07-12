# ==========================================
# nodejs-argo + VPN Gate 完整镜像
# 架构：客户端 → VLESS/VMess → Railway → VPN Gate → 互联网
# ==========================================

# Stage 1: 编译 vpngate-to-socks
FROM golang:1.26-alpine3.22 AS builder

WORKDIR /src

# 克隆 vpngate-to-socks
RUN apk add --no-cache git && \
    git clone https://github.com/Sakuralaaa/vpngate-to-socks.git .

# 编译
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' -o /out/vpngate-web . && \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' -o /out/vpngate-runner ./cmd/vpngate-runner

# Stage 2: 运行环境
FROM node:alpine3.22

WORKDIR /tmp

# 安装 OpenVPN 和其他依赖
RUN apk update && apk upgrade && \
    apk add --no-cache \
    openssl curl gcompat iproute2 coreutils bash \
    openvpn ca-certificates \
    netcat-openbsd

# 复制 vpngate-to-socks
COPY --from=builder /out/vpngate-web /usr/local/bin/vpngate-web
COPY --from=builder /out/vpngate-runner /usr/local/bin/vpngate-runner
RUN chmod +x /usr/local/bin/vpngate-web /usr/local/bin/vpngate-runner

# 复制 nodejs-argo 原有文件（保持不变）
COPY index.js index.html package.json ./

# 复制 VPN Gate 模块（新增）
COPY vpngate.js vpngate-server.js modify-xray.js start.sh ./

# 安装 Node.js 依赖
RUN chmod +x index.js start.sh && npm install

# 暴露端口
# 3000: nodejs-argo (VLESS/VMess/Trojan)
# 1080: SOCKS5 代理 (VPN Gate)
EXPOSE 3000/tcp 1080/tcp

# 环境变量
ENV VPNGATE_PORT=3001
ENV VPNGATE_INTERVAL=3600
ENV VPNGATE_OUTPUT=/tmp/vpngate
ENV SOCKS5_ADDR=127.0.0.1:1080
ENV XRAY_CONFIG=/tmp/config.json

# 启动脚本
CMD ["sh", "start.sh"]
