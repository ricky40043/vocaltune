import json
import logging
from pathlib import Path

# Shared Job Store Module to avoid circular imports
job_status_store = {}

BASE_DIR = Path(__file__).resolve().parent
SEPARATED_DIR = BASE_DIR / "separated"

def update_job_status(job_id: str, diff: dict):
    """更新任務狀態並持久化寫入磁碟"""
    if job_id not in job_status_store:
        job_status_store[job_id] = {}
    
    job_status_store[job_id].update(diff)
    
    # 磁碟持久化：如果任務有自己的目錄 (separated/{job_id})，則同步寫入 json
    job_dir = SEPARATED_DIR / job_id
    try:
        job_dir.mkdir(exist_ok=True)
        status_file = job_dir / "job_status.json"
        with open(status_file, "w", encoding="utf-8") as f:
            json.dump(job_status_store[job_id], f, ensure_ascii=False, indent=2)
    except Exception as e:
        logging.error(f"Failed to persist job status for {job_id}: {str(e)}")
    
    # 同步更新 SQLite
    status = diff.get("status")
    progress = diff.get("progress")
    if status:
        try:
            import db
            tracks = diff.get("tracks")
            error_msg = diff.get("error") or diff.get("message") if status == "error" else None
            db.update_song_status_db(
                job_id=job_id,
                status=status,
                tracks_dict=tracks,
                error_message=error_msg
            )
        except Exception as e:
            logging.error(f"Failed to sync status to DB for job {job_id}: {str(e)}")

    if status or progress:
        logging.info(f"Status Update [{job_id}]: {status} - {progress}%")

def get_job_status(job_id: str):
    """查詢任務狀態（優先查記憶體，若無則查磁碟恢復）"""
    if job_id in job_status_store:
        return job_status_store[job_id]
    
    # 如果記憶體內沒有，嘗試從硬碟的 job_status.json 讀取恢復
    status_file = SEPARATED_DIR / job_id / "job_status.json"
    if status_file.exists():
        try:
            with open(status_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                job_status_store[job_id] = data
                logging.info(f"Successfully restored job status from disk for {job_id}")
                return data
        except Exception as e:
            logging.error(f"Failed to read persisted job status for {job_id}: {str(e)}")
            
    return {"status": "unknown"}
