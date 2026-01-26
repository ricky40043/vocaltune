# VocalTune Pro AI Worker Dockerfile
# 負責繁重的 YouTube 下載與 AI 人聲分離

FROM python:3.10-slim

# Set working directory
WORKDIR /app

# Install system dependencies
# - ffmpeg: 音訊處理必須
# - libsndfile1: Demucs 依賴
# - git: 支援 pip git install
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install PyTorch CPU version (required by Demucs)
RUN pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cpu

# Install yt-dlp and Demucs from Git (for latest fixes)
RUN pip install --no-cache-dir \
    git+https://github.com/yt-dlp/yt-dlp.git \
    git+https://github.com/facebookresearch/demucs.git

# Copy application code
COPY . .

# Set environment variables
ENV PYTHONUNBUFFERED=1

# Run Celery worker
# concurrency=1 因為 AI 處理非常吃資源
CMD ["celery", "-A", "tasks", "worker", "--loglevel=info", "--concurrency=1"]
