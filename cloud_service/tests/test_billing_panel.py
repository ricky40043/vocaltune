import base64
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend-api'))
import cloud_billing
import cloud_billing_api
import media_policy

SETTINGS = {'gross_budget_id': 'gross', 'net_budget_id': 'net', 'billing_account': 'account',
            'project': 'project', 'subscription': 'projects/project/subscriptions/cost',
            'region': 'asia-southeast1', 'service': 'separation', 'budget_twd': 300}


def message(amount=42, budget='gross', published='2026-11-23T09:00:00Z'):
    return {'attributes': {'budgetId': budget, 'billingAccountId': 'account'},
            'data': base64.b64encode(json.dumps({'costAmount': amount, 'currencyCode': 'TWD',
                    'costIntervalStart': '2026-11-01T07:00:00Z'}).encode()).decode(),
            'publishTime': published}


class BillingReportTests(unittest.TestCase):
    def test_duplicates_and_out_of_order_cannot_reduce_newer_spend(self):
        reports = {}
        self.assertTrue(cloud_billing.accept_report(message(), SETTINGS, reports))
        self.assertFalse(cloud_billing.accept_report(message(1), SETTINGS, reports))
        self.assertFalse(cloud_billing.accept_report(message(1, published='2026-11-22T09:00:00Z'), SETTINGS, reports))
        self.assertEqual(reports['2026-11:gross']['amount_twd'], 42)

    def test_another_budget_is_ignored(self):
        reports = {}
        self.assertFalse(cloud_billing.accept_report(message(budget='another-project'), SETTINGS, reports))
        self.assertFalse(reports)

    def test_nonfinite_cost_is_rejected(self):
        with self.assertRaises(ValueError):
            cloud_billing.accept_report(message(float('nan')), SETTINGS, {})

    def test_zero_after_credits_is_a_real_report_not_missing(self):
        reports = {}
        cloud_billing.accept_report(message(0, budget='net'), SETTINGS, reports)
        self.assertEqual(reports['2026-11:net']['amount_twd'], 0)

    def test_billing_month_does_not_reset_at_taipei_midnight(self):
        period, start = cloud_billing.billing_period(datetime(2026, 12, 1, 7, tzinfo=timezone.utc))
        self.assertEqual(period, '2026-11')
        self.assertEqual(start.hour, 7)  # November starts in PDT, before DST ends.


class BillingSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / 'config.json'
        self.config.write_text(json.dumps(SETTINGS))
        self.provider = cloud_billing.BillingStatus(self.config, self.root / 'state.json')

    def snapshot(self, estimate=None):
        with patch.object(cloud_billing, 'access_token', return_value='test-token'), \
             patch.object(self.provider, 'reports'), patch.object(self.provider, 'estimate', return_value=estimate):
            return self.provider.snapshot()

    def test_missing_reports_are_unknown_not_zero_or_within_free_credit(self):
        result = self.snapshot()
        self.assertIsNone(result['reported_gross'])
        self.assertIsNone(result['reported_net'])
        self.assertIsNone(result['reported_remaining_twd'])
        self.assertFalse(result['credits']['verified'])
        self.assertIsNone(result['credits']['remaining_twd'])

    def test_old_month_report_is_not_shown_as_current_spend(self):
        self.provider.save({'reports': {'2000-01:gross': {'amount_twd': 200, 'reported_at': '2000-01-02T00:00:00Z'}}})
        self.assertIsNone(self.snapshot()['reported_gross'])

    def test_no_config_is_not_reported_as_free_usage(self):
        self.config.unlink()
        result = self.provider.snapshot()
        self.assertFalse(result['configured'])
        self.assertNotIn('reported_gross', result)

    def test_failed_refresh_keeps_old_estimate_with_original_timestamp(self):
        period, _ = cloud_billing.billing_period(datetime.now(timezone.utc))
        old = {'amount_twd': 42, 'as_of': '2026-11-23T00:00:00Z', 'stale': False}
        self.provider.save({'estimate': old, 'estimate_period': period})
        result = self.snapshot()
        self.assertTrue(result['cloud_run_estimate']['stale'])
        self.assertEqual(result['cloud_run_estimate']['as_of'], old['as_of'])

    def test_report_is_durable_before_acknowledging_message(self):
        def handler(request):
            if request.url.path.endswith(':acknowledge'):
                state = json.loads(self.provider.state_path.read_text())
                self.assertEqual(state['reports']['2026-11:gross']['amount_twd'], 42)
                return httpx.Response(503)
            return httpx.Response(200, json={'receivedMessages': [{'message': message(), 'ackId': 'ack'}]})
        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            with self.assertRaises(httpx.HTTPStatusError):
                self.provider.reports(client, {}, SETTINGS, {})

    def test_monitoring_math_uses_cpu_seconds_and_all_metric_pages(self):
        calls = []
        def handler(request):
            calls.append(request)
            cpu = 'cpu/allocation_time' in request.url.params['filter']
            second = 'pageToken' in request.url.params
            amount = 4 if cpu else 1
            return httpx.Response(200, json={'timeSeries': [{'points': [{
                'value': {'doubleValue': amount}, 'interval': {'endTime': '2026-11-23T09:00:00Z'}}]}],
                **({} if second else {'nextPageToken': 'second'})})
        now = datetime.now(timezone.utc)
        with httpx.Client(transport=httpx.MockTransport(handler)) as client, \
             patch.object(self.provider, 'prices', return_value={'gpu': 1, 'cpu': 1, 'memory': 1, 'network': 0}):
            result = self.provider.estimate(client, {}, SETTINGS, {}, now, now)
        self.assertEqual(result['amount_twd'], 2 + 8 + 32)
        self.assertEqual(len(calls), 6)


class BillingAuthorizationTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(cloud_billing_api.router)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_unauthenticated_request_cannot_read_or_trigger_financial_queries(self):
        with patch.object(cloud_billing_api.provider, 'snapshot') as query:
            self.assertEqual(self.client.get('/api/admin/cloud-billing').status_code, 401)
            query.assert_not_called()

    def test_admin_response_is_not_cacheable_and_preserves_unknown_cost(self):
        token = media_policy.authenticate(media_policy.ADMIN_MODE_PASSWORD)
        with patch.object(cloud_billing_api.provider, 'snapshot', return_value={'reported_gross': None}):
            response = self.client.get('/api/admin/cloud-billing', headers={'X-Admin-Mode-Token': token})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['cache-control'], 'no-store')
        self.assertIsNone(response.json()['reported_gross'])
