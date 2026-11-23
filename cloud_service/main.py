"""Cloud Run separation API. Quota limits inference, never total cloud spend."""
import asyncio
import hmac
import logging
import math
import os
import sys
import tempfile
import time
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.background import BackgroundTask

from cloud_service.quota import FirestoreQuota, QuotaExceeded

LOG = logging.getLogger(__name__)
MAX_UPLOAD = 30 * 1024 * 1024  # Cloud Run HTTP/1 request limit is 32 MiB incl multipart.
MAX_AUDIO_SECONDS = 600
INFERENCE_TIMEOUT = 240  # Kill the child before Cloud Run's 300s request timeout.
STEMS = {
    2: ("vocals", "no_vocals"),
    4: ("vocals", "drums", "bass", "other"),
    6: ("vocals", "drums", "bass", "guitar", "piano", "other"),
}


@asynccontextmanager
async def lifespan(app):
    key = os.environ.get("SEPARATION_API_KEY", "")
    if len(key) < 32:
        raise RuntimeError("SEPARATION_API_KEY must contain at least 32 characters")
    limit = int(os.getenv("MAX_MONTHLY_GPU_SECONDS", "40000"))
    if limit < 0:
        raise RuntimeError("MAX_MONTHLY_GPU_SECONDS must be nonnegative")
    app.state.api_key = key
    app.state.quota = FirestoreQuota(
        os.environ["GOOGLE_CLOUD_PROJECT"],
        os.getenv("QUOTA_COLLECTION", "vocaltune_gpu_quota"), limit,
    )
    app.state.slots = asyncio.Semaphore(2)
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def authorize(request, call_next):
    if request.url.path != "/health":
        supplied = request.headers.get("x-api-key", "")
        expected = getattr(app.state, "api_key", "")
        if not expected or not hmac.compare_digest(supplied.encode(), expected.encode()):
            return JSONResponse({"detail": "Invalid API key"}, status_code=401)
        if request.method == "POST":
            try:
                length = int(request.headers["content-length"])
            except (KeyError, ValueError):
                return JSONResponse({"detail": "Content-Length required"}, status_code=411)
            if length < 0 or length > MAX_UPLOAD:
                return JSONResponse({"detail": "Upload too large"}, status_code=413)
    return await call_next(request)


@app.get("/health")
def health():
    return {"status": "ok"}


async def run_child(command, timeout):
    process = await asyncio.create_subprocess_exec(
        *command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout)
    except BaseException:
        if process.returncode is None:
            process.kill()
        await process.wait()
        raise
    if process.returncode:
        LOG.error("Audio child failed: %s", stderr[-2000:].decode(errors="replace"))
        raise HTTPException(422, "Audio decoding or separation failed")
    return stdout


def zip_stems(directory, target, names):
    # Keep WAV output lossless while reducing the long download of six full songs.
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
        for name in names:
            path = directory / f"{name}.wav"
            if not path.is_file():
                raise RuntimeError("Missing separated stem")
            archive.write(path, arcname=path.name)


def zip_chunks(path):
    with path.open("rb") as source:
        while chunk := source.read(64 * 1024):
            yield chunk


@app.post("/api/separate")
async def separate(file: UploadFile = File(...), stems: int = Form(2)):
    if stems not in STEMS:
        raise HTTPException(422, "stems must be 2, 4, or 6")
    extension = Path(file.filename or "").suffix.lower()
    if extension not in {".mp3", ".wav", ".flac"}:
        raise HTTPException(415, "Supported formats: mp3, wav, flac")
    temp = tempfile.TemporaryDirectory(prefix="separate-")
    root = Path(temp.name)
    handed_off = False
    try:
        audio = root / f"input{extension}"
        size = 0
        with audio.open("wb") as destination:
            while chunk := await file.read(64 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD:
                    raise HTTPException(413, "Upload too large")
                destination.write(chunk)
        if not size:
            raise HTTPException(422, "Empty audio")
        async with app.state.slots:
            duration = await run_child([
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", str(audio),
            ], 10)
            try:
                seconds = float(duration.strip())
                if not math.isfinite(seconds) or not 0 < seconds <= MAX_AUDIO_SECONDS:
                    raise ValueError()
            except ValueError:
                raise HTTPException(422, "Audio must be at most 600 seconds") from None
            try:
                # Atomically reserve the worst case BEFORE starting CUDA, including
                # overlapping requests/revisions. Crashes keep their reservation.
                reservation = await asyncio.to_thread(
                    app.state.quota.reserve, INFERENCE_TIMEOUT + 5,
                )
            except QuotaExceeded:
                raise HTTPException(429, "Quota Exceeded", headers={"Retry-After": "86400"}) from None
            except Exception:
                LOG.exception("Quota unavailable; refusing GPU work")
                raise HTTPException(503, "Quota ledger unavailable") from None
            started = time.monotonic()
            model = "htdemucs_6s" if stems == 6 else "htdemucs_ft"
            command = [sys.executable, "-m", "demucs", "-n", model, "-d", "cuda",
                       "--segment", "7", "-o", str(root), str(audio)]
            if stems == 2:
                command += ["--two-stems", "vocals"]
            try:
                await run_child(command, INFERENCE_TIMEOUT)
            except asyncio.TimeoutError:
                raise HTTPException(504, "Inference timed out") from None
            try:
                await asyncio.to_thread(app.state.quota.finish, reservation, time.monotonic() - started)
            except Exception:
                # Reservation stays charged if accounting fails; never reset to zero.
                LOG.exception("Quota settlement failed; retaining reservation")
        archive = root / "stems.zip"
        await asyncio.to_thread(zip_stems, root / model / "input", archive, STEMS[stems])
        response = StreamingResponse(
            zip_chunks(archive), media_type="application/zip",
            # Advertise the expected body size without Content-Length, which would
            # disable chunked transfer and hit Cloud Run's non-streaming limit.
            headers={"Content-Disposition": 'attachment; filename="stems.zip"',
                     "X-Archive-Bytes": str(archive.stat().st_size)},
            background=BackgroundTask(temp.cleanup),
        )
        handed_off = True
        return response
    finally:
        await file.close()
        if not handed_off:
            temp.cleanup()
