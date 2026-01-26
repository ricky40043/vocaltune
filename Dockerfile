
FROM python:3.10-slim

# Install system dependencies
# ffmpeg: required for audio processing (yt-dlp, demucs)
# nodejs/npm: required for building frontend
# git: required for some pip packages
RUN apt-get update && apt-get install -y ffmpeg nodejs npm git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Backend Dependencies
COPY backend-api/requirements.txt requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
# Manually install missing key packages
RUN pip install --no-cache-dir demucs
RUN pip install --no-cache-dir https://github.com/yt-dlp/yt-dlp/archive/master.zip

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

# Start Application
CMD ["uvicorn", "backend-api.main:app", "--host", "0.0.0.0", "--port", "8080"]
