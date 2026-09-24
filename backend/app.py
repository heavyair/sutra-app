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


def migrate_works():
    """作品与逐字落笔存储（幂等）。"""
    conn = get_db()
    conn.execute(
        """CREATE TABLE IF NOT EXISTS works (
             id          INTEGER PRIMARY KEY AUTOINCREMENT,
             sutra_id    TEXT NOT NULL,
             title       TEXT NOT NULL,
             font_id     TEXT,
             owner_type  TEXT NOT NULL DEFAULT 'anon',
             owner_id    INTEGER,
             anon_key    TEXT,
             is_public   INTEGER NOT NULL DEFAULT 1,
             share_token TEXT,
             audio_path  TEXT,
             chars_total INTEGER DEFAULT 0,
             chars_done  INTEGER DEFAULT 0,
             completed_at TEXT,
             farewell_at   TEXT,
             farewell_mode TEXT,                      -- 去向：keep=私藏 | public=陈列 | cremate=焚化
             created_at  TEXT DEFAULT (datetime('now')),
             updated_at  TEXT DEFAULT (datetime('now'))
           )"""
    )
    # completed_at：公开作品 7 日焚化期的起点（幂等补列）
    cols = [r[1] for r in conn.execute("PRAGMA table_info(works)").fetchall()]
    if "completed_at" not in cols:
        conn.execute("ALTER TABLE works ADD COLUMN completed_at TEXT")
        # 存量回填：已写完的公开作品自本次起算 7 日
        conn.execute(
            """UPDATE works SET completed_at = datetime('now')
               WHERE completed_at IS NULL AND is_public = 1
                 AND chars_total > 0 AND chars_done >= chars_total"""
        )
    # farewell_at：焚化时刻（NULL=不焚化，即注册用户私藏）。清理脚本只看此列。
    if "farewell_at" not in cols:
        conn.execute("ALTER TABLE works ADD COLUMN farewell_at TEXT")
        conn.execute(
            """UPDATE works SET farewell_at = datetime(completed_at, '+7 days')
               WHERE farewell_at IS NULL AND completed_at IS NOT NULL AND is_public = 1"""
        )
    # farewell_mode：去向选择（幂等补列）
    cols = [r[1] for r in conn.execute("PRAGMA table_info(works)").fetchall()]
    if "farewell_mode" not in cols:
        conn.execute("ALTER TABLE works ADD COLUMN farewell_mode TEXT")
        conn.execute(
            """UPDATE works SET farewell_mode = 'public'
               WHERE farewell_mode IS NULL AND farewell_at IS NOT NULL"""
        )
    # 回向：dedicated_at / dedication_target / dedication_text / dedication_kind / ash_cells /
    #      dedicator_name（回向署名，空=匿名）/ dedication_expires_at（7天无人访问删除；幂等补列）
    cols = [r[1] for r in conn.execute("PRAGMA table_info(works)").fetchall()]
    for _col in ("dedicated_at", "dedication_target", "dedication_text", "dedication_kind", "ash_cells",
                 "dedicator_name", "dedication_expires_at"):
        if _col not in cols:
            conn.execute(f"ALTER TABLE works ADD COLUMN {_col} TEXT")
    # 存量已回向作品：按回向时刻起算 7 天有效期
    conn.execute(
        """UPDATE works SET dedication_expires_at = datetime(dedicated_at, '+7 days')
           WHERE dedicated_at IS NOT NULL AND dedication_expires_at IS NULL"""
    )
    # 最后书写者：公开作品的最后书写者可回向（幂等补列；存量按作者回填）
    cols = [r[1] for r in conn.execute("PRAGMA table_info(works)").fetchall()]
    if "last_writer_type" not in cols:
        conn.execute("ALTER TABLE works ADD COLUMN last_writer_type TEXT")
    if "last_writer_id" not in cols:
        conn.execute("ALTER TABLE works ADD COLUMN last_writer_id INTEGER")
    if "last_writer_anon" not in cols:
        conn.execute("ALTER TABLE works ADD COLUMN last_writer_anon TEXT")
    conn.execute(
        """UPDATE works SET last_writer_type = owner_type, last_writer_id = owner_id,
               last_writer_anon = anon_key WHERE last_writer_type IS NULL"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS work_chars (
             id         INTEGER PRIMARY KEY AUTOINCREMENT,
             work_id    INTEGER NOT NULL,
             pos        INTEGER NOT NULL,
             ch         TEXT NOT NULL,
             pen        TEXT,
             strokes    TEXT NOT NULL,
             updated_at TEXT DEFAULT (datetime('now')),
             UNIQUE (work_id, pos)
           )"""
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_works_owner ON works(owner_type, owner_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_works_public ON works(is_public, updated_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_work_chars_work ON work_chars(work_id)")
    conn.commit()
    conn.close()


init_db()
migrate_auth()
migrate_verification()
migrate_works()


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
        "SELECT s.id, s.title, s.tradition, s.intro, s.like_count,"
        "       CASE WHEN s.full_text IS NULL THEN 0 ELSE length(s.full_text) END AS char_count,"
        "       (SELECT COUNT(*) FROM works w WHERE w.sutra_id = s.id"
        "        AND w.dedicated_at IS NOT NULL"
        "        AND w.dedication_expires_at > datetime('now')) AS dedication_count"
        " FROM sutras s ORDER BY s.tradition, s.title"
    ).fetchall()
    conn.close()
    return jsonify({"ok": True, "sutras": [dict(r) for r in rows]})


@app.route("/api/sutra/<sutra_id>/dedications")
def sutra_dedications(sutra_id):
    """某经文的回向记录：所有已回向作品（公开/个人），按回向时间倒序。
    只返回有效期内；每次访问，有效期延长 7 天（无人访问 7 天后由清理脚本删除）。"""
    conn = get_db()
    srow = conn.execute("SELECT id FROM sutras WHERE id = ?", (sutra_id,)).fetchone()
    if not srow:
        conn.close()
        return jsonify({"ok": False, "message": "经文不存在"}), 404
    conn.execute(
        """UPDATE works SET dedication_expires_at = datetime('now', '+7 days')
           WHERE sutra_id = ? AND dedicated_at IS NOT NULL
             AND dedication_expires_at > datetime('now')""",
        (sutra_id,),
    )
    rows = conn.execute(
        """SELECT id, dedication_text, dedication_kind, dedication_target,
                  dedicator_name, dedicated_at, ash_cells
           FROM works
           WHERE sutra_id = ? AND dedicated_at IS NOT NULL
             AND dedication_expires_at > datetime('now')
           ORDER BY dedicated_at DESC LIMIT 100""",
        (sutra_id,),
    ).fetchall()
    conn.commit()
    conn.close()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["ash_cells"] = json.loads(d["ash_cells"] or "[]")
        except Exception:
            d["ash_cells"] = []
        out.append(d)
    return jsonify({"ok": True, "dedications": out})


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


# ---------- 作品（逐字落笔存储） ----------
# 匿名作品公开：任何人可看、可续写、可改；注册用户作品默认私有，可分享。

AUDIO_DIR = os.path.join(UPLOAD_DIR, "audio")
os.makedirs(AUDIO_DIR, exist_ok=True)


def _anon_key():
    return request.headers.get("X-Anon-Key", "") or ""


def _work_role(work, user):
    """返回 'owner' | 'writer' | 'reader' | None。
    owner: 作者本人（注册用户本人 / anon_key 持有者）
    writer: 可写（匿名公开作品对任何人可写：可续写、可改）
    reader: 可读（公开作品 / 分享链接）"""
    if not work:
        return None
    akey = _anon_key()
    is_owner = (user and work["owner_type"] == "user" and work["owner_id"] == user["id"]) or \
               (akey and work["anon_key"] and akey == work["anon_key"])
    if is_owner:
        return "owner"
    if work["is_public"]:
        return "writer" if work["owner_type"] == "anon" else "reader"
    share = request.args.get("share", "")
    if share and work["share_token"] and share == work["share_token"]:
        return "reader"
    return None


def _is_last_writer(work, user):
    """是否为该作品的最后书写者（写下一字的人）。"""
    keys = work.keys()
    t = work["last_writer_type"] if "last_writer_type" in keys else None
    if t == "user" and user:
        return work["last_writer_id"] == user["id"]
    if t == "anon":
        akey = _anon_key()
        return bool(akey) and bool(work["last_writer_anon"]) and work["last_writer_anon"] == akey
    return False


def _can_dedicate_work(work):
    """回向权限：登录作者（原规则），或公开作品的最后书写者（新规则）。"""
    keys = work.keys()
    if "dedicated_at" in keys and work["dedicated_at"]:
        return False
    user = current_user()
    role = _work_role(work, user)
    if role == "owner" and work["owner_type"] == "user" and user:
        return True
    return bool(work["is_public"]) and _is_last_writer(work, user)


def _work_json(w):
    keys = w.keys()
    farewell_at = w["farewell_at"] if "farewell_at" in keys else None
    farewell_days = None
    if farewell_at:
        try:
            dt = datetime.strptime(farewell_at, "%Y-%m-%d %H:%M:%S")
            secs = (dt - datetime.utcnow()).total_seconds()
            farewell_days = max(0, int(-(-secs // 86400)))
        except (ValueError, TypeError):
            pass
    return {
        "id": w["id"], "sutra_id": w["sutra_id"], "title": w["title"],
        "font_id": w["font_id"], "owner_type": w["owner_type"],
        "is_public": bool(w["is_public"]), "has_audio": bool(w["audio_path"]),
        "chars_total": w["chars_total"], "chars_done": w["chars_done"],
        "created_at": w["created_at"], "updated_at": w["updated_at"],
        "completed_at": w["completed_at"] if "completed_at" in keys else None,
        "farewell_at": farewell_at, "farewell_days": farewell_days,
        "farewell_mode": w["farewell_mode"] if "farewell_mode" in keys else None,
        "dedicated_at": w["dedicated_at"] if "dedicated_at" in keys else None,
        "dedication_target": w["dedication_target"] if "dedication_target" in keys else None,
        "dedication_text": w["dedication_text"] if "dedication_text" in keys else None,
        "dedication_kind": w["dedication_kind"] if "dedication_kind" in keys else None,
        "ash_cells": _parse_ash(w["ash_cells"]) if "ash_cells" in keys else [],
        "can_dedicate": _can_dedicate_work(w),
    }


def _parse_ash(raw):
    try:
        v = json.loads(raw or "[]")
        return sorted(set(int(x) for x in v)) if isinstance(v, list) else []
    except Exception:
        return []


@app.route("/api/works", methods=["POST"])
def work_create():
    data = request.get_json(silent=True) or {}
    sutra_id = (data.get("sutra_id") or "").strip()
    font_id = (data.get("font_id") or "").strip()
    if not sutra_id:
        return jsonify({"ok": False, "message": "缺少 sutra_id"}), 400
    conn = get_db()
    s = conn.execute("SELECT title, full_text FROM sutras WHERE id = ?", (sutra_id,)).fetchone()
    if not s:
        conn.close()
        return jsonify({"ok": False, "message": "经文不存在"}), 404
    total = len((s["full_text"] or "").replace("\n", "").replace(" ", "").replace("\r", ""))
    user = current_user()
    if user:
        conn.execute(
            """INSERT INTO works (sutra_id, title, font_id, owner_type, owner_id, is_public, chars_total,
                                  last_writer_type, last_writer_id)
               VALUES (?, ?, ?, 'user', ?, 0, ?, 'user', ?)""",
            (sutra_id, s["title"], font_id, user["id"], total, user["id"]),
        )
        wid = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        conn.commit()
        w = conn.execute("SELECT * FROM works WHERE id = ?", (wid,)).fetchone()
        conn.close()
        return jsonify({"ok": True, "work": _work_json(w)})
    akey = _anon_key() or secrets.token_urlsafe(16)
    conn.execute(
        """INSERT INTO works (sutra_id, title, font_id, owner_type, anon_key, is_public, chars_total,
                              last_writer_type, last_writer_anon)
           VALUES (?, ?, ?, 'anon', ?, 1, ?, 'anon', ?)""",
        (sutra_id, s["title"], font_id, akey, total, akey),
    )
    wid = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
    conn.commit()
    w = conn.execute("SELECT * FROM works WHERE id = ?", (wid,)).fetchone()
    conn.close()
    j = _work_json(w)
    j["anon_key"] = akey
    return jsonify({"ok": True, "work": j})


@app.route("/api/works", methods=["GET"])
def work_list_public():
    """公开画廊：最近更新的公开作品。"""
    limit = max(1, min(60, int(request.args.get("limit", 24))))
    conn = get_db()
    rows = conn.execute(
        """SELECT * FROM works WHERE is_public = 1
           ORDER BY updated_at DESC LIMIT ?""",
        (limit,),
    ).fetchall()
    conn.close()
    return jsonify({"ok": True, "works": [_work_json(w) for w in rows]})


@app.route("/api/my/works", methods=["GET"])
def work_list_mine():
    """我的作品：注册用户按 user_id；匿名按 X-Anon-Key。"""
    user = current_user()
    akey = _anon_key()
    conn = get_db()
    if user:
        rows = conn.execute(
            "SELECT * FROM works WHERE owner_type='user' AND owner_id=? ORDER BY updated_at DESC",
            (user["id"],),
        ).fetchall()
    elif akey:
        rows = conn.execute(
            "SELECT * FROM works WHERE owner_type='anon' AND anon_key=? ORDER BY updated_at DESC",
            (akey,),
        ).fetchall()
    else:
        conn.close()
        return jsonify({"ok": True, "works": []})
    conn.close()
    return jsonify({"ok": True, "works": [_work_json(w) for w in rows]})


@app.route("/api/works/<int:wid>", methods=["GET"])
def work_get(wid):
    conn = get_db()
    w = conn.execute("SELECT * FROM works WHERE id = ?", (wid,)).fetchone()
    role = _work_role(w, current_user())
    if not role:
        conn.close()
        return jsonify({"ok": False, "message": "作品不存在或无权查看"}), 404
    chars = conn.execute(
        "SELECT pos, ch, pen, strokes FROM work_chars WHERE work_id = ? ORDER BY pos",
        (wid,),
    ).fetchall()
    if "dedicated_at" in w.keys() and w["dedicated_at"]:
        # 回向记录：每次有人访问（查看此作），有效期延长 7 天；已过期的不再续（等清理删除）
        conn.execute(
            """UPDATE works SET dedication_expires_at = datetime('now', '+7 days')
               WHERE id = ? AND (dedication_expires_at IS NULL
                                 OR dedication_expires_at > datetime('now'))""",
            (wid,),
        )
        conn.commit()
    conn.close()
    out = []
    for c in chars:
        try:
            strokes = json.loads(c["strokes"])
        except Exception:
            strokes = {}
        out.append({"pos": c["pos"], "ch": c["ch"], "pen": c["pen"], "strokes": strokes})
    j = _work_json(w)
    j["role"] = role
    return jsonify({"ok": True, "work": j, "chars": out})


@app.route("/api/works/<int:wid>/chars", methods=["PUT"])
def work_save_char(wid):
    """保存一个字（最小存储单位）。匿名公开作品任何人可写；私有作品仅作者。"""
    data = request.get_json(silent=True) or {}
    try:
        pos = int(data.get("pos"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "message": "缺少 pos"}), 400
    ch = (data.get("ch") or "")[:4]
    pen = (data.get("pen") or "")[:16]
    strokes = data.get("strokes")
    if not isinstance(strokes, dict):
        return jsonify({"ok": False, "message": "strokes 非法"}), 400
    blob = json.dumps(strokes, separators=(",", ":"), ensure_ascii=False)
    if len(blob) > 500 * 1024:
        return jsonify({"ok": False, "message": "笔画数据过大"}), 413
    conn = get_db()
    w = conn.execute("SELECT * FROM works WHERE id = ?", (wid,)).fetchone()
    role = _work_role(w, current_user())
    if role not in ("owner", "writer"):
        conn.close()
        return jsonify({"ok": False, "message": "无权修改"}), 403
    if "dedicated_at" in w.keys() and w["dedicated_at"]:
        conn.close()
        return jsonify({"ok": False, "message": "此作已回向，不可再写"}), 400
    conn.execute(
        """INSERT INTO work_chars (work_id, pos, ch, pen, strokes, updated_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(work_id, pos) DO UPDATE
           SET ch=excluded.ch, pen=excluded.pen, strokes=excluded.strokes,
               updated_at=datetime('now')""",
        (wid, pos, ch, pen, blob),
    )
    conn.execute(
        """UPDATE works SET chars_done = (SELECT COUNT(*) FROM work_chars WHERE work_id = ?),
                              updated_at = datetime('now'),
                              farewell_at = NULL, farewell_mode = NULL WHERE id = ?""",
        (wid, wid),
    )
    # 记录最后书写者：公开作品的最后书写者可回向
    _me = current_user()
    _ak = _anon_key()
    if _me:
        conn.execute(
            "UPDATE works SET last_writer_type = 'user', last_writer_id = ?, last_writer_anon = NULL WHERE id = ?",
            (_me["id"], wid),
        )
    elif _ak:
        conn.execute(
            "UPDATE works SET last_writer_type = 'anon', last_writer_id = NULL, last_writer_anon = ? WHERE id = ?",
            (_ak, wid),
        )
    # 无身份（未带 key 的续写）：保持原最后书写者不变
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/works/<int:wid>/chars/<int:pos>", methods=["DELETE"])
def work_delete_char(wid, pos):
    conn = get_db()
    w = conn.execute("SELECT * FROM works WHERE id = ?", (wid,)).fetchone()
    role = _work_role(w, current_user())
    if role not in ("owner", "writer"):
        conn.close()
        return jsonify({"ok": False, "message": "无权修改"}), 403
    if "dedicated_at" in w.keys() and w["dedicated_at"]:
        conn.close()
        return jsonify({"ok": False, "message": "此作已回向，不可再改"}), 400
    conn.execute("DELETE FROM work_chars WHERE work_id = ? AND pos = ?", (wid, pos))
    conn.execute(
        """UPDATE works SET chars_done = (SELECT COUNT(*) FROM work_chars WHERE work_id = ?),
                              updated_at = datetime('now') WHERE id = ?""",
        (wid, wid),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/works/<int:wid>", methods=["DELETE"])
def work_delete(wid):
    conn = get_db()
    w = conn.execute("SELECT * FROM works WHERE id = ?", (wid,)).fetchone()
    if _work_role(w, current_user()) != "owner":
        conn.close()
        return jsonify({"ok": False, "message": "无权删除"}), 403
    conn.execute("DELETE FROM work_chars WHERE work_id = ?", (wid,))
    if w["audio_path"]:
        try:
            os.remove(os.path.join(AUDIO_DIR, os.path.basename(w["audio_path"])))
        except OSError:
            pass
    conn.execute("DELETE FROM works WHERE id = ?", (wid,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/works/<int:wid>/complete", methods=["POST"])
def work_complete(wid):
    """标记完成 + 选择去向（幂等；重复完成不覆盖已有选择）。
    mode: ''=仅标记完成(首次按默认去向) | 'keep'=私藏 | 'public'=陈列七日 | 'cremate'=定时焚化
    days: cremate 时 1~7（最多七日）"""
    data = request.get_json(silent=True) or {}
    mode = (data.get("mode") or "").strip()
    try:
        days = max(1, min(7, int(data.get("days", 7))))
    except (TypeError, ValueError):
        days = 7
    conn = get_db()
    w = conn.execute("SELECT * FROM works WHERE id = ?", (wid,)).fetchone()
    role = _work_role(w, current_user())
    if role not in ("owner", "writer"):
        conn.close()
        return jsonify({"ok": False, "message": "无权操作"}), 403
    if not w["completed_at"]:
        conn.execute("UPDATE works SET completed_at = datetime('now') WHERE id = ?", (wid,))
    if mode == "keep":
        # 私藏：不设焚化时刻（注册用户默认）
        conn.execute("UPDATE works SET farewell_at = NULL, farewell_mode = 'keep' WHERE id = ?", (wid,))
    elif mode == "public":
        # 分享到公众陈列：最长展示七日，到期焚化
        conn.execute(
            """UPDATE works SET is_public = 1, farewell_mode = 'public',
                   farewell_at = datetime('now', '+7 days') WHERE id = ?""",
            (wid,),
        )
    elif mode == "cremate":
        # 定时焚化：1~7 日后
        conn.execute(
            "UPDATE works SET farewell_at = datetime('now', ?), farewell_mode = 'cremate' WHERE id = ?",
            (f"+{days} days", wid),
        )
    elif not w["farewell_at"]:
        # 首次完成默认去向：匿名→陈列七日；注册用户→私藏
        if w["owner_type"] == "anon":
            conn.execute(
                """UPDATE works SET is_public = 1, farewell_mode = 'public',
                       farewell_at = datetime('now', '+7 days') WHERE id = ?""",
                (wid,),
            )
        else:
            conn.execute("UPDATE works SET farewell_mode = 'keep' WHERE id = ?", (wid,))
    conn.execute("UPDATE works SET updated_at = datetime('now') WHERE id = ?", (wid,))
    conn.commit()
    w = conn.execute("SELECT * FROM works WHERE id = ?", (wid,)).fetchone()
    conn.close()
    return jsonify({"ok": True, "work": _work_json(w)})


@app.route("/api/works/<int:wid>/cremate", methods=["POST"])
def work_cremate(wid):
    """即刻焚化：立即删除作品（含字数据与录音）。形化去，功德留存。"""
    conn = get_db()
    w = conn.execute("SELECT * FROM works WHERE id = ?", (wid,)).fetchone()
    if _work_role(w, current_user()) != "owner":
        conn.close()
        return jsonify({"ok": False, "message": "无权焚化"}), 403
    conn.execute("DELETE FROM work_chars WHERE work_id = ?", (wid,))
    if w["audio_path"]:
        try:
            os.remove(os.path.join(AUDIO_DIR, os.path.basename(w["audio_path"])))
        except OSError:
            pass
    conn.execute("DELETE FROM works WHERE id = ?", (wid,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/storage/status", methods=["GET"])
def storage_status():
    """磁盘用量：注册用户空间不足时提示下载本地保存。"""
    try:
        import shutil
        db_dir = os.path.dirname(os.path.abspath(DB_PATH))
        st = shutil.disk_usage(db_dir)
        pct = round(st.used / st.total * 100, 1) if st.total else 0
        return jsonify({"ok": True, "percent": pct, "low": pct >= 80,
                        "free_mb": round(st.free / 1048576)})
    except OSError:
        return jsonify({"ok": True, "percent": 0, "low": False, "free_mb": 0})


@app.route("/api/works/<int:wid>/share", methods=["POST"])
def work_share(wid):
    """注册用户生成分享链接（#w=…&share=…）。"""
    user, err = require_user()
    if err:
        return err
    conn = get_db()
    w = conn.execute("SELECT * FROM works WHERE id = ?", (wid,)).fetchone()
    if not w or not (w["owner_type"] == "user" and w["owner_id"] == user["id"]):
        conn.close()
        return jsonify({"ok": False, "message": "无权分享"}), 403
    token = w["share_token"] or secrets.token_urlsafe(16)
    conn.execute("UPDATE works SET share_token = ? WHERE id = ?", (token, wid))
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "share_token": token})


DEDICATION_TEXTS = {
    # 回向偈
    "huixiangji": ("愿以此抄经功德，回向{target}。"
                   "愿以此功德，庄严佛净土，上报四重恩，下济三途苦；"
                   "若有见闻者，悉发菩提心，尽此一报身，同生极乐国。"),
    # 普贤行愿品·回向
    "puxian": ("愿以此抄经功德，回向{target}。"
               "所有十方世界中，三世一切人师子，我以清净身语意，一切遍礼尽无余。"
               "愿我临欲命终时，尽除一切诸障碍，面见彼佛阿弥陀，即得往生安乐刹。"),
    # 平等回向
    "pingdeng": ("愿以此抄经功德，回向{target}。"
                 "愿以此功德，平等施一切，同发菩提心，往生安乐国。"),
    # 消灾祈福
    "xiaozai": ("愿以此抄经功德，回向{target}。"
                "愿消三障诸烦恼，愿得智慧真明了，"
                "普愿罪障悉消除，世世常行菩萨道。"),
}
DEDICATION_KINDS = {"huixiangji": "回向偈", "puxian": "普贤回向",
                    "pingdeng": "平等回向", "xiaozai": "消灾祈福"}


@app.route("/api/works/<int:wid>/dedicate", methods=["POST"])
def work_dedicate(wid):
    """回向：登录作者（原规则），或公开作品的最后书写者。
    生成回向文；字迹化烟（删逐字笔画与录音），留灰尘格与回向文作纪念；
    清除焚化安排（清理脚本只看 farewell_at）。"""
    conn = get_db()
    w = conn.execute("SELECT * FROM works WHERE id = ?", (wid,)).fetchone()
    if not w:
        conn.close()
        return jsonify({"ok": False, "message": "作品不存在"}), 404
    keys = w.keys()
    if "dedicated_at" in keys and w["dedicated_at"]:
        conn.close()
        return jsonify({"ok": False, "message": "已经回向过了"}), 400
    if not _can_dedicate_work(w):
        conn.close()
        return jsonify({"ok": False, "message": "仅作者或最后书写者可回向"}), 403
    data = request.get_json(silent=True) or {}
    target = (data.get("target") or "").strip()[:40] or "法界一切众生"
    kind = data.get("kind")
    if kind not in DEDICATION_TEXTS:
        kind = "huixiangji"
    dname = (data.get("dedicator_name") or "").strip()[:20]  # 空=匿名
    rows = conn.execute("SELECT pos FROM work_chars WHERE work_id = ?", (wid,)).fetchall()
    ash = sorted(set(r["pos"] for r in rows))
    if not ash:
        conn.close()
        return jsonify({"ok": False, "message": "还没有写字"}), 400
    text = DEDICATION_TEXTS[kind].format(target=target)
    conn.execute("DELETE FROM work_chars WHERE work_id = ?", (wid,))
    if w["audio_path"]:
        try:
            os.remove(os.path.join(AUDIO_DIR, os.path.basename(w["audio_path"])))
        except OSError:
            pass
    conn.execute(
        """UPDATE works SET dedicated_at = datetime('now'), dedication_target = ?,
               dedication_text = ?, dedication_kind = ?, dedicator_name = ?,
               dedication_expires_at = datetime('now', '+7 days'),
               ash_cells = ?, audio_path = NULL,
               farewell_at = NULL, farewell_mode = 'dedicated',
               updated_at = datetime('now') WHERE id = ?""",
        (target, text, kind, dname, json.dumps(ash), wid),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "dedication_text": text, "dedication_kind": kind, "ash_cells": ash})


@app.route("/api/works/<int:wid>/audio", methods=["POST"])
def work_audio_upload(wid):
    conn = get_db()
    w = conn.execute("SELECT * FROM works WHERE id = ?", (wid,)).fetchone()
    role = _work_role(w, current_user())
    if role not in ("owner", "writer"):
        conn.close()
        return jsonify({"ok": False, "message": "无权上传"}), 403
    if "audio" not in request.files:
        conn.close()
        return jsonify({"ok": False, "message": "没有音频文件"}), 400
    f = request.files["audio"]
    name = f"work_{wid}.webm"
    f.save(os.path.join(AUDIO_DIR, name))
    conn.execute("UPDATE works SET audio_path = ?, updated_at = datetime('now') WHERE id = ?",
                 (name, wid))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/works/<int:wid>/audio", methods=["GET"])
def work_audio_get(wid):
    conn = get_db()
    w = conn.execute("SELECT * FROM works WHERE id = ?", (wid,)).fetchone()
    role = _work_role(w, current_user())
    conn.close()
    if not role or not w["audio_path"]:
        return jsonify({"ok": False, "message": "无音频"}), 404
    return send_from_directory(AUDIO_DIR, os.path.basename(w["audio_path"]),
                               mimetype="audio/webm")


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
