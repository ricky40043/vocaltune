"""
VocalTune Pro Backend API
FastAPI 應用程式，處理音樂下載與 AI 分離服務
支援直接 YouTube 下載和本地 Demucs 分離
"""

import os
from datetime import datetime, timedelta
import uuid
import subprocess
import tempfile
import shutil
from pathlib import Path
from typing import Optional, List
from fastapi import FastAPI, HTTPException, BackgroundTasks, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import asyncio
import json
import media_policy

# Directories
BASE_DIR = Path(__file__).parent
DOWNLOADS_DIR = BASE_DIR / "downloads"
SEPARATED_DIR = BASE_DIR / "separated"
DOWNLOADS_DIR.mkdir(exist_ok=True)
SEPARATED_DIR.mkdir(exist_ok=True)

from job_store import job_status_store, update_job_status, get_job_status
from karaoke import process_karaoke_job, KARAOKE_DIR
from ai_device import demucs_python, get_demucs_device
from utils.youtube_search import search_youtube
import db

# Queue Persistence (supports per-user queues)
def get_queue_file(user: str = None) -> Path:
    """取得佇列檔案路徑，支援個人歌單"""
    if user:
        return BASE_DIR / f"queue_{user}.json"
    return BASE_DIR / "queue.json"

# Ensure default queue file exists
if not (BASE_DIR / "queue.json").exists():
    with open(BASE_DIR / "queue.json", "w") as f:
        json.dump([], f)

def load_queue(user: str = None):
    qf = get_queue_file(user)
    try:
        if not qf.exists():
            return []
        with open(qf, "r") as f:
            return json.load(f)
    except:
        return []

def save_queue(queue_data, user: str = None):
    with open(get_queue_file(user), "w") as f:
        json.dump(queue_data, f, indent=2, ensure_ascii=False)

async def queue_processor():
    """Background task to process karaoke queue sequentially (scans all queue files)"""
    logging.info("Queue Processor Started")
    
    # Reset stuck 'processing' items across all queue files
    try:
        for qf in BASE_DIR.glob("queue*.json"):
            user = None
            fname = qf.stem  # e.g. 'queue' or 'queue_ricky'
            if fname.startswith("queue_"):
                user = fname[6:]  # extract user from filename
            
            queue = load_queue(user)
            stuck_count = 0
            for item in queue:
                is_stuck = item["status"] == "processing"
                is_bugged = item["status"] == "error" and "unexpected keyword argument" in item.get("error", "")
                
                if is_stuck or is_bugged:
                    item["status"] = "pending"
                    item["progress"] = 0
                    stuck_count += 1
            if stuck_count > 0:
                save_queue(queue, user)
                logging.info(f"Reset {stuck_count} stuck/bugged jobs to pending in {qf.name}")
    except Exception as e:
        logging.error(f"Failed to reset stuck jobs: {e}")

    while True:
        try:
            # Scan all queue files for pending items
            for qf in BASE_DIR.glob("queue*.json"):
                user = None
                fname = qf.stem
                if fname.startswith("queue_"):
                    user = fname[6:]
                
                queue = load_queue(user)
                # Find next pending item
                pending_item = next((item for item in queue if item["status"] == "pending"), None)
                
                if pending_item:
                    job_id = pending_item["id"]
                    youtube_url = pending_item["youtube_url"]
                    
                    logging.info(f"Processing Queue Item: {job_id} ({pending_item.get('title', 'Unknown')}) [user={user or 'shared'}]")
                    
                    # Update status to processing
                    for item in queue:
                        if item["id"] == job_id:
                            item["status"] = "processing"
                            item["progress"] = 0
                    save_queue(queue, user)
                    
                    # Execute Karaoke Job
                    try:
                        task = asyncio.create_task(process_karaoke_job(job_id, youtube_url=youtube_url))
                        
                        # Wait for task while syncing progress
                        while not task.done():
                            await asyncio.sleep(1)
                            current_status = get_job_status(job_id)
                            if current_status:
                                q = load_queue(user)
                                for item in q:
                                    if item["id"] == job_id:
                                        item["progress"] = current_status.get("progress", 0)
                                save_queue(q, user)
                        
                        await task
                        
                        # Check actual job result from job_status_store
                        final_status = get_job_status(job_id)
                        actual_status = final_status.get("status", "") if final_status else ""
                        
                        queue = load_queue(user)
                        if actual_status == "completed":
                            # Success
                            for item in queue:
                                if item["id"] == job_id:
                                    item["status"] = "completed"
                                    item["progress"] = 100
                            save_queue(queue, user)
                            logging.info(f"Queue Item Completed: {job_id}")
                        else:
                            # Job finished but didn't reach completed state
                            error_msg = final_status.get("error", "Job did not complete successfully") if final_status else "No status found"
                            for item in queue:
                                if item["id"] == job_id:
                                    item["status"] = "error"
                                    item["error"] = error_msg
                            save_queue(queue, user)
                            logging.error(f"Queue Item Failed (status={actual_status}): {job_id} - {error_msg}")
                        
                    except Exception as e:
                        logging.error(f"Queue Job Failed: {e}")
                        queue = load_queue(user)
                        for item in queue:
                            if item["id"] == job_id:
                                item["status"] = "error"
                                item["error"] = str(e)
                        save_queue(queue, user)
                    
                    break  # Process one job at a time across all queues
            
            await asyncio.sleep(2)
            
        except Exception as e:
            logging.error(f"Queue Processor Critical Error: {e}")
            await asyncio.sleep(5)


async def auto_cleanup():
    """每小時檢查一次，刪除超過 7 天的資料"""
    logging.info("Auto Cleanup Task Started")
    while True:
        try:
            cutoff = datetime.now() - timedelta(days=7)
            cleaned = 0
            
            # 1. 清除過期的 queue items
            for qf in BASE_DIR.glob("queue*.json"):
                try:
                    with open(qf, "r") as f:
                        queue = json.load(f)
                    original_len = len(queue)
                    new_queue = []
                    for item in queue:
                        added_at = item.get("added_at", "")
                        try:
                            item_time = datetime.fromisoformat(added_at)
                            if item_time >= cutoff:
                                new_queue.append(item)
                            else:
                                cleaned += 1
                        except (ValueError, TypeError):
                            new_queue.append(item)  # Keep items without valid timestamp
                    if len(new_queue) < original_len:
                        with open(qf, "w") as f:
                            json.dump(new_queue, f, indent=2, ensure_ascii=False)
                        logging.info(f"Cleanup: Removed {original_len - len(new_queue)} expired items from {qf.name}")
                except Exception as e:
                    logging.error(f"Cleanup queue error ({qf.name}): {e}")
            
            # 2. 清除過期的 karaoke_output（按日期資料夾 YYYYMMDD）
            if KARAOKE_DIR.exists():
                for date_dir in KARAOKE_DIR.iterdir():
                    if date_dir.is_dir() and len(date_dir.name) == 8:
                        try:
                            dir_date = datetime.strptime(date_dir.name, "%Y%m%d")
                            if dir_date < cutoff:
                                shutil.rmtree(date_dir)
                                cleaned += 1
                                logging.info(f"Cleanup: Removed karaoke output {date_dir.name}")
                        except ValueError:
                            pass
            
            # 3. 清除過期的 downloads 和 separated
            for directory in [DOWNLOADS_DIR, SEPARATED_DIR]:
                if not directory.exists():
                    continue
                for file_path in directory.iterdir():
                    try:
                        mtime = datetime.fromtimestamp(file_path.stat().st_mtime)
                        if mtime < cutoff:
                            if file_path.is_file():
                                file_path.unlink()
                                cleaned += 1
                            elif file_path.is_dir():
                                shutil.rmtree(file_path)
                                cleaned += 1
                    except Exception as e:
                        logging.error(f"Cleanup file error ({file_path}): {e}")
            
            if cleaned > 0:
                logging.info(f"Auto Cleanup Complete: {cleaned} items removed")
                
        except Exception as e:
            logging.error(f"Auto Cleanup Error: {e}")
        
        await asyncio.sleep(3600)  # 每小時執行一次

# Job status store is now imported from job_store.py

# Logging Configuration
import logging
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(BASE_DIR / "debug.log"),
        logging.StreamHandler()
    ]
)
logging.info("Backend Service Started")

# Initialize FastAPI
app = FastAPI(
    title="VocalTune Pro API",
    description="YouTube 音樂下載與 AI 人聲分離服務",
    version="2.0.0"
)

# CORS Configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all for local development (Best for LAN)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─────────────────────────── 使用紀錄 DB + 後台 ──────────────────────────────
import usage_db
from fastapi import Request
from fastapi.responses import JSONResponse
usage_db.init_db(str(BASE_DIR / "db_data" / "usage.db"))
ADMIN_TOKEN = os.getenv('ADMIN_TOKEN', '')

def client_ip(request: Request):
    return (request.headers.get('cf-connecting-ip')
            or request.headers.get('x-forwarded-for', '').split(',')[0].strip()
            or (request.client.host if request.client else '') or '')

def _admin_ok(request: Request):
    if not ADMIN_TOKEN:
        return False
    got = request.headers.get('x-admin-token') or request.query_params.get('token', '')
    if not got:
        a = request.headers.get('authorization', '')
        if a.startswith('Bearer '):
            got = a[7:]
    return got == ADMIN_TOKEN

@app.get("/admin")
def admin_page():
    return FileResponse(str(BASE_DIR / "admin.html"))

@app.get("/api/admin/usage")
def admin_usage(request: Request, limit: int = 100, offset: int = 0):
    if not _admin_ok(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    return {"items": usage_db.list_usage(min(limit, 500), offset), "total": usage_db.count_usage()}

@app.get("/api/admin/stats")
def admin_stats(request: Request):
    if not _admin_ok(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    return usage_db.get_stats()

@app.get("/api/admin/ktv")
def admin_ktv(request: Request):
    if not _admin_ok(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    try:
        conn = db.get_db_connection()
        users = [dict(r) for r in conn.execute("SELECT username, created_at FROM users ORDER BY created_at DESC").fetchall()]
        songs = [dict(r) for r in conn.execute("SELECT title, song_type, youtube_url, status, created_at FROM songs ORDER BY created_at DESC LIMIT 200").fetchall()]
        play_count = conn.execute("SELECT COUNT(*) c FROM user_histories").fetchone()["c"]
        conn.close()
        return {"user_count": len(users), "song_count": len(songs), "play_count": play_count,
                "users": users, "songs": songs}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

# Serve static files (downloaded and separated audio)
app.mount("/files/downloads", StaticFiles(directory=str(DOWNLOADS_DIR)), name="downloads")
app.mount("/files/separated", StaticFiles(directory=str(SEPARATED_DIR)), name="separated")
app.mount("/files/karaoke", StaticFiles(directory=str(KARAOKE_DIR)), name="karaoke")

# ============== Request/Response Models ==============

class DownloadRequest(BaseModel):
    youtube_url: str

class DownloadResponse(BaseModel):
    job_id: str
    status: str
    message: str

class SeparateRequest(BaseModel):
    file_path: str  # Path to audio file (can be job_id or filename)
    stems: Optional[str] = "6"  # "4", "6"
    username: Optional[str] = None
    youtube_url: Optional[str] = None

class JobStatusResponse(BaseModel):
    job_id: str
    status: str
    progress: int = 0
    message: str = ""
    file_url: Optional[str] = None
    vocals_url: Optional[str] = None
    instrumental_url: Optional[str] = None
    tracks: Optional[dict] = None
    error: Optional[str] = None

class AnalyzeRequest(BaseModel):
    file_path: str

class TranscribeRequest(BaseModel):
    job_id: str  # Original separation job ID
    stem: str    # Which stem to transcribe (vocals, piano, guitar, etc.)

class TranscribeResponse(BaseModel):
    task_id: str
    status: str
    message: str

class SongRequest(BaseModel):
    youtube_url: str
    title: str = "Unknown Title"
    thumbnail: Optional[str] = None
    duration: Optional[str] = "0:00"

class AdminModeLogin(BaseModel):
    password: str

@app.post("/api/admin-mode/login")
async def admin_mode_login(request: AdminModeLogin):
    return {"token": media_policy.authenticate(request.password), "expires_in": media_policy.ADMIN_MODE_TTL_SECONDS}

@app.on_event("startup")
async def startup_event():
    db.init_db()
    asyncio.create_task(queue_processor())
    asyncio.create_task(auto_cleanup())

@app.get("/api/youtube/search")
async def search_youtube_endpoint(q: str):
    """Search YouTube without API Key"""
    if not q:
        return []
    return search_youtube(q)

@app.get("/api/queue")
async def get_queue(user: str = None):
    """Get current song queue (supports per-user queues via ?user=xxx)"""
    return load_queue(user)

@app.post("/api/queue")
async def add_to_queue(request: SongRequest, http_request: Request, user: str = None):
    """Add a song to the queue (supports per-user queues via ?user=xxx)"""
    duration = await asyncio.to_thread(media_policy.probe_youtube_duration, request.youtube_url)
    media_policy.enforce_duration(duration, http_request)
    queue = load_queue(user)
    
    # Check if already exists
    if any(item["youtube_url"] == request.youtube_url and item["status"] in ["pending", "processing"] for item in queue):
         raise HTTPException(status_code=400, detail="Song already in queue")
         
    job_id = str(uuid.uuid4())[:8]
    new_item = {
        "id": job_id,
        "youtube_url": request.youtube_url,
        "title": request.title,
        "thumbnail": request.thumbnail,
        "duration": request.duration,
        "status": "pending",
        "progress": 0,
        "added_at": datetime.now().isoformat(),
        "user": user  # 記錄是誰點的
    }
    
    queue.append(new_item)
    save_queue(queue, user)
    
    # Initialize job status in store as well so status API works
    update_job_status(job_id, {"status": "pending", "progress": 0, "message": "In Queue"})
    
    return new_item

@app.delete("/api/queue/{item_id}")
async def remove_from_queue(item_id: str, user: str = None):
    """Remove a song from queue (supports per-user queues via ?user=xxx)"""
    queue = load_queue(user)
    queue = [item for item in queue if item["id"] != item_id]
    save_queue(queue, user)
    return {"status": "removed"}


# ============== Helper Functions ==============

@app.post("/api/analyze-bpm")
def analyze_bpm(request: AnalyzeRequest):
    """分析音訊 BPM"""
    import librosa
    import numpy as np

    def resolve_path(file_path: str):
        if file_path.startswith("/files/downloads/"):
            return DOWNLOADS_DIR / file_path.split("/files/downloads/")[-1]
        if file_path.startswith("/files/separated/"):
            return SEPARATED_DIR / file_path.split("/files/separated/")[-1]
        return Path(file_path)

    try:
        path = resolve_path(request.file_path)
        if not path.exists():
            raise HTTPException(status_code=404, detail="File not found")
        y, sr = librosa.load(str(path), duration=60, mono=True)
        onset_env = librosa.onset.onset_strength(y=y, sr=sr)
        tempo = librosa.feature.tempo(onset_envelope=onset_env, sr=sr)
        bpm = round(float(tempo[0]))
        return {"bpm": bpm}
    except HTTPException:
        raise
    except Exception as e:
        print(f"BPM Analysis Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/analyze-key")
def analyze_key(request: AnalyzeRequest):
    """自動偵測音訊調性 (Key)"""
    import librosa
    import numpy as np

    KEY_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

    def resolve_path(file_path: str):
        # Accept server-side relative path like /files/downloads/xxx.m4a
        if file_path.startswith("/files/downloads/"):
            filename = file_path.split("/files/downloads/")[-1]
            return DOWNLOADS_DIR / filename
        if file_path.startswith("/files/separated/"):
            filename = file_path.split("/files/separated/")[-1]
            return SEPARATED_DIR / filename
        return Path(file_path)

    try:
        path = resolve_path(request.file_path)
        if not path.exists():
            raise HTTPException(status_code=404, detail="File not found")

        y, sr = librosa.load(str(path), duration=60, mono=True)
        # Use chroma energy to estimate key
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
        chroma_mean = chroma.mean(axis=1)
        key_idx = int(np.argmax(chroma_mean))
        key = KEY_NAMES[key_idx]
        confidence = float(chroma_mean[key_idx] / chroma_mean.sum())
        return {"key": key, "confidence": round(confidence, 3)}
    except HTTPException:
        raise
    except Exception as e:
        print(f"Key Analysis Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/analyze-upload")
def analyze_upload(file: UploadFile = File(...)):
    """上傳並分析檔案 BPM"""
    import librosa
    """上傳並分析檔案 BPM"""
    import librosa
    import numpy as np
    
    try:
        # Create temp file
        with tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(file.filename)[1]) as tmp:
            shutil.copyfileobj(file.file, tmp)
            tmp_path = tmp.name
            
        try:
            # Load and analyze
            y, sr = librosa.load(tmp_path, duration=60)
            onset_env = librosa.onset.onset_strength(y=y, sr=sr)
            tempo = librosa.feature.tempo(onset_envelope=onset_env, sr=sr)
            bpm = round(float(tempo[0]))
            return {"bpm": bpm}
        except Exception as e:
            print(f"Upload Analysis Error: {e}")
            raise HTTPException(status_code=500, detail="無法分析檔案")
        finally:
            # Clean up temp file
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
    except Exception as e:
        print(f"Upload Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/upload")
async def upload_file(http_request: Request, file: UploadFile = File(...)):
    """上傳檔案至 downloads 目錄供後續處理"""
    try:
        # Generate unique filename
        ext = os.path.splitext(file.filename)[1]
        if not ext:
            ext = ".mp3"
        job_id = str(uuid.uuid4())[:8]
        filename = f"{job_id}{ext}"
        file_path = DOWNLOADS_DIR / filename
        
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        try:
            duration = await asyncio.to_thread(media_policy.probe_file_duration, file_path)
            media_policy.enforce_duration(duration, http_request)
        except Exception:
            file_path.unlink(missing_ok=True)
            raise
            
        return {
            "status": "success",
            "job_id": job_id,
            "file_url": f"/files/downloads/{filename}",
            "file_path": str(file_path),
            "filename": file.filename
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"File Upload Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

def validate_youtube_url(url: str) -> bool:
    """驗證 YouTube URL 格式"""
    valid_patterns = [
        "youtube.com/watch",
        "youtu.be/",
        "youtube.com/shorts/",
        "youtube.com/embed/",
    ]
    return any(pattern in url for pattern in valid_patterns)



# ============== Download File Endpoint ==============

@app.get("/api/download-file/{job_id}")
async def download_file(job_id: str):
    """Force browser to download file instead of playing it"""
    # Find the file with this job_id
    found_files = list(DOWNLOADS_DIR.glob(f"{job_id}.*"))
    found_files = [f for f in found_files if f.suffix != '.log']
    
    if not found_files:
        raise HTTPException(status_code=404, detail="檔案不存在")
    
    file_path = found_files[0]
    filename = f"YouTube_Audio_{job_id}{file_path.suffix}"
    
    return FileResponse(
        path=file_path,
        filename=filename,
        media_type="application/octet-stream",  # Force download
        headers={
            "Content-Disposition": f"attachment; filename={filename}"
        }
    )

# ============== Background Tasks ==============

async def download_youtube_audio(job_id: str, youtube_url: str):
    """背景任務：下載 YouTube 音訊"""
    try:
        update_job_status(job_id, {
            "status": "downloading",
            "progress": 10,
            "message": "正在連接 YouTube..."
        })
        
        output_path = DOWNLOADS_DIR / f"{job_id}.mp3"
        
        # Check for ffmpeg
        ffmpeg_path = shutil.which("ffmpeg")
        logging.debug(f"ffmpeg path: {ffmpeg_path}")
        if not ffmpeg_path:
            # Fallback for Mac specific paths if not in PATH
            if os.path.exists("/opt/homebrew/bin/ffmpeg"):
                ffmpeg_path = "/opt/homebrew/bin/ffmpeg"
            elif os.path.exists("/usr/local/bin/ffmpeg"):
                ffmpeg_path = "/usr/local/bin/ffmpeg"
        
        # Use yt-dlp to download
        cmd = [
            "yt-dlp",
            # Select best audio stream
            "-f", "bestaudio/best",
            # CRITICAL: Extract audio and convert to m4a (ensures audio-only output)
            "-x", "--audio-format", "m4a",
            # Critical: Prevent downloading entire playlist if URL has &list=...
            "--no-playlist",
            # Save to specific path with job_id
            "-o", str(DOWNLOADS_DIR / f"{job_id}.%(ext)s"),
            # Use android client (currently working without PO Token)
            "--extractor-args", "youtube:player_client=android",
            # Prevent hanging on infinite progress updates
            "--no-progress",
            # Prevent hanging on infinite progress updates
            "--no-progress",
            "--no-warnings",
        ]
        
        # Add Browser Cookies Support (Auto-detect Chrome)
        # Check for cookies.txt first (manual override)
        if (Path("cookies.txt").exists()):
            cmd.extend(["--cookies", "cookies.txt"])
            logging.info("Using cookies.txt for auth")

        cmd.append(youtube_url)
        
        # ffmpeg is required for audio extraction
        if ffmpeg_path:
             cmd.extend(["--ffmpeg-location", ffmpeg_path])

        update_job_status(job_id, {
            "status": "downloading",
            "progress": 30,
            "message": "正在下載並轉換為音訊..."
        })
        
        logging.info(f"Running download command: {' '.join(cmd)}")
        
        # Define synchronous wrapper for subprocess.run
        def run_sync_download():
            log_file_path = DOWNLOADS_DIR / f"{job_id}.log"
            logging.info(f"Thread: Starting download for {job_id}")
            with open(log_file_path, "w") as log_file:
                # Run blocking subprocess call
                logging.info(f"Thread: Executing subprocess.run for {job_id}")
                try:
                    result = subprocess.run(
                        cmd,
                        stdout=log_file,
                        stderr=subprocess.STDOUT,
                        stdin=subprocess.DEVNULL,
                        text=True,
                        timeout=120 # 2 minutes timeout to prevent infinite hang
                    )
                    logging.info(f"Thread: subprocess.run finished with code {result.returncode}")
                    return result.returncode, ""
                except subprocess.TimeoutExpired:
                    logging.error("Thread: Download timed out")
                    return -1, "Download timed out"
                except Exception as e:
                    logging.error(f"Thread: Exception {e}")
                    return -1, str(e)
            
            # Read log (moved outside to simplify logic flow above)
            # Refetch logic if needed, but simple return is safer for now.
            
        # Run in thread pool to avoid blocking event loop
        loop = asyncio.get_event_loop()
        logging.debug("Offloading download to thread pool...")
        returncode, full_log = await loop.run_in_executor(None, run_sync_download) # Note: full_log might be simple string now
        logging.debug(f"Download thread finished with return code: {returncode}")
        
        # Re-read log file for details if error
        log_file_path = DOWNLOADS_DIR / f"{job_id}.log"
        if os.path.exists(log_file_path):
             with open(log_file_path, "r") as f:
                full_log = f.read()
             if returncode == 0:
                 os.remove(log_file_path)

        if returncode != 0:
            logging.error(f"yt-dlp failed. Log output:\n{full_log}")
            if "Sign in" in full_log:
                 raise Exception("YouTube 要求驗證 (Bot Detection)。請稍後再試。")
            raise Exception(f"下載失敗: {full_log[-300:]}") 
        
        logging.info("Download finished successfully")

        # Find the actual file (yt-dlp might have created m4a, webm, or mp4)
        found_files = list(DOWNLOADS_DIR.glob(f"{job_id}.*"))
        # Filter out .log files just in case
        found_files = [f for f in found_files if f.suffix != '.log']
        
        if found_files:
            downloaded_file = found_files[0]
            extension = downloaded_file.suffix.lower()
            
            update_job_status(job_id, {
                "status": "completed",
                "progress": 100,
                "message": "下載完成！",
                "file_url": f"/files/downloads/{job_id}{extension}"
            })
        else:
             raise Exception("下載似乎成功但找不到檔案")
        
    except Exception as e:
        print(f"EXCEPTION: {str(e)}")
        update_job_status(job_id, {
            "status": "error",
            "progress": 0,
            "message": f"下載失敗: {str(e)}",
            "error": str(e)
        })

async def separate_audio_local(job_id: str, audio_path: str, stems: str = "6"):
    """背景任務：使用 Demucs 分離音軌"""
    try:
        update_job_status(job_id, {
            "status": "separating",
            "progress": 10,
            "message": "正在載入 AI 模型..."
        })
        
        # Create output directory for this job
        output_dir = SEPARATED_DIR / job_id
        output_dir.mkdir(exist_ok=True)
        
        update_job_status(job_id, {
            "status": "separating",
            "progress": 0,
            "message": "正在啟動 AI 分離引擎..."
        })
        
        # 決定 Demucs 模型：4軌使用 htdemucs，6軌使用 htdemucs_6s
        model_name = "htdemucs" if stems == "4" else "htdemucs_6s"
        
        # Run Demucs
        # Using -u to force unbuffered binary stdout/stderr
        demucs_device = get_demucs_device()
        print(f"[Backend] Starting Demucs command for job {job_id} on {demucs_device} with {stems} stems ({model_name})...")
        cmd = [
            demucs_python(), "-u", "-m", "demucs",
            "-n", model_name,
            "-d", demucs_device,
            "-o", str(output_dir),
            str(audio_path)
        ]
        
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        
        # Real-time output processing
        async def read_stream(stream, is_stderr=False):
            buffer = ""
            while True:
                # Read chunks instead of lines to handle progress bars that use \r
                chunk = await stream.read(100)
                if not chunk:
                    break
                
                chunk_str = chunk.decode(errors='replace')
                buffer += chunk_str
                
                # Split by either newline or carriage return
                while '\n' in buffer or '\r' in buffer:
                    if '\n' in buffer:
                        line, buffer = buffer.split('\n', 1)
                    elif '\r' in buffer:
                        line, buffer = buffer.split('\r', 1)
                    
                    line = line.strip()
                    if not line:
                        continue
                        
                    print(f"[Demucs-{job_id}] {line}")  # Log to server console
                    
                    # Check for Demucs separation progress (e.g., "54%|███...| 175.5/345.15 [01:27<01:13, 2.16seconds/s]")
                    # This has format: XX%|progress_bar|current/total [time<remaining, speed]
                    if "%" in line and "|" in line:
                        # Extract percentage
                        try:
                            percent_str = line.split('%')[0].strip()
                            # Get last 3 chars which should be the number
                            percent = percent_str[-3:].strip()
                            if percent.isdigit():
                                progress_value = int(percent)
                                update_job_status(job_id, {
                                    "status": "separating",
                                    "progress": progress_value,
                                    "message": f"AI 音軌分離中... {progress_value}%"
                                })
                        except:
                            pass
 
        # Wait for both streams and the process
        await asyncio.gather(
            read_stream(process.stdout),
            read_stream(process.stderr, is_stderr=True),
            process.wait()
        )
        
        if process.returncode != 0:
            error_msg = "Demucs process failed"
            # Since we consumed streams, we can't get stderr here easily unless we stored it.
            # But the logs should have shown it.
            raise Exception(f"分離失敗 (Exit Code: {process.returncode}) - 請查看後端日誌")
        
        update_job_status(job_id, {
            "status": "processing",
            "progress": 80,
            "message": "正在處理分離後的音軌..."
        })
        
        # Find separated files
        audio_name = Path(audio_path).stem
        stems_dir = output_dir / model_name / audio_name
        
        if not stems_dir.exists():
            # Try finding in alternative paths
            possible_paths = list(output_dir.rglob("*.wav"))
            if possible_paths:
                stems_dir = possible_paths[0].parent
            else:
                raise Exception(f"找不到分離後的檔案")
        
        # Collect track URLs based on stems option
        tracks = {}
        
        if stems == "4":
            # 4軌模式：人聲、鼓組、Bass、其他
            track_names = ["vocals", "drums", "bass", "other"]
            for track_name in track_names:
                track_file = stems_dir / f"{track_name}.wav"
                if track_file.exists():
                    dest_path = output_dir / f"{track_name}.wav"
                    shutil.copy(track_file, dest_path)
                    tracks[track_name] = f"/files/separated/{job_id}/{track_name}.wav"
                    
        else:
            # 6軌模式：人聲、鼓組、Bass、吉他、鋼琴、其他
            track_names = ["vocals", "drums", "bass", "guitar", "piano", "other"]
            for track_name in track_names:
                track_file = stems_dir / f"{track_name}.wav"
                if track_file.exists():
                    dest_path = output_dir / f"{track_name}.wav"
                    shutil.copy(track_file, dest_path)
                    tracks[track_name] = f"/files/separated/{job_id}/{track_name}.wav"
        
        if not tracks:
            raise Exception("分離完成但找不到任何音軌")
        
        update_job_status(job_id, {
            "status": "completed",
            "progress": 100,
            "message": f"分離完成！已產生 {len(tracks)} 個音軌",
            "tracks": tracks
        })
        
    except Exception as e:
        update_job_status(job_id, {
            "status": "error",
            "progress": 0,
            "message": f"分離失敗: {str(e)}",
            "error": str(e)
        })

# ============== API Endpoints ==============

@app.get("/api/health")
def health_check():
    return {
        "message": "VocalTune Pro API is running",
        "version": "2.0.0",
        "endpoints": {
            "download": "/api/download",
            "separate": "/api/separate-local",
            "status": "/api/status/{job_id}"
        }
    }

@app.post("/api/download", response_model=DownloadResponse)
async def download_youtube(request: DownloadRequest, background_tasks: BackgroundTasks, http_request: Request):
    """
    直接下載 YouTube 音訊
    - 驗證 URL
    - 啟動背景下載任務
    - 回傳 job_id 供前端追蹤進度
    """
    if not validate_youtube_url(request.youtube_url):
        usage_db.log_usage(client_ip(http_request), '轉檔下載', summary=request.youtube_url,
            status='error', error='無效的 YouTube 連結', user_agent=http_request.headers.get('user-agent', ''))
        raise HTTPException(
            status_code=400,
            detail="無效的 YouTube 連結 (支援 Watch, Shorts, Youtu.be)"
        )

    duration = await asyncio.to_thread(media_policy.probe_youtube_duration, request.youtube_url)
    media_policy.enforce_duration(duration, http_request)

    usage_db.log_usage(client_ip(http_request), '轉檔下載', summary=request.youtube_url,
        detail={'youtube_url': request.youtube_url}, status='ok',
        user_agent=http_request.headers.get('user-agent', ''))

    job_id = str(uuid.uuid4())[:8]  # Shorter ID for simplicity
    
    update_job_status(job_id, {
        "status": "pending",
        "progress": 0,
        "message": "任務已建立..."
    })
    
    # Start background download
    background_tasks.add_task(download_youtube_audio, job_id, request.youtube_url)
    
    return DownloadResponse(
        job_id=job_id,
        status="pending",
        message="下載任務已開始"
    )

def get_youtube_title(url: str) -> Optional[str]:
    """利用 yt-dlp 快速獲取 YouTube 影片的標題"""
    try:
        import subprocess
        import json
        command = [
            "yt-dlp",
            "--dump-json",
            "--flat-playlist",
            "--no-warnings",
            url
        ]
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=5 # 5 秒超時
        )
        if result.returncode == 0:
            data = json.loads(result.stdout.strip().split('\n')[0])
            return data.get("title")
    except Exception as e:
        print(f"[Backend] Error fetching YouTube title: {e}")
    return None

@app.post("/api/separate-local", response_model=DownloadResponse)
async def separate_local(request: SeparateRequest, background_tasks: BackgroundTasks, http_request: Request):
    """
    AI 音軌分離
    - 使用 Demucs 分離音軌
    - 不需要雲端服務
    - 支援多用戶歷史紀錄關聯
    - 支援跨用戶 YouTube 快取共享，秒速命中已完成之歷史結果
    """
    import hashlib
    import re

    file_path = request.file_path
    stems = request.stems or "6"
    username = request.username or "guest_default"
    youtube_url = request.youtube_url

    usage_db.log_usage(client_ip(http_request), '音樂分離', summary=(youtube_url or file_path or ''),
        detail={'stems': stems, 'username': username, 'youtube_url': youtube_url}, status='ok',
        user_agent=http_request.headers.get('user-agent', ''))
    
    # 1. 取得或創建用戶
    user_id = db.get_or_create_user(username)
    
    # 2. 輔助函數：提取 YouTube Video ID
    def extract_youtube_id(url: str) -> Optional[str]:
        if not url:
            return None
        patterns = [
            r"(?:v=|\/)([\w-]{11})(?:\?|&|$)",
            r"youtu\.be\/([\w-]{11})",
            r"youtube\.com\/shorts\/([\w-]{11})",
            r"youtube\.com\/embed\/([\w-]{11})"
        ]
        for p in patterns:
            match = re.search(p, url)
            if match:
                return match.group(1)
        return None

    video_id = extract_youtube_id(youtube_url)
    print(f"[Backend] request from user: {username} (id={user_id}), url: {youtube_url}, parsed video_id: {video_id}")

    # 3. 決定實體檔案路徑
    if "://" in file_path:
        try:
            from urllib.parse import urlparse
            parsed = urlparse(file_path)
            file_path = parsed.path
            print(f"[Debug] Parsed URL path: {file_path}")
        except Exception as e:
            print(f"[Debug] URL parse error: {e}")

    if file_path.startswith("/files/downloads/"):
        filename = file_path.replace("/files/downloads/", "")
        audio_path = DOWNLOADS_DIR / filename
        print(f"[Debug] Resolved DOWNLOADS path: {audio_path}")
    elif file_path.startswith("/files/separated/"):
        filename = file_path.replace("/files/separated/", "")
        audio_path = SEPARATED_DIR / filename
        print(f"[Debug] Resolved SEPARATED path: {audio_path}")
    else:
        audio_path = Path(file_path)
        print(f"[Debug] Resolved Direct path: {audio_path}")
    
    if not audio_path.exists():
        # 嘗試在目錄下尋找
        search_name = audio_path.name
        print(f"[Debug] Exact path not found. Searching for {search_name} in directories...")
        found = list(DOWNLOADS_DIR.rglob(search_name)) + list(SEPARATED_DIR.rglob(search_name))
        
        if found:
            audio_path = found[0]
            print(f"[Debug] Found fallback file: {audio_path}")
        else:
            print(f"[Error] File not found at: {audio_path}")
            raise HTTPException(status_code=404, detail=f"找不到音訊檔案: {request.file_path}")

    duration = await asyncio.to_thread(media_policy.probe_file_duration, audio_path)
    media_policy.enforce_duration(duration, http_request)

    # 4. 計算確定性工作 job_id
    file_name = audio_path.name
    file_size = audio_path.stat().st_size if audio_path.exists() else 0
    cache_str = f"{file_name}_{file_size}_{stems}"
    job_id = hashlib.md5(cache_str.encode()).hexdigest()[:12]
    
    print(f"[Backend] Computed deterministic job_id: {job_id} for {file_name} with {stems} stems")

    # 5. 跨用戶 YouTube 快取命中檢查 (YouTube 模式) - 必須確保快取歌曲的 job_id 與當前實體檔案算出來的 job_id 完全一致
    if video_id:
        cached_song = db.get_cached_youtube_song(video_id, stems)
        # 強加校驗：cached_song["job_id"] 必須與當前 job_id 完全相符，才允許跨用戶快取命中
        if cached_song and cached_song["job_id"] == job_id:
            cached_job_id = cached_song["job_id"]
            print(f"[Backend] Database Cache Hit! Sharing YouTube job {cached_job_id} for user {username}")
            db.add_user_history(user_id, cached_song["id"])
            tracks = json.loads(cached_song["tracks_json"])
            update_job_status(cached_job_id, {
                "status": "completed", "progress": 100,
                "message": "快取命中！音軌分離結果已加載。", "tracks": tracks
            })
            return DownloadResponse(job_id=cached_job_id, status="completed", message="快取命中！音軌分離結果已加載。")
    
    # 6. 檢查是否已有相同 job_id 的本地快取 (本地檔案快取命中)
    existing_status = get_job_status(job_id)
    output_dir = SEPARATED_DIR / job_id
    cached_disk_tracks = db.get_existing_track_urls(job_id, stems)
    
    # 嘗試在資料庫中尋找或創建這首歌曲
    conn = db.get_db_connection()
    song_row = conn.execute("SELECT id, status FROM songs WHERE job_id = ?", (job_id,)).fetchone()
    conn.close()
    
    song_id = song_row["id"] if song_row else None
    
    db_says_completed = bool(song_row and song_row["status"] == "completed")
    if cached_disk_tracks and (existing_status.get("status") == "completed" or db_says_completed):
        print(f"[Backend] Local Cache Hit! Job {job_id} is already completed. Returning cached results immediately.")
        
        # 若資料庫無此紀錄（舊資料轉移），補建歌曲紀錄
        if not song_id:
            song_type = "youtube" if video_id else "upload"
            # 嘗試讀取已完成的音軌
            tracks = dict(cached_disk_tracks)
            
            song_title = audio_path.stem
            if video_id and youtube_url:
                print(f"[Backend] Auto-fetching YouTube title for cache-restore: {youtube_url}")
                fetched_title = get_youtube_title(youtube_url)
                if fetched_title:
                    song_title = fetched_title
            
            song_id = db.create_song_record(
                job_id=job_id,
                song_type=song_type,
                stems=stems,
                title=song_title,
                youtube_url=youtube_url,
                video_id=video_id,
                file_path=str(audio_path)
            )
            db.update_song_status_db(job_id, "completed", tracks_dict=tracks)
        else:
            # DB 已存在時也修復舊版可能為空或損壞的 tracks_json。
            db.update_song_status_db(job_id, "completed", tracks_dict=cached_disk_tracks)

        update_job_status(job_id, {
            "status": "completed",
            "progress": 100,
            "message": "快取命中！音軌分離結果已加載。",
            "tracks": cached_disk_tracks
        })
            
        # 建立用戶歷史關聯
        db.add_user_history(user_id, song_id)
        
        return DownloadResponse(
            job_id=job_id,
            status="completed",
            message="快取命中！音軌分離結果已加載。"
        )
    
    # 7. 快取未命中：建立新歌曲記錄與歷史關聯，開始背景分離
    if not song_id:
        song_type = "youtube" if video_id else "upload"
        
        song_title = audio_path.stem
        if video_id and youtube_url:
            print(f"[Backend] Auto-fetching YouTube title for new song: {youtube_url}")
            fetched_title = get_youtube_title(youtube_url)
            if fetched_title:
                song_title = fetched_title
                
        song_id = db.create_song_record(
            job_id=job_id,
            song_type=song_type,
            stems=stems,
            title=song_title,
            youtube_url=youtube_url,
            video_id=video_id,
            file_path=str(audio_path)
        )
        
    db.add_user_history(user_id, song_id)
    
    # 若有殘留的 error 狀態或未完成狀態，將其重置並更新狀態為 pending
    update_job_status(job_id, {
        "status": "pending",
        "progress": 0,
        "message": "分離任務已建立..."
    })
    
    # Start background separation
    background_tasks.add_task(separate_audio_local, job_id, str(audio_path), stems)
    
    return DownloadResponse(
        job_id=job_id,
        status="pending",
        message="AI 分離任務已開始"
    )

@app.get("/api/status/{job_id}", response_model=JobStatusResponse)
async def get_status(job_id: str):
    """查詢任務狀態"""
    status = get_job_status(job_id)
    
    
    # Auto-Restore: Check disk if memory is empty (server restart)
    if status.get("status") == "unknown":
        # 1. Check New Structure (YYYYMMDD/job_id/video.mp4)
        # We don't know the date, so we search all subdirs
        found_video = list(KARAOKE_DIR.rglob(f"{job_id}/video.mp4"))
        
        if found_video:
            video_path = found_video[0] # e.g. karaoke_output/20260208/job_id/video.mp4
            # Extract date from parent's parent usually, or just use path
            # Path structure: KARAOKE_DIR / YYYYMMDD / job_id / video.mp4
            try:
                date_folder = video_path.parent.parent.name
            except:
                date_folder = "unknown"
                
            print(f"[Restore] Found existing job on disk (New Structure): {job_id}")
            
            restored_status = {
                "status": "completed",
                "progress": 100,
                "message": "已從磁碟恢復",
                "file_url": f"/files/karaoke/{date_folder}/{job_id}/video.mp4",
            }
            
            # Check for vocals
            vocals_path = video_path.parent / "vocals.mp3"
            if vocals_path.exists():
                restored_status["vocals_url"] = f"/files/karaoke/{date_folder}/{job_id}/vocals.mp3"

            # Check for instrumental
            instrumental_path = video_path.parent / "instrumental.mp3"
            if instrumental_path.exists():
                restored_status["instrumental_url"] = f"/files/karaoke/{date_folder}/{job_id}/instrumental.mp3"

            update_job_status(job_id, restored_status)
            status = restored_status
            
        else:
            # 2. Check Legacy Structure (Root level)
            karaoke_file = KARAOKE_DIR / f"{job_id}.mp4"
            if karaoke_file.exists():
                print(f"[Restore] Found existing job on disk (Legacy): {job_id}")
                restored_status = {
                    "status": "completed",
                    "progress": 100,
                    "message": "已從磁碟恢復 (舊版)",
                    "file_url": f"/files/karaoke/{job_id}.mp4",
                }
                # Check for vocals
                vocals_file = KARAOKE_DIR / f"{job_id}_vocals.mp3"
                if vocals_file.exists():
                    restored_status["vocals_url"] = f"/files/karaoke/{job_id}_vocals.mp3"
                
                update_job_status(job_id, restored_status)
                status = restored_status
            else:
                raise HTTPException(status_code=404, detail="找不到此任務")
    
    return JobStatusResponse(
        job_id=job_id,
        status=status.get("status", "unknown"),
        progress=status.get("progress", 0),
        message=status.get("message", ""),
        file_url=status.get("file_url"),
        vocals_url=status.get("vocals_url"),
        instrumental_url=status.get("instrumental_url"),
        tracks=status.get("tracks"),
        error=status.get("error")
    )

class HistoryItem(BaseModel):
    job_id: str
    title: str
    date: str
    youtube_url: Optional[str] = None

@app.get("/api/karaoke/history", response_model=List[HistoryItem])
async def get_history(user: str = None):
    """取得卡拉OK轉檔紀錄（支援 ?user= 過濾）"""
    # If user is specified, get their queue job IDs for filtering
    user_job_ids = None
    if user:
        user_queue = load_queue(user)
        user_job_ids = set(item["id"] for item in user_queue)
    
    history = []
    
    # Recursively find all info.json files
    # Structure: KARAOKE_DIR / YYYYMMDD / job_id / info.json
    for info_file in KARAOKE_DIR.rglob("info.json"):
        try:
            with open(info_file, "r", encoding='utf-8') as f:
                data = json.load(f)
                
                # Check if completed
                if data.get("status") == "completed":
                    job_id = data.get("job_id")
                    
                    # Filter by user's queue if user is specified
                    if user_job_ids is not None and job_id not in user_job_ids:
                        continue
                    
                    history.append(HistoryItem(
                        job_id=job_id,
                        title=data.get("title", "Unknown"),
                        date=data.get("created_at", ""),
                        youtube_url=data.get("youtube_url")
                    ))
        except Exception as e:
            print(f"Error reading history file {info_file}: {e}")
            continue
            
    # Sort by date ascending (oldest first, matching queue order)
    history.sort(key=lambda x: x.date or "", reverse=False)
    return history

@app.delete("/api/karaoke/history")
async def clear_history(user: str = None):
    """清除卡拉OK歷史紀錄（支援 ?user= 僅清除該使用者的紀錄）"""
    try:
        if user:
            # Only delete jobs from this user's queue
            user_queue = load_queue(user)
            user_job_ids = set(item["id"] for item in user_queue)
            deleted = 0
            for info_file in KARAOKE_DIR.rglob("info.json"):
                try:
                    with open(info_file, "r", encoding='utf-8') as f:
                        data = json.load(f)
                    if data.get("job_id") in user_job_ids:
                        shutil.rmtree(info_file.parent)
                        deleted += 1
                except Exception:
                    continue
            return {"message": f"Deleted {deleted} items for user {user}"}
        else:
            # Delete all subdirectories in KARAOKE_DIR
            for item in KARAOKE_DIR.iterdir():
                if item.is_dir():
                    shutil.rmtree(item)
            return {"message": "History cleared"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ============== AI Separation History Endpoints ==============

@app.get("/api/separate/history")
async def get_separate_history(username: str):
    """獲取指定使用者的分離歷史紀錄"""
    if not username:
        raise HTTPException(status_code=400, detail="請提供 username 參數")
    try:
        history = db.get_user_history_list(username)
        return history
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/separate/history/{job_id}")
async def delete_separate_history_item(job_id: str, username: str):
    """刪除該用戶對某首歌曲的分離歷史關聯（不影響檔案實體與其他用戶）"""
    if not username:
        raise HTTPException(status_code=400, detail="請提供 username 參數")
    try:
        success = db.delete_user_history_item(username, job_id)
        if success:
            return {"message": f"成功刪除該首歌曲之歷史紀錄"}
        else:
            raise HTTPException(status_code=404, detail="找不到對應的歷史紀錄")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/separate/history/clear")
async def clear_separate_history(username: str):
    """清空該用戶的所有分離歷史關聯"""
    if not username:
        raise HTTPException(status_code=400, detail="請提供 username 參數")
    try:
        deleted_count = db.clear_user_history(username)
        return {"message": f"成功清除該用戶 {deleted_count} 筆歷史紀錄"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class RenameRequest(BaseModel):
    username: str
    job_id: str
    new_title: str

@app.patch("/api/separate/history/rename")
async def rename_separate_history_item(request: RenameRequest):
    """手動修改分離歷史歌曲的標題"""
    if not request.username or not request.job_id or not request.new_title.strip():
        raise HTTPException(status_code=400, detail="無效的參數")
    try:
        success = db.update_song_status_db(request.job_id, status=None, title=request.new_title.strip())
        if success:
            return {"message": "歌名修改成功"}
        else:
            raise HTTPException(status_code=404, detail="找不到對應的歌曲")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/upload")
async def upload_audio(http_request: Request, file: UploadFile = File(...)):
    """
    上傳音訊檔案
    供前端直接上傳本地檔案
    """
    job_id = str(uuid.uuid4())[:8]
    
    # Save uploaded file
    file_ext = Path(file.filename).suffix or ".mp3"
    save_path = DOWNLOADS_DIR / f"{job_id}{file_ext}"
    
    with open(save_path, "wb") as f:
        content = await file.read()
        f.write(content)
    try:
        duration = await asyncio.to_thread(media_policy.probe_file_duration, save_path)
        media_policy.enforce_duration(duration, http_request)
    except Exception:
        save_path.unlink(missing_ok=True)
        raise
    
    return {
        "job_id": job_id,
        "file_url": f"/files/downloads/{job_id}{file_ext}",
        "message": "檔案上傳成功"
    }

@app.post("/api/karaoke/process", response_model=DownloadResponse)
async def create_karaoke(request: DownloadRequest, background_tasks: BackgroundTasks, http_request: Request):
    """
    製作卡拉OK影片 (伴奏版 MV)
    - 支援 YouTube 下載或本地檔案
    - 自動分離人聲 + 合成影片
    """
    if request.youtube_url.startswith("http"):
        duration = await asyncio.to_thread(media_policy.probe_youtube_duration, request.youtube_url)
    else:
        raw_path = request.youtube_url.replace("/files/downloads/", "")
        duration = await asyncio.to_thread(media_policy.probe_file_duration, DOWNLOADS_DIR / raw_path)
    media_policy.enforce_duration(duration, http_request)
    job_id = str(uuid.uuid4())[:8]
    
    update_job_status(job_id, {
        "status": "pending",
        "progress": 0,
        "message": "卡拉OK製作任務已建立..."
    })
    
    # Check if URL looks like a local path (starts with /files/) or is a web URL
    file_path = None
    youtube_url = None
    
    if request.youtube_url.startswith("http"):
        youtube_url = request.youtube_url
    else:
        file_path = request.youtube_url # Reuse field for simplicity, frontend can send path
        
    background_tasks.add_task(process_karaoke_job, job_id, youtube_url, file_path)
    
    return DownloadResponse(
        job_id=job_id,
        status="pending",
        message="製作任務已開始"
    )

# ============== Transcription (Audio to MIDI) ==============

@app.post("/api/transcribe", response_model=TranscribeResponse)
async def transcribe_audio(request: TranscribeRequest, background_tasks: BackgroundTasks):
    """
    音訊轉 MIDI (Audio to MIDI Transcription)
    使用 Basic Pitch 將音軌轉換為 MIDI 檔案
    """
    from celery import Celery
    import os
    
    VALID_STEMS = ["vocals", "drums", "bass", "guitar", "piano", "other", "accompaniment", "original"]
    
    if request.stem not in VALID_STEMS:
        raise HTTPException(
            status_code=400,
            detail=f"無效的音軌名稱: {request.stem}. 有效選項: {', '.join(VALID_STEMS)}"
        )
    
    # Generate transcription job ID
    transcribe_job_id = str(uuid.uuid4())[:8]
    
    update_job_status(transcribe_job_id, {
        "status": "pending",
        "progress": 0,
        "message": "採譜任務已建立..."
    })
    
    # Check if we have a Celery/Redis connection for cloud mode
    redis_url = os.getenv("REDIS_URL")
    
    if redis_url:
        # Cloud mode: dispatch to Celery worker
        celery_app = Celery("tasks", broker=redis_url, backend=redis_url)
        celery_app.send_task(
            "tasks.transcribe_audio",
            args=[request.job_id, request.stem, transcribe_job_id],
            queue="music_separation"
        )
    else:
        # Local mode: run in background
        async def local_transcribe():
            import asyncio
            import shutil
            
            # Check for dependencies
            try:
                from basic_pitch.inference import predict_and_save
                from basic_pitch import ICASSP_2022_MODEL_PATH
                import tensorflow as tf
                has_dependencies = True
            except ImportError:
                has_dependencies = False
                print("Missing basic-pitch or tensorflow. Falling back to simulation.")

            if not has_dependencies:
                # Simulate processing time (Fallback)
                update_job_status(transcribe_job_id, {
                    "status": "transcribing",
                    "progress": 50,
                    "message": "本地模式：模擬採譜中 (未安裝 AI 模型)..."
                })
                await asyncio.sleep(1)
                
                # Create a dummy MIDI file for testing
                midi_hex = b'\x4D\x54\x68\x64\x00\x00\x00\x06\x00\x00\x00\x01\x00\x60\x4D\x54\x72\x6B\x00\x00\x00\x04\x00\xFF\x2F\x00'
                
                output_dir = SEPARATED_DIR / request.job_id
                output_dir.mkdir(parents=True, exist_ok=True)
                
                midi_path = output_dir / f"{request.stem}.mid"
                with open(midi_path, 'wb') as f:
                    f.write(midi_hex)
                
                update_job_status(transcribe_job_id, {
                    "status": "completed",
                    "progress": 100,
                    "message": "採譜完成！(模擬模式)",
                    "midi_url": f"/files/separated/{request.job_id}/{request.stem}.mid"
                })
                return

            # Real AI Transcription Logic
            try:
                update_job_status(transcribe_job_id, {
                    "status": "transcribing",
                    "progress": 10,
                    "message": "AI 正在讀取音訊檔案..."
                })
                
                # 1. Find the source audio file
                source_file = None
                
                # Check Downloads (Direct Upload)
                for ext in [".mp3", ".wav", ".m4a", ".flac", ".ogg", ".webm"]:
                    p = DOWNLOADS_DIR / f"{request.job_id}{ext}"
                    if p.exists():
                        source_file = p
                        break
                
                # Check Separated Directory (if from separation job)
                if not source_file:
                    # Specific stem
                    p = SEPARATED_DIR / request.job_id / f"{request.stem}.wav"
                    if p.exists():
                        source_file = p
                    else:
                        # Original
                        p = SEPARATED_DIR / request.job_id / "original.mp3" 
                        if p.exists():
                            source_file = p

                if not source_file:
                    raise FileNotFoundError("找不到原始音訊檔案")

                # 2. Run Basic Pitch
                update_job_status(transcribe_job_id, {
                    "status": "transcribing",
                    "progress": 30,
                    "message": "AI 正在分析音高與節奏 (Basic Pitch)..."
                })
                
                output_dir = SEPARATED_DIR / request.job_id
                output_dir.mkdir(parents=True, exist_ok=True)
                
                # Run prediction (blocking call)
                predict_and_save(
                    audio_path_list=[str(source_file)],
                    output_directory=str(output_dir),
                    save_midi=True,
                    sonify_midi=False,
                    save_model_outputs=False,
                    save_notes=False,
                    model_or_model_path=ICASSP_2022_MODEL_PATH
                )
                
                # 3. Handle Output
                # Basic Pitch appends _basic_pitch.mid to the filename
                # If source is "original.mp3", output is "original_basic_pitch.mid"
                # If source is "vocals.wav", output is "vocals_basic_pitch.mid"
                
                generated_filename = f"{source_file.stem}_basic_pitch.mid"
                generated_midi = output_dir / generated_filename
                
                if not generated_midi.exists():
                    # Fallback search
                    generated_midis = list(output_dir.glob("*_basic_pitch.mid"))
                    if generated_midis:
                        generated_midi = generated_midis[0]
                    else:
                        raise Exception("Basic Pitch 未能生成 MIDI 檔案")
                
                # Rename to {stem}.mid for consistency
                final_midi_path = output_dir / f"{request.stem}.mid"
                if generated_midi != final_midi_path:
                    shutil.move(str(generated_midi), str(final_midi_path))
                
                update_job_status(transcribe_job_id, {
                    "status": "completed",
                    "progress": 100,
                    "message": "採譜完成！",
                    "midi_url": f"/files/separated/{request.job_id}/{request.stem}.mid"
                })

            except Exception as e:
                print(f"Transcription error: {str(e)}")
                update_job_status(transcribe_job_id, {
                    "status": "error",
                    "progress": 0,
                    "error": str(e),
                    "message": f"採譜失敗: {str(e)}"
                })
        
        background_tasks.add_task(local_transcribe)
    
    return TranscribeResponse(
        task_id=transcribe_job_id,
        status="pending",
        message="採譜任務已開始"
    )

@app.get("/api/transcribe/status/{task_id}")
async def get_transcribe_status(task_id: str):
    """
    查詢採譜任務狀態
    """
    import os
    import redis
    import json
    
    redis_url = os.getenv("REDIS_URL")
    
    if redis_url:
        # Cloud mode: check Redis
        try:
            redis_client = redis.from_url(redis_url, decode_responses=True)
            status_key = f"job:{task_id}:status"
            status_data = redis_client.get(status_key)
            
            if status_data:
                return json.loads(status_data)
        except Exception as e:
            print(f"Redis error: {e}")
    
    # Fallback to in-memory store
    status = get_job_status(task_id)
    
    if status.get("status") == "unknown":
        raise HTTPException(status_code=404, detail="找不到此任務")
    
    return {
        "task_id": task_id,
        "status": status.get("status", "unknown"),
        "progress": status.get("progress", 0),
        "message": status.get("message", ""),
        "midi_url": status.get("midi_url")
    }

class PitchShiftRequest(BaseModel):
    file_path: str
    semitones: float

@app.post("/api/pitch-shift-premium")
def pitch_shift_premium(request: PitchShiftRequest, http_request: Request):
    """
    使用後端 Librosa 進行高品質無損變調，支援高質感 Caching 機制
    """
    import librosa
    import soundfile as sf
    from urllib.parse import urlparse

    file_path = request.file_path
    semitones = request.semitones

    # 記錄升降 key 操作（semitones 即升降幾個半音；0 表示沒有升降）
    _dir = '升' if semitones > 0 else ('降' if semitones < 0 else '無變化')
    usage_db.log_usage(client_ip(http_request), '升降key',
        summary=f"{_dir} {abs(semitones):g} 個半音",
        detail={'semitones': semitones, 'used_pitch': semitones != 0}, status='ok',
        user_agent=http_request.headers.get('user-agent', ''))

    # 1. 決定檔案的真實磁碟路徑
    if "://" in file_path:
        try:
            file_path = urlparse(file_path).path
        except:
            pass
            
    if file_path.startswith("/files/downloads/"):
        filename = file_path.replace("/files/downloads/", "")
        audio_path = DOWNLOADS_DIR / filename
    elif file_path.startswith("/files/separated/"):
        filename = file_path.replace("/files/separated/", "")
        audio_path = SEPARATED_DIR / filename
    else:
        audio_path = Path(file_path)
        
    if not audio_path.exists():
        # Fallback search
        found = list(DOWNLOADS_DIR.glob(audio_path.name)) + list(SEPARATED_DIR.glob(audio_path.name))
        if found:
            audio_path = found[0]
        else:
            raise HTTPException(status_code=404, detail="找不到音訊檔案")
            
    # 如果 semitones 為 0，則直接返回原檔 URL
    if abs(semitones) < 0.01:
        return {"status": "success", "file_url": request.file_path}
        
    # 2. 生成快取檔名 (格式: {原檔名}_pitch_v2_{semitones}.wav)
    # v2 避開舊版 mono/峰值未保護的快取檔，避免繼續回傳會爆音的舊結果。
    job_id = audio_path.parent.name if audio_path.parent != DOWNLOADS_DIR else "downloads"
    output_filename = f"{audio_path.stem}_pitch_v2_{semitones:.1f}.wav"
    output_path = audio_path.parent / output_filename
    
    # URL 格式
    if audio_path.parent != DOWNLOADS_DIR:
        file_url = f"/files/separated/{job_id}/{output_filename}"
    else:
        file_url = f"/files/downloads/{output_filename}"
        
    # 3. 檢查快取是否存在，存在則 1ms 內瞬間返還
    if output_path.exists():
        print(f"[PitchShift] Cache Hit! Returning: {file_url}")
        return {"status": "success", "file_url": file_url}
        
    # 4. 進行高品質變調 (Librosa + SoundFile)
    try:
        import numpy as np
        print(f"[PitchShift] Shifting {audio_path} by {semitones} semitones using Librosa...")
        
        # 載入原檔：sr=None 保持原生採樣率，mono=False 保留立體聲與聲像
        y, sr = librosa.load(str(audio_path), sr=None, mono=False)
        
        # 使用 librosa.effects.pitch_shift 高品質變調
        y_shifted = librosa.effects.pitch_shift(y=y, sr=sr, n_steps=semitones)

        # 避免變調後峰值比原檔更高造成瞬間爆音
        original_peak = float(np.max(np.abs(y))) if y.size else 0.0
        shifted_peak = float(np.max(np.abs(y_shifted))) if y_shifted.size else 0.0
        if original_peak > 0 and shifted_peak > original_peak:
            y_shifted = y_shifted * (original_peak / shifted_peak)

        # librosa multi-channel: (channels, samples); soundfile expects (samples, channels)
        if getattr(y_shifted, "ndim", 1) == 2:
            y_shifted = y_shifted.T
        
        # 寫入目標檔案
        sf.write(str(output_path), y_shifted, sr)
        
        print(f"[PitchShift] Shift Completed! Saved to: {output_path}")
        return {"status": "success", "file_url": file_url}
        
    except Exception as e:
        print(f"[PitchShift] Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ============== Run Server ==============

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8050)
# Serve Static Files (Frontend) - Production Mode
# When running in Docker, /app/dist will contain the built frontend
# Fix: Register m4a mimetype explicitly to ensure browsers play it
import mimetypes
mimetypes.add_type("audio/mp4", ".m4a")

FRONTEND_DIST = Path("/app/dist")

if FRONTEND_DIST.exists():
    # Mount assets (CSS, JS, Images)
    if (FRONTEND_DIST / "assets").exists():
        app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="assets")

    # Catch-all route for SPA (React Router)
    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str, request: Request):
        # Allow API and Files access to pass through
        if full_path.startswith("api/") or full_path.startswith("files/"):
            raise HTTPException(status_code=404)

        # admin-vocal 子網域：任何路徑都顯示後台
        if request.headers.get('host', '').startswith('admin'):
            return FileResponse(str(BASE_DIR / "admin.html"))

        # Check if file exists (e.g. favicon.ico)
        file_path = FRONTEND_DIST / full_path
        if file_path.exists() and file_path.is_file():
            return FileResponse(file_path)

        # Fallback to index.html for React Routes
        return FileResponse(FRONTEND_DIST / "index.html")
