"""Media length policy and short-lived admin-mode authentication."""

import base64
import hashlib
import hmac
import json
import os
import subprocess
import time
from pathlib import Path

from fastapi import HTTPException, Request

MAX_MEDIA_SECONDS = 10 * 60
ADMIN_MODE_PASSWORD = os.getenv("ADMIN_MODE_PASSWORD", "go for it")
ADMIN_MODE_TTL_SECONDS = int(os.getenv("ADMIN_MODE_TTL_SECONDS", "28800"))
_SIGNING_KEY = os.getenv("ADMIN_MODE_SIGNING_KEY", ADMIN_MODE_PASSWORD).encode()


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _unb64(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def authenticate(password: str) -> str:
    if not hmac.compare_digest(password, ADMIN_MODE_PASSWORD):
        raise HTTPException(status_code=401, detail="管理密碼錯誤")
    payload = json.dumps({"exp": int(time.time()) + ADMIN_MODE_TTL_SECONDS}, separators=(",", ":")).encode()
    signature = hmac.new(_SIGNING_KEY, payload, hashlib.sha256).digest()
    return f"{_b64(payload)}.{_b64(signature)}"


def is_admin_request(request: Request) -> bool:
    token = request.headers.get("x-admin-mode-token", "")
    try:
        payload_part, signature_part = token.split(".", 1)
        payload = _unb64(payload_part)
        expected = hmac.new(_SIGNING_KEY, payload, hashlib.sha256).digest()
        if not hmac.compare_digest(_unb64(signature_part), expected):
            return False
        return int(json.loads(payload)["exp"]) >= int(time.time())
    except (ValueError, KeyError, TypeError, json.JSONDecodeError):
        return False


def parse_duration(value) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    try:
        if ":" not in text:
            return float(text)
        parts = [float(part) for part in text.split(":")]
        if len(parts) > 3:
            return None
        return sum(part * (60 ** index) for index, part in enumerate(reversed(parts)))
    except ValueError:
        return None


def probe_file_duration(path: Path) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True, timeout=20,
    )
    duration = parse_duration(result.stdout.strip()) if result.returncode == 0 else None
    if duration is None:
        raise HTTPException(status_code=422, detail="無法讀取媒體長度，請確認檔案格式")
    return duration


def probe_youtube_duration(url: str) -> float:
    result = subprocess.run(
        ["yt-dlp", "--no-playlist", "--skip-download", "--print", "%(duration)s", "--no-warnings", url],
        capture_output=True, text=True, timeout=30,
    )
    duration = parse_duration(result.stdout.strip().splitlines()[0]) if result.returncode == 0 and result.stdout.strip() else None
    if duration is None:
        raise HTTPException(status_code=422, detail="無法確認影片長度，請稍後再試")
    return duration


def enforce_duration(duration: float, request: Request) -> None:
    if duration > MAX_MEDIA_SECONDS and not is_admin_request(request):
        raise HTTPException(status_code=413, detail="音樂長度不可超過 10 分鐘")
