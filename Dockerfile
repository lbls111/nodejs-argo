# ==========================================
# nodejs-argo + 公共 SOCKS5 干净出口
# 架构：客户端 → VLESS/VMess → Railway → SOCKS5 → 互联网
# 无 openvpn / 无 TUN / 无 go 编译
# ==========================================

FROM node:alpine3.22

WORKDIR /tmp

RUN apk update && apk upgrade && \
    apk add --no-cache \
    openssl curl gcompat coreutils bash \
    ca-certificates netcat-openbsd nginx

COPY index.js index.html package.json ./
COPY exit-proxy.js modify-xray.js start.sh ./
# 兼容旧 refresh 脚本（可选）
COPY refresh-vpn.sh ./

RUN chmod +x index.js start.sh refresh-vpn.sh && npm install

COPY nginx.conf /etc/nginx/nginx.conf

# 3000: nginx (VLESS/VMess + 订阅)
EXPOSE 3000/tcp

ENV VPNGATE_PORT=3001
ENV EXIT_PORT=3001
ENV EXIT_INTERVAL=1800
ENV EXIT_MAX_NODES=20
ENV FILE_PATH=/tmp
ENV OUTBOUND_TAG=clean-exit

ARG COMMIT_SHA=unknown
ARG BUILD_TIME=unknown
ENV COMMIT_SHA=${COMMIT_SHA}
ENV BUILD_TIME=${BUILD_TIME}
RUN echo "{\"commit\":\"${COMMIT_SHA}\",\"built\":\"${BUILD_TIME}\",\"mode\":\"socks5-exit\"}" > /tmp/version.json

CMD ["sh", "start.sh"]
