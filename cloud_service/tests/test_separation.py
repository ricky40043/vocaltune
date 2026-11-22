import asyncio
import io
import os
import struct
import sys
import tempfile
import threading
import unittest
import wave
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend-api'))
import separation_client as client
from cloud_scaling import IdleController
from cloud_service import main
from cloud_service.quota import FirestoreQuota, QuotaExceeded

KEY = 'a' * 32


def wav_bytes():
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(44100)
        wav.writeframes(struct.pack('<hh', 10, -10) * 20)
    return buffer.getvalue()


def archive_bytes(stems=2, extra=None):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        for name in client.STEM_NAMES[stems]:
            archive.writestr(name + '.wav', wav_bytes())
        if extra:
            archive.writestr(extra, b'bad')
    return buffer.getvalue()


class Ledger:
    def __init__(self, limit=40000):
        self.used = 0
        self.limit = limit
        self.lock = threading.Lock()

    def reserve(self, seconds):
        with self.lock:
            if self.used + seconds > self.limit:
                raise QuotaExceeded()
            self.used += seconds
        return seconds

    def finish(self, reserved, elapsed):
        self.used -= reserved - 1


class APITests(unittest.TestCase):
    def setUp(self):
        main.app.state.api_key = KEY
        main.app.state.slots = asyncio.Semaphore(2)
        main.app.state.quota = Ledger()
        self.api = TestClient(main.app)
        self.calls = []

        async def run(command, timeout):
            self.calls.append(command)
            if command[0] == 'ffprobe':
                return b'10.0\n'
            model = command[command.index('-n') + 1]
            root = Path(command[command.index('-o') + 1]) / model / 'input'
            root.mkdir(parents=True)
            count = 2 if '--two-stems' in command else (6 if model == 'htdemucs_6s' else 4)
            for name in main.STEMS[count]:
                (root / (name + '.wav')).write_bytes(wav_bytes())
            return b''
        self.child = patch.object(main, 'run_child', side_effect=run)
        self.child.start()

    def tearDown(self):
        self.child.stop()
        self.api.close()

    def request(self, stems=2, key=KEY, name='song.mp3', content=b'audio'):
        return self.api.post('/api/separate', headers={'X-API-Key': key},
                             files={'file': (name, content)}, data={'stems': stems})

    def test_two_four_and_six_stems_zip(self):
        for count in (2, 4, 6):
            response = self.request(count)
            self.assertEqual(response.status_code, 200, response.text[:200])
            self.assertEqual(int(response.headers['x-archive-bytes']), len(response.content))
            self.assertNotIn('content-length', response.headers)
            with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                self.assertEqual(set(archive.namelist()), {x + '.wav' for x in main.STEMS[count]})
                self.assertIsNone(archive.testzip())
                self.assertTrue(all(item.compress_type == zipfile.ZIP_DEFLATED for item in archive.infolist()))
            # Streaming cleanup completes after response is consumed.
            command = self.calls[-1]
            self.assertFalse(Path(command[command.index('-o') + 1]).exists())

    def test_auth_before_work(self):
        self.assertEqual(self.request(key='wrong').status_code, 401)
        self.assertEqual(self.calls, [])

    def test_exhausted_quota_never_launches_gpu(self):
        main.app.state.quota = Ledger(244)
        self.assertEqual(self.request().status_code, 429)
        self.assertEqual(len(self.calls), 1)  # ffprobe only

    def test_ledger_outage_fails_closed(self):
        main.app.state.quota.reserve = lambda seconds: (_ for _ in ()).throw(OSError('offline'))
        self.assertEqual(self.request().status_code, 503)
        self.assertEqual(len(self.calls), 1)

    def test_invalid_inputs(self):
        self.assertEqual(self.request(stems=3).status_code, 422)
        self.assertEqual(self.request(name='song.exe').status_code, 415)
        self.assertEqual(self.request(content=b'').status_code, 422)
        self.assertEqual(self.calls, [])

    def test_large_request_rejected_before_parse(self):
        response = self.api.post('/api/separate', content=b'x', headers={
            'X-API-Key': KEY, 'Content-Length': str(main.MAX_UPLOAD + 1),
        })
        self.assertEqual(response.status_code, 413)
        self.assertEqual(self.calls, [])

    def test_timeout_retains_reservation(self):
        async def run(command, timeout):
            if command[0] == 'ffprobe':
                return b'10'
            raise asyncio.TimeoutError()
        with patch.object(main, 'run_child', side_effect=run):
            self.assertEqual(self.request().status_code, 504)
        self.assertEqual(main.app.state.quota.used, 245)

    def test_duration_limit(self):
        with patch.object(main, 'run_child', new=AsyncMock(return_value=b'601')) as child:
            self.assertEqual(self.request().status_code, 422)
        self.assertEqual(child.call_count, 1)
        self.assertEqual(main.app.state.quota.used, 0)


class ClientTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.audio = self.root / 'song.mp3'
        self.audio.write_bytes(b'input')
        self.env = patch.dict(os.environ, {
            'SEPARATION_CLOUD_ENABLED': '1', 'SEPARATION_API_URL': 'https://service.run.app',
            'SEPARATION_API_KEY': KEY, 'SEPARATION_ID_TOKEN': 'iam-token',
        })
        self.env.start()
        client._retry_after = 0

    async def asyncTearDown(self):
        self.env.stop()
        self.temp.cleanup()

    async def invoke(self, handler):
        original = httpx.AsyncClient
        with patch.object(client.httpx, 'AsyncClient', side_effect=lambda **kw: original(
                transport=httpx.MockTransport(handler), **kw)):
            return await client.try_cloud_separation(self.audio, self.root / 'output', 2)

    async def test_rest_roundtrip(self):
        def handle(request):
            self.assertEqual(request.headers['x-api-key'], KEY)
            self.assertEqual(request.headers['authorization'], 'Bearer iam-token')
            self.assertEqual(request.url.path, '/api/separate')
            return httpx.Response(200, headers={'content-type': 'application/zip'}, content=archive_bytes())
        result = await self.invoke(handle)
        self.assertEqual({p.name for p in result.iterdir()}, {'vocals.wav', 'no_vocals.wav'})

    async def test_idle_timer_waits_for_complete_zip_download(self):
        now, calls = [0], []
        controller = IdleController(calls.append, clock=lambda: now[0])
        good = archive_bytes()
        case = self
        class Download(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield good[:20]
                now[0] = 1000
                await controller.check_idle()
                case.assertEqual(controller.active, 1)
                case.assertEqual(calls, [True])
                yield good[20:]
        with patch.object(client, 'get_idle_controller', return_value=controller):
            result = await self.invoke(lambda request: httpx.Response(
                200, headers={'content-type': 'application/zip'}, stream=Download()))
        self.assertIsNotNone(result)
        self.assertEqual(controller.active, 0)
        now[0] = 1119
        await controller.check_idle()
        self.assertEqual(calls, [True])
        now[0] = 1120
        await controller.check_idle()
        self.assertEqual(calls, [True, False])

    async def test_quota_failure_releases_idle_lease_and_does_not_wake_on_cooldown(self):
        calls = []
        controller = IdleController(calls.append)
        with patch.object(client, 'get_idle_controller', return_value=controller):
            self.assertIsNone(await self.invoke(lambda request: httpx.Response(429)))
            self.assertEqual(controller.active, 0)
            self.assertIsNone(await self.invoke(lambda request: self.fail('cooldown must not send')))
        self.assertEqual(calls, [True])

    async def test_429_fallback_and_cooldown(self):
        handler = unittest.mock.Mock(return_value=httpx.Response(429))
        self.assertIsNone(await self.invoke(handler))
        self.assertIsNone(await self.invoke(handler))
        self.assertEqual(handler.call_count, 1)

    async def test_large_wav_is_losslessly_compressed_before_upload(self):
        self.audio = self.root / 'song.wav'
        with wave.open(str(self.audio), 'wb') as source:
            source.setnchannels(2)
            source.setsampwidth(2)
            source.setframerate(44100)
            for _ in range(180):
                source.writeframes(b'\x00' * (44100 * 4))
        self.assertGreater(self.audio.stat().st_size, 29 * 1024 * 1024)
        def handle(request):
            self.assertIn(b'filename="song.flac"', request.content)
            self.assertIn(b'fLaC', request.content)
            self.assertLess(len(request.content), 29 * 1024 * 1024)
            return httpx.Response(200, headers={'content-type': 'application/zip'}, content=archive_bytes())
        result = await self.invoke(handle)
        self.assertEqual(result.name, 'song')

    async def test_network_failure_falls_back(self):
        calls = []
        def handle(request):
            calls.append(request)
            raise httpx.ConnectError('offline')
        self.assertIsNone(await self.invoke(handle))
        self.assertEqual(len(calls), 2)

    async def test_interrupted_large_download_retries_before_local_fallback(self):
        class Interrupted(httpx.AsyncByteStream):
            async def __aiter__(self):
                # Model an HTTP 200 whose ZIP body is severed mid-download.
                yield b'PK' + b'x' * (33 * 1024 * 1024)
                raise httpx.RemoteProtocolError('incomplete chunked read')
        calls = []
        good = archive_bytes()
        def handle(request):
            calls.append(request)
            if len(calls) == 1:
                return httpx.Response(200, headers={'content-type': 'application/zip'}, stream=Interrupted())
            self.assertIn(b'input', request.content)  # Retry reopened the upload.
            return httpx.Response(200, headers={'content-type': 'application/zip',
                                               'x-archive-bytes': str(len(good))}, content=good)
        result = await self.invoke(handle)
        self.assertIsNotNone(result)
        self.assertEqual(len(calls), 2)
        self.assertEqual(client._retry_after, 0)
        self.assertFalse(any(result.parent.glob('.extract-*')))

    async def test_silently_truncated_archive_retries(self):
        good = archive_bytes()
        calls = []
        def handle(request):
            calls.append(request)
            return httpx.Response(200, headers={'content-type': 'application/zip',
                                               'x-archive-bytes': str(len(good))},
                                  content=good[:-20] if len(calls) == 1 else good)
        self.assertIsNotNone(await self.invoke(handle))
        self.assertEqual(len(calls), 2)

    async def test_auth_and_server_errors_do_not_retry_gpu_work(self):
        for status in (401, 403, 422, 503, 504):
            client._retry_after = 0
            handler = unittest.mock.Mock(return_value=httpx.Response(status))
            self.assertIsNone(await self.invoke(handler))
            self.assertEqual(handler.call_count, 1)

    async def test_status_exposes_cloud_inference_and_download(self):
        messages = []
        original = httpx.AsyncClient
        with patch.object(client.httpx, 'AsyncClient', side_effect=lambda **kw: original(
                transport=httpx.MockTransport(lambda request: httpx.Response(
                    200, headers={'content-type': 'application/zip'}, content=archive_bytes())), **kw)):
            result = await client.try_cloud_separation(self.audio, self.root / 'output', 2,
                                                       on_status=messages.append)
        self.assertIsNotNone(result)
        self.assertTrue(any('GPU' in message for message in messages))
        self.assertTrue(any('下載' in message for message in messages))

    async def test_malformed_zip_falls_back_without_outputs(self):
        self.assertIsNone(await self.invoke(lambda request: httpx.Response(
            200, headers={'content-type': 'application/zip'}, content=b'broken')))
        self.assertFalse((self.root / 'output' / 'cloud' / 'song').exists())

    async def test_disabled_never_calls_network(self):
        with patch.dict(os.environ, {'SEPARATION_CLOUD_ENABLED': '0'}):
            self.assertIsNone(await self.invoke(lambda request: self.fail('network called')))

    async def test_http_url_never_sends_credentials(self):
        with patch.dict(os.environ, {'SEPARATION_API_URL': 'http://insecure'}):
            self.assertIsNone(await self.invoke(lambda request: self.fail('network called')))

    async def test_traversal_archive_does_not_publish(self):
        with self.assertRaises(ValueError):
            client.extract_stems(archive_bytes(extra='../escape.wav'), self.root / 'out', 'song', 2)
        self.assertFalse((self.root / 'out').exists())

    async def test_missing_stem_does_not_publish(self):
        with self.assertRaises(ValueError):
            client.extract_stems(archive_bytes(2), self.root / 'out', 'song', 4)
        self.assertFalse((self.root / 'out').exists())


class QuotaAdapterTests(unittest.TestCase):
    def test_restart_concurrent_reservations_and_month_reset(self):
        # Use a transaction emulator shared by newly constructed adapters.
        lock = threading.RLock()
        documents = {}
        class Ref:
            def __init__(self, key): self.key = key
            def get(self, transaction): return SimpleNamespace(to_dict=lambda: documents.get(self.key, {}).copy())
        class Transaction:
            def set(self, ref, values, merge=True): documents.setdefault(ref.key, {}).update(values)
            def update(self, ref, values): documents[ref.key].update(values)
        def transactional(fn):
            def call(transaction):
                with lock: return fn(transaction)
            return call
        fake = SimpleNamespace(transactional=transactional)
        db = SimpleNamespace(
            collection=lambda collection: SimpleNamespace(document=lambda month: Ref((collection, month))),
            transaction=Transaction,
        )
        def new_ledger():
            ledger = object.__new__(FirestoreQuota)
            ledger.db, ledger.collection, ledger.limit = db, 'quota', 245
            return ledger
        with patch.dict(sys.modules, {'google': SimpleNamespace(), 'google.cloud': SimpleNamespace(firestore=fake)}):
            with patch('cloud_service.quota.billing_month', return_value='2026-11'):
                ledger = new_ledger()
                results = []
                def reserve():
                    try:
                        new_ledger().reserve(245)
                        results.append('success')
                    except QuotaExceeded:
                        results.append('rejected')
                threads = [threading.Thread(target=reserve) for _ in range(2)]
                for thread in threads: thread.start()
                for thread in threads: thread.join()
                self.assertCountEqual(results, ['success', 'rejected'])
                with self.assertRaises(QuotaExceeded): ledger.reserve(1)
            with patch('cloud_service.quota.billing_month', return_value='2026-12'):
                new_ledger().reserve(245)
            self.assertEqual(len(documents), 2)


class BackendIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def run_job(self, cloud):
        # Load the actual background function without starting the whole app,
        # importing TensorFlow, or touching its live database.
        import ast
        import shutil
        from media_progress import map_demucs_progress
        source = Path(__file__).resolve().parents[2] / 'backend-api' / 'main.py'
        node = next(n for n in ast.parse(source.read_text()).body
                    if isinstance(n, ast.AsyncFunctionDef) and n.name == 'separate_audio_local')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            states = []
            commands = []
            async def remote(audio, output, count, on_status=None):
                if not cloud: return None
                return client.extract_stems(archive_bytes(count), output, Path(audio).stem, count)
            async def local(*command, **kwargs):
                commands.append(command)
                count = 2 if '--two-stems' in command else (6 if 'htdemucs_6s' in command else 4)
                model = command[command.index('-n') + 1]
                output = Path(command[command.index('-o') + 1]) / model / 'song'
                output.mkdir(parents=True)
                for name in client.STEM_NAMES[count]:
                    (output / (name + '.wav')).write_bytes(wav_bytes())
                return SimpleNamespace(
                    stdout=SimpleNamespace(read=AsyncMock(return_value=b'')),
                    stderr=SimpleNamespace(read=AsyncMock(return_value=b'')),
                    wait=AsyncMock(return_value=0), returncode=0,
                )
            scope = dict(Path=Path, SEPARATED_DIR=root, asyncio=asyncio, shutil=shutil,
                         try_cloud_separation=remote, update_job_status=lambda job, status: states.append(status),
                         get_demucs_device=lambda: 'cpu', demucs_python=lambda: sys.executable,
                         map_demucs_progress=map_demucs_progress)
            exec(compile(ast.Module(body=[node], type_ignores=[]), str(source), 'exec'), scope)
            with patch.object(asyncio, 'create_subprocess_exec', side_effect=local):
                for count in (2, 4, 6):
                    job = 'job' + str(count)
                    await scope['separate_audio_local'](job, str(root / 'song.mp3'), str(count))
                    final = states[-1]
                    self.assertEqual(final['status'], 'completed', final)
                    self.assertEqual(set(final['tracks']), client.STEM_NAMES[count])
                    for name, url in final['tracks'].items():
                        self.assertEqual(url, f'/files/separated/{job}/{name}.wav')
                        self.assertTrue((root / job / (name + '.wav')).is_file())
            self.assertEqual(len(commands), 0 if cloud else 3)

    async def test_cloud_publishes_original_track_urls(self):
        await self.run_job(True)

    async def test_fallback_runs_local_and_publishes_track_urls(self):
        await self.run_job(False)


class ChildDeadlineTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_child_is_killed_on_deadline(self):
        with self.assertRaises(asyncio.TimeoutError):
            await main.run_child([sys.executable, '-c', 'import time; time.sleep(10)'], 0.05)


if __name__ == '__main__':
    unittest.main()
