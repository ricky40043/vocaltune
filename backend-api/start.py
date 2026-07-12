import mimetypes
from pathlib import Path
from typing import Iterator

from fastapi import HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.routing import APIRoute

from main import SEPARATED_DIR, app

_CHUNK_SIZE = 1024 * 1024


def _safe_track_path(job_id: str, filename: str) -> Path:
    base = SEPARATED_DIR.resolve()
    candidate = (base / job_id / filename).resolve()

    try:
        candidate.relative_to(base)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Audio file not found") from exc

    if not candidate.is_file():
        raise HTTPException(status_code=404, detail="Audio file not found")

    return candidate


def _parse_range(range_header: str, file_size: int) -> tuple[int, int]:
    if not range_header.startswith("bytes="):
        raise HTTPException(status_code=416, detail="Invalid range")

    value = range_header[6:].split(",", 1)[0].strip()
    start_text, separator, end_text = value.partition("-")
    if not separator:
        raise HTTPException(status_code=416, detail="Invalid range")

    try:
        if start_text:
            start = int(start_text)
            end = int(end_text) if end_text else file_size - 1
        else:
            suffix_length = int(end_text)
            if suffix_length <= 0:
                raise ValueError
            start = max(file_size - suffix_length, 0)
            end = file_size - 1
    except ValueError as exc:
        raise HTTPException(status_code=416, detail="Invalid range") from exc

    if start < 0 or start >= file_size or end < start:
        raise HTTPException(
            status_code=416,
            detail="Requested range not satisfiable",
            headers={"Content-Range": f"bytes */{file_size}"},
        )

    return start, min(end, file_size - 1)


def _read_range(path: Path, start: int, end: int) -> Iterator[bytes]:
    remaining = end - start + 1
    with path.open("rb") as file:
        file.seek(start)
        while remaining > 0:
            chunk = file.read(min(_CHUNK_SIZE, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


async def serve_separated_audio(job_id: str, filename: str, request: Request):
    path = _safe_track_path(job_id, filename)
    file_size = path.stat().st_size
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
    }

    range_header = request.headers.get("range")
    if not range_header:
        return FileResponse(path, media_type=media_type, headers=headers)

    start, end = _parse_range(range_header, file_size)
    headers.update(
        {
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Content-Length": str(end - start + 1),
        }
    )

    return StreamingResponse(
        _read_range(path, start, end),
        status_code=206,
        media_type=media_type,
        headers=headers,
    )


# Remove the old StaticFiles mount.
app.router.routes = [
    route
    for route in app.router.routes
    if not (getattr(route, "path", None) == "/files/separated")
]

# main.py already registered the SPA catch-all. Appending this route would put it
# after /{full_path:path}, causing every audio request to return JSON 404.
range_route = APIRoute(
    path="/files/separated/{job_id}/{filename:path}",
    endpoint=serve_separated_audio,
    methods=["GET", "HEAD"],
    include_in_schema=False,
)
catch_all_index = next(
    (
        index
        for index, route in enumerate(app.router.routes)
        if getattr(route, "path", None) == "/{full_path:path}"
    ),
    len(app.router.routes),
)
app.router.routes.insert(catch_all_index, range_route)
