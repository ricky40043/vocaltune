"""Optional cloud separation. Returning None tells callers to run local Demucs."""
import asyncio
import io
import logging
import os
import shutil
import tempfile
import time
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

import httpx

LOG = logging.getLogger(__name__)
STEM_NAMES = {
    2: {"vocals", "no_vocals"},
    4: {"vocals", "drums", "bass", "other"},
    6: {"vocals", "drums", "bass", "guitar", "piano", "other"},
}
MAX_ZIP_BYTES = 768 * 1024 * 1024
_retry_after = 0.0


def extract_stems(payload, output_dir, audio_name, stems):
    """Validate the entire ZIP before publishing any files; never use extractall."""
    expected = {f"{name}.wav" for name in STEM_NAMES[stems]}
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        members = archive.infolist()
        if len(members) != len(expected) or {item.filename for item in members} != expected:
            raise ValueError("Unexpected ZIP members")
        if sum(item.file_size for item in members) > MAX_ZIP_BYTES:
            raise ValueError("Expanded archive too large")
        for item in members:
            mode = item.external_attr >> 16
            if item.is_dir() or (mode & 0o170000) == 0o120000 or item.flag_bits & 1:
                raise ValueError("Invalid ZIP entry")
        parent = Path(output_dir) / "cloud"
        parent.mkdir(parents=True, exist_ok=True)
        target = parent / audio_name
        # output_dir belongs to a unique job. Refuse overwriting existing results.
        if target.exists():
            raise ValueError("Output already exists")
        with tempfile.TemporaryDirectory(prefix=".extract-", dir=parent) as temporary:
            staging = Path(temporary) / "stems"
            staging.mkdir()
            for item in members:
                with archive.open(item) as source, (staging / item.filename).open("wb") as dest:
                    header = source.read(12)
                    if len(header) != 12 or header[:4] != b"RIFF" or header[8:] != b"WAVE":
                        raise ValueError("Invalid WAV")
                    dest.write(header)
                    shutil.copyfileobj(source, dest, 64 * 1024)
            staging.rename(target)
        return target


def identity_token(audience):
    token = os.getenv("SEPARATION_ID_TOKEN")
    if token:
        return token
    import google.auth
    from google.auth import impersonated_credentials
    from google.auth.transport.requests import Request
    from google.oauth2.id_token import fetch_id_token
    request = Request()
    credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    if isinstance(credentials, impersonated_credentials.Credentials):
        # gcloud auth application-default login --impersonate-service-account=...
        identity = impersonated_credentials.IDTokenCredentials(
            credentials, target_audience=audience, include_email=True,
        )
        identity.refresh(request)
        return identity.token
    return fetch_id_token(request, audience)


async def try_cloud_separation(audio_path, output_dir, stems=6, on_status=None):
    global _retry_after
    if os.getenv("SEPARATION_CLOUD_ENABLED", "0") != "1":
        return None
    if time.monotonic() < _retry_after:
        return None
    audio = Path(audio_path)
    url = os.getenv("SEPARATION_API_URL", "").rstrip("/")
    key = os.getenv("SEPARATION_API_KEY", "")
    parts = urlsplit(url)
    if (parts.scheme != "https" or not parts.netloc or parts.path not in ("", "/")
            or parts.query or parts.fragment or parts.username or not key
            or stems not in STEM_NAMES or audio.suffix.lower() not in {".mp3", ".wav", ".flac"}):
        LOG.warning("Cloud separation configuration/input unsupported; using local inference")
        return None
    encoded = None
    started = time.monotonic()
    received = 0
    phase = "preparing"
    def notify(message):
        if on_status is not None:
            on_status(message)
    try:
        notify("正在準備雲端 GPU 分軌...")
        upload = audio
        if audio.stat().st_size > 29 * 1024 * 1024:
            # Karaoke extracts PCM WAV. Compress it losslessly so normal songs
            # can cross Cloud Run's HTTP/1 upload limit without losing quality.
            if audio.suffix.lower() != ".wav" or audio.stat().st_size > 128 * 1024 * 1024:
                return None
            encoded = tempfile.TemporaryDirectory(prefix="cloud-upload-")
            upload = Path(encoded.name) / (audio.stem + ".flac")
            process = await asyncio.create_subprocess_exec(
                "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                "-i", str(audio), "-vn", "-c:a", "flac", str(upload),
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            )
            try:
                await asyncio.wait_for(process.wait(), timeout=30)
            except BaseException:
                if process.returncode is None:
                    process.kill()
                await process.wait()
                raise
            if process.returncode or upload.stat().st_size > 29 * 1024 * 1024:
                return None
        headers = {"X-API-Key": key}
        # IAM blocks unauthorized traffic before a GPU container can be started.
        headers["Authorization"] = "Bearer " + await asyncio.wait_for(
            asyncio.to_thread(identity_token, url), timeout=15,
        )
        timeout = httpx.Timeout(310, connect=15, write=60, pool=15)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            for attempt in range(2):
                received = 0
                phase = "request"
                try:
                    notify("雲端 GPU 分軌中（首次啟動需稍候）..." if attempt == 0
                           else "雲端傳輸中斷，正在重試一次...")
                    with upload.open("rb") as source:
                        async with client.stream(
                            "POST", url + "/api/separate", headers=headers,
                            data={"stems": str(stems)},
                            files={"file": (upload.name, source, "application/octet-stream")},
                        ) as response:
                            if response.status_code == 429:
                                # Never retry or wake a container after quota exhaustion.
                                _retry_after = time.monotonic() + 86400
                                LOG.warning("Cloud inference quota exceeded; using local inference")
                                notify("雲端額度已滿，改用本地分軌...")
                                return None
                            response.raise_for_status()
                            if response.headers.get("content-type", "").split(";")[0] != "application/zip":
                                raise ValueError("Expected a ZIP response")
                            expected_bytes = response.headers.get("x-archive-bytes")
                            expected_bytes = int(expected_bytes) if expected_bytes is not None else None
                            if expected_bytes is not None and not 0 < expected_bytes <= MAX_ZIP_BYTES:
                                raise ValueError("Invalid archive size")
                            phase = "download"
                            notify("雲端分軌完成，正在下載音軌...")
                            payload = io.BytesIO()
                            announced = 0
                            async for chunk in response.aiter_bytes():
                                received += len(chunk)
                                if received > MAX_ZIP_BYTES:
                                    raise ValueError("Response archive too large")
                                payload.write(chunk)
                                if received - announced >= 16 * 1024 * 1024:
                                    announced = received
                                    notify(f"正在下載雲端音軌... {received // (1024 * 1024)} MiB")
                            if expected_bytes is not None and received != expected_bytes:
                                raise EOFError("Incomplete archive")
                    phase = "extract"
                    notify("正在驗證並解壓縮雲端音軌...")
                    result = await asyncio.to_thread(
                        extract_stems, payload.getvalue(), output_dir, audio.stem, stems,
                    )
                    LOG.info("Cloud separation succeeded: stems=%s bytes=%s seconds=%.2f attempts=%s",
                             stems, received, time.monotonic() - started, attempt + 1)
                    return result
                except (httpx.TransportError, zipfile.BadZipFile, EOFError) as exc:
                    # A severed download must not immediately trigger minutes of CPU
                    # work. One retry is charged by the same durable GPU quota.
                    LOG.warning("Cloud attempt failed: type=%s phase=%s bytes=%s attempt=%s",
                                type(exc).__name__, phase, received, attempt + 1)
                    if attempt or time.monotonic() - started >= 90:
                        raise
    except (httpx.HTTPError, OSError, ValueError, zipfile.BadZipFile, EOFError, asyncio.TimeoutError) as exc:
        _retry_after = time.monotonic() + 60
        status = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else None
        LOG.warning("Cloud separation failed; using local inference: type=%s status=%s phase=%s bytes=%s seconds=%.2f",
                    type(exc).__name__, status, phase, received, time.monotonic() - started)
        notify("雲端未完成，改用本地分軌（速度較慢）...")
        return None
    except Exception as exc:
        # ADC/identity provider or decompression errors also fall back, without
        # logging credentials or remote response bodies.
        _retry_after = time.monotonic() + 60
        LOG.warning("Cloud separation unavailable (%s); using local inference", type(exc).__name__)
        return None
    finally:
        if encoded is not None:
            encoded.cleanup()
