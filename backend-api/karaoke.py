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
import json
from datetime import datetime

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
        # Create Date-Based Directory Structure: YYYYMMDD/job_id
        today_date = datetime.now().strftime("%Y%m%d")
        # Base work dir remains same for temp processing, but final output goes to date folder
        # Actually, let's keep everything self-contained in the date folder to avoid scatter
        
        # New Structure: karaoke_output/YYYYMMDD/job_id/
        job_dir = KARAOKE_DIR / today_date / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        
        work_dir = job_dir # Use this as work dir
        
        # Metadata
        video_title = "Unknown Title"
        
        # 1. Acquire Input Video
        input_video_path = None
        ffmpeg_path = shutil.which("ffmpeg")
        if not ffmpeg_path and os.path.exists("/opt/homebrew/bin/ffmpeg"):
            ffmpeg_path = "/opt/homebrew/bin/ffmpeg"
        if not ffmpeg_path:
             logging.warning("FFmpeg not found in PATH or standard locations.")
             # Fallback to rely on system PATH just in case
             ffmpeg_path = "ffmpeg"

        if youtube_url:
            update_job_status(job_id, {"status": "downloading", "progress": 10, "message": "下載影片中..."})
            
            # Fetch Title First
            try:
                title_cmd = ["yt-dlp", "--get-title", youtube_url]
                # Check for cookies (reuse logic)
                if Path("cookies.txt").exists():
                    title_cmd.extend(["--cookies", "cookies.txt"])
                
                proc_title = await asyncio.create_subprocess_exec(
                    *title_cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
                )
                t_out, t_err = await proc_title.communicate()
                if proc_title.returncode == 0:
                    video_title = t_out.decode().strip()
                    logging.info(f"Fetched Title: {video_title}")
            except Exception as e:
                logging.warning(f"Failed to fetch title: {e}")

            # yt-dlp download (Best Video+Audio -> mp4)
            # Use strict temp filename to avoid weird character issues
            input_video_path = work_dir / "input.mp4"
            
            # Check for ffmpeg
            ffmpeg_path = shutil.which("ffmpeg")
            if not ffmpeg_path and os.path.exists("/opt/homebrew/bin/ffmpeg"):
                ffmpeg_path = "/opt/homebrew/bin/ffmpeg"
                
            cmd = [
                "yt-dlp",
                "-f", "bestvideo+bestaudio/best",
                "--merge-output-format", "mp4",
                "-o", str(input_video_path),
                "--extractor-args", "youtube:player_client=android",
                "--no-playlist",
                "--no-playlist",
                "--no-warnings",
            ]

            # Authentication: Try cookies.txt
            if Path("cookies.txt").exists():
                cmd.extend(["--cookies", "cookies.txt"])
                logging.info("Using cookies.txt for authentication")
            elif Path("../cookies.txt").exists():
                cmd.extend(["--cookies", "../cookies.txt"])
                logging.info("Using ../cookies.txt for authentication")

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
            video_title = Path(file_path).stem # Use filename as title
            
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

        # Save Metadata (info.json)
        info_path = work_dir / "info.json"
        with open(info_path, "w", encoding='utf-8') as f:
            json.dump({
                "job_id": job_id,
                "title": video_title,
                "youtube_url": youtube_url,
                "created_at": datetime.now().isoformat(),
                "status": "processing" # Will update to completed later
            }, f, indent=4, ensure_ascii=False)

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
            "python", "-u", "-m", "demucs",
            "-n", "htdemucs_6s",
            "-d", "cpu",
            "--out", str(work_dir),
            str(extracted_audio)
        ]
        
        logging.info(f"Starting Demucs: {' '.join(cmd_demucs)}")

        # Demucs parsing logic
        # Merge stderr to stdout to capture tqdm progress bars
        proc_demucs = await asyncio.create_subprocess_exec(
            *cmd_demucs, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
        )

        buffer = ""
        full_log = []

        while True:
            # Read chunk instead of readline to handle \r
            chunk = await proc_demucs.stdout.read(4096)
            if not chunk:
                break
            
            chunk_str = chunk.decode('utf-8', errors='ignore')
            buffer += chunk_str
            full_log.append(chunk_str)
            
            # Keep log size reasonable
            if len(full_log) > 1000:
                full_log = full_log[-500:]

            # Split by either newline or carriage return
            while '\n' in buffer or '\r' in buffer:
                if '\n' in buffer:
                    line, buffer = buffer.split('\n', 1)
                elif '\r' in buffer:
                    line, buffer = buffer.split('\r', 1)
                
                line = line.strip()
                if not line:
                    continue
                
                logging.debug(f"[Demucs] {line}")
                
                # Parse progress: e.g. " 45%|████... "
                if "%" in line and "|" in line:
                    try:
                        percent_str = line.split('%')[0].strip()
                        # Get last 3 chars
                        percent = percent_str[-3:].strip()
                        if percent.isdigit():
                            d_prog = int(percent)
                            # Map Demucs 0-100% to Overall 30-85% (Expanded range for better UX)
                            overall_prog = 30 + int(d_prog * 0.55)
                            
                            if overall_prog % 2 == 0:
                                update_job_status(job_id, {
                                    "status": "separating", 
                                    "progress": overall_prog,
                                    "message": f"AI 去人聲運算中... {d_prog}%"
                                })
                    except:
                        pass

        await proc_demucs.wait()
        
        if proc_demucs.returncode != 0:
            error_msg = "".join(full_log[-20:]) # Last 20 chunks as context
            raise Exception(f"Demucs 分離失敗 (Exit Code: {proc_demucs.returncode}): {error_msg}")

        # 4. Mix Instrumental
        # Folder structure: work_dir/htdemucs_6s/source_audio/
        demucs_out = work_dir / "htdemucs_6s" / "source_audio"
        
        if not demucs_out.exists():
             # Fallback: Try finding in alternative paths (recursive search)
             logging.warning(f"Demucs output not found at {demucs_out}, searching recursively...")
             possible_paths = list(work_dir.rglob("vocals.wav"))
             if possible_paths:
                 demucs_out = possible_paths[0].parent
                 logging.info(f"Found Demucs output at: {demucs_out}")
             else:
                 # Debug: list all files
                 all_files = list(work_dir.rglob("*"))
                 logging.error(f"All files in work_dir: {all_files}")
                 raise Exception("找不到分離結果 (Files not found)")

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
             
        # Use normalize=0 to SUM the signals instead of averaging.
        # This restores the original volume/energy of the backing track.
        filter_complex += f"amix=inputs={idx}:duration=longest:normalize=0[out]"
        
        cmd_mix = ["ffmpeg", "-y"] + inputs + ["-filter_complex", filter_complex, "-map", "[out]", str(instrumental_wav)]
        
        proc_mix = await asyncio.create_subprocess_exec(
             *cmd_mix, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await proc_mix.communicate()

        # Bonus: Process Vocals for Toggle Feature
        vocals_wav = demucs_out / "vocals.wav"
        vocals_mp3 = work_dir / "vocals.mp3" # Save inside job_dir
        vocals_url = None
        
        # Helper to convert wav to mp3 and return url
        async def convert_to_mp3(wav_path: Path, mp3_path: Path) -> str:
            if not wav_path.exists(): return None
            cmd = [
                ffmpeg_path, "-y",
                "-i", str(wav_path),
                "-vn", "-ar", "44100", "-ac", "2", "-b:a", "192k",
                str(mp3_path)
            ]
            p = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
            )
            await p.communicate()
            if mp3_path.exists():
                return f"/files/karaoke/{today_date}/{job_id}/{mp3_path.name}"
            return None

        if vocals_wav.exists():
             try:
                 update_job_status(job_id, {"status": "processing", "progress": 90, "message": "正在處理人聲音軌..."})
                 vocals_url = await convert_to_mp3(vocals_wav, vocals_mp3)
             except Exception as ve:
                 logging.error(f"Vocals processing error: {ve}")

        # Process all other stems for individual access
        stems_urls = {}
        for s in stems:
            stem_wav = demucs_out / f"{s}.wav"
            stem_mp3 = work_dir / f"{s}.mp3"
            if stem_wav.exists():
                url = await convert_to_mp3(stem_wav, stem_mp3)
                if url:
                    stems_urls[s] = url

        # 4.5 Convert Instrumental to MP3 for simpler frontend loading
        instrumental_mp3 = work_dir / "instrumental.mp3"
        instrumental_url = None
        
        try:
            update_job_status(job_id, {"status": "processing", "progress": 92, "message": "正在最佳化伴奏音訊..."})
            instrumental_url = await convert_to_mp3(instrumental_wav, instrumental_mp3)
        except Exception as e:
            logging.warning(f"Instrumental MP3 conversion failed: {e}")

        # 5. Remux with Video
        update_job_status(job_id, {"status": "processing", "progress": 95, "message": "正在輸出最終影片..."})
        
        final_output = work_dir / "video.mp4" # Rename to generic video.mp4 inside folder
        
        # Merge Original Video (no audio) + Instrumental Audio
        cmd_remux = [
            ffmpeg_path, "-y",
            "-i", str(input_video_path),
            "-i", str(instrumental_wav),
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-c:v", "copy",
            "-c:a", "aac",
            "-shortest", 
            str(final_output)
        ]
        
        proc_remux = await asyncio.create_subprocess_exec(
            *cmd_remux, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await proc_remux.communicate()
        
        if proc_remux.returncode != 0:
             logging.error(f"FFmpeg Remux failed: {stderr.decode()}")
             raise Exception("最終合成失敗")

        # Update Info JSON
        info_path = work_dir / "info.json"
        if info_path.exists():
            with open(info_path, "r+", encoding='utf-8') as f:
                data = json.load(f)
                data["status"] = "completed"
                f.seek(0)
                json.dump(data, f, indent=4, ensure_ascii=False)
                f.truncate()
        
        final_status = {
            "status": "completed",
            "progress": 100,
            "message": "轉換完成！",
            "file_url": f"/files/karaoke/{today_date}/{job_id}/video.mp4",
            "vocals_url": vocals_url,
            "instrumental_url": instrumental_url,
            "stems": stems_urls # Expose all individual stems
        }
        update_job_status(job_id, final_status)

    except Exception as e:
        print(f"Karaoke Error: {e}")
        update_job_status(job_id, {"status": "error", "message": f"處理失敗: {str(e)}", "error": str(e)})
