# ==========================================
# nodejs-argo + public SOCKS5 clean exit (inline modify)
# ==========================================

FROM node:alpine3.22

WORKDIR /tmp

RUN apk update && apk upgrade && apk add --no-cache openssl curl gcompat coreutils bash jq ca-certificates netcat-openbsd nginx

COPY install-cloudflared.sh /tmp/
RUN sh /tmp/install-cloudflared.sh

COPY index.js index.html package.json ./
COPY exit-proxy.js /tmp/
COPY start.sh refresh-vpn.sh ./

RUN chmod +x index.js start.sh refresh-vpn.sh /tmp/exit-proxy.js /tmp/install-cloudflared.sh && npm install

COPY nginx.conf /etc/nginx/nginx.conf

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
