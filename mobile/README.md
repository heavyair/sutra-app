# 抄经 App · 打包工程

Capacitor 打包工程，一套前端代码同时出 Android / iOS。

- App ID：`com.arcai.sutra`
- 应用名：抄经
- 前端来源：`../frontend`（`npm run sync` 同步到 `www/`）
- API：打包后走远端 `https://scri.arcai.com`（`frontend/app.js` 的 `API_BASE` 自动切换，浏览器直连时保持同源）

## 日常发版（网页层更新）

App 内置单文件页面（`www/index.html` 即 bundle，含热更新引导），启动后在后台比对服务器版本，
有新版就下载存到本地，下次启动自动生效。**改界面不再需要重新打包。**坏包自愈：新包连续 3 次
没跑起来就回落内置版，不再拉它。

发版流程：

1. 改 `../frontend`，四个文件 `?v=` 一起升；
2. `python3 ../build_bundle.py` 生成 `frontend/dist/bundle.html`；
3. 照常部署网页版（scp `frontend/` + `backend/` → docker build），新接口 `/api/app/version`
   与 `/api/app/bundle` 会随之上线，App 侧自动完成热更新。

## 打 Android 包（手工构建，不用 Gradle）

Gradle 会反复触发 `127.0.0.1` 权限弹窗，已弃用。手工路线（aapt2 + javac + d8 + zipalign + apksigner）：

```bash
bash scripts/sync-www.sh                        # 同步单文件 bundle 到 www/
python3 scripts/manual_build/resolve_deps.py     # 只需跑一次：POM 解析下载依赖到 .deps/
bash scripts/manual_build/build_apk.sh           # 构建 → android/app/build/outputs/apk/debug/app-debug.apk
```

依赖缓存 `.deps/`、构建中间产物 `build/manual/` 不进 git。debug 签名 keystore 在 `~/.android/debug.keystore`
（脚本自动生成）。教训沉淀在脚本注释里：AAR 的 res 分目录编 flat；androidx.annotation 取 1.5.0；
去掉 capacitor 的 AppTheme.NoActionBar；R.java 改包名给 capacitor 用；d8 排除 kotlin-stdlib-jdk7/jdk8。

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
