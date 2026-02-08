"""
VocalTune Pro Backend API
FastAPI 應用程式，處理音樂下載與 AI 分離服務
支援直接 YouTube 下載和本地 Demucs 分離
"""

import os
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

# Directories
BASE_DIR = Path(__file__).parent
DOWNLOADS_DIR = BASE_DIR / "downloads"
SEPARATED_DIR = BASE_DIR / "separated"
DOWNLOADS_DIR.mkdir(exist_ok=True)
SEPARATED_DIR.mkdir(exist_ok=True)

from job_store import job_status_store, update_job_status, get_job_status
from karaoke import process_karaoke_job, KARAOKE_DIR

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

class JobStatusResponse(BaseModel):
    job_id: str
    status: str
    progress: int = 0
    message: str = ""
    file_url: Optional[str] = None
    vocals_url: Optional[str] = None
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

# ============== Helper Functions ==============

@app.post("/api/analyze-bpm")
def analyze_bpm(request: AnalyzeRequest):
    """分析音訊 BPM"""
    import librosa
    import numpy as np

# ...

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
async def upload_file(file: UploadFile = File(...)):
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
            
        return {
            "status": "success",
            "job_id": job_id,
            "file_url": f"/files/downloads/{filename}",
            "file_path": str(file_path),
            "filename": file.filename
        }
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
            "--no-warnings",
            youtube_url
        ]
        
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

async def separate_audio_local(job_id: str, audio_path: str):
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
        
        # Run Demucs (htdemucs_6s model for 6-stem separation)
        # Using -u to force unbuffered binary stdout/stderr
        print(f"[Backend] Starting Demucs command for job {job_id}...")
        cmd = [
            "python", "-u", "-m", "demucs",
            "-n", "htdemucs_6s",  # 6-stem model
            "-d", "cpu",          # Use CPU
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
        stems_dir = output_dir / "htdemucs_6s" / audio_name
        
        if not stems_dir.exists():
            # Try finding in alternative paths
            possible_paths = list(output_dir.rglob("*.wav"))
            if possible_paths:
                stems_dir = possible_paths[0].parent
            else:
                raise Exception(f"找不到分離後的檔案")
        
        # Collect track URLs (6-stem model)
        tracks = {}
        track_names = ["vocals", "drums", "bass", "guitar", "piano", "other"]
        
        for track_name in track_names:
            track_file = stems_dir / f"{track_name}.wav"
            if track_file.exists():
                # Copy to accessible location
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
async def download_youtube(request: DownloadRequest, background_tasks: BackgroundTasks):
    """
    直接下載 YouTube 音訊
    - 驗證 URL
    - 啟動背景下載任務
    - 回傳 job_id 供前端追蹤進度
    """
    if not validate_youtube_url(request.youtube_url):
        raise HTTPException(
            status_code=400,
            detail="無效的 YouTube 連結 (支援 Watch, Shorts, Youtu.be)"
        )
    
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

@app.post("/api/separate-local", response_model=DownloadResponse)
async def separate_local(request: SeparateRequest, background_tasks: BackgroundTasks):
    """
    AI 音軌分離
    - 使用 Demucs 分離音軌
    - 不需要雲端服務
    """
    job_id = str(uuid.uuid4())[:8]
    
    # Determine full path - handle both URL and path formats
    file_path = request.file_path
    
    # Remove full URL prefix - Handle ANY URL format (localhost, IP, domain)
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
        # Handle cases where path might still be absolute or relative on disk
        audio_path = Path(file_path)
        print(f"[Debug] Resolved Direct path: {audio_path}")
    
    if not audio_path.exists():
        # Fallback: Try to find by filename only
        search_name = audio_path.name
        print(f"[Debug] Exact path not found. Searching for {search_name} in directories...")
        
        found = list(DOWNLOADS_DIR.rglob(search_name)) + list(SEPARATED_DIR.rglob(search_name))
        
        if found:
            audio_path = found[0]
            print(f"[Debug] Found fallback file: {audio_path}")
        else:
            print(f"[Error] File not found at: {audio_path}")
            # List dir content for debugging
            if audio_path.parent.exists():
                print(f"[Debug] Dir content of {audio_path.parent}: {list(audio_path.parent.glob('*'))}")
            raise HTTPException(status_code=404, detail=f"找不到音訊檔案: {request.file_path}")
    
    update_job_status(job_id, {
        "status": "pending",
        "progress": 0,
        "message": "分離任務已建立..."
    })
    
    # Start background separation
    background_tasks.add_task(separate_audio_local, job_id, str(audio_path))
    
    return DownloadResponse(
        job_id=job_id,
        status="pending",
        message="AI 分離任務已開始"
    )

@app.get("/api/status/{job_id}", response_model=JobStatusResponse)
async def get_status(job_id: str):
    """查詢任務狀態"""
    status = get_job_status(job_id)
    
    if status.get("status") == "unknown":
        raise HTTPException(status_code=404, detail="找不到此任務")
    
    return JobStatusResponse(
        job_id=job_id,
        status=status.get("status", "unknown"),
        progress=status.get("progress", 0),
        message=status.get("message", ""),
        file_url=status.get("file_url"),
        vocals_url=status.get("vocals_url"),
        tracks=status.get("tracks"),
        error=status.get("error")
    )

@app.post("/api/upload")
async def upload_audio(file: UploadFile = File(...)):
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
    
    return {
        "job_id": job_id,
        "file_url": f"/files/downloads/{job_id}{file_ext}",
        "message": "檔案上傳成功"
    }

@app.post("/api/karaoke/process", response_model=DownloadResponse)
async def create_karaoke(request: DownloadRequest, background_tasks: BackgroundTasks):
    """
    製作卡拉OK影片 (伴奏版 MV)
    - 支援 YouTube 下載或本地檔案
    - 自動分離人聲 + 合成影片
    """
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
    async def serve_spa(full_path: str):
        # Allow API and Files access to pass through
        if full_path.startswith("api/") or full_path.startswith("files/"):
            raise HTTPException(status_code=404)
        
        # Check if file exists (e.g. favicon.ico)
        file_path = FRONTEND_DIST / full_path
        if file_path.exists() and file_path.is_file():
            return FileResponse(file_path)
            
        # Fallback to index.html for React Routes
        return FileResponse(FRONTEND_DIST / "index.html")
