"""Pause one private Cloud Run service after local requests have been idle.

Use one backend process/host as the owner. Automatic scaling remains enabled while
working, so a crashed local controller cannot leave a pinned GPU running forever.
"""
import asyncio
import contextlib
import logging
import os
import re
import time

import httpx

LOG = logging.getLogger(__name__)
_controller = None


def access_token():
    import google.auth
    from google.auth.transport.requests import Request
    credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    request = Request()
    def bounded_request(*args, **kwargs):
        kwargs.setdefault("timeout", 15)
        return request(*args, **kwargs)
    credentials.refresh(bounded_request)
    return credentials.token


class CloudRunScaling:
    def __init__(self, project, region, service):
        if not all(re.fullmatch(r"[a-zA-Z0-9-]+", value) for value in (project, region, service)):
            raise ValueError("Invalid Cloud Run scaling resource")
        self.url = f"https://run.googleapis.com/v2/projects/{project}/locations/{region}/services/{service}"

    def __call__(self, awake):
        headers = {"Authorization": "Bearer " + access_token()}
        desired = "AUTOMATIC" if awake else "MANUAL"
        with httpx.Client(timeout=15, follow_redirects=False) as client:
            response = client.get(self.url, headers=headers)
            response.raise_for_status()
            current = response.json()
            scaling = current.get("scaling", {})
            matches = (scaling.get("scalingMode", "AUTOMATIC") == desired
                       and (awake or scaling.get("manualInstanceCount", 0) == 0))
            if matches and not current.get("reconciling"):
                return
            # Compare-and-swap prevents overwriting another administrative update.
            if not matches:
                if not current.get("etag"):
                    raise ValueError("Cloud Run service has no etag")
                response = client.patch(
                    self.url, headers=headers,
                    params={"updateMask": "scaling.scalingMode,scaling.manualInstanceCount"},
                    json={"name": current["name"], "etag": current["etag"], "scaling": {
                        "scalingMode": desired, "manualInstanceCount": None if awake else 0,
                    }},
                )
                response.raise_for_status()
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                response = client.get(self.url, headers=headers)
                response.raise_for_status()
                current = response.json()
                scaling = current.get("scaling", {})
                if (scaling.get("scalingMode", "AUTOMATIC") == desired
                        and (awake or scaling.get("manualInstanceCount", 0) == 0)
                        and not current.get("reconciling")):
                    return
                time.sleep(1)
            raise TimeoutError("Cloud Run scaling did not settle")


class IdleController:
    def __init__(self, control, idle_seconds=120, clock=time.monotonic):
        if not 1 <= idle_seconds <= 600:
            raise ValueError("Idle shutdown must be between 1 and 600 seconds")
        self.control = control
        self.idle_seconds = idle_seconds
        self.clock = clock
        self.last_finished = clock()
        self.active = 0
        self.paused = None
        self.lock = asyncio.Lock()
        self.task = None

    def start(self):
        if self.task is None:
            self.task = asyncio.create_task(self.watch())

    async def acquire(self):
        # Waking and pausing share this lock. A request arriving during pause
        # waits, then wakes the service before uploading rather than being cut off.
        async with self.lock:
            if self.paused is not False:
                await asyncio.to_thread(self.control, True)
                self.paused = False
                LOG.info("Cloud Run enabled automatic scaling for separation")
            self.active += 1

    async def release(self):
        async with self.lock:
            self.active -= 1
            self.last_finished = self.clock()

    async def check_idle(self):
        async with self.lock:
            if (not self.active and self.paused is not True
                    and self.clock() - self.last_finished >= self.idle_seconds):
                await asyncio.to_thread(self.control, False)
                self.paused = True
                LOG.info("Cloud Run paused at zero after %s idle seconds", self.idle_seconds)

    async def watch(self):
        while True:
            await asyncio.sleep(min(5, self.idle_seconds))
            try:
                await self.check_idle()
            except Exception as exc:
                # Do not kill the supervisor on IAM/API failures, nor wake the GPU
                # to check health. Retry control-plane operations on the next tick.
                LOG.warning("Cloud idle pause failed (%s); will retry", type(exc).__name__)

    async def close(self):
        if self.task is not None:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task
        async with self.lock:
            if not self.active:
                try:
                    await asyncio.to_thread(self.control, False)
                    self.paused = True
                except Exception as exc:
                    LOG.warning("Cloud pause on shutdown failed (%s)", type(exc).__name__)


def get_idle_controller():
    global _controller
    if (os.getenv("SEPARATION_CLOUD_ENABLED", "0") != "1"
            or os.getenv("SEPARATION_IDLE_SHUTDOWN_SECONDS", "0") == "0"):
        return None
    if _controller is None:
        _controller = IdleController(CloudRunScaling(
            os.environ["GOOGLE_CLOUD_PROJECT"], os.environ["SEPARATION_CLOUD_REGION"],
            os.environ["SEPARATION_CLOUD_SERVICE"],
        ), int(os.environ["SEPARATION_IDLE_SHUTDOWN_SECONDS"]))
    _controller.start()
    return _controller


async def close_idle_controller():
    if _controller is not None:
        await _controller.close()
