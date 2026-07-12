from pathlib import Path
import json


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise SystemExit(f'Missing expected block: {label}')
    return text.replace(old, new, 1)

song_path = Path('components/SongRequestSystem.tsx')
song = song_path.read_text(encoding='utf-8')
song = replace_once(
    song,
    '{video.duration}',
    '{formatDuration(video.duration)}',
    'duration display',
)
song_path.write_text(song, encoding='utf-8')

backend_path = Path('backend-api/main.py')
backend = backend_path.read_text(encoding='utf-8')
old = '''    duration = await asyncio.to_thread(media_policy.probe_youtube_duration, request.youtube_url)\n    media_policy.enforce_duration(duration, http_request)\n    queue = load_queue(user)\n'''
new = '''    def parse_duration_seconds(value: str | None) -> int | None:\n        if value is None:\n            return None\n        text = str(value).strip()\n        if not text:\n            return None\n        try:\n            if ":" not in text:\n                return int(float(text))\n            total = 0\n            for part in text.split(":"):\n                total = total * 60 + int(part)\n            return total\n        except (TypeError, ValueError):\n            return None\n\n    # Search results already include duration. Use that first so a temporary\n    # YouTube metadata probe failure does not block adding a valid song.\n    duration = parse_duration_seconds(request.duration)\n    if duration is None:\n        duration = await asyncio.to_thread(media_policy.probe_youtube_duration, request.youtube_url)\n    media_policy.enforce_duration(duration, http_request)\n    queue = load_queue(user)\n'''
backend = replace_once(backend, old, new, 'queue duration validation')
backend_path.write_text(backend, encoding='utf-8')

app_path = Path('App.tsx')
app = app_path.read_text(encoding='utf-8')
app = app.replace('v4.0.4', 'v4.0.5')
app_path.write_text(app, encoding='utf-8')

package_path = Path('package.json')
package = json.loads(package_path.read_text(encoding='utf-8'))
package['version'] = '4.0.5'
package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
