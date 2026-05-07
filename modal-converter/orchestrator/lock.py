"""File lock helpers for orchestrator job processing."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, Optional

from shared.atomic_write import atomic_write_json
from shared.config import Config, load_config
from shared.env import read_str_env


def _now() -> int:
    return int(time.time())


def _read_json(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as file:
            loaded = json.load(file)
    except Exception:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _lock_path(job_dir: Path) -> Path:
    return job_dir / ".processing.lock"


def _lock_created_ts(lock: Path, data: Dict[str, Any]) -> int:
    try:
        created_ts = int(data.get("created_ts", 0))
    except (TypeError, ValueError):
        created_ts = 0
    if created_ts > 0:
        return created_ts
    try:
        return int(lock.stat().st_mtime)
    except OSError:
        return 0


def _acquire_lock(job_dir: Path, config: Optional[Config] = None) -> bool:
    config = config or load_config(strict_gateway=False)
    lock = _lock_path(job_dir)
    lock.parent.mkdir(parents=True, exist_ok=True)

    payload = {
        "owner": read_str_env("HOSTNAME", "module-b-orchestrator"),
        "created_ts": _now(),
        "phase": "pending",
        "retry_count": 0,
    }

    try:
        # Atomically create the lock file — O_EXCL ensures only one winner.
        fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.close(fd)
        atomic_write_json(lock, payload)
        return True
    except FileExistsError:
        pass

    # Lock exists: check if it has expired.
    data = _read_json(lock)
    created_ts = _lock_created_ts(lock, data)
    now = _now()
    if created_ts and created_ts + config.lock_ttl_seconds < now:
        try:
            lock.unlink()
        except Exception:
            return False
        # Retry once after unlinking the stale lock.
        try:
            fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(fd)
            atomic_write_json(lock, payload)
            return True
        except (FileExistsError, OSError):
            return False

    return False


def _release_lock(job_dir: Path) -> None:
    lock = _lock_path(job_dir)
    if lock.exists():
        try:
            lock.unlink()
        except Exception:
            pass


acquire_lock = _acquire_lock
release_lock = _release_lock
