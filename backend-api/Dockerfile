# VocalTune Pro Backend API Dockerfile
FROM python:3.10-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    ffmpeg \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Current YouTube extraction requires an external JavaScript runtime.
RUN curl -fsSL https://deno.land/install.sh | sh -s v2.3.3 \
    && mv /root/.deno/bin/deno /usr/local/bin/deno \
    && rm -rf /root/.deno

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Expose port
EXPOSE 8050

# Run uvicorn server
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8050"]
