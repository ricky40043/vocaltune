import asyncio
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend-api'))
import cloud_scaling
from cloud_scaling import IdleController, CloudRunScaling
from cloud_service import configure_budget


class IdleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.now = 0
        self.calls = []
        self.controller = IdleController(self.calls.append, clock=lambda: self.now)

    async def test_two_minutes_then_pause_without_repeated_updates(self):
        self.now = 119
        await self.controller.check_idle()
        self.assertEqual(self.calls, [])
        self.now = 120
        await self.controller.check_idle()
        await self.controller.check_idle()
        self.assertEqual(self.calls, [False])

    async def test_all_concurrent_downloads_must_finish_before_timer_starts(self):
        await self.controller.acquire()
        await self.controller.acquire()
        self.assertEqual(self.calls, [True])
        self.now = 1000
        await self.controller.release()
        await self.controller.check_idle()
        self.assertEqual(self.calls, [True])
        await self.controller.release()
        self.now = 1119
        await self.controller.check_idle()
        self.assertEqual(self.calls, [True])
        self.now = 1120
        await self.controller.check_idle()
        self.assertEqual(self.calls, [True, False])

    async def test_new_song_wakes_after_pause(self):
        self.now = 120
        await self.controller.check_idle()
        await self.controller.acquire()
        self.assertEqual(self.calls, [False, True])
        self.assertEqual(self.controller.active, 1)

    async def test_request_arriving_during_pause_waits_then_wakes(self):
        started, finish = threading.Event(), threading.Event()
        def control(awake):
            self.calls.append(awake)
            if not awake:
                started.set()
                if not finish.wait(2):
                    raise TimeoutError('test pause timed out')
        self.controller.control = control
        self.now = 120
        pause = asyncio.create_task(self.controller.check_idle())
        self.assertTrue(await asyncio.to_thread(started.wait, 2))
        incoming = asyncio.create_task(self.controller.acquire())
        await asyncio.sleep(0)
        self.assertFalse(incoming.done())
        finish.set()
        await asyncio.gather(pause, incoming)
        self.assertEqual(self.calls, [False, True])
        self.assertEqual(self.controller.active, 1)

    async def test_failed_pause_can_be_retried(self):
        self.now = 120
        self.controller.control = lambda awake: (_ for _ in ()).throw(OSError('offline'))
        with self.assertRaises(OSError):
            await self.controller.check_idle()
        self.assertIsNone(self.controller.paused)
        self.controller.control = self.calls.append
        await self.controller.check_idle()
        self.assertEqual(self.calls, [False])

    async def test_failed_wake_does_not_leave_an_active_lease(self):
        self.controller.control = lambda awake: (_ for _ in ()).throw(OSError('offline'))
        with self.assertRaises(OSError):
            await self.controller.acquire()
        self.assertEqual(self.controller.active, 0)

    async def test_close_pauses_idle_service(self):
        self.controller.start()
        await self.controller.close()
        self.assertEqual(self.calls, [False])

    async def test_disabled_controller_never_starts(self):
        with patch.dict(os.environ, {'SEPARATION_CLOUD_ENABLED': '1',
                                     'SEPARATION_IDLE_SHUTDOWN_SECONDS': '0'}):
            self.assertIsNone(cloud_scaling.get_idle_controller())


class ScalingAPITests(unittest.TestCase):
    def invoke(self, awake, initial):
        state = {'name': 'projects/test/locations/asia-southeast1/services/separation',
                 'etag': 'version-one', 'scaling': initial, 'reconciling': False}
        calls = []
        def handler(request):
            self.assertEqual(request.headers['authorization'], 'Bearer test-token')
            if request.method == 'PATCH':
                body = json.loads(request.content)
                self.assertEqual(set(body), {'name', 'etag', 'scaling'})
                self.assertEqual(body['etag'], 'version-one')
                self.assertEqual(request.url.params['updateMask'],
                                 'scaling.scalingMode,scaling.manualInstanceCount')
                calls.append(body['scaling'])
                state['scaling'] = body['scaling']
                return httpx.Response(200, json={'name': 'operation'})
            return httpx.Response(200, json=state)
        original = httpx.Client
        with patch.object(cloud_scaling, 'access_token', return_value='test-token'), \
             patch.object(cloud_scaling.httpx, 'Client', side_effect=lambda **kw: original(
                 transport=httpx.MockTransport(handler), **kw)):
            CloudRunScaling('test', 'asia-southeast1', 'separation')(awake)
        return calls

    def test_pause_only_changes_scaling_and_uses_etag(self):
        self.assertEqual(self.invoke(False, {'scalingMode': 'AUTOMATIC'}),
                         [{'scalingMode': 'MANUAL', 'manualInstanceCount': 0}])

    def test_wake_restores_automatic_without_pinning_a_gpu(self):
        self.assertEqual(self.invoke(True, {'scalingMode': 'MANUAL', 'manualInstanceCount': 0}),
                         [{'scalingMode': 'AUTOMATIC', 'manualInstanceCount': None}])

    def test_already_enabled_does_not_write(self):
        self.assertEqual(self.invoke(True, {}), [])


class BudgetTests(unittest.TestCase):
    def invoke(self, update=False, currency='TWD', etag='budget-version'):
        budget = {
            'name': 'billingAccounts/account/budgets/budget', 'etag': etag,
            'budgetFilter': {'projects': ['projects/123'], 'services': ['services/152E-C115-5142']},
            'amount': {'specifiedAmount': {'currencyCode': currency, 'units': '100'}},
            'spendCap': {'outputState': 'CONFIGURED'},
        }
        writes = []
        def open_url(request, timeout):
            if request.get_method() == 'PATCH':
                body = json.loads(request.data)
                self.assertEqual(body['etag'], 'budget-version')
                self.assertEqual(body['spendCap'], {'inputState': 'CONFIGURED'})
                self.assertIn('updateMask=amount,spendCap', request.full_url)
                self.assertNotIn('budgetFilter', body)
                writes.append(body)
                budget['amount'] = body['amount']
                value = budget
            elif request.full_url.endswith('/budgets'):
                value = {'budgets': [copy.deepcopy(budget)]}
            else:
                value = budget
            return io.BytesIO(json.dumps(value).encode())
        argv = ['budget', '--project=test', '--billing-account=account', '--currency=TWD',
                '--amount=300', '--execute'] + (['--update-existing'] if update else [])
        with patch.object(sys, 'argv', argv), \
             patch.object(configure_budget.subprocess, 'check_output', side_effect=['123', 'token']), \
             patch.object(configure_budget.urllib.request, 'urlopen', side_effect=open_url), \
             contextlib.redirect_stdout(io.StringIO()):
            configure_budget.main()
        return writes

    def test_explicit_update_preserves_configured_cap_and_verifies_amount(self):
        writes = self.invoke(update=True)
        self.assertEqual(writes[0]['amount']['specifiedAmount'], {'currencyCode': 'TWD', 'units': '300'})

    def test_implicit_budget_overwrite_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, 'update-existing'):
            self.invoke()

    def test_currency_change_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, 'currency'):
            self.invoke(update=True, currency='USD')

    def test_budget_update_requires_etag(self):
        with self.assertRaisesRegex(RuntimeError, 'etag'):
            self.invoke(update=True, etag='')
