#!/usr/bin/env bash
# No cloud mutation occurs by default. A paid deployment cannot meet a strict
# zero-out-of-pocket guarantee, so --execute additionally requires relaxing it.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
mode=${1:---dry-run}
if [[ "$mode" != --dry-run && "$mode" != --execute ]]; then
  echo 'Usage: ./deploy.sh [--dry-run|--execute]' >&2
  exit 2
fi
if [[ "$mode" == --execute && ${REQUIRE_ZERO_OUT_OF_POCKET:-1} != 0 ]]; then
  echo 'Deployment refused: Cloud Run GPU cannot guarantee zero out-of-pocket spending.' >&2
  echo 'Inference quota, max-instances, and billing spend caps do not cap the total bill.' >&2
  echo 'Keep local mode enabled. Read cloud_service/README.md before changing this requirement.' >&2
  exit 1
fi
SETUP_FILE=${VOCALTUNE_CLOUD_SETUP_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/vocaltune/cloud-setup.json}
setup_value() {
  python3 - "$SETUP_FILE" "$1" "$2" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
settings = json.loads(path.read_text()) if path.is_file() else {}
print(settings.get(sys.argv[2], sys.argv[3]))
PY
}
PROJECT_ID=${PROJECT_ID:-$(setup_value project_id YOUR_PROJECT_ID)}
REGION=${REGION:-$(setup_value region us-central1)}
REGISTRY_REGION=${REGISTRY_REGION:-$(setup_value registry_region "$REGION")}
SERVICE=${SERVICE:-vocaltune-separation}
REPOSITORY=${REPOSITORY:-vocaltune}
API_KEY_SECRET=${API_KEY_SECRET:-vocaltune-separation-api-key}
MAX_MONTHLY_GPU_SECONDS=${MAX_MONTHLY_GPU_SECONDS:-$(setup_value monthly_gpu_seconds 40000)}
CALLER_MEMBER=${CALLER_MEMBER:-serviceAccount:$(setup_value caller_service_account YOUR_CALLER_SERVICE_ACCOUNT)}
API_KEY_FILE=${API_KEY_FILE:-$(setup_value api_key_file /path/to/private-api-key-file)}
BILLING_ACCOUNT_ID=${BILLING_ACCOUNT_ID:-$(setup_value billing_account '')}
CLOUD_RUN_BUDGET_CURRENCY=${CLOUD_RUN_BUDGET_CURRENCY:-$(setup_value run_budget_currency USD)}
CLOUD_RUN_BUDGET_AMOUNT=${CLOUD_RUN_BUDGET_AMOUNT:-$(setup_value run_budget_amount 5)}
IMAGE_TAG=${IMAGE_TAG:-$(date -u +%Y%m%d%H%M%S)}
IMAGE="$REGISTRY_REGION-docker.pkg.dev/$PROJECT_ID/$REPOSITORY/separation:$IMAGE_TAG"
RUNTIME_ACCOUNT="vocaltune-separation@$PROJECT_ID.iam.gserviceaccount.com"
export CLOUDSDK_BILLING_QUOTA_PROJECT="$PROJECT_ID"
if ! [[ "$MAX_MONTHLY_GPU_SECONDS" =~ ^(0|[1-9][0-9]{0,4})$ ]] || (( MAX_MONTHLY_GPU_SECONDS > 40000 )); then
  echo 'MAX_MONTHLY_GPU_SECONDS must be an integer between 0 and 40000.' >&2
  exit 2
fi
run() {
  if [[ "$mode" == --dry-run ]]; then
    printf '%q ' "$@"
    printf '\n'
  else
    "$@"
  fi
}
if [[ "$mode" == --execute ]]; then
  command -v gcloud >/dev/null
  command -v docker >/dev/null
  [[ "$PROJECT_ID" != YOUR_PROJECT_ID && "$CALLER_MEMBER" != *YOUR_CALLER* ]] || {
    echo 'Set PROJECT_ID and CALLER_MEMBER first.' >&2; exit 2;
  }
  # Do not echo secret contents or place them in Docker build args/environment.
  python3 - "$API_KEY_FILE" <<'PY'
import pathlib, sys
key = pathlib.Path(sys.argv[1]).read_bytes()
if len(key) < 32 or any(byte < 33 or byte > 126 for byte in key):
    raise SystemExit('API key must be >=32 printable ASCII characters without whitespace/newline')
PY
fi
run gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  firestore.googleapis.com secretmanager.googleapis.com iam.googleapis.com \
  billingbudgets.googleapis.com cloudresourcemanager.googleapis.com --project="$PROJECT_ID"
if [[ -n "$BILLING_ACCOUNT_ID" ]]; then
  if [[ "$mode" == --dry-run ]] || [[ "$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingAccountName)')" != "billingAccounts/$BILLING_ACCOUNT_ID" ]]; then
    run gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT_ID" --quiet
  fi
  run python3 cloud_service/configure_budget.py --project="$PROJECT_ID" \
    --billing-account="$BILLING_ACCOUNT_ID" --currency="$CLOUD_RUN_BUDGET_CURRENCY" \
    --amount="$CLOUD_RUN_BUDGET_AMOUNT" --execute
fi
# Each describe is read-only. Unexpected errors abort the subsequent create.
if [[ "$mode" == --dry-run ]] || ! gcloud artifacts repositories describe "$REPOSITORY" --location="$REGISTRY_REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  run gcloud artifacts repositories create "$REPOSITORY" --repository-format=docker --location="$REGISTRY_REGION" --project="$PROJECT_ID"
fi
if [[ "$mode" == --dry-run ]] || ! gcloud firestore databases describe --database='(default)' --project="$PROJECT_ID" >/dev/null 2>&1; then
  run gcloud firestore databases create --database='(default)' --location="$REGION" --type=firestore-native --project="$PROJECT_ID"
fi
if [[ "$mode" == --dry-run ]] || ! gcloud iam service-accounts describe "$RUNTIME_ACCOUNT" --project="$PROJECT_ID" >/dev/null 2>&1; then
  run gcloud iam service-accounts create vocaltune-separation --project="$PROJECT_ID"
fi
run gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$RUNTIME_ACCOUNT" --role=roles/datastore.user --condition=None
if [[ "$mode" == --dry-run ]] || ! gcloud secrets describe "$API_KEY_SECRET" --project="$PROJECT_ID" >/dev/null 2>&1; then
  run gcloud secrets create "$API_KEY_SECRET" --replication-policy=automatic --project="$PROJECT_ID"
fi
if [[ "$mode" == --dry-run ]]; then
  run gcloud secrets versions add "$API_KEY_SECRET" --data-file="$API_KEY_FILE" --project="$PROJECT_ID"
else
  python3 - "$API_KEY_FILE" "$API_KEY_SECRET" "$PROJECT_ID" <<'PY'
import hmac, pathlib, subprocess, sys
key_file, secret, project = sys.argv[1:]
current = subprocess.run(
    ["gcloud", "secrets", "versions", "access", "latest", "--secret=" + secret,
     "--project=" + project], capture_output=True,
)
if current.returncode == 0 and hmac.compare_digest(current.stdout, pathlib.Path(key_file).read_bytes()):
    print("Secret already matches; retaining existing version")
else:
    subprocess.run(["gcloud", "secrets", "versions", "add", secret,
                    "--data-file=" + key_file, "--project=" + project], check=True)
PY
fi
run gcloud secrets add-iam-policy-binding "$API_KEY_SECRET" --member="serviceAccount:$RUNTIME_ACCOUNT" --role=roles/secretmanager.secretAccessor --project="$PROJECT_ID"
run gcloud auth configure-docker "$REGISTRY_REGION-docker.pkg.dev" --quiet
run docker build --platform linux/amd64 -f cloud_service/Dockerfile -t "$IMAGE" cloud_service
run docker push "$IMAGE"
run gcloud run deploy "$SERVICE" --project="$PROJECT_ID" --region="$REGION" \
  --image="$IMAGE" --platform=managed --execution-environment=gen2 \
  --gpu=1 --gpu-type=nvidia-l4 --no-gpu-zonal-redundancy \
  --no-cpu-throttling --min-instances=0 --max-instances=1 --min=0 --max=1 \
  --concurrency=2 --memory=16Gi --cpu=4 --timeout=300 \
  --no-allow-unauthenticated --invoker-iam-check --service-account="$RUNTIME_ACCOUNT" \
  --set-secrets="SEPARATION_API_KEY=$API_KEY_SECRET:latest" \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT_ID,MAX_MONTHLY_GPU_SECONDS=$MAX_MONTHLY_GPU_SECONDS,QUOTA_COLLECTION=vocaltune_gpu_quota" \
  --quiet
run gcloud run services add-iam-policy-binding "$SERVICE" --region="$REGION" --project="$PROJECT_ID" --member="$CALLER_MEMBER" --role=roles/run.invoker
run gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)'
