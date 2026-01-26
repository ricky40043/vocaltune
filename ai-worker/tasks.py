"""
VocalTune Pro AI Worker
Celery Worker 負責執行繁重的 AI 音樂處理
- 使用 yt-dlp 下載 YouTube 音訊
- 使用 Demucs (htdemucs_6s) 進行 AI 6軌分離
- 使用 FFmpeg 進行混音
"""

import os
import subprocess
import tempfile
import json
from datetime import timedelta
from pathlib import Path

from celery import Celery
import redis
from google.cloud import storage

# Environment variables
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
BUCKET_NAME = os.getenv("BUCKET_NAME", "vocaltune-temp-storage")
GCS_KEY_PATH = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "")

# Initialize Celery
app = Celery("tasks", broker=REDIS_URL, backend=REDIS_URL)

# Celery configuration
app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="Asia/Taipei",
    enable_utc=True,
    task_routes={
        "tasks.separate_music": {"queue": "music_separation"},
        "tasks.mix_tracks": {"queue": "music_separation"},
    },
    worker_prefetch_multiplier=1,
    task_acks_late=True,
)

# Redis client for status updates
redis_client = redis.from_url(REDIS_URL, decode_responses=True)

# ============== Helper Functions ==============

def update_status(job_id: str, status: dict):
    """更新任務狀態到 Redis"""
    status_key = f"job:{job_id}:status"
    redis_client.set(status_key, json.dumps(status), ex=3600)

def get_gcs_client():
    """獲取 GCS 客戶端"""
    if GCS_KEY_PATH and os.path.exists(GCS_KEY_PATH):
        return storage.Client.from_service_account_json(GCS_KEY_PATH)
    return storage.Client()

def upload_to_gcs(local_path: str, gcs_path: str) -> str:
    """
    上傳檔案到 GCS
    回傳 Signed URL (1 小時有效)
    """
    client = get_gcs_client()
    bucket = client.bucket(BUCKET_NAME)
    blob = bucket.blob(gcs_path)
    
    blob.upload_from_filename(local_path)
    
    # Generate signed URL (1 hour expiry)
    signed_url = blob.generate_signed_url(
        expiration=timedelta(hours=1),
        method="GET"
    )
    return signed_url

def download_from_gcs(gcs_path: str, local_path: str):
    """從 GCS 下載檔案"""
    client = get_gcs_client()
    bucket = client.bucket(BUCKET_NAME)
    blob = bucket.blob(gcs_path)
    blob.download_to_filename(local_path)

# ============== Main Tasks ==============

@app.task(name="tasks.separate_music", bind=True)
def separate_music(self, youtube_url: str, job_id: str):
    """
    音樂分離任務
    1. 使用 yt-dlp 下載音訊 (MP3)
    2. 使用 Demucs (htdemucs_6s) 分離成 6 軌
    3. 上傳到 GCS 並生成 Signed URLs
    """
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir = Path(tmpdir)
            
            # Step 1: Download audio using yt-dlp
            update_status(job_id, {
                "status": "downloading",
                "progress": 10,
                "message": "正在下載音訊..."
            })
            
            audio_path = tmpdir / "audio.mp3"
            download_cmd = [
                "yt-dlp",
                "-x",  # Extract audio
                "--audio-format", "mp3",
                "--audio-quality", "0",  # Best quality
                "-o", str(audio_path),
                "--no-playlist",
                "--cookies-from-browser", "chrome",  # Try to use browser cookies
                youtube_url
            ]
            
            # Try without cookies first
            download_cmd_simple = [
                "yt-dlp",
                "-x",
                "--audio-format", "mp3",
                "--audio-quality", "0",
                "-o", str(audio_path),
                "--no-playlist",
                youtube_url
            ]
            
            result = subprocess.run(
                download_cmd_simple,
                capture_output=True,
                text=True,
                timeout=300
            )
            
            if result.returncode != 0:
                # Try with browser cookies
                result = subprocess.run(
                    download_cmd,
                    capture_output=True,
                    text=True,
                    timeout=300
                )
            
            if result.returncode != 0:
                raise Exception(f"下載失敗: {result.stderr}")
            
            # Find the actual downloaded file
            mp3_files = list(tmpdir.glob("*.mp3"))
            if not mp3_files:
                # Try other audio formats
                audio_files = list(tmpdir.glob("audio.*"))
                if audio_files:
                    audio_path = audio_files[0]
                else:
                    raise Exception("找不到下載的音訊檔案")
            else:
                audio_path = mp3_files[0]
            
            # Step 2: Separate with Demucs
            update_status(job_id, {
                "status": "separating",
                "progress": 30,
                "message": "AI 正在分離音軌，這可能需要幾分鐘..."
            })
            
            output_dir = tmpdir / "separated"
            output_dir.mkdir(exist_ok=True)
            
            # Run Demucs with CPU (Cloud Run doesn't have GPU)
            demucs_cmd = [
                "python", "-m", "demucs",
                "--two-stems", "vocals",  # Separate vocals and accompaniment
                "-n", "htdemucs_6s",
                "-d", "cpu",  # Force CPU
                "-o", str(output_dir),
                str(audio_path)
            ]
            
            # Alternative: Full 6-stem separation
            demucs_cmd_full = [
                "python", "-m", "demucs",
                "-n", "htdemucs_6s",
                "-d", "cpu",
                "-o", str(output_dir),
                str(audio_path)
            ]
            
            result = subprocess.run(
                demucs_cmd_full,
                capture_output=True,
                text=True,
                timeout=600  # 10 minutes max for separation
            )
            
            if result.returncode != 0:
                raise Exception(f"分離失敗: {result.stderr}")
            
            # Step 3: Upload to GCS
            update_status(job_id, {
                "status": "uploading",
                "progress": 80,
                "message": "正在上傳處理後的音軌..."
            })
            
            # Find separated files
            stem_dir = output_dir / "htdemucs_6s" / audio_path.stem
            if not stem_dir.exists():
                # Try alternative path
                stems = list(output_dir.glob("**/vocals.wav"))
                if stems:
                    stem_dir = stems[0].parent
                else:
                    raise Exception(f"找不到分離後的檔案: {list(output_dir.rglob('*'))}")
            
            tracks = {}
            stem_names = ["vocals", "drums", "bass", "guitar", "piano", "other"]
            
            for stem in stem_names:
                stem_file = stem_dir / f"{stem}.wav"
                if stem_file.exists():
                    gcs_path = f"jobs/{job_id}/{stem}.wav"
                    signed_url = upload_to_gcs(str(stem_file), gcs_path)
                    tracks[stem] = signed_url
            
            # If only 2-stem separation (vocals + no_vocals)
            no_vocals_file = stem_dir / "no_vocals.wav"
            if no_vocals_file.exists() and "drums" not in tracks:
                gcs_path = f"jobs/{job_id}/accompaniment.wav"
                signed_url = upload_to_gcs(str(no_vocals_file), gcs_path)
                tracks["accompaniment"] = signed_url
            
            # Also upload original
            original_gcs_path = f"jobs/{job_id}/original.mp3"
            original_url = upload_to_gcs(str(audio_path), original_gcs_path)
            tracks["original"] = original_url
            
            # Update final status
            update_status(job_id, {
                "status": "completed",
                "progress": 100,
                "message": "分離完成！",
                "tracks": tracks
            })
            
            return {"job_id": job_id, "tracks": tracks}
            
    except Exception as e:
        update_status(job_id, {
            "status": "error",
            "progress": 0,
            "error": str(e),
            "message": f"處理失敗: {str(e)}"
        })
        raise

@app.task(name="tasks.mix_tracks", bind=True)
def mix_tracks(self, job_id: str, volumes: dict, mix_job_id: str):
    """
    混音任務
    1. 下載該 job 的原始軌道
    2. 使用 FFmpeg 進行混音
    3. 上傳混音結果
    """
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir = Path(tmpdir)
            
            update_status(mix_job_id, {
                "status": "downloading",
                "progress": 20,
                "message": "正在下載原始軌道..."
            })
            
            # Get original job status to find track URLs
            status_key = f"job:{job_id}:status"
            status_data = redis_client.get(status_key)
            if not status_data:
                raise Exception("找不到原始任務資料")
            
            status = json.loads(status_data)
            tracks = status.get("tracks", {})
            
            # Download tracks from GCS
            local_tracks = {}
            for stem, url in tracks.items():
                if stem == "original":
                    continue
                    
                gcs_path = f"jobs/{job_id}/{stem}.wav"
                local_path = tmpdir / f"{stem}.wav"
                
                try:
                    download_from_gcs(gcs_path, str(local_path))
                    local_tracks[stem] = str(local_path)
                except Exception:
                    pass  # Skip if file doesn't exist
            
            if not local_tracks:
                raise Exception("無法下載任何音軌")
            
            # Step 2: Mix with FFmpeg
            update_status(mix_job_id, {
                "status": "mixing",
                "progress": 50,
                "message": "正在混音..."
            })
            
            output_path = tmpdir / "mix.mp3"
            
            # Build FFmpeg filter complex
            inputs = []
            filter_parts = []
            
            for i, (stem, path) in enumerate(local_tracks.items()):
                inputs.extend(["-i", path])
                vol = volumes.get(stem, 1.0)
                filter_parts.append(f"[{i}:a]volume={vol}[a{i}]")
            
            # Mix all streams
            mix_inputs = "".join([f"[a{i}]" for i in range(len(local_tracks))])
            filter_complex = ";".join(filter_parts) + f";{mix_inputs}amix=inputs={len(local_tracks)}:duration=longest[out]"
            
            ffmpeg_cmd = [
                "ffmpeg", "-y",
                *inputs,
                "-filter_complex", filter_complex,
                "-map", "[out]",
                "-codec:a", "libmp3lame",
                "-q:a", "2",
                str(output_path)
            ]
            
            result = subprocess.run(
                ffmpeg_cmd,
                capture_output=True,
                text=True,
                timeout=120
            )
            
            if result.returncode != 0:
                raise Exception(f"混音失敗: {result.stderr}")
            
            # Step 3: Upload to GCS
            update_status(mix_job_id, {
                "status": "uploading",
                "progress": 80,
                "message": "正在上傳混音結果..."
            })
            
            gcs_path = f"jobs/{job_id}/mix_{mix_job_id}.mp3"
            mix_url = upload_to_gcs(str(output_path), gcs_path)
            
            # Update final status
            update_status(mix_job_id, {
                "status": "completed",
                "progress": 100,
                "message": "混音完成！",
                "mix_url": mix_url
            })
            
            return {"mix_job_id": mix_job_id, "mix_url": mix_url}
            
    except Exception as e:
        update_status(mix_job_id, {
            "status": "error",
            "progress": 0,
            "error": str(e),
            "message": f"混音失敗: {str(e)}"
        })
        raise


@app.task(name="tasks.transcribe_audio", bind=True)
def transcribe_audio(self, job_id: str, stem_name: str, transcribe_job_id: str):
    """
    音訊轉 MIDI 任務 (Audio to MIDI Transcription)
    使用 Spotify Basic Pitch 將音軌轉換為 MIDI
    
    1. 驗證 stem_name
    2. 從 GCS 下載該音軌
    3. 使用 Basic Pitch 推論
    4. 上傳 MIDI 到 GCS
    5. 回傳 Signed URL
    """
    from basic_pitch.inference import predict_and_save
    from basic_pitch import ICASSP_2022_MODEL_PATH
    
    VALID_STEMS = ["vocals", "drums", "bass", "guitar", "piano", "other", "accompaniment", "original"]
    
    try:
        # Step 0: Validate stem name
        if stem_name not in VALID_STEMS:
            raise ValueError(f"無效的音軌名稱: {stem_name}. 有效選項: {VALID_STEMS}")
        
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir = Path(tmpdir)
            
            # Step 1: Download audio from GCS
            update_status(transcribe_job_id, {
                "status": "downloading",
                "progress": 10,
                "message": f"正在下載 {stem_name} 音軌..."
            })
            
            # Determine file extension (wav for separated, mp3 for original)
            file_ext = "mp3" if stem_name == "original" else "wav"
            gcs_path = f"jobs/{job_id}/{stem_name}.{file_ext}"
            local_audio_path = tmpdir / f"{stem_name}.{file_ext}"
            
            download_from_gcs(gcs_path, str(local_audio_path))
            
            if not local_audio_path.exists():
                raise Exception(f"無法下載音軌: {gcs_path}")
            
            # Step 2: Run Basic Pitch inference
            update_status(transcribe_job_id, {
                "status": "transcribing",
                "progress": 30,
                "message": "AI 正在分析音高與節奏，這可能需要 1-2 分鐘..."
            })
            
            output_dir = tmpdir / "midi_output"
            output_dir.mkdir(exist_ok=True)
            
            # Run prediction
            predict_and_save(
                audio_path_list=[str(local_audio_path)],
                output_directory=str(output_dir),
                save_midi=True,
                sonify_midi=False,
                save_model_outputs=False,
                save_notes=False,
                model_or_model_path=ICASSP_2022_MODEL_PATH,
            )
            
            # Find the generated MIDI file
            midi_files = list(output_dir.glob("*.mid"))
            if not midi_files:
                raise Exception("Basic Pitch 未能生成 MIDI 檔案")
            
            midi_file = midi_files[0]
            
            # Step 3: Upload MIDI to GCS
            update_status(transcribe_job_id, {
                "status": "uploading",
                "progress": 80,
                "message": "正在上傳 MIDI 檔案..."
            })
            
            gcs_midi_path = f"jobs/{job_id}/{stem_name}.mid"
            midi_url = upload_to_gcs(str(midi_file), gcs_midi_path)
            
            # Step 4: Update final status
            update_status(transcribe_job_id, {
                "status": "completed",
                "progress": 100,
                "message": "採譜完成！",
                "midi_url": midi_url
            })
            
            return {"transcribe_job_id": transcribe_job_id, "midi_url": midi_url}
            
    except Exception as e:
        update_status(transcribe_job_id, {
            "status": "error",
            "progress": 0,
            "error": str(e),
            "message": f"採譜失敗: {str(e)}"
        })
        raise


# For local testing
if __name__ == "__main__":
    print("Use: celery -A tasks worker --loglevel=info --pool=solo")
