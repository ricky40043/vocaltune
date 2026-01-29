# Shared Job Store Module to avoid circular imports

job_status_store = {}

def update_job_status(job_id: str, diff: dict):
    """更新任務狀態"""
    if job_id not in job_status_store:
        job_status_store[job_id] = {}
    
    job_status_store[job_id].update(diff)
    
    # Log status changes
    status = diff.get("status")
    progress = diff.get("progress")
    if status or progress:
        import logging
        logging.info(f"Status Update [{job_id}]: {status} - {progress}%")

def get_job_status(job_id: str):
    return job_status_store.get(job_id, {"status": "unknown"})
