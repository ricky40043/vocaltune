import os
import uuid
import subprocess
import shutil
import asyncio
from pathlib import Path
import logging

# Directory Setup (Refers to structure in main.py)
BASE_DIR = Path(__file__).parent
DOWNLOADS_DIR = BASE_DIR / "downloads"
SEPARATED_DIR = BASE_DIR / "separated"
KARAOKE_DIR = BASE_DIR / "karaoke_output"
KARAOKE_DIR.mkdir(exist_ok=True)

# Shared job updater callback
from job_store import update_job_status, job_status_store

async def process_karaoke_job(job_id: str, youtube_url: str = None, file_path: str = None):
    """
    Orchestrates the Karaoke Video creation process:
    1. Download Video (if URL) or Use Local File.
    2. Extract Audio.
    3. Separate Audio (isolate Vocals vs Other).
    4. Mix "Backing Track" (All stems except vocals).
    5. Remux processed audio with original video.
    """
    try:
        work_dir = KARAOKE_DIR / job_id
        work_dir.mkdir(exist_ok=True)
        
        # 1. Acquire Input Video
        input_video_path = None
        
        if youtube_url:
            update_job_status(job_id, {"status": "downloading", "progress": 10, "message": "下載影片中..."})
            
            # yt-dlp download (Best Video+Audio -> mp4)
            # Use strict temp filename to avoid weird character issues
            input_video_path = work_dir / "input.mp4"
            
            # Check for ffmpeg
            ffmpeg_path = shutil.which("ffmpeg")
            if not ffmpeg_path and os.path.exists("/opt/homebrew/bin/ffmpeg"):
                ffmpeg_path = "/opt/homebrew/bin/ffmpeg"
                
            cmd = [
                "yt-dlp",
                "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
                "-o", str(input_video_path),
                "--extractor-args", "youtube:player_client=android",
                "--no-playlist",
                "--no-warnings",
            ]
            
            if ffmpeg_path:
                cmd.extend(["--ffmpeg-location", ffmpeg_path])
                
            cmd.append(youtube_url)
            
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await proc.communicate()
            
            if proc.returncode != 0 or not input_video_path.exists():
                error_msg = stderr.decode('utf-8', errors='ignore').strip()
                # Log full error
                logging.error(f"yt-dlp error: {error_msg}")
                # Return last meaningful line to user
                clean_error = error_msg.split('\n')[-1] if error_msg else "Unknown Error"
                raise Exception(f"下載失敗: {clean_error}")
                
        elif file_path:
            update_job_status(job_id, {"status": "processing", "progress": 10, "message": "讀取影片中..."})
            
            source_path = Path(file_path)
            if not source_path.exists():
                 # Try resolving relative path from main directories
                if (DOWNLOADS_DIR / file_path).exists():
                    source_path = DOWNLOADS_DIR / file_path
                elif (SEPARATED_DIR / file_path).exists():
                     source_path = SEPARATED_DIR / file_path
                else: 
                     raise Exception("找不到原始檔案")
            
            input_video_path = work_dir / "input.mp4"
            shutil.copy(source_path, input_video_path)

        # 2. Extract Audio for Demucs
        update_job_status(job_id, {"status": "separating", "progress": 30, "message": "正在準備音訊..."})
        
        extracted_audio = work_dir / "source_audio.wav"
        
        # ffmpeg extract
        cmd_extract = [
            "ffmpeg", "-y",
            "-i", str(input_video_path),
            "-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2",
            str(extracted_audio)
        ]
        
        proc_ext = await asyncio.create_subprocess_exec(
            *cmd_extract, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await proc_ext.communicate()
        
        if not extracted_audio.exists():
             raise Exception("音訊擷取失敗")

        # 3. Runs Demucs to separate
        update_job_status(job_id, {"status": "separating", "progress": 40, "message": "AI 去人聲運算中 (這需要一點時間)..."})
        
        # Use simpler model for speed? or same htdemucs_6s?
        # User wants quality. htdemucs_6s is good.
        # Demucs Output: work_dir / htdemucs_6s / source_audio / {vocals.wav, ...}
        
        cmd_demucs = [
            "python3", "-m", "demucs.separate",
            "-n", "htdemucs_6s",
            "--out", str(work_dir),
            str(extracted_audio)
        ]
        
        # Demucs parsing logic (borrowed from main.py) usually needed for progress bars
        # For separate module, we can simplify or duplicate logic.
        # Simplification: Just run it. Progress is roughly simulated or block-waiting.
        
        # Demucs parsing logic
        proc_demucs = await asyncio.create_subprocess_exec(
            *cmd_demucs, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )

        while True:
            line = await proc_demucs.stdout.readline()
            if not line:
                break
            
            line_str = line.decode('utf-8', errors='ignore').strip()
            
            # Parse progress: e.g. " 45%|████... "
            if "%" in line_str and "|" in line_str:
                try:
                    percent_str = line_str.split('%')[0].strip()
                    # Get last few chars
                    percent_digits = percent_str[-3:]
                    if percent_digits.isdigit():
                        d_prog = int(percent_digits)
                        # Map Demucs 0-100% to Overall 40-90%
                        # 40 + (d_prog * 0.5)
                        overall_prog = 40 + int(d_prog * 0.5)
                        
                        # Only update every 5% to reduce noise
                        if overall_prog % 5 == 0:
                            update_job_status(job_id, {
                                "status": "separating", 
                                "progress": overall_prog,
                                "message": f"AI 去人聲運算中... {d_prog}%"
                            })
                except:
                    pass

        await proc_demucs.wait()
        
        # Capture stderr for error checking
        stderr_data = await proc_demucs.stderr.read()
        stderr = stderr_data
        
        if proc_demucs.returncode != 0:
            error_msg = stderr_data.decode('utf-8', errors='ignore')
            raise Exception(f"Demucs 分離失敗: {error_msg}")

        # 4. Mix Instrumental
        # Folder structure: work_dir/htdemucs_6s/source_audio/
        demucs_out = work_dir / "htdemucs_6s" / "source_audio"
        if not demucs_out.exists():
             raise Exception("找不到分離結果")

        # Stems: vocals, drums, bass, guitar, piano, other
        # We want everything EXCEPT vocals.
        # So: drums + bass + guitar + piano + other
        
        update_job_status(job_id, {"status": "processing", "progress": 85, "message": "正在合成伴奏..."})
        
        instrumental_wav = work_dir / "instrumental.wav"
        
        # Use ffmpeg complex filter to mix
        # inputs: drums, bass, guitar, piano, other
        stems = ["drums", "bass", "guitar", "piano", "other"]
        inputs = []
        filter_complex = ""
        
        idx = 0
        valid_stems = []
        for s in stems:
            p = demucs_out / f"{s}.wav"
            if p.exists():
                inputs.extend(["-i", str(p)])
                valid_stems.append(p)
                filter_complex += f"[{idx}:a]"
                idx += 1
        
        if idx == 0:
             raise Exception("沒有分離出任何背景音軌")
             
        filter_complex += f"amix=inputs={idx}:duration=longest[out]"
        
        cmd_mix = ["ffmpeg", "-y"] + inputs + ["-filter_complex", filter_complex, "-map", "[out]", str(instrumental_wav)]
        
        proc_mix = await asyncio.create_subprocess_exec(
             *cmd_mix, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await proc_mix.communicate()

        # 5. Remux with Video
        update_job_status(job_id, {"status": "processing", "progress": 95, "message": "正在輸出最終影片..."})
        
        final_output = KARAOKE_DIR / f"{job_id}.mp4"
        
        # Merge Original Video (no audio) + Instrumental Audio
        cmd_remux = [
            "ffmpeg", "-y",
            "-i", str(input_video_path),
            "-i", str(instrumental_wav),
            "-c:v", "copy",        # Copy video stream (fast!)
            "-c:a", "aac",         # Encode audio to AAC
            "-b:a", "256k",
            "-map", "0:v:0",       # Use video from input 0
            "-map", "1:a:0",       # Use audio from input 1
            "-shortest",           # Cut to shortest duration
            str(final_output)
        ]
        
        proc_remux = await asyncio.create_subprocess_exec(
             *cmd_remux, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await proc_remux.communicate()
        
        if not final_output.exists():
             raise Exception("影片合成失敗")
             
        # Cleanup work dir
        try:
             shutil.rmtree(work_dir)
        except:
             pass

        update_job_status(job_id, {
            "status": "completed", 
            "progress": 100, 
            "message": "轉換完成！",
            "file_url": f"/files/karaoke/{job_id}.mp4"
        })

    except Exception as e:
        print(f"Karaoke Error: {e}")
        update_job_status(job_id, {"status": "error", "message": f"處理失敗: {str(e)}", "error": str(e)})
