#!/bin/bash
# 手工构建抄经 APK（替代 Gradle）：aapt2 + javac + d8 + zipalign + apksigner。
# 不用 Gradle daemon，不触发 127.0.0.1 权限弹窗。
# 前置：python3 resolve_deps.py（只需跑一次，依赖缓存在 mobile/.deps/）
#       bash scripts/sync-www.sh（每次发版后跑，同步单文件 bundle 到 www/）
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"          # .../mobile/scripts/manual_build
MOBILE="$(dirname "$(dirname "$HERE")")"       # .../mobile
DEPS="$MOBILE/.deps"
BUILD="$MOBILE/build/manual"
SDK="$HOME/android-sdk"
BT="$SDK/build-tools/34.0.0"
ANDROID_JAR="$SDK/platforms/android-34/android.jar"
OUT="$MOBILE/android/app/build/outputs/apk/debug/app-debug.apk"

AAPT2="$BT/aapt2"; D8="$BT/d8"; ZIPALIGN="$BT/zipalign"; APKSIGNER="$BT/apksigner"
KEYSTORE="$HOME/.android/debug.keystore"

echo "== 0. 检查 =="
[ -f "$DEPS/deps.json" ] || { echo "先跑 python3 resolve_deps.py"; exit 1; }
[ -f "$MOBILE/www/index.html" ] || { echo "先跑 bash scripts/sync-www.sh"; exit 1; }
[ -f "$ANDROID_JAR" ] || { echo "缺 $ANDROID_JAR"; exit 1; }
rm -rf "$BUILD"; mkdir -p "$BUILD"

echo "== 1. 解包 AAR =="
python3 - "$DEPS" "$BUILD" << 'EOF'
import json, os, sys, zipfile
deps_dir, build = sys.argv[1], sys.argv[2]
man = json.load(open(os.path.join(deps_dir, "deps.json")))
n = 0
for m in man:
    if m["kind"] != "aar":
        continue
    name = "%s-%s-%s" % (m["group"], m["artifact"], m["version"])
    dest = os.path.join(build, "aar", name)
    os.makedirs(dest, exist_ok=True)
    with zipfile.ZipFile(m["path"]) as z:
        z.extractall(dest)
    n += 1
print("解包 %d 个 AAR" % n)
EOF

echo "== 2. 准备 res（app / capacitor / 各 AAR） =="
mkdir -p "$BUILD/res"
cp -r "$MOBILE/android/app/src/main/res" "$BUILD/res/app"
# capacitor 的 res：去掉与 app 冲突的 AppTheme.NoActionBar（教训）
mkdir -p "$BUILD/res/cap"
cp -r "$MOBILE/node_modules/@capacitor/android/capacitor/src/main/res/." "$BUILD/res/cap/"
python3 - << EOF
import re
p = "$BUILD/res/cap/values/styles.xml"
s = open(p, encoding="utf-8").read()
s2 = re.sub(r'\s*<style name="AppTheme\.NoActionBar".*?</style>', '', s, flags=re.S)
assert s2 != s, "没找到 capacitor 的 AppTheme.NoActionBar"
open(p, "w", encoding="utf-8").write(s2)
print("已去掉 capacitor 的 AppTheme.NoActionBar")
EOF
# 各 AAR 的 res 分目录存放（教训：同名 values_values.arsc.flat 会互相覆盖）
i=0
for d in "$BUILD"/aar/*/; do
  if [ -d "$d/res" ]; then
    cp -r "$d/res" "$BUILD/res/aar_$i"
    i=$((i+1))
  fi
done
echo "res 目录数: $(ls "$BUILD/res" | wc -l)"

echo "== 3. aapt2 compile =="
mkdir -p "$BUILD/flat"
for d in "$BUILD"/res/*/; do
  name="$(basename "$d")"
  mkdir -p "$BUILD/flat/$name"
  "$AAPT2" compile --dir "$d" -o "$BUILD/flat/$name/"
done
echo "flat 文件总数: $(find "$BUILD/flat" -name '*.flat' | wc -l)"

echo "== 4. 准备 assets 与 manifest =="
mkdir -p "$BUILD/assets/public"
cp "$MOBILE/www/index.html" "$BUILD/assets/public/"
touch "$BUILD/assets/public/cordova.js" "$BUILD/assets/public/cordova_plugins.js"
node -e "console.log(JSON.stringify(require('$MOBILE/capacitor.config.js'), null, '\t'))" \
  > "$BUILD/assets/capacitor.config.json"
echo '[]' > "$BUILD/assets/capacitor.plugins.json"
# manifest 占位符 ${applicationId} 换成真包名（Gradle 原来代劳），并补 package 属性
sed 's/${applicationId}/com.arcai.sutra/g' \
  "$MOBILE/android/app/src/main/AndroidManifest.xml" > "$BUILD/AndroidManifest.xml"
sed -i 's|<manifest |<manifest package="com.arcai.sutra" |' "$BUILD/AndroidManifest.xml"

echo "== 5. aapt2 link =="
mkdir -p "$BUILD/gen"
FLATS="$(find "$BUILD/flat" -name '*.flat' | sort)"
# shellcheck disable=SC2086
"$AAPT2" link -o "$BUILD/app-base.apk" \
  --manifest "$BUILD/AndroidManifest.xml" \
  -I "$ANDROID_JAR" \
  --min-sdk-version 22 --target-sdk-version 34 \
  --version-code 1 --version-name 1.0 \
  --java "$BUILD/gen" \
  -A "$BUILD/assets" \
  $FLATS
echo "link 完成: $(du -h "$BUILD/app-base.apk" | cut -f1)"

echo "== 6. 生成 R.java（app + capacitor 用） =="
# 教训：capacitor 源码引 com.getcapacitor.android.R，从主 R.java 改包名生成
mkdir -p "$BUILD/gen/com/getcapacitor/android"
sed 's/^package com\.arcai\.sutra;/package com.getcapacitor.android;/' \
  "$BUILD/gen/com/arcai/sutra/R.java" > "$BUILD/gen/com/getcapacitor/android/R.java"
grep -m1 '^package' "$BUILD/gen/com/getcapacitor/android/R.java"

echo "== 7. javac =="
mkdir -p "$BUILD/classes"
# classpath：android.jar + 全部 AAR 的 classes.jar + 全部 jar 依赖
CP="$ANDROID_JAR"
for j in "$BUILD"/aar/*/classes.jar; do CP="$CP:$j"; done
for m in $(python3 -c "
import json
man = json.load(open('$DEPS/deps.json'))
print(' '.join(x['path'] for x in man if x['kind']=='jar'))"); do
  CP="$CP:$m"
done
find "$MOBILE/android/app/src/main/java" "$MOBILE/node_modules/@capacitor/android/capacitor/src/main/java" "$BUILD/gen" \
  -name '*.java' > "$BUILD/sources.txt"
echo "源码文件数: $(wc -l < "$BUILD/sources.txt")"
javac -encoding UTF-8 -nowarn -cp "$CP" -d "$BUILD/classes" @"$BUILD/sources.txt"
echo "javac 完成: $(find "$BUILD/classes" -name '*.class' | wc -l) 个类"

echo "== 8. d8 =="
mkdir -p "$BUILD/dex"
# d8 不接受裸 class 目录，先打成 jar
jar cf "$BUILD/app-classes.jar" -C "$BUILD/classes" .
D8INPUTS="$BUILD/app-classes.jar"
for j in "$BUILD"/aar/*/classes.jar; do D8INPUTS="$D8INPUTS $j"; done
for m in $(python3 -c "
import json
man = json.load(open('$DEPS/deps.json'))
skip = ('kotlin-stdlib-jdk7', 'kotlin-stdlib-jdk8')  # 教训：与 stdlib 重复类
print(' '.join(x['path'] for x in man if x['kind']=='jar' and x['artifact'] not in skip))"); do
  D8INPUTS="$D8INPUTS $m"
done
# shellcheck disable=SC2086
"$D8" --min-api 22 --output "$BUILD/dex/" $D8INPUTS
echo "dex: $(du -h "$BUILD/dex/classes.dex" | cut -f1)"

echo "== 9. 装配 APK =="
python3 - "$BUILD" << 'EOF'
import sys, zipfile
build = sys.argv[1]
# 干净重建：去掉旧的 classes.dex（若有），再装入新的，避免重复条目
with zipfile.ZipFile(build + "/app-base.apk", "r") as zin:
    items = [(i, zin.read(i.filename)) for i in zin.infolist()
             if i.filename != "classes.dex"]
with zipfile.ZipFile(build + "/app-with-dex.apk", "w", zipfile.ZIP_DEFLATED) as zout:
    for info, data in items:
        zout.writestr(info, data)
    zout.write(build + "/dex/classes.dex", "classes.dex")
print("APK 重建完成，classes.dex 已装入")
EOF
"$ZIPALIGN" -p -f 4 "$BUILD/app-with-dex.apk" "$BUILD/app-aligned.apk"
if [ ! -f "$KEYSTORE" ]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  keytool -genkeypair -keystore "$KEYSTORE" -alias androiddebugkey \
    -storepass android -keypass android -keyalg RSA -keysize 2048 -validity 10950 \
    -dname "CN=Android Debug,O=Android,C=US" 2>/dev/null
  echo "已生成 debug keystore"
fi
mkdir -p "$(dirname "$OUT")"
"$APKSIGNER" sign --ks "$KEYSTORE" --ks-pass pass:android --key-pass pass:android \
  --out "$OUT" "$BUILD/app-aligned.apk"

echo "== 10. 验证 =="
"$APKSIGNER" verify --print-certs "$OUT" | head -4
unzip -l "$OUT" | grep -E 'assets/public/index.html|capacitor.config.json|classes.dex|AndroidManifest.xml'
echo "APK: $(du -h "$OUT" | cut -f1) -> $OUT"
