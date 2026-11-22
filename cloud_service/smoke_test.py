"""Exercise the deployed private API with synthetic audio and the real REST client."""
import argparse
import asyncio
import io
import json
import math
import os
import struct
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import wave
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend-api"))
import separation_client


def make_audio(root):
    wav = root / "sample.wav"
    samples = bytearray()
    for index in range(44100 * 3):
        value = int(10000 * math.sin(2 * math.pi * 220 * index / 44100)
                    + 3000 * math.sin(2 * math.pi * 440 * index / 44100))
        samples.extend(struct.pack("<hh", value, value))
    with wave.open(str(wav), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(44100)
        output.writeframes(samples)
    for extension in ("mp3", "flac"):
        subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                        "-y", "-i", str(wav), str(root / ("sample." + extension))], check=True)


def verify_wav(data):
    with wave.open(io.BytesIO(data)) as audio:
        assert audio.getnchannels() == 2
        assert abs(audio.getnframes() / audio.getframerate() - 3) < 0.2


async def verify_quota(client, headers, args, root):
    # This administrative probe runs before enabling the local production client.
    # It changes only charged_seconds and restores it with an update-time check.
    token = subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True).strip()
    admin_headers = {"Authorization": "Bearer " + token,
                     "x-goog-user-project": args.project, "Content-Type": "application/json"}
    month = datetime.now(timezone.utc).strftime("%Y-%m")
    endpoint = ("https://firestore.googleapis.com/v1/projects/" + args.project
                + "/databases/(default)/documents/vocaltune_gpu_quota/" + month)

    def read():
        with urllib.request.urlopen(urllib.request.Request(endpoint, headers=admin_headers), timeout=20) as response:
            return json.load(response)

    def set_seconds(seconds, update_time):
        query = urllib.parse.urlencode({"updateMask.fieldPaths": "charged_seconds",
                                        "currentDocument.updateTime": update_time})
        body = {"fields": {"charged_seconds": {"integerValue": str(seconds)}}}
        request = urllib.request.Request(endpoint + "?" + query, headers=admin_headers,
                                         data=json.dumps(body).encode(), method="PATCH")
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)

    original = await asyncio.to_thread(read)
    seconds = int(original["fields"]["charged_seconds"]["integerValue"])
    reserved = await asyncio.to_thread(set_seconds, args.quota_limit, original["updateTime"])
    try:
        with (root / "sample.wav").open("rb") as source:
            response = await client.post(args.url + "/api/separate", headers=headers,
                                         data={"stems": "2"}, files={"file": ("sample.wav", source)})
        assert response.status_code == 429, response.status_code
        separation_client._retry_after = 0
        result = await separation_client.try_cloud_separation(root / "sample.wav", root / "quota-output", 2)
        assert result is None
    finally:
        # Reject overwriting an unrelated update rather than dropping valid use.
        await asyncio.to_thread(set_seconds, seconds, reserved["updateTime"])
    return {"status": 429, "client_requested_local_fallback": True,
            "charged_seconds_restored": seconds}


async def run(args):
    args.url = args.url.rstrip("/")
    key = Path(args.key_file).read_text()
    os.environ.update(SEPARATION_API_URL=args.url, SEPARATION_API_KEY=key,
                      SEPARATION_CLOUD_ENABLED="1", GOOGLE_APPLICATION_CREDENTIALS=args.credentials)
    token = await asyncio.to_thread(separation_client.identity_token, args.url)
    headers = {"Authorization": "Bearer " + token, "X-API-Key": key}
    evidence = {"url": args.url, "results": []}
    with tempfile.TemporaryDirectory(prefix="cloud-smoke-") as temporary:
        root = Path(temporary)
        make_audio(root)
        async with httpx.AsyncClient(timeout=310) as client:
            anonymous = await client.get(args.url + "/api/separate")
            assert anonymous.status_code in (401, 403), anonymous.status_code
            evidence["anonymous_status"] = anonymous.status_code
            health = await client.get(args.url + "/health", headers=headers)
            assert health.status_code == 200, health.status_code
            evidence["health_status"] = health.status_code
            with (root / "sample.wav").open("rb") as source:
                denied = await client.post(args.url + "/api/separate",
                                           headers={**headers, "X-API-Key": "incorrect"},
                                           data={"stems": "2"}, files={"file": ("sample.wav", source)})
            assert denied.status_code == 401, denied.status_code
            evidence["invalid_key_status"] = denied.status_code

            async def separate(extension, count):
                started = time.monotonic()
                with (root / ("sample." + extension)).open("rb") as source:
                    response = await client.post(args.url + "/api/separate", headers=headers,
                                                 data={"stems": str(count)},
                                                 files={"file": ("sample." + extension, source)})
                assert response.status_code == 200, (response.status_code, response.text[:200])
                with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                    assert set(archive.namelist()) == {name + ".wav" for name in separation_client.STEM_NAMES[count]}
                    assert archive.testzip() is None
                    for name in archive.namelist():
                        verify_wav(archive.read(name))
                return {"input": extension, "stems": count, "status": 200,
                        "seconds": round(time.monotonic() - started, 2)}

            # Two simultaneous requests exercise the deployed concurrency setting.
            evidence["results"] = await asyncio.gather(separate("wav", 2), separate("mp3", 4))
            started = time.monotonic()
            result = await separation_client.try_cloud_separation(root / "sample.flac", root / "client", 6)
            assert result is not None, "The real REST client fell back instead of completing cloud inference"
            assert {path.stem for path in result.iterdir()} == separation_client.STEM_NAMES[6]
            for path in result.iterdir():
                verify_wav(path.read_bytes())
            evidence["results"].append({"input": "flac", "stems": 6, "real_client": True,
                                         "seconds": round(time.monotonic() - started, 2)})
            if args.check_quota:
                evidence["quota"] = await verify_quota(client, headers, args, root)
    evidence["passed"] = True
    if args.output:
        Path(args.output).write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(evidence, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--key-file", required=True)
    parser.add_argument("--credentials", required=True)
    parser.add_argument("--output")
    parser.add_argument("--check-quota", action="store_true")
    parser.add_argument("--quota-limit", type=int, default=12000)
    asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    main()
