#!/usr/bin/env python3
"""抄经应用后端（Flask + SQLite）骨架。

本地运行:
    cd backend
    pip install -r requirements.txt
    python app.py            # 默认监听 0.0.0.0:5000

环境变量:
    SUTRA_DB    SQLite 文件路径（默认 backend/sutra.db）
    SECRET_KEY  Flask secret（默认每次启动随机生成；生产环境请设置固定值）
    PORT        监听端口（默认 5000）

注意: 当前 user_id 由客户端传入（stub），正式上线前需接上登录态校验。
"""
import json
import os
import secrets
import sqlite3
import time
from datetime import datetime

from flask import Flask, abort, jsonify, request, send_from_directory
from werkzeug.utils import secure_filename

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(BASE_DIR)
FRONTEND_DIR = os.path.join(PROJECT_DIR, "frontend")
DATA_DIR = os.path.join(PROJECT_DIR, "data")
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
DB_PATH = os.environ.get("SUTRA_DB", os.path.join(BASE_DIR, "sutra.db"))

os.makedirs(UPLOAD_DIR, exist_ok=True)

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 上传上限 50MB

ALLOWED_EXTENSIONS = {
    "png", "jpg", "jpeg", "gif", "webp",      # 图片
    "mp3", "wav", "m4a", "aac",               # 音频
    "mp4", "webm", "mov",                     # 视频
}


# ---------- 数据库 ----------
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with open(os.path.join(BASE_DIR, "schema.sql"), encoding="utf-8") as f:
        schema = f.read()
    conn = get_db()
    conn.executescript(schema)

    # 种子经文
    row = conn.execute("SELECT COUNT(*) AS c FROM sutras").fetchone()
    if row["c"] == 0:
        with open(os.path.join(DATA_DIR, "seed_sutras.json"), encoding="utf-8") as f:
            seeds = json.load(f)
        for s in seeds:
            conn.execute(
                """INSERT INTO sutras (id, title, tradition, intro, full_text, music_config, like_count)
                   VALUES (?, ?, ?, ?, ?, ?, 0)""",
                (
                    s["id"],
                    s["title"],
                    s["tradition"],
                    s.get("intro", ""),
                    s.get("full_text"),
                    json.dumps(s.get("music", {}), ensure_ascii=False),
                ),
            )
        print(f"[init] 已导入 {len(seeds)} 部经文")

    # 开发环境默认推荐码（生产请删掉，改走管理后台发放）
    row = conn.execute("SELECT COUNT(*) AS c FROM invite_codes").fetchone()
    if row["c"] == 0:
        conn.execute(
            "INSERT INTO invite_codes (code, created_by, note) VALUES (?, ?, ?)",
            ("REM-DEV-001", "system", "开发环境默认推荐码"),
        )
        print("[init] 已创建开发推荐码: REM-DEV-001")

    conn.commit()
    conn.close()


init_db()


def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


# ---------- 前端静态文件 ----------
@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    if filename.startswith("api/"):
        abort(404)
    return send_from_directory(FRONTEND_DIR, filename)


@app.route("/uploads/<path:filename>")
def uploaded_file(filename):
    return send_from_directory(UPLOAD_DIR, filename)


# ---------- API ----------
@app.route("/api/health")
def health():
    return jsonify({"ok": True, "time": datetime.now().isoformat()})


@app.route("/api/invite/verify", methods=["POST"])
def invite_verify():
    data = request.get_json(silent=True) or {}
    code = (data.get("code") or "").strip()
    if not code:
        return jsonify({"ok": False, "message": "推荐码不能为空"}), 400
    conn = get_db()
    row = conn.execute("SELECT * FROM invite_codes WHERE code = ?", (code,)).fetchone()
    conn.close()
    if not row:
        return jsonify({"ok": False, "message": "推荐码无效"}), 404
    if row["max_uses"] and row["used_count"] >= row["max_uses"]:
        return jsonify({"ok": False, "message": "该推荐码已用完"}), 403
    return jsonify({"ok": True, "message": "验证通过"})


@app.route("/api/sutras")
def sutra_list():
    conn = get_db()
    rows = conn.execute(
        "SELECT id, title, tradition, intro, like_count,"
        "       CASE WHEN full_text IS NULL THEN 0 ELSE length(full_text) END AS char_count"
        " FROM sutras ORDER BY tradition, title"
    ).fetchall()
    conn.close()
    return jsonify({"ok": True, "sutras": [dict(r) for r in rows]})


@app.route("/api/sutra/<sutra_id>")
def sutra_detail(sutra_id):
    conn = get_db()
    row = conn.execute("SELECT * FROM sutras WHERE id = ?", (sutra_id,)).fetchone()
    conn.close()
    if not row:
        return jsonify({"ok": False, "message": "经文不存在"}), 404
    d = dict(row)
    d["music_config"] = json.loads(d["music_config"] or "{}")
    return jsonify({"ok": True, "sutra": d})


@app.route("/api/like", methods=["POST"])
def like():
    data = request.get_json(silent=True) or {}
    sutra_id = data.get("sutra_id")
    user_id = data.get("user_id")  # stub: 正式版改为从登录态取
    if not sutra_id:
        return jsonify({"ok": False, "message": "缺少 sutra_id"}), 400
    conn = get_db()
    try:
        conn.execute(
            "INSERT OR IGNORE INTO likes (sutra_id, user_id) VALUES (?, ?)",
            (sutra_id, user_id),
        )
        conn.execute(
            "UPDATE sutras SET like_count = "
            "(SELECT COUNT(*) FROM likes WHERE likes.sutra_id = sutras.id)"
            " WHERE id = ?",
            (sutra_id,),
        )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True})


@app.route("/api/comments", methods=["GET", "POST"])
def comments():
    if request.method == "GET":
        sutra_id = request.args.get("sutra_id")
        conn = get_db()
        rows = conn.execute(
            "SELECT * FROM comments WHERE sutra_id = ? ORDER BY id DESC LIMIT 100",
            (sutra_id,),
        ).fetchall()
        conn.close()
        return jsonify({"ok": True, "comments": [dict(r) for r in rows]})

    data = request.get_json(silent=True) or {}
    sutra_id = data.get("sutra_id")
    kind = data.get("kind", "text")  # text | audio | image | video
    if not sutra_id or kind not in ("text", "audio", "image", "video"):
        return jsonify({"ok": False, "message": "参数错误"}), 400
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO comments (sutra_id, user_id, kind, body, file_url)"
        " VALUES (?, ?, ?, ?, ?)",
        (
            sutra_id,
            data.get("user_id"),  # stub
            kind,
            data.get("body"),
            data.get("file_url"),
        ),
    )
    conn.commit()
    cid = cur.lastrowid
    conn.close()
    return jsonify({"ok": True, "id": cid})


@app.route("/api/upload", methods=["POST"])
def upload():
    if "file" not in request.files:
        return jsonify({"ok": False, "message": "没有文件"}), 400
    f = request.files["file"]
    if not f.filename or not allowed_file(f.filename):
        return jsonify({"ok": False, "message": "不支持的文件类型"}), 400
    name = f"{int(time.time())}_{secure_filename(f.filename)}"
    f.save(os.path.join(UPLOAD_DIR, name))
    return jsonify({"ok": True, "url": f"/uploads/{name}"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
