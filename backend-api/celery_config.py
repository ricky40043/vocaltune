"""
Celery 設定檔
從環境變數讀取 Redis URL
"""

import os

# Redis URL from environment
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")

# Celery Configuration
broker_url = REDIS_URL
result_backend = REDIS_URL

# Task settings
task_serializer = "json"
result_serializer = "json"
accept_content = ["json"]
timezone = "Asia/Taipei"
enable_utc = True

# Task routing
task_routes = {
    "tasks.separate_music": {"queue": "music_separation"},
    "tasks.mix_tracks": {"queue": "music_separation"},
}

# Worker settings
worker_prefetch_multiplier = 1
task_acks_late = True
task_reject_on_worker_lost = True

# Task time limits
task_time_limit = 600  # 10 minutes max
task_soft_time_limit = 540  # 9 minutes soft limit
