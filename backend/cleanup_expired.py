#!/usr/bin/env python3
"""七日焚化：删除 7 天前完成的公开作品（含逐字数据与录音文件）。

公开作品（匿名）自完成 7 日后化去；注册用户作品不受影响。
幂等，建议每日凌晨由 cron 执行：
    docker exec sutra-app python3 /app/backend/cleanup_expired.py
"""
import os
import sqlite3
import sys

DB_PATH = os.environ.get("SUTRA_DB", "/data/sutra.db")
AUDIO_DIR = os.environ.get("SUTRA_AUDIO_DIR", "/app/backend/uploads/audio")
RETENTION_DAYS = int(os.environ.get("SUTRA_PUBLIC_RETENTION_DAYS", "7"))


def main():
    if not os.path.exists(DB_PATH):
        print(f"skip: no db at {DB_PATH}")
        return 0
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """SELECT id, audio_path FROM works
           WHERE is_public = 1 AND completed_at IS NOT NULL
             AND completed_at < datetime('now', ?)""",
        (f"-{RETENTION_DAYS} days",),
    ).fetchall()
    removed = 0
    for w in rows:
        wid = w["id"]
        conn.execute("DELETE FROM work_chars WHERE work_id = ?", (wid,))
        if w["audio_path"]:
            try:
                os.remove(os.path.join(AUDIO_DIR, os.path.basename(w["audio_path"])))
            except OSError:
                pass
        conn.execute("DELETE FROM works WHERE id = ?", (wid,))
        removed += 1
        print(f"cremated work {wid}")
    conn.commit()
    conn.close()
    print(f"done: {removed} public work(s) cremated after {RETENTION_DAYS}d")
    return 0


if __name__ == "__main__":
    sys.exit(main())
