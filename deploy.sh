#!/bin/bash
echo "🚀 VocalTune Pro - Cloud Run Deployment"
echo "========================================"

# Check for gcloud
if ! command -v gcloud &> /dev/null; then
    echo "❌ 'gcloud' command not found. Please install Google Cloud SDK."
    exit 1
fi

# Ask for Project ID
read -p "👉 Enter your Google Cloud Project ID: " PROJECT_ID

if [ -z "$PROJECT_ID" ]; then
    echo "❌ Project ID is required."
    exit 1
fi

# Set Project
echo "🔄 Setting project to $PROJECT_ID..."
gcloud config set project $PROJECT_ID

# Build Container
echo "🏗️  Building container image (this may take a few minutes)..."
gcloud builds submit --tag gcr.io/$PROJECT_ID/vocaltune-pro .

# Deploy to Cloud Run
echo "🚀 Deploying to Cloud Run..."
# Using 4Gi Memory and 2 CPU because AI separation (Demucs) is resource intensive
gcloud run deploy vocaltune-pro \
    --image gcr.io/$PROJECT_ID/vocaltune-pro \
    --platform managed \
    --region us-central1 \
    --allow-unauthenticated \
    --memory 4Gi \
    --cpu 2 \
    --timeout 300s

echo ""
echo "✅ Deployment pipeline completed!"
