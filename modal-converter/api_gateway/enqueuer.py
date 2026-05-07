import json
import os
import time
from pathlib import Path
from typing import Optional


class EnqueueError(RuntimeError):
    pass


def create_enqueue_trigger(job_root: str, job_id: str, payload: Optional[str] = None) -> Path:
    """Create a lightweight .enqueue file inside the job directory.

    The file content is a JSON line containing a timestamp and optional payload.
    Returns the Path to the created file.
    Raises EnqueueError if the job directory does not exist or creation fails.
    """
    job_dir = Path(job_root) / job_id
    if not job_dir.exists() or not job_dir.is_dir():
        raise EnqueueError(f"job dir does not exist: {job_dir}")

    enqueue_path = job_dir / ".enqueue"
    tmp_path = job_dir / f".enqueue.{os.getpid()}.{time.time_ns()}.tmp"
    try:
        ts = int(time.time())
        content = json.dumps({"enqueued_at": ts, "payload": payload}, ensure_ascii=False) + "\n"
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            try:
                os.fsync(f.fileno())
            except Exception:
                pass
        os.replace(tmp_path, enqueue_path)
        return enqueue_path
    except Exception as e:
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass
        raise EnqueueError(f"failed to create enqueue trigger: {e}")
