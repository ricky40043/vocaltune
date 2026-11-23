FROM pytorch/pytorch:2.4.0-cuda12.1-cudnn9-runtime
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 TORCH_HOME=/opt/models PORT=8080
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*
# Match torchaudio to the preinstalled CUDA PyTorch; do not upgrade torch via pip.
RUN pip install --no-cache-dir torchaudio==2.4.0 --index-url https://download.pytorch.org/whl/cu121
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
# Build needs network, never a GPU. Include 6 stems for existing VocalTune flows.
RUN python -c "from demucs.pretrained import get_model; get_model('htdemucs_ft'); get_model('htdemucs_6s')"
COPY main.py quota.py /app/cloud_service/
RUN useradd --create-home --uid 10001 service \
    && chmod -R a+rX /opt/models /app
USER service
EXPOSE 8080
CMD ["sh", "-c", "exec uvicorn cloud_service.main:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1"]
