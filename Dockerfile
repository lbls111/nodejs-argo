# ==========================================
# nodejs-argo + 鍏叡 SOCKS5 骞插噣鍑哄彛锛坕nline modify锛?# ==========================================

FROM node:alpine3.22

WORKDIR /tmp

RUN apk update && apk upgrade && \
    apk add --no-cache \
    openssl curl gcompat coreutils bash jq \
    ca-certificates netcat-openbsd nginx

COPY index.js index.html package.json ./
COPY exit-proxy.js /tmp/
COPY start.sh refresh-vpn.sh ./

RUN chmod +x index.js start.sh refresh-vpn.sh /tmp/exit-proxy.js && npm install

# modify-xray 宸插唴鑱斿埌 start.sh锛屼笉鍐嶉渶瑕佸崟鐙枃浠?
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
