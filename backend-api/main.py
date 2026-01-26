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

# Job status storage (in-memory for simplicity, Redis for production)
job_status_store: dict = {}

# Initialize FastAPI
app = FastAPI(
    title="VocalTune Pro API",
    description="YouTube 音樂下載與 AI 人聲分離服務",
    version="2.0.0"
)

# CORS Configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all for local development
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static files (downloaded and separated audio)
app.mount("/files/downloads", StaticFiles(directory=str(DOWNLOADS_DIR)), name="downloads")
app.mount("/files/separated", StaticFiles(directory=str(SEPARATED_DIR)), name="separated")

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
    tracks: Optional[dict] = None
    error: Optional[str] = None

class AnalyzeRequest(BaseModel):
    file_path: str

# ============== Helper Functions ==============

@app.post("/api/analyze-bpm")
async def analyze_bpm(request: AnalyzeRequest):
    """分析音訊 BPM"""
    import librosa
    import numpy as np
    
    # 支援 URL 路徑轉本地路徑
    # e.g. /files/downloads/xxx.mp3 -> backend-api/downloads/xxx.mp3
    
    try:
        if request.file_path.startswith("/files/downloads/"):
            filename = request.file_path.replace("/files/downloads/", "")
            local_path = str(DOWNLOADS_DIR / filename)
        elif request.file_path.startswith("http"):
             # Handle full URL if passed
             if "/files/downloads/" in request.file_path:
                 filename = request.file_path.split("/files/downloads/")[-1]
                 local_path = str(DOWNLOADS_DIR / filename)
             else:
                 raise HTTPException(status_code=400, detail="只支援分析本機下載的檔案")
        else:
             local_path = request.file_path

        if not os.path.exists(local_path):
            raise HTTPException(status_code=404, detail="找不到檔案")

        # Load audio (only first 30 seconds to speed up)
        y, sr = librosa.load(local_path, duration=60)
        
        # Estimate tempo
        onset_env = librosa.onset.onset_strength(y=y, sr=sr)
        tempo = librosa.feature.tempo(onset_envelope=onset_env, sr=sr)
        
        bpm = round(float(tempo[0]))
        
        return {"bpm": bpm}
        
    except Exception as e:
        print(f"BPM Analysis Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/analyze-upload")
async def analyze_upload(file: UploadFile = File(...)):
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

def update_job_status(job_id: str, status: dict):
    """更新任務狀態"""
    job_status_store[job_id] = status

def get_job_status(job_id: str) -> dict:
    """獲取任務狀態"""
    return job_status_store.get(job_id, {"status": "unknown"})

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
        
        # Use yt-dlp to download
        cmd = [
            "yt-dlp",
            "-x",  # Extract audio
            "--audio-format", "mp3",
            "--audio-quality", "0",
            "-o", str(output_path),
            "--no-playlist",
            "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "--referer", "https://www.youtube.com/",
            youtube_url
        ]
        
        update_job_status(job_id, {
            "status": "downloading",
            "progress": 30,
            "message": "正在下載音訊..."
        })
        
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        
        stdout, stderr = await process.communicate()
        
        if process.returncode != 0:
            raise Exception(f"下載失敗: {stderr.decode()}")
        
        # Find the actual file (yt-dlp may add extensions)
        mp3_files = list(DOWNLOADS_DIR.glob(f"{job_id}*"))
        if mp3_files:
            actual_file = mp3_files[0]
            # Rename to expected path if needed
            if actual_file != output_path:
                actual_file.rename(output_path)
        
        if not output_path.exists():
            raise Exception("下載完成但找不到檔案")
        
        update_job_status(job_id, {
            "status": "completed",
            "progress": 100,
            "message": "下載完成！",
            "file_url": f"/files/downloads/{job_id}.mp3"
        })
        
    except Exception as e:
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
    
    # Remove full URL prefix if present (e.g., http://localhost:8000/files/downloads/xxx.mp3)
    if "://localhost" in file_path or "://127.0.0.1" in file_path:
        # Extract path from URL
        from urllib.parse import urlparse
        parsed = urlparse(file_path)
        file_path = parsed.path
    
    if file_path.startswith("/files/downloads/"):
        filename = file_path.replace("/files/downloads/", "")
        audio_path = DOWNLOADS_DIR / filename
    elif file_path.startswith("/files/separated/"):
        filename = file_path.replace("/files/separated/", "")
        audio_path = SEPARATED_DIR / filename
    else:
        audio_path = Path(file_path)
    
    if not audio_path.exists():
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

# ============== Run Server ==============

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
# Serve Static Files (Frontend) - Production Mode
# When running in Docker, /app/dist will contain the built frontend
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
