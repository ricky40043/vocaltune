import sqlite3
import json
import logging
from pathlib import Path
from datetime import datetime

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "db_data" / "vocaltune.db"
SEPARATED_DIR = BASE_DIR / "separated"

def expected_track_names(stems: str) -> list:
    return ["vocals", "drums", "bass", "other"] if str(stems) == "4" else ["vocals", "drums", "bass", "guitar", "piano", "other"]

def get_existing_track_urls(job_id: str, stems: str) -> dict:
    """以磁碟為準重建音軌 URL；只有指定軌數完整時才回傳。"""
    output_dir = SEPARATED_DIR / job_id
    names = expected_track_names(stems)
    if not all((output_dir / f"{name}.wav").is_file() for name in names):
        return {}
    return {name: f"/files/separated/{job_id}/{name}.wav" for name in names}

def get_db_connection():
    """取得資料庫連線，設定 timeout 避免鎖庫，並啟用 row_factory 以便回傳 dict"""
    # 確保資料夾存在以防止 Docker 掛載路徑錯誤
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=30.0)
    conn.row_factory = sqlite3.Row
    # 啟用外鍵支援
    conn.execute("PRAGMA foreign_keys = ON;")
    # 啟用 WAL 模式提高併發讀寫性能
    conn.execute("PRAGMA journal_mode = WAL;")
    return conn

def init_db():
    """初始化資料表"""
    # 確保資料夾存在以防止 Docker 掛載路徑錯誤
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    logging.info(f"Initializing database at {DB_PATH}")
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # 1. 使用者表
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)
    
    # 2. 歌曲分離實體表
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS songs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT UNIQUE NOT NULL,
        song_type TEXT NOT NULL, -- 'youtube' 或 'upload'
        youtube_url TEXT,
        video_id TEXT,
        title TEXT,
        stems TEXT NOT NULL, -- '4' 或 '6'
        file_path TEXT,
        tracks_json TEXT, -- 存放音軌 JSON: {"vocals": "...", "drums": "..."}
        status TEXT NOT NULL, -- 'pending', 'downloading', 'separating', 'completed', 'error'
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)
    
    # 針對 video_id 和 stems 建立索引，加速快取查詢
    cursor.execute("""
    CREATE INDEX IF NOT EXISTS idx_songs_youtube ON songs (video_id, stems, status);
    """)
    
    # 3. 使用者分離歷史紀錄表
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS user_histories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        song_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
        FOREIGN KEY (song_id) REFERENCES songs (id) ON DELETE CASCADE,
        UNIQUE(user_id, song_id) -- 避免重複關聯
    );
    """)
    
    conn.commit()
    conn.close()
    logging.info("Database initialized successfully.")

def get_or_create_user(username: str) -> int:
    """獲取或創立使用者，回傳 user_id"""
    if not username:
        username = "guest_default"
        
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT id FROM users WHERE username = ?", (username,))
        row = cursor.fetchone()
        if row:
            return row["id"]
        
        cursor.execute("INSERT INTO users (username) VALUES (?)", (username,))
        conn.commit()
        return cursor.lastrowid
    finally:
        conn.close()

def get_cached_youtube_song(video_id: str, stems: str) -> dict:
    """
    查詢是否有已成功分離的同首 YouTube 歌曲且檔案依然存在。
    若有，返回歌曲紀錄 dict；若無，返回 None
    """
    if not video_id:
        return None
        
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("""
            SELECT * FROM songs 
            WHERE video_id = ? AND stems = ? AND status = 'completed'
            ORDER BY created_at DESC LIMIT 1
        """, (video_id, stems))
        row = cursor.fetchone()
        if row:
            song = dict(row)
            # 必須確認指定軌數全部存在，不能只憑 vocals.wav 判定快取完整。
            job_id = song["job_id"]
            disk_tracks = get_existing_track_urls(job_id, song["stems"])
            if disk_tracks:
                song["tracks_json"] = json.dumps(disk_tracks, ensure_ascii=False)
                return song
            else:
                logging.warning(f"Cache Hit in DB for job {job_id} but required tracks are incomplete. Invalidating cache.")
        return None
    finally:
        conn.close()

def create_song_record(job_id: str, song_type: str, stems: str, title: str = None, 
                       youtube_url: str = None, video_id: str = None, file_path: str = None) -> int:
    """新增一筆歌曲分離工作紀錄，回傳 song_id"""
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("""
            INSERT INTO songs (job_id, song_type, youtube_url, video_id, title, stems, file_path, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
        """, (job_id, song_type, youtube_url, video_id, title or "未命名音訊", stems, file_path))
        conn.commit()
        return cursor.lastrowid
    finally:
        conn.close()

def add_user_history(user_id: int, song_id: int):
    """建立使用者與歌曲的歷史關聯"""
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        # 使用 INSERT OR REPLACE 來更新關聯時間
        cursor.execute("""
            INSERT OR REPLACE INTO user_histories (user_id, song_id, created_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
        """, (user_id, song_id))
        conn.commit()
    finally:
        conn.close()

def get_user_history_list(username: str) -> list:
    """獲取使用者的分離歷史紀錄"""
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("""
            SELECT s.job_id, s.song_type, s.youtube_url, s.video_id, s.title, s.stems, s.status, s.tracks_json, s.error_message, h.created_at, s.file_path
            FROM user_histories h
            JOIN users u ON h.user_id = u.id
            JOIN songs s ON h.song_id = s.id
            WHERE u.username = ?
            ORDER BY h.created_at DESC
        """, (username,))
        rows = cursor.fetchall()
        
        result = []
        for r in rows:
            item = dict(r)
            if item["tracks_json"]:
                try:
                    item["tracks"] = json.loads(item["tracks_json"])
                except Exception:
                    item["tracks"] = {}
            else:
                item["tracks"] = {}

            # completed 必須以磁碟實體檔案為準。tracks_json 遺失或損壞時可自動重建；
            # 實體音軌不完整時改為 error，避免前端顯示空白的完成頁。
            if item.get("status") == "completed":
                disk_tracks = get_existing_track_urls(item["job_id"], item["stems"])
                if disk_tracks:
                    item["tracks"] = disk_tracks
                else:
                    item["status"] = "error"
                    item["error_message"] = "分離音軌檔案不完整，請重新分離"
                    item["tracks"] = {}
            
            # 自動補全 original 軌道 URL，供前端播放器對比或載入
            if item.get("file_path") and isinstance(item["tracks"], dict):
                original_filename = Path(item["file_path"]).name
                if "downloads" in str(item["file_path"]):
                    item["tracks"]["original"] = f"/files/downloads/{original_filename}"
                else:
                    item["tracks"]["original"] = f"/files/separated/{item['job_id']}/{original_filename}"
                    
            result.append(item)
        return result
    finally:
        conn.close()

def delete_user_history_item(username: str, job_id: str) -> bool:
    """刪除該用戶對某首歌的歷史關聯（不刪除 songs 實體與檔案，保留快取）"""
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        # 尋找 user_id 和 song_id
        cursor.execute("""
            SELECT h.id FROM user_histories h
            JOIN users u ON h.user_id = u.id
            JOIN songs s ON h.song_id = s.id
            WHERE u.username = ? AND s.job_id = ?
        """, (username, job_id))
        row = cursor.fetchone()
        if row:
            cursor.execute("DELETE FROM user_histories WHERE id = ?", (row["id"],))
            conn.commit()
            return True
        return False
    finally:
        conn.close()

def clear_user_history(username: str) -> int:
    """清空該用戶的所有歷史關聯，回傳刪除的數量"""
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT id FROM users WHERE username = ?", (username,))
        user_row = cursor.fetchone()
        if not user_row:
            return 0
        user_id = user_row["id"]
        
        cursor.execute("DELETE FROM user_histories WHERE user_id = ?", (user_id,))
        deleted_count = cursor.rowcount
        conn.commit()
        return deleted_count
    finally:
        conn.close()

def update_song_status_db(job_id: str, status: str = None, title: str = None, file_path: str = None, 
                          tracks_dict: dict = None, error_message: str = None) -> bool:
    """更新歌曲分離工作的狀態與結果"""
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        # 先查詢是否存在
        cursor.execute("SELECT id FROM songs WHERE job_id = ?", (job_id,))
        if not cursor.fetchone():
            return False
            
        fields = []
        params = []
        
        if status is not None:
            fields.append("status = ?")
            params.append(status)
        
        if title is not None:
            fields.append("title = ?")
            params.append(title)
            
        if file_path is not None:
            fields.append("file_path = ?")
            params.append(file_path)
            
        if tracks_dict is not None:
            fields.append("tracks_json = ?")
            params.append(json.dumps(tracks_dict, ensure_ascii=False))
            
        if error_message is not None:
            fields.append("error_message = ?")
            params.append(error_message)
            
        if not fields:
            return True
            
        params.append(job_id)
        query = f"UPDATE songs SET {', '.join(fields)} WHERE job_id = ?"
        
        cursor.execute(query, tuple(params))
        conn.commit()
        return True
    except Exception as e:
        logging.error(f"Failed to update song status in DB for {job_id}: {e}")
        return False
    finally:
        conn.close()
