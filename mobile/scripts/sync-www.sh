#!/bin/bash
# 把前端单文件 bundle 同步为 mobile/www/index.html（打包用）。
# APK 内置页 = bundle（含热更新引导）；启动后自动从服务器拉新版替换本地。
# 每次发版（升 ?v=）后跑一次。
set -e
cd "$(dirname "$0")/.."
python3 ../build_bundle.py
rm -rf www
mkdir -p www
cp ../frontend/dist/bundle.html www/index.html
echo "www 已同步单文件 bundle：$(du -h www/index.html | cut -f1)"
