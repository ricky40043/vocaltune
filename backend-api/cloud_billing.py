"""Private cost status: delayed Google budget reports and labelled usage estimates."""
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import logging
import math
import os
from pathlib import Path
import threading
import time
from zoneinfo import ZoneInfo

import httpx
from cloud_scaling import access_token

LOG = logging.getLogger(__name__)
ROOT = Path(__file__).resolve().parent / 'db_data'
SKU_IDS = {'gpu': '453B-678A-63C7', 'cpu': '4D3C-D63E-1DF1',
           'memory': '7550-6D11-4653', 'network': '9EA6-AE6D-E34E'}


def billing_period(now):
    local = now.astimezone(ZoneInfo('America/Los_Angeles'))
    start = local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    return local.strftime('%Y-%m'), start.astimezone(timezone.utc)


def instant(value):
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('Timestamp needs a timezone')
    return result


def accept_report(message, settings, reports):
    attributes = message.get('attributes', {})
    kind = {settings['gross_budget_id']: 'gross', settings['net_budget_id']: 'net'}.get(attributes.get('budgetId'))
    if attributes.get('billingAccountId') != settings['billing_account'] or kind is None:
        return False
    payload = json.loads(base64.b64decode(message['data'], validate=True))
    amount = float(payload['costAmount'])
    if payload['currencyCode'] != 'TWD' or not math.isfinite(amount):
        raise ValueError('Invalid report currency or amount')
    period = instant(payload['costIntervalStart']).strftime('%Y-%m')
    published = instant(message['publishTime'])
    key = period + ':' + kind
    previous = reports.get(key)
    if previous and instant(previous['reported_at']) >= published:
        return False
    reports[key] = {'amount_twd': amount, 'reported_at': published.isoformat()}
    return True


class BillingStatus:
    def __init__(self, settings_path=None, state_path=None):
        self.settings_path = Path(settings_path or os.getenv('SEPARATION_BILLING_CONFIG_FILE', ROOT / 'cloud_billing_config.json'))
        self.state_path = Path(state_path or ROOT / 'cloud_billing_status.json')
        self.lock = threading.Lock()
        self.cached, self.cached_at = None, 0

    def save(self, state):
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.state_path.with_suffix('.tmp')
        temporary.write_text(json.dumps(state, allow_nan=False))
        temporary.chmod(0o600)
        temporary.replace(self.state_path)

    def reports(self, client, headers, settings, state):
        url = 'https://pubsub.googleapis.com/v1/' + settings['subscription']
        response = client.post(url + ':pull', headers=headers,
                               json={'maxMessages': 100, 'returnImmediately': True})
        response.raise_for_status()
        acknowledgements = []
        for received in response.json().get('receivedMessages', []):
            try:
                accept_report(received['message'], settings, state.setdefault('reports', {}))
            except (ValueError, KeyError, TypeError):
                LOG.warning('Invalid budget report discarded')
            acknowledgements.append(received['ackId'])
        # Persist before ack: a restart must not turn a known bill into unknown/zero.
        self.save(state)
        if acknowledgements:
            response = client.post(url + ':acknowledge', headers=headers,
                                   json={'ackIds': acknowledgements})
            response.raise_for_status()

    def prices(self, client, headers, state, now):
        old = state.get('prices')
        if old and (now - instant(old['fetched_at'])).total_seconds() < 86400:
            return old['rates']
        params = {'currencyCode': 'TWD', 'pageSize': 5000}
        rates = {}
        while True:
            response = client.get('https://cloudbilling.googleapis.com/v1/services/152E-C115-5142/skus',
                                  headers=headers, params=params)
            response.raise_for_status()
            data = response.json()
            for sku in data.get('skus', []):
                for key, identifier in SKU_IDS.items():
                    if sku['skuId'] == identifier:
                        price = sku['pricingInfo'][-1]['pricingExpression']['tieredRates'][0]['unitPrice']
                        if price['currencyCode'] != 'TWD':
                            raise ValueError('Unexpected price currency')
                        rates[key] = float(price.get('units', 0)) + float(price.get('nanos', 0)) / 1e9
            if len(rates) == 4:
                break
            if not data.get('nextPageToken'):
                raise ValueError('Cloud Run prices incomplete')
            params['pageToken'] = data['nextPageToken']
        state['prices'] = {'rates': rates, 'fetched_at': now.isoformat()}
        return rates

    def estimate(self, client, headers, settings, state, now, start):
        if settings['region'] != 'asia-southeast1':
            raise ValueError('Pricing supports Singapore L4 only')
        def metric_total(metric):
            params = {
                'filter': f'metric.type="run.googleapis.com/container/{metric}" AND resource.labels.service_name="{settings["service"]}"',
                'interval.startTime': start.isoformat(), 'interval.endTime': now.isoformat(),
                'aggregation.alignmentPeriod': '86400s', 'aggregation.perSeriesAligner': 'ALIGN_SUM',
                'aggregation.crossSeriesReducer': 'REDUCE_SUM', 'pageSize': 1000,
            }
            total, found, latest = 0, False, None
            while True:
                response = client.get(f'https://monitoring.googleapis.com/v3/projects/{settings["project"]}/timeSeries',
                                      headers=headers, params=params)
                response.raise_for_status()
                data = response.json()
                for series in data.get('timeSeries', []):
                    for point in series.get('points', []):
                        found = True
                        value = point['value']
                        total += float(value.get('doubleValue', value.get('int64Value', 0)))
                        timestamp = point['interval']['endTime']
                        latest = max(latest, instant(timestamp)) if latest else instant(timestamp)
                if not data.get('nextPageToken'):
                    break
                params['pageToken'] = data['nextPageToken']
            return total, found, latest
        with ThreadPoolExecutor(max_workers=3) as executor:
            pending = [executor.submit(metric_total, metric) for metric in
                       ('billable_instance_time', 'cpu/allocation_time', 'network/sent_bytes_count')]
            rates = self.prices(client, headers, state, now)
            billable, cpu, network = [future.result() for future in pending]
        # Empty monitoring data can mean reporting delay/permissions, never $0.
        if not all(result[1] for result in (billable, cpu, network)):
            return None
        parts = {'gpu': billable[0] * rates['gpu'], 'cpu': cpu[0] * rates['cpu'],
                 'memory': billable[0] * 16 * rates['memory'],
                 'network': network[0] / 1024**3 * rates['network']}
        return {'amount_twd': round(sum(parts.values()), 2), 'parts_twd': parts,
                'as_of': now.isoformat(), 'stale': False, 'billable_seconds': billable[0],
                'scope': 'Cloud Run only; before credits; excludes image storage and other services'}

    def snapshot(self):
        with self.lock:
            if self.cached is not None and time.monotonic() - self.cached_at < 60:
                return self.cached
            now = datetime.now(timezone.utc)
            period, start = billing_period(now)
            if not self.settings_path.is_file():
                return {'configured': False, 'period': period}
            settings = json.loads(self.settings_path.read_text())
            try:
                state = json.loads(self.state_path.read_text())
            except (FileNotFoundError, ValueError):
                state = {}
            issues = []
            estimate = state.get('estimate') if state.get('estimate_period') == period else None
            if estimate:
                estimate = dict(estimate, stale=True)
            try:
                headers = {'Authorization': 'Bearer ' + access_token(),
                           'x-goog-user-project': settings['project']}
                with httpx.Client(timeout=15, follow_redirects=False) as client:
                    try:
                        self.reports(client, headers, settings, state)
                    except Exception as exc:
                        issues.append('reports_unavailable')
                        LOG.warning('Budget report read failed (%s)', type(exc).__name__)
                    try:
                        updated = self.estimate(client, headers, settings, state, now, start)
                        if updated:
                            estimate = updated
                            state.update(estimate=estimate, estimate_period=period)
                        else:
                            issues.append('estimate_unavailable')
                    except Exception as exc:
                        issues.append('estimate_unavailable')
                        LOG.warning('Cost estimate failed (%s)', type(exc).__name__)
            except Exception as exc:
                issues.append('credentials_unavailable')
                LOG.warning('Cost data authentication failed (%s)', type(exc).__name__)
            self.save(state)
            reports = state.get('reports', {})
            def report(kind):
                value = reports.get(period + ':' + kind)
                if not value:
                    return None
                return dict(value, stale=(now - instant(value['reported_at'])).total_seconds() > 86400)
            gross, net = report('gross'), report('net')
            budget = float(settings['budget_twd'])
            result = {
                'configured': True, 'period': period, 'budget_twd': budget,
                'reported_gross': gross, 'reported_net': net,
                'reported_remaining_twd': round(budget - gross['amount_twd'], 2) if gross else None,
                'cloud_run_estimate': estimate, 'issues': issues,
                'credits': {'verified': False, 'remaining_twd': None,
                            'reference_usd': settings.get('monthly_credit_reference_usd', 10)},
                'links': {'reports': f'https://console.cloud.google.com/billing/{settings["billing_account"]}/reports?project={settings["project"]}',
                          'credits': f'https://console.cloud.google.com/billing/{settings["billing_account"]}/credits'},
                'checked_at': now.isoformat(),
            }
            self.cached, self.cached_at = result, time.monotonic()
            return result
