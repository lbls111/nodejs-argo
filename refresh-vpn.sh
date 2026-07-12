#!/bin/sh
# 兼容旧名：触发 exit-proxy 刷新 SOCKS 池
curl -s -X POST --max-time 5 http://127.0.0.1:3001/refresh || true
echo "exit-proxy refresh requested"
