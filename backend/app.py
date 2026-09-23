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

注意: 写入接口（点赞/留言/上传）需要 Authorization: Bearer token 登录态。
"""
import base64
import json
import os
import re
import secrets
import smtplib
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from flask import Flask, abort, jsonify, request, send_from_directory
from werkzeug.security import check_password_hash, generate_password_hash
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


def migrate_verification():
    """验证码表（幂等）。"""
    conn = get_db()
    conn.execute(
        """CREATE TABLE IF NOT EXISTS verification_codes (
             id           INTEGER PRIMARY KEY AUTOINCREMENT,
             account      TEXT NOT NULL,
             account_type TEXT NOT NULL,   -- phone | email
             code_hash    TEXT NOT NULL,
             expires_at   TEXT NOT NULL,
             used         INTEGER DEFAULT 0,
             attempts     INTEGER DEFAULT 0,
             created_at   TEXT DEFAULT (datetime('now'))
           )"""
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_vcodes_account ON verification_codes(account)"
    )
    conn.commit()
    conn.close()


def migrate_auth():
    """账号体系迁移：给 users 表加 account/account_type/password_hash，加 sessions 表。幂等。"""
    conn = get_db()
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(users)").fetchall()]
    if "account" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN account TEXT")
    if "account_type" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN account_type TEXT")
    if "password_hash" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN password_hash TEXT")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_account ON users(account)")
    conn.execute(
        """CREATE TABLE IF NOT EXISTS sessions (
             token      TEXT PRIMARY KEY,
             user_id    INTEGER NOT NULL,
             created_at TEXT DEFAULT (datetime('now'))
           )"""
    )
    conn.commit()
    conn.close()


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
migrate_auth()
migrate_verification()


def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


# ---------- 前端静态文件 ----------
@app.route("/")
def index():
    # index.html 必须每次重新验证：它携带 JS/CSS 的版本号，
    # 否则浏览器可能用旧 HTML 配旧 JS，或新旧混搭导致空指针
    resp = send_from_directory(FRONTEND_DIR, "index.html")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


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
    ok, msg = check_invite(code)
    if not ok:
        return jsonify({"ok": False, "message": msg}), 404
    return jsonify({"ok": True, "message": "验证通过"})


# ---------- 账号体系 ----------

PHONE_RE = re.compile(r"^\+?\d{7,15}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def check_invite(code):
    """返回 (是否有效, 提示信息)。"""
    conn = get_db()
    row = conn.execute("SELECT * FROM invite_codes WHERE code = ?", (code,)).fetchone()
    conn.close()
    if not row:
        return False, "推荐码无效"
    if row["max_uses"] and row["used_count"] >= row["max_uses"]:
        return False, "该推荐码已用完"
    return True, "验证通过"


def normalize_account(account_type, account):
    """返回 (是否合法, 规范化后的账号)。"""
    account = (account or "").strip()
    if account_type == "phone":
        return bool(PHONE_RE.match(account)), account
    if account_type == "email":
        account = account.lower()
        return bool(EMAIL_RE.match(account)), account
    return False, account


def current_user():
    """从 Authorization: Bearer token 解析当前用户，无效返回 None。"""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    token = auth[7:].strip()
    if not token:
        return None
    conn = get_db()
    row = conn.execute(
        "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?",
        (token,),
    ).fetchone()
    conn.close()
    return row


def require_user():
    u = current_user()
    if not u:
        return None, (jsonify({"ok": False, "message": "请先登录", "need_auth": True}), 401)
    return u, None


def issue_token(conn, user_id):
    token = secrets.token_hex(32)
    conn.execute("INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, user_id))
    return token


@app.route("/api/register", methods=["POST"])
def register():
    data = request.get_json(silent=True) or {}
    code = (data.get("invite_code") or "").strip()
    ok, msg = check_invite(code)
    if not ok:
        return jsonify({"ok": False, "message": msg}), 403
    account_type = data.get("account_type")
    valid, account = normalize_account(account_type, data.get("account"))
    if not valid:
        return jsonify({"ok": False, "message": "手机号或邮箱格式不正确"}), 400
    password = data.get("password") or ""
    if len(password) < 6:
        return jsonify({"ok": False, "message": "密码至少 6 位"}), 400

    conn = get_db()
    if conn.execute("SELECT id FROM users WHERE account = ?", (account,)).fetchone():
        conn.close()
        return jsonify({"ok": False, "message": "该账号已注册，请直接登录"}), 409
    conn.close()

    ok, msg = consume_code(account, data.get("code"))
    if not ok:
        return jsonify({"ok": False, "message": msg}), 400

    conn = get_db()
    cur = conn.execute(
        "INSERT INTO users (account, account_type, password_hash, invite_code)"
        " VALUES (?, ?, ?, ?)",
        (account, account_type, generate_password_hash(password), code),
    )
    conn.execute(
        "UPDATE invite_codes SET used_count = used_count + 1 WHERE code = ?", (code,)
    )
    token = issue_token(conn, cur.lastrowid)
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "token": token, "account": account})


@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    account = (data.get("account") or "").strip()
    if "@" in account:
        account = account.lower()
    password = data.get("password") or ""
    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE account = ?", (account,)).fetchone()
    if (
        not user
        or not user["password_hash"]
        or not check_password_hash(user["password_hash"], password)
    ):
        conn.close()
        return jsonify({"ok": False, "message": "账号或密码不正确"}), 401
    token = issue_token(conn, user["id"])
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "token": token, "account": user["account"]})


# ---------- 注册验证码（邮箱 / 短信） ----------

CODE_TTL_MINUTES = 15
CODE_RESEND_SECONDS = 60
CODE_MAX_PER_HOUR = 10
CODE_MAX_ATTEMPTS = 5


def _utcnow():
    return datetime.now(timezone.utc)


def _fmt(dt):
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def _parse(s):
    # SQLite datetime('now') 与本模块存入的时间统一为 UTC 'YYYY-MM-DD HH:MM:SS'
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)


def send_email_code(to_email, code):
    """返回 (是否成功, 提示信息)。"""
    host = os.environ.get("SMTP_HOST", "")
    port = int(os.environ.get("SMTP_PORT", "587") or 587)
    user = os.environ.get("SMTP_USER", "")
    password = os.environ.get("SMTP_PASS", "")
    sender = os.environ.get("SMTP_FROM", user)
    if not (host and user and password):
        return False, "邮件服务未配置"
    try:
        msg = EmailMessage()
        msg["Subject"] = "抄经 · 注册验证码"
        msg["From"] = sender
        msg["To"] = to_email
        msg.set_content(
            f"您的注册验证码是 {code}，{CODE_TTL_MINUTES} 分钟内有效。请勿转发给他人。"
        )
        with smtplib.SMTP(host, port, timeout=15) as s:
            s.starttls()
            s.login(user, password)
            s.send_message(msg)
        return True, ""
    except Exception as e:  # noqa: BLE001 — 错误透出给前端便于排查
        return False, f"邮件发送失败：{e}"


def send_sms_code(to_phone, code):
    """Twilio 短信。返回 (是否成功, 提示信息)。"""
    sid = os.environ.get("TWILIO_SID", "")
    token = os.environ.get("TWILIO_TOKEN", "")
    from_num = os.environ.get("TWILIO_FROM", "")
    if not (sid and token and from_num):
        return False, "短信服务未配置"
    try:
        body = urlencode(
            {
                "To": to_phone,
                "From": from_num,
                "Body": f"【抄经】您的注册验证码是 {code}，{CODE_TTL_MINUTES} 分钟内有效。",
            }
        ).encode()
        req = Request(
            f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
            data=body,
            headers={
                "Authorization": "Basic "
                + base64.b64encode(f"{sid}:{token}".encode()).decode()
            },
        )
        with urlopen(req, timeout=15) as resp:
            if resp.status not in (200, 201):
                return False, f"短信发送失败（{resp.status}）"
        return True, ""
    except Exception as e:  # noqa: BLE001
        return False, f"短信发送失败：{e}"


@app.route("/api/auth/send-code", methods=["POST"])
def auth_send_code():
    data = request.get_json(silent=True) or {}
    account_type = data.get("account_type")
    valid, account = normalize_account(account_type, data.get("account"))
    if not valid:
        return jsonify({"ok": False, "message": "手机号或邮箱格式不正确"}), 400

    conn = get_db()
    # 顺手清理一天前的旧验证码
    conn.execute(
        "DELETE FROM verification_codes WHERE expires_at < ?",
        (_fmt(_utcnow() - timedelta(days=1)),),
    )
    recent = conn.execute(
        "SELECT created_at FROM verification_codes WHERE account = ?"
        " ORDER BY id DESC LIMIT 1",
        (account,),
    ).fetchone()
    if recent:
        last = _parse(recent["created_at"])
        if (_utcnow() - last).total_seconds() < CODE_RESEND_SECONDS:
            conn.close()
            return (
                jsonify({"ok": False, "message": f"{CODE_RESEND_SECONDS} 秒后再试"}),
                429,
            )
    hourly = conn.execute(
        "SELECT COUNT(*) AS c FROM verification_codes"
        " WHERE account = ? AND created_at > ?",
        (account, _fmt(_utcnow() - timedelta(hours=1))),
    ).fetchone()
    if hourly["c"] >= CODE_MAX_PER_HOUR:
        conn.close()
        return jsonify({"ok": False, "message": "发送太频繁，请稍后再试"}), 429

    code = "%06d" % secrets.randbelow(1000000)
    expires_at = _fmt(_utcnow() + timedelta(minutes=CODE_TTL_MINUTES))
    conn.execute(
        "INSERT INTO verification_codes (account, account_type, code_hash, expires_at)"
        " VALUES (?, ?, ?, ?)",
        (account, account_type, generate_password_hash(code), expires_at),
    )
    conn.commit()
    conn.close()

    if account_type == "email":
        ok, msg = send_email_code(account, code)
    else:
        ok, msg = send_sms_code(account, code)
    if not ok:
        return jsonify({"ok": False, "message": msg}), 502
    return jsonify(
        {"ok": True, "message": "验证码已发送", "ttl_minutes": CODE_TTL_MINUTES}
    )


def consume_code(account, code):
    """校验并核销验证码。返回 (是否成功, 提示信息)。"""
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM verification_codes WHERE account = ? AND used = 0"
        " ORDER BY id DESC LIMIT 1",
        (account,),
    ).fetchone()
    if not row or _parse(row["expires_at"]) <= _utcnow():
        conn.close()
        return False, "验证码无效或已过期，请重新发送"
    if row["attempts"] >= CODE_MAX_ATTEMPTS:
        conn.close()
        return False, "尝试次数过多，请重新发送"
    if not check_password_hash(row["code_hash"], code or ""):
        conn.execute(
            "UPDATE verification_codes SET attempts = attempts + 1 WHERE id = ?",
            (row["id"],),
        )
        conn.commit()
        conn.close()
        return False, "验证码不正确"
    conn.execute("UPDATE verification_codes SET used = 1 WHERE id = ?", (row["id"],))
    conn.commit()
    conn.close()
    return True, ""


@app.route("/api/me")
def me():
    u = current_user()
    if not u:
        return jsonify({"ok": False, "message": "请先登录", "need_auth": True}), 401
    return jsonify(
        {
            "ok": True,
            "user": {
                "id": u["id"],
                "account": u["account"],
                "account_type": u["account_type"],
            },
        }
    )


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
    user, err = require_user()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    sutra_id = data.get("sutra_id")
    user_id = user["id"]
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
    user, err = require_user()
    if err:
        return err
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO comments (sutra_id, user_id, kind, body, file_url)"
        " VALUES (?, ?, ?, ?, ?)",
        (
            sutra_id,
            user["id"],
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
    _, err = require_user()
    if err:
        return err
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
