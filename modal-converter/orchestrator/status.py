"""Status document helpers for orchestrator job processing."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict, Optional

from shared.atomic_write import atomic_write_json as _atomic_write_json
from shared.context import JobContext

from .retry import _should_retry


def _now() -> int:
    return int(time.time())


def _commit_cache_if_available(ctx: Optional[JobContext]) -> None:
    callback = ctx.commit_cache if ctx is not None else None
    if callable(callback):
        try:
            callback()
        except Exception:
            pass


def _status_path(job_dir: Path) -> Path:
    return job_dir / "status.json"


def _read_json(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as file:
            loaded = json.load(file)
    except Exception:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _default_status(job_id: str) -> Dict[str, Any]:
    return {
        "job_id": job_id,
        "status": "pending",
        "phase": "pending",
        "progress": 0,
        "progress_details": {
            "parsing": {"current_page": 0, "total_pages": 0},
        },
        "message": "queued",
        "error_code": None,
        "error_message": None,
        "last_updated_ts": _now(),
        "phase_elapsed_ms": 0,
        "retry_count": 0,
        "retry_history": [],
        "next_retry_at": None,
    }


def _merge_status(base: Dict[str, Any], updates: Dict[str, Any]) -> Dict[str, Any]:
    merged = _default_status(base.get("job_id") or updates.get("job_id"))
    merged.update(base)
    merged.update(updates)
    merged["last_updated_ts"] = _now()
    return merged


def _update_phase(
    status_path: Path,
    base: Dict[str, Any],
    phase: str,
    progress: int,
    message: str,
    ctx: Optional[JobContext] = None,
) -> Dict[str, Any]:
    updated = _merge_status(base, {
        "status": phase.split(":")[0] if ":" in phase else phase,
        "phase": phase,
        "progress": progress,
        "message": message,
        "error_code": None,
        "error_message": None,
    })
    _atomic_write_json(status_path, updated)
    _commit_cache_if_available(ctx)
    return updated


def _record_failure(
    status_path: Path,
    base: Dict[str, Any],
    phase: str,
    error_code: str,
    error_message: str,
    ctx: Optional[JobContext] = None,
) -> Dict[str, Any]:
    retry_count = int(base.get("retry_count", 0))
    retry_history = list(base.get("retry_history", []))[-2:]
    retry_history.append({
        "ts": _now(),
        "phase": phase,
        "error_code": error_code,
        "message": error_message,
    })

    should_retry, next_retry_at = _should_retry(error_code, retry_count)
    new_retry_count = retry_count + 1 if should_retry else retry_count

    updated = _merge_status(base, {
        "status": "failed",
        "phase": phase,
        "progress": base.get("progress", 0),
        "message": error_message,
        "error_code": error_code,
        "error_message": error_message,
        "retry_count": new_retry_count,
        "retry_history": retry_history,
        "next_retry_at": next_retry_at,
    })
    _atomic_write_json(status_path, updated)
    _commit_cache_if_available(ctx)
    return updated


def _record_success(status_path: Path, base: Dict[str, Any], ctx: Optional[JobContext] = None) -> Dict[str, Any]:
    updated = _merge_status(base, {
        "status": "completed",
        "phase": "completed",
        "progress": 100,
        "message": "done",
        "error_code": None,
        "error_message": None,
        "next_retry_at": None,
    })
    _atomic_write_json(status_path, updated)
    _commit_cache_if_available(ctx)
    return updated


def _record_success_with_warning(
    status_path: Path,
    base: Dict[str, Any],
    warning: Dict[str, Any],
    message: str,
    ctx: Optional[JobContext] = None,
) -> Dict[str, Any]:
    warnings = list(base.get("warnings") or [])
    already_exists = any(
        item.get("code") == warning.get("code") and item.get("source") == warning.get("source")
        for item in warnings
        if isinstance(item, dict)
    )
    if not already_exists:
        warnings.append(warning)

    updated = _merge_status(base, {
        "status": "completed",
        "phase": "completed",
        "progress": 100,
        "message": message,
        "error_code": None,
        "error_message": None,
        "next_retry_at": None,
        "warnings": warnings,
    })
    _atomic_write_json(status_path, updated)
    _commit_cache_if_available(ctx)
    return updated
