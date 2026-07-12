from pathlib import Path
import json


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"Missing expected block: {label}")
    return text.replace(old, new, 1)

main_path = Path('backend-api/main.py')
main = main_path.read_text(encoding='utf-8')

# Downloads are allowed regardless of duration. Separation still enforces 10 minutes.
main = replace_once(
    main,
    "    duration = await asyncio.to_thread(media_policy.probe_youtube_duration, request.youtube_url)\n    media_policy.enforce_duration(duration, http_request)\n\n",
    "",
    "download duration guard",
)

# Replace forced-download endpoint with explicit MP3/MP4 endpoint while keeping compatibility.
start = main.index('@app.get("/api/download-file/{job_id}")')
end = main.index('# ============== Background Tasks ==============', start)
endpoint_block = '''@app.get("/api/download-file/{job_id}")
async def download_file(job_id: str):
    """Backward-compatible audio download endpoint."""
    return await download_file_by_type(job_id, "mp3")


@app.get("/api/download-file/{job_id}/{file_type}")
async def download_file_by_type(job_id: str, file_type: str):
    """Force browser download of the generated MP3 or MP4 file."""
    normalized = file_type.lower()
    if normalized not in {"mp3", "mp4"}:
        raise HTTPException(status_code=400, detail="僅支援 MP3 或 MP4")

    file_path = DOWNLOADS_DIR / f"{job_id}.{normalized}"
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail=f"{normalized.upper()} 檔案尚未產生")

    filename = f"VocalTune_{job_id}.{normalized}"
    media_type = "audio/mpeg" if normalized == "mp3" else "video/mp4"
    return FileResponse(
        path=file_path,
        filename=filename,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


'''
main = main[:start] + endpoint_block + main[end:]

# Replace downloader so each job produces MP3 and MP4. Long videos are permitted.
start = main.index('async def download_youtube_audio(job_id: str, youtube_url: str):')
end = main.index('async def separate_audio_local(', start)
function_block = '''async def download_youtube_audio(job_id: str, youtube_url: str):
    """Download both MP3 and MP4. Source download has no duration limit."""
    try:
        update_job_status(job_id, {
            "status": "downloading", "progress": 5,
            "message": "正在連接 YouTube..."
        })

        ffmpeg_path = shutil.which("ffmpeg")
        if not ffmpeg_path:
            for candidate in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"):
                if os.path.exists(candidate):
                    ffmpeg_path = candidate
                    break
        if not ffmpeg_path:
            raise Exception("伺服器找不到 ffmpeg")

        common = [
            "yt-dlp", "--no-playlist", "--no-progress", "--no-warnings",
            "--extractor-args", "youtube:player_client=android",
            "--ffmpeg-location", ffmpeg_path,
        ]
        if Path("cookies.txt").exists():
            common.extend(["--cookies", "cookies.txt"])

        mp3_cmd = common + [
            "-f", "bestaudio/best", "-x", "--audio-format", "mp3",
            "--audio-quality", "0", "-o", str(DOWNLOADS_DIR / f"{job_id}.%(ext)s"),
            youtube_url,
        ]
        mp4_cmd = common + [
            "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
            "--merge-output-format", "mp4",
            "-o", str(DOWNLOADS_DIR / f"{job_id}.mp4"),
            youtube_url,
        ]

        async def run_command(cmd, progress, message, log_suffix):
            update_job_status(job_id, {
                "status": "downloading", "progress": progress, "message": message
            })
            log_path = DOWNLOADS_DIR / f"{job_id}.{log_suffix}.log"

            def run_sync():
                with open(log_path, "w", encoding="utf-8") as log_file:
                    try:
                        result = subprocess.run(
                            cmd, stdout=log_file, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, text=True, timeout=7200,
                        )
                        return result.returncode
                    except subprocess.TimeoutExpired:
                        return -2

            returncode = await asyncio.get_event_loop().run_in_executor(None, run_sync)
            full_log = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
            if returncode == 0:
                log_path.unlink(missing_ok=True)
                return
            if returncode == -2:
                raise Exception("下載逾時")
            if "Sign in" in full_log:
                raise Exception("YouTube 要求驗證，請稍後再試")
            raise Exception(f"下載失敗: {full_log[-400:]}")

        await run_command(mp3_cmd, 15, "正在產生 MP3 音訊...", "mp3")
        await run_command(mp4_cmd, 60, "正在產生 MP4 影片...", "mp4")

        mp3_path = DOWNLOADS_DIR / f"{job_id}.mp3"
        mp4_path = DOWNLOADS_DIR / f"{job_id}.mp4"
        if not mp3_path.is_file() or not mp4_path.is_file():
            raise Exception("轉換完成但找不到 MP3 或 MP4 檔案")

        update_job_status(job_id, {
            "status": "completed", "progress": 100,
            "message": "MP3 與 MP4 已準備完成",
            "file_url": f"/files/downloads/{job_id}.mp3",
            "mp3_url": f"/api/download-file/{job_id}/mp3",
            "mp4_url": f"/api/download-file/{job_id}/mp4",
        })
    except Exception as exc:
        logging.exception("Download job failed: %s", job_id)
        update_job_status(job_id, {
            "status": "error", "progress": 0,
            "message": f"下載失敗: {exc}", "error": str(exc),
        })


'''
main = main[:start] + function_block + main[end:]
main_path.write_text(main, encoding='utf-8')

app_path = Path('App.tsx')
app = app_path.read_text(encoding='utf-8')

app = replace_once(app, '>v4.0.2<', '>v4.0.3<', 'display version')

# Status response can include explicit export URLs.
app = replace_once(
    app,
    "                        file_url?: string;\n                        error?: string;",
    "                        file_url?: string;\n                        mp3_url?: string;\n                        mp4_url?: string;\n                        error?: string;",
    'status response fields',
)

# Add download buttons under the selected-video card after conversion completes.
needle = """                                        {downloadStatus === 'downloading' ? `${downloadMessage || '轉換中...'} ${downloadProgress}%` : downloadStatus === 'completed' ? '重新轉換這首歌' : '開始轉換音訊'}
                                    </button>"""
replacement = needle + """
                                    {downloadStatus === 'completed' && downloadJobId && (
                                        <div className=\"mt-3 grid grid-cols-2 gap-3\">
                                            <a
                                                href={`${API_BASE_URL}/api/download-file/${downloadJobId}/mp3`}
                                                className=\"flex items-center justify-center rounded-xl border border-purple-400/50 bg-purple-500/15 px-4 py-3 font-bold text-purple-100 hover:bg-purple-500/25\"
                                            >
                                                下載 MP3
                                            </a>
                                            <a
                                                href={`${API_BASE_URL}/api/download-file/${downloadJobId}/mp4`}
                                                className=\"flex items-center justify-center rounded-xl border border-pink-400/50 bg-pink-500/15 px-4 py-3 font-bold text-pink-100 hover:bg-pink-500/25\"
                                            >
                                                下載 MP4
                                            </a>
                                        </div>
                                    )}
                                    <p className=\"mt-3 text-center text-xs text-gray-400\">
                                        下載 MP3／MP4 不限影片長度；音軌分離仍限制 10 分鐘。
                                    </p>"""
app = replace_once(app, needle, replacement, 'download buttons')
app_path.write_text(app, encoding='utf-8')

package_path = Path('package.json')
package = json.loads(package_path.read_text(encoding='utf-8'))
package['version'] = '4.0.3'
package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
