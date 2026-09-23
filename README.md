# 抄经 · 静心 —— 移动端 Web 应用

手机访问的手指抄经应用：推荐码准入，佛道经典库，手指在画布上临摹书写，
Web Audio 实时生成氛围背景音乐（按经文配调式，随抄写进度加层），支持点赞、
文字 / 音频 / 图片 / 视频留言与经文分享。

## 架构

```
sutra-app/
├── backend/
│   ├── app.py            # Flask 应用（API + 静态文件同源服务）
│   ├── schema.sql        # SQLite 表结构
│   ├── requirements.txt  # Flask, gunicorn
│   ├── uploads/          # 用户上传的音/图/视频（gitignore，不入库）
│   └── sutra.db          # SQLite 数据库（首次启动自动创建 + 灌种子数据）
├── frontend/             # 原生 HTML/CSS/JS，无构建步骤
│   ├── index.html        # 四个屏幕：推荐码 / 经文库 / 抄经 / 留言
│   ├── styles.css        # 移动端优先样式
│   ├── app.js            # 屏幕路由 + API 调用
│   ├── music.js          # Web Audio 生成式氛围音乐引擎（五声音阶）
│   └── writing.js        # 手指书写画布（毛笔/硬笔/榜书三种笔触）
├── data/
│   └── seed_sutras.json  # 种子经文（心经/道德经第一章/清静经/大悲咒全文；金刚经待补充）
└── README.md
```

前后端同源部署：Flask 同时提供 `/api/*` 接口和前端静态文件，
正式环境前面可加 nginx 做反向代理与 HTTPS。

### API 一览（均为 stub 级实现，可启动；鉴权后续迭代）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/invite/verify | 校验推荐码 `{code}` |
| GET  | /api/sutras | 经文列表（含字数、点赞数） |
| GET  | /api/sutra/<id> | 经文详情（含全文、音乐配置） |
| POST | /api/like | 点赞 `{sutra_id}` |
| GET/POST | /api/comments | 留言列表 / 发表留言（text/audio/image/video） |
| POST | /api/upload | 文件上传 → 返回 `/uploads/...` 地址 |
| GET  | /api/health | 健康检查 |

## 本地运行

```bash
cd sutra-app/backend
pip install -r requirements.txt
python app.py
# 浏览器打开 http://localhost:5000
# 开发推荐码：REM-DEV-001（生产环境请删除，见下方）
```

环境变量：`SUTRA_DB`（数据库路径）、`SECRET_KEY`（生产务必设置固定值）、`PORT`。

## 部署到 VPS（Ubuntu 示例）

```bash
# 1. 传代码到 VPS（任选其一）
rsync -avz --exclude uploads --exclude '*.db' ./ user@your-vps:/opt/sutra-app/
# 或：git clone <repo> /opt/sutra-app

# 2. 装依赖
cd /opt/sutra-app/backend
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# 3. 准备生产推荐码（删掉开发码，写入真实码）
sqlite3 sutra.db "DELETE FROM invite_codes WHERE code='REM-DEV-001';"
sqlite3 sutra.db "INSERT INTO invite_codes (code, created_by, note) VALUES ('YOUR-REAL-CODE','admin','首批');"

# 4. systemd 服务：/etc/systemd/system/sutra.service
```

```ini
[Unit]
Description=Sutra copy app
After=network.target

[Service]
User=www-data
WorkingDirectory=/opt/sutra-app/backend
Environment="SECRET_KEY=请改成随机长字符串"
Environment="PORT=5000"
ExecStart=/opt/sutra-app/backend/venv/bin/gunicorn -w 2 -b 127.0.0.1:5000 app:app
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
# 5. 启动
sudo systemctl daemon-reload
sudo systemctl enable --now sutra.service

# 6. nginx 反向代理（可选）/etc/nginx/sites-enabled/sutra
```

```nginx
server {
    listen 80;
    server_name sutra.example.com;
    client_max_body_size 55m;   # 音/视频上传
    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
# 建议再用 certbot 加 HTTPS：sudo certbot --nginx -d sutra.example.com
```

## 本机验证结果

- 安装：`pip install -r requirements.txt`（Flask 3.x）
- 启动：`cd backend && python app.py` → 监听 0.0.0.0:5000，数据库自动初始化
- `GET /` → 200，返回前端首页（含四个屏幕骨架）
- `GET /api/sutras` → 200，返回 5 部经文（心经/道德经第一章/清静经/大悲咒全文，金刚经标注待补充全文）
- `POST /api/invite/verify` `{code:"REM-DEV-001"}` → 200 `{"ok": true}`
- `GET /api/sutra/xingjing` → 200，含全文与音乐配置
- `GET /api/health` → 200

（以上为骨架验证通过；鉴权、音频录制、笔顺校验等功能后续迭代。）
