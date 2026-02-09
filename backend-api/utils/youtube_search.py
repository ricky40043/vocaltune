
import subprocess
import json
import logging

logger = logging.getLogger(__name__)

def search_youtube(query: str, limit: int = 10):
    """
    Search YouTube using yt-dlp and return a list of results.
    """
    try:
        # Construct yt-dlp command
        # --dump-json: Output JSON metadata
        # --flat-playlist: Don't download video, just list info
        # --no-warnings: Suppress warnings
        # ytsearch{limit}:{query}: Search syntax
        
        command = [
            "yt-dlp",
            "--dump-json",
            "--flat-playlist",
            "--no-warnings",
            f"ytsearch{limit}:{query}"
        ]
        
        logger.info(f"Running search command: {' '.join(command)}")
        
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=True
        )
        
        videos = []
        for line in result.stdout.strip().split('\n'):
            if not line:
                continue
            try:
                data = json.loads(line)
                video_info = {
                    "id": data.get("id"),
                    "title": data.get("title"),
                    "thumbnail": data.get("thumbnail") or f"https://i.ytimg.com/vi/{data.get('id')}/hqdefault.jpg",
                    "duration": data.get("duration"),
                    "uploader": data.get("uploader"),
                    "view_count": data.get("view_count"),
                    "url": data.get("url") or f"https://www.youtube.com/watch?v={data.get('id')}"
                }
                videos.append(video_info)
            except json.JSONDecodeError:
                logger.error(f"Failed to parse JSON line: {line}")
                continue
                
        return videos
        
    except subprocess.CalledProcessError as e:
        logger.error(f"yt-dlp search failed: {e.stderr}")
        return []
    except Exception as e:
        logger.error(f"Unexpected error during search: {str(e)}")
        return []
