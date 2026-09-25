# 抄经 App · 打包工程

Capacitor 打包工程，一套前端代码同时出 Android / iOS。

- App ID：`com.arcai.sutra`
- 应用名：抄经
- 前端来源：`../frontend`（`npm run sync` 同步到 `www/`）
- API：打包后走远端 `https://scri.arcai.com`（`frontend/app.js` 的 `API_BASE` 自动切换，浏览器直连时保持同源）

## 日常发版（网页层更新）

App 内嵌的前端从服务器热更新，用户无需走商店更新。发版流程不变：

1. 改 `../frontend`，按规矩升 `?v=`；
2. `npm run sync` 同步到 `www/`；
3. 发布热更新包到服务器（待接入）；
4. 同时照常部署网页版（scp + docker build）。

## 打 Android 包

需要 JDK 17 + Android SDK（API 34）：

```bash
npm run build:android          # 同步 www 并 cap sync
cd android
./gradlew assembleDebug        # 调试包：app/build/outputs/apk/debug/app-debug.apk
./gradlew bundleRelease        # 上架包：app/build/outputs/bundle/release/app-release.aab（需先签名）
```

## 打 iOS 包（需 Mac + Xcode）

```bash
npx cap add ios
npx cap sync ios
npx cap open ios               # 在 Xcode 里签名并 Archive
```

## 上架前清单

- [ ] Google Play 开发者账号（$25 一次性）/ Apple Developer（$99/年），本人身份证 + 银行卡注册
- [ ] 正式 HTTPS 证书（已换 Let's Encrypt，Caddy 自动续期）
- [ ] 隐私政策上线：`PRIVACY.md` 发布为网页，填到商店后台
- [ ] 应用图标（已生成 `assets/icon-1024.png`，mipmap 已就位）
- [ ] 商店截图、应用介绍文案
- [ ] release 签名密钥（keystore，妥善保管，丢了就发不了更新）
- [ ] Google 新个人账号：12 名测试员封闭测试 14 天
