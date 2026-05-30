import os
import sys
from pathlib import Path

# 將當前目錄加入 path 以利 import
sys.path.append(str(Path(__file__).resolve().parent))

import db

def test_database():
    print("=== 開始測試資料庫 ===")
    
    # 1. 初始化資料庫
    db.init_db()
    print("[1] 資料表初始化完成。")
    
    # 2. 測試用戶註冊/取得
    user_id = db.get_or_create_user("TestUser")
    print(f"[2] 創建/取得用戶 'TestUser'，ID: {user_id}")
    assert user_id > 0, "用戶 ID 應該大於 0"
    
    user_id_again = db.get_or_create_user("TestUser")
    assert user_id == user_id_again, "同一個用戶應該回傳相同的 ID"
    
    # 3. 測試創建歌曲工作
    job_id = "testjob12345"
    song_id = db.create_song_record(
        job_id=job_id,
        song_type="youtube",
        stems="6",
        title="Test YouTube Song",
        youtube_url="https://www.youtube.com/watch?v=TEST12345",
        video_id="TEST12345",
        file_path="/files/downloads/testjob12345.mp3"
    )
    print(f"[3] 創建歌曲分離工作紀錄，Song ID: {song_id}")
    assert song_id > 0, "歌曲 ID 應該大於 0"
    
    # 4. 建立用戶與歌曲的歷史關聯
    db.add_user_history(user_id, song_id)
    print("[4] 建立用戶與歌曲的歷史關聯完成。")
    
    # 5. 測試更新歌曲狀態與音軌 JSON
    tracks_data = {
        "vocals": f"/files/separated/{job_id}/vocals.wav",
        "drums": f"/files/separated/{job_id}/drums.wav"
    }
    db.update_song_status_db(
        job_id=job_id,
        status="completed",
        tracks_dict=tracks_data
    )
    print("[5] 更新工作狀態為 completed 並寫入音軌資料。")
    
    # 建立一個實體檔案以利快取檢查命中 (db.py 中會檢查 vocals.wav 存在)
    job_dir = db.SEPARATED_DIR / job_id
    job_dir.mkdir(exist_ok=True)
    vocals_file = job_dir / "vocals.wav"
    vocals_file.write_text("dummy audio data")
    
    # 6. 測試 YouTube 快取命中
    cached = db.get_cached_youtube_song("TEST12345", "6")
    print(f"[6] 測試 YouTube 快取查詢: {cached}")
    assert cached is not None, "快取應該要命中"
    assert cached["job_id"] == job_id, "命中的 job_id 應該相符"
    
    # 7. 測試獲取歷史紀錄清單
    history = db.get_user_history_list("TestUser")
    print(f"[7] 獲取 'TestUser' 的歷史清單 (長度: {len(history)}):")
    for item in history:
        print(f"    - 歌名: {item['title']}, 狀態: {item['status']}, 軌數: {item['stems']}, 類型: {item['song_type']}, 關聯時間: {item['created_at']}")
        assert item["tracks"] is not None, "解碼的 tracks JSON 不應為空"
        assert item["tracks"]["vocals"] == tracks_data["vocals"], "解碼的音軌 URL 應正確"
        
    assert len(history) == 1, "歷史清單長度應為 1"
    
    # 8. 測試刪除單筆歷史紀錄
    deleted = db.delete_user_history_item("TestUser", job_id)
    print(f"[8] 刪除單筆歷史紀錄: {deleted}")
    assert deleted is True, "刪除應該成功"
    
    history_after = db.get_user_history_list("TestUser")
    assert len(history_after) == 0, "刪除後歷史清單長度應為 0"
    
    # 確認歌曲實體依然存在於歌曲表中 (以供快取保留)
    cached_still = db.get_cached_youtube_song("TEST12345", "6")
    assert cached_still is not None, "歷史關聯刪除後，歌曲實體快取應依然保留"
    print("[8-1] 確認歷史關聯刪除後，歌曲快取依然保留，設計符合預期！")
    
    # 9. 清理測試產出的檔案與目錄
    vocals_file.unlink()
    job_dir.rmdir()
    print("[9] 測試產出實體檔案清理完成。")
    
    print("\n=== 所有資料庫單元測試均成功通過！ ===")

if __name__ == "__main__":
    test_database()
