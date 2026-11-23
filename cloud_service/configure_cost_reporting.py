"""Connect project cost notifications and grant a read-only cost panel its inputs."""
import argparse
import json
from pathlib import Path
import subprocess
import urllib.error
import urllib.request
import urllib.parse


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--project', required=True)
    p.add_argument('--billing-account', required=True)
    p.add_argument('--gross-budget', required=True, help='Existing whole-project budget resource name')
    p.add_argument('--caller', required=True, help='Service account email')
    p.add_argument('--output', required=True)
    p.add_argument('--execute', action='store_true')
    args = p.parse_args()
    topic = f'projects/{args.project}/topics/vocaltune-cost-status'
    subscription = f'projects/{args.project}/subscriptions/vocaltune-cost-status'
    if not args.execute:
        print(json.dumps({'project': args.project, 'gross_budget': args.gross_budget,
                          'topic': topic, 'subscription': subscription, 'caller': args.caller}))
        return

    def gcloud(*parts):
        return subprocess.check_output(['gcloud', *parts, '--quiet'], text=True).strip()

    gcloud('services', 'enable', 'pubsub.googleapis.com', 'monitoring.googleapis.com',
           'cloudbilling.googleapis.com', '--project=' + args.project)
    token = gcloud('auth', 'print-access-token')

    def request(url, body=None, method=None, missing_ok=False):
        req = urllib.request.Request(url, method=method, headers={
            'Authorization': 'Bearer ' + token, 'x-goog-user-project': args.project,
            'Content-Type': 'application/json',
        }, data=json.dumps(body).encode() if body is not None else None)
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            if missing_ok and exc.code == 404:
                return None
            raise RuntimeError(f'Cost reporting setup HTTP {exc.code}') from None

    number = gcloud('projects', 'describe', args.project, '--format=value(projectNumber)')
    topic_url = 'https://pubsub.googleapis.com/v1/' + topic
    if request(topic_url, missing_ok=True) is None:
        request(topic_url, {}, 'PUT')
    gcloud('pubsub', 'topics', 'add-iam-policy-binding', topic,
           '--member=serviceAccount:billing-budget-alert@system.gserviceaccount.com',
           '--role=roles/pubsub.publisher', '--project=' + args.project)
    sub_url = 'https://pubsub.googleapis.com/v1/' + subscription
    sub = request(sub_url, missing_ok=True)
    if sub is None:
        request(sub_url, {'topic': topic, 'ackDeadlineSeconds': 30,
                         'messageRetentionDuration': '604800s', 'expirationPolicy': {}}, 'PUT')
    elif sub.get('topic') != topic:
        raise RuntimeError('Existing subscription points to another topic')
    member = '--member=serviceAccount:' + args.caller
    gcloud('pubsub', 'subscriptions', 'add-iam-policy-binding', subscription, member,
           '--role=roles/pubsub.subscriber', '--project=' + args.project)
    for role in ('roles/monitoring.viewer', 'roles/serviceusage.serviceUsageConsumer'):
        gcloud('projects', 'add-iam-policy-binding', args.project, member,
               '--role=' + role, '--condition=None')

    base = 'https://billingbudgets.googleapis.com/v1/'
    if not args.gross_budget.startswith('billingAccounts/' + args.billing_account + '/budgets/'):
        raise RuntimeError('Gross budget does not belong to the selected billing account')
    gross = request(base + args.gross_budget)
    filters = gross.get('budgetFilter', {})
    if (filters.get('projects') != ['projects/' + number] or filters.get('services')
            or filters.get('creditTypesTreatment') != 'EXCLUDE_ALL_CREDITS' or gross.get('spendCap')):
        raise RuntimeError('Gross budget must be an alerts-only whole-project budget before credits')
    notifications = dict(gross.get('notificationsRule', {}), pubsubTopic=topic, schemaVersion='1.0')
    request(base + args.gross_budget + '?updateMask=notificationsRule', {
        'name': gross['name'], 'etag': gross['etag'], 'notificationsRule': notifications,
    }, 'PATCH')

    net_name = 'VocalTune project cost after credits (reporting only)'
    budgets_url = base + 'billingAccounts/' + args.billing_account + '/budgets'
    matches, page = [], budgets_url
    while page:
        listing = request(page)
        matches.extend(b for b in listing.get('budgets', []) if b.get('displayName') == net_name)
        page = budgets_url + '?' + urllib.parse.urlencode({'pageToken': listing['nextPageToken']}) if listing.get('nextPageToken') else None
    if len(matches) > 1:
        raise RuntimeError('Multiple reporting budgets found')
    desired_filter = dict(filters, creditTypesTreatment='INCLUDE_ALL_CREDITS')
    if matches:
        net = matches[0]
        if net.get('budgetFilter') != desired_filter or net.get('spendCap'):
            raise RuntimeError('Existing reporting budget has a different scope')
        if net.get('notificationsRule', {}).get('pubsubTopic') != topic:
            raise RuntimeError('Existing reporting budget has another notification topic')
    else:
        net = request(budgets_url, {
            'displayName': net_name, 'budgetFilter': desired_filter, 'amount': gross['amount'],
            'notificationsRule': {'pubsubTopic': topic, 'schemaVersion': '1.0',
                                  'disableDefaultIamRecipients': True},
        })
    amount = gross['amount']['specifiedAmount']
    if amount['currencyCode'] != 'TWD':
        raise RuntimeError('The cost panel requires a TWD budget')
    budget_twd = int(amount.get('units', 0)) + int(amount.get('nanos', 0)) / 1e9
    settings = {
        'project': args.project, 'region': 'asia-southeast1', 'service': 'vocaltune-separation',
        'billing_account': args.billing_account, 'subscription': subscription,
        'gross_budget_id': gross['name'].rsplit('/', 1)[-1],
        'net_budget_id': net['name'].rsplit('/', 1)[-1], 'budget_twd': budget_twd,
        'monthly_credit_reference_usd': 10,
    }
    out = Path(args.output)
    out.write_text(json.dumps(settings, indent=2) + '\n')
    out.chmod(0o600)
    print(json.dumps({'configured': True, 'settings_file': str(out),
                      'first_notification': 'May take several hours; missing data is not zero cost'}))


if __name__ == '__main__':
    main()
