import time
from pathlib import Path
from typing import Optional, Dict, Any

from shared.atomic_write import atomic_write_json


class StatusWriterError(RuntimeError):
    pass


def create_initial_status(
    job_root: str,
    job_id: str,
    file_name: str,
    file_size: int,
    file_hash: Optional[str] = None,
    options: Optional[Dict[str, Any]] = None,
) -> Path:
    """Create initial status.json for a job in `job_root/{job_id}`.

    Writes atomically to `status.json`. Returns Path to status.json.
    """
    job_dir = Path(job_root) / job_id
    if not job_dir.exists():
        raise StatusWriterError(f"job dir does not exist: {job_dir}")

    status = {
        "job_id": job_id,
        "status": "pending",
        "progress": 0,
        "message": "uploaded",
        "error": None,
        "created_at": int(time.time()),
        "file_name": file_name,
        "file_size": int(file_size),
        "file_hash": file_hash,
        "options": options or None,
    }

    status_path = job_dir / "status.json"
    try:
        atomic_write_json(status_path, status)
        return status_path
    except Exception as e:
        raise StatusWriterError(f"failed to write status.json: {e}")
