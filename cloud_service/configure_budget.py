"""Configure a project-scoped Cloud Run spend cap; default is preview only."""
import argparse
import json
import subprocess
import urllib.error
import urllib.parse
import urllib.request

CLOUD_RUN_SERVICE = "services/152E-C115-5142"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--billing-account", required=True)
    parser.add_argument("--currency", required=True)
    parser.add_argument("--amount", type=int, required=True)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    if args.amount <= 0:
        parser.error("amount must be positive")
    project_number = subprocess.check_output(
        ["gcloud", "projects", "describe", args.project,
         "--format=value(projectNumber)"], text=True,
    ).strip()
    scope = {"projects": ["projects/" + project_number],
             "services": [CLOUD_RUN_SERVICE], "calendarPeriod": "MONTH",
             "creditTypesTreatment": "EXCLUDE_ALL_CREDITS"}
    desired = {
        "displayName": "VocalTune Cloud Run spend cap",
        "budgetFilter": scope,
        "amount": {"specifiedAmount": {"currencyCode": args.currency,
                                       "units": str(args.amount)}},
        "thresholdRules": [{"thresholdPercent": value, "spendBasis": "CURRENT_SPEND"}
                           for value in (0.5, 0.8, 1.0)],
        "notificationsRule": {"enableProjectLevelRecipients": True,
                              "disableDefaultIamRecipients": False},
        "spendCap": {"inputState": "CONFIGURED"},
    }
    if not args.execute:
        print(json.dumps(desired, indent=2))
        return
    token = subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True).strip()

    def request(url, body=None):
        headers = {"Authorization": "Bearer " + token,
                   "x-goog-user-project": args.project}
        if body is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, headers=headers,
                                     data=json.dumps(body).encode() if body is not None else None)
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            details = json.loads(error.read()).get("error", {})
            raise RuntimeError("Budget API: " + details.get("message", str(error.code))) from None

    base = "https://billingbudgets.googleapis.com/v1/billingAccounts/" + args.billing_account + "/budgets"
    matches = []
    page = base
    while page:
        listing = request(page)
        for budget in listing.get("budgets", []):
            filters = budget.get("budgetFilter", {})
            if (filters.get("projects") == scope["projects"]
                    and filters.get("services") == scope["services"]
                    and budget.get("spendCap")):
                matches.append(budget)
        next_page = listing.get("nextPageToken")
        page = base + "?" + urllib.parse.urlencode({"pageToken": next_page}) if next_page else None
    if len(matches) > 1:
        raise RuntimeError("Multiple matching spend caps; refusing to modify them")
    existing = matches[0] if matches else None
    if existing:
        amount = existing.get("amount", {}).get("specifiedAmount", {})
        if amount.get("currencyCode") != args.currency or int(amount.get("units", 0)) != args.amount:
            raise RuntimeError("Existing spend cap differs; refusing to overwrite it")
        result = request("https://billingbudgets.googleapis.com/v1/" + existing["name"])
    else:
        created = request(base, desired)
        result = request("https://billingbudgets.googleapis.com/v1/" + created["name"])
    actual = result.get("spendCap", {})
    if actual.get("outputState") not in ("CONFIGURED", "ENFORCED"):
        raise RuntimeError("Spend cap is not configured: " + json.dumps(actual))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
