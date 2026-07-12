# ==========================================
# nodejs-argo + VPN Gate 完整镜像
# 架构：客户端 → VLESS/VMess → Railway → VPN Gate → 互联网
# 关键：使用 go-openvpn 用户态实现，无需 TUN/TAP
# ==========================================

# Stage 1: 编译 openvpn2socks（用户态 OpenVPN + SOCKS5）
# 已打补丁：添加 AES-128-CBC + HMAC-SHA1 支持（VPN Gate 兼容）
FROM golang:1.26-alpine3.22 AS builder

WORKDIR /src

# 安装 git + python3（用于打补丁）
RUN apk add --no-cache git python3

# 克隆 go-openvpn
RUN git clone --depth 1 https://github.com/n0madic/go-openvpn.git .

# 复制并应用 CBC+HMAC 补丁
COPY patches/ /patches/
RUN chmod +x /patches/apply.sh && sh /patches/apply.sh

# 编译 openvpn2socks（独立模块，需从子目录构建）
WORKDIR /src/cmd/openvpn2socks
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' -o /out/openvpn2socks .

# Stage 2: 运行环境
FROM node:alpine3.22

WORKDIR /tmp

# 安装运行时依赖（nginx 用于端口复用，不再需要 openvpn/iproute2）
RUN apk update && apk upgrade && \
    apk add --no-cache \
    openssl curl gcompat coreutils bash \
    ca-certificates netcat-openbsd nginx

# 复制 openvpn2socks
COPY --from=builder /out/openvpn2socks /usr/local/bin/openvpn2socks
RUN chmod +x /usr/local/bin/openvpn2socks

# 复制 nodejs-argo 原有文件（保持不变）
COPY index.js index.html package.json ./

# 复制 VPN Gate 模块（新增）
COPY vpngate.js vpngate-server.js modify-xray.js start.sh refresh-vpn.sh ./

# 安装 Node.js 依赖
RUN chmod +x index.js start.sh refresh-vpn.sh && npm install

# 配置 nginx 反向代理
COPY nginx.conf /etc/nginx/nginx.conf

# 暴露端口
# 3000: nginx (复用 VLESS/VMess + 订阅)
# 1080: SOCKS5 代理 (VPN Gate)
EXPOSE 3000/tcp 1080/tcp

# 环境变量
ENV VPNGATE_PORT=3001
ENV VPNGATE_INTERVAL=3600
ENV VPNGATE_OUTPUT=/tmp/vpngate
ENV SOCKS5_ADDR=127.0.0.1:1080
ENV XRAY_CONFIG=/tmp/config.json

# 版本信息（构建时注入）
ARG COMMIT_SHA=unknown
ARG BUILD_TIME=unknown
ENV COMMIT_SHA=${COMMIT_SHA}
ENV BUILD_TIME=${BUILD_TIME}
RUN echo "{\"commit\":\"${COMMIT_SHA}\",\"built\":\"${BUILD_TIME}\"}" > /tmp/version.json

# Go 运行时调优：激进 GC，防止 gVisor 内存爬升导致 OOM
ENV GOGC=50
ENV GOMEMLIMIT=800MiB

# 启动脚本
CMD ["sh", "start.sh"]
