#!/bin/bash
# 把 ../frontend 同步到 mobile/www（打包用）。每次发版后跑一次。
set -e
cd "$(dirname "$0")/.."
rm -rf www
mkdir -p www
cp -r ../frontend/. www/
# Capacitor 不需要后端模板之外的东西；去掉开发期文件（若有）
rm -f www/*.bak www/*.orig
echo "www 已从 ../frontend 同步：$(ls www | tr '\n' ' ')"
