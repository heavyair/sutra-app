#!/usr/bin/env python3
"""七日焚化：删除已到焚化时刻的作品（含逐字数据与录音文件）。

去向由用户在完成时选择：陈列七日 / 定时焚化（最多七日）/ 即刻焚化；
注册用户私藏作品 farewell_at 为 NULL，不受影响。
幂等，建议每日凌晨由 cron 执行：
    docker exec sutra-app python3 /app/backend/cleanup_expired.py
"""
import os
import sqlite3
import sys

DB_PATH = os.environ.get("SUTRA_DB", "/data/sutra.db")
AUDIO_DIR = os.environ.get("SUTRA_AUDIO_DIR", "/app/backend/uploads/audio")


def main():
    if not os.path.exists(DB_PATH):
        print(f"skip: no db at {DB_PATH}")
        return 0
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """SELECT id, audio_path FROM works
           WHERE farewell_at IS NOT NULL
             AND farewell_at < datetime('now')"""
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
    # 回向记录：7 天无人访问（无续期）的，删除释放存储
    cols = [r[1] for r in conn.execute("PRAGMA table_info(works)").fetchall()]
    if "dedication_expires_at" in cols:
        drows = conn.execute(
            """SELECT id FROM works
               WHERE dedicated_at IS NOT NULL
                 AND dedication_expires_at < datetime('now')"""
        ).fetchall()
        for w in drows:
            conn.execute("DELETE FROM works WHERE id = ?", (w["id"],))
            removed += 1
            print(f"expired dedication work {w['id']}")
    conn.commit()
    conn.close()
    print(f"done: {removed} work(s) removed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
