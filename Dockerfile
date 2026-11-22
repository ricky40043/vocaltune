FROM python:3.10-slim

# Install system dependencies
# ffmpeg: required for audio processing (yt-dlp, demucs)
# nodejs/npm: required for building frontend
# git: required for some pip packages
RUN apt-get update && apt-get install -y ffmpeg nodejs npm git && rm -rf /var/lib/apt/lists/*

# The existing downloader requests Deno; preserve it when rebuilding the app.
COPY --from=denoland/deno:bin-2.3.3 /deno /usr/local/bin/deno

WORKDIR /app

# Install Backend Dependencies
COPY backend-api/requirements.txt requirements.txt
# The local container provides the CPU fallback; Cloud Run owns GPU inference.
RUN pip install --no-cache-dir torch==2.5.1+cpu torchaudio==2.5.1+cpu \
    --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple
RUN pip install --no-cache-dir -r requirements.txt
# yt-dlp is installed from the Python-compatible release in requirements.txt.

# Copy Source Code
COPY . .

# Build Frontend
# VITE_API_URL="" ensures requests go to relative path /api/...
ENV VITE_API_URL=""
RUN npm install
RUN npm run build

# Environment Variables
ENV PORT=8080
ENV HOST=0.0.0.0

# Expose port (Cloud Run sets PORT usually to 8080)
EXPOSE 8080

# Start Application through the bootstrap that replaces StaticFiles with byte-range audio responses.
WORKDIR /app/backend-api
CMD ["uvicorn", "start:app", "--host", "0.0.0.0", "--port", "8080"]
