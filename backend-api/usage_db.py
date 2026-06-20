"""
使用記錄資料庫（SQLite，零外部依賴）。
記錄每一次使用：時間、IP、做了什麼動作、輸入摘要、輸出、成功/失敗、錯誤訊息、耗時。
設計成「絕不因記錄而讓主程式出錯」—— 所有寫入都包在 try 裡。
"""
import sqlite3
import os
import json
import threading
from datetime import datetime

_db_path = None
_lock = threading.Lock()

_SCHEMA = """
CREATE TABLE IF NOT EXISTS usage (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT,
    day         TEXT,
    ip          TEXT,
    endpoint    TEXT,
    summary     TEXT,
    detail      TEXT,
    status      TEXT,
    error       TEXT,
    duration_ms INTEGER,
    user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ts  ON usage(ts);
CREATE INDEX IF NOT EXISTS idx_usage_day ON usage(day);
"""


def init_db(path):
    global _db_path
    _db_path = path
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        conn = sqlite3.connect(path)
        conn.executescript(_SCHEMA)
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"[usage_db] init failed: {e}")
        _db_path = None


def log_usage(ip="", endpoint="", summary="", detail=None, status="ok", error="", duration_ms=0, user_agent=""):
    if not _db_path:
        return
    try:
        now = datetime.now()
        with _lock:
            conn = sqlite3.connect(_db_path, timeout=5)
            conn.execute(
                """INSERT INTO usage (ts,day,ip,endpoint,summary,detail,status,error,duration_ms,user_agent)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (
                    now.isoformat(timespec="seconds"),
                    now.strftime("%Y-%m-%d"),
                    (ip or "")[:64],
                    (endpoint or "")[:64],
                    (summary or "")[:500],
                    json.dumps(detail, ensure_ascii=False) if detail else "",
                    status,
                    (error or "")[:1000],
                    int(duration_ms or 0),
                    (user_agent or "")[:300],
                ),
            )
            conn.commit()
            conn.close()
    except Exception as e:
        print(f"[usage_db] log failed: {e}")


def _rows(query, args=()):
    conn = sqlite3.connect(_db_path, timeout=5)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(query, args).fetchall()]
    finally:
        conn.close()


def list_usage(limit=100, offset=0):
    if not _db_path:
        return []
    return _rows("SELECT * FROM usage ORDER BY id DESC LIMIT ? OFFSET ?", (limit, offset))


def count_usage():
    if not _db_path:
        return 0
    return _rows("SELECT COUNT(*) AS c FROM usage")[0]["c"]


def get_stats():
    if not _db_path:
        return {}
    total = count_usage()
    ok = _rows("SELECT COUNT(*) AS c FROM usage WHERE status='ok'")[0]["c"]
    err = _rows("SELECT COUNT(*) AS c FROM usage WHERE status='error'")[0]["c"]
    uniq_ip = _rows("SELECT COUNT(DISTINCT ip) AS c FROM usage")[0]["c"]
    return {
        "total": total,
        "ok": ok,
        "error": err,
        "unique_ips": uniq_ip,
        "by_day": _rows("SELECT day AS label, COUNT(*) AS count FROM usage GROUP BY day ORDER BY day DESC LIMIT 30"),
        "by_endpoint": _rows("SELECT endpoint AS label, COUNT(*) AS count FROM usage GROUP BY endpoint ORDER BY count DESC"),
        "by_hour": _rows("SELECT substr(ts,12,2) AS label, COUNT(*) AS count FROM usage GROUP BY label ORDER BY label"),
        "top_ips": _rows("SELECT ip AS label, COUNT(*) AS count FROM usage GROUP BY ip ORDER BY count DESC LIMIT 10"),
        "recent_errors": _rows("SELECT ts,ip,endpoint,error FROM usage WHERE status='error' ORDER BY id DESC LIMIT 20"),
    }
