"""Main job processing pipeline for the Modal backend."""

from __future__ import annotations

import os
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from shared.atomic_write import atomic_write_json
from shared.config import Config, load_config
from shared.constants import PARSEOTTER_FREE_OUTPUT_PROFILE
from shared.context import JobContext
from shared.error_codes import ErrorCode

from .cache import _build_cache_signature, _cache_dir, _compute_cache_key, _restore_cached_parse, _store_cached_parse
from .lock import _acquire_lock, _lock_path, _release_lock
from .status import (
    _commit_cache_if_available,
    _merge_status,
    _now,
    _read_json,
    _record_failure,
    _record_success,
    _status_path,
    _update_phase,
)


PARSING_PROGRESS_END = 40
PARSING_DONE_SENTINEL = ".stage.parsing.done.json"


@dataclass
class Outcome:
    job_id: str
    status: str
    current_phase: str
    progress: int
    error_code: Optional[str] = None
    error_message: Optional[str] = None


def _reload_cache_if_available(ctx: Optional[JobContext]) -> None:
    callback = ctx.reload_cache if ctx is not None else None
    if callable(callback):
        try:
            callback()
        except Exception:
            pass


def _job_dir(job_id: str, config: Optional[Config] = None) -> Path:
    config = config or load_config(strict_gateway=False)
    return Path(config.marker_job_dir) / job_id


def _stage_sentinel_path(job_dir: Path, stage: str) -> Path:
    if stage == "parsing":
        return job_dir / PARSING_DONE_SENTINEL
    raise ValueError(f"unknown stage: {stage}")


def _mark_stage_done(
    job_dir: Path,
    stage: str,
    details: Optional[Dict[str, Any]] = None,
    ctx: Optional[JobContext] = None,
) -> None:
    payload: Dict[str, Any] = {
        "stage": stage,
        "completed_at": _now(),
    }
    if details:
        payload.update(details)
    atomic_write_json(_stage_sentinel_path(job_dir, stage), payload)
    _commit_cache_if_available(ctx)


def _parsing_stage_done(job_dir: Path) -> bool:
    return _stage_sentinel_path(job_dir, "parsing").exists() and (job_dir / "raw.md").exists()


def _load_options(job_dir: Path, injected: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if injected is not None:
        return injected
    path = job_dir / "options.json"
    if not path.exists():
        return {}
    try:
        return _read_json(path)
    except Exception:
        return {}


def _write_result_zip(
    job_dir: Path,
    options: Optional[Dict[str, Any]] = None,
    ctx: Optional[JobContext] = None,
) -> None:
    options = options if options is not None else _load_options(job_dir, None)
    output_profile = options.get("output_profile") if isinstance(options, dict) else None
    _write_result_zip_for_profile(job_dir, output_profile if isinstance(output_profile, str) else "", ctx)


def _write_result_zip_for_profile(
    job_dir: Path,
    output_profile: str = "",
    ctx: Optional[JobContext] = None,
) -> None:
    raw_md = job_dir / "raw.md"
    if not raw_md.exists():
        return

    zip_path = job_dir / "result.zip"
    tmp_path = job_dir / ".result.zip.tmp"
    if tmp_path.exists():
        tmp_path.unlink()
    with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zip_file:
        if raw_md.exists():
            zip_file.write(raw_md, arcname="raw.md")
        status_path = job_dir / "status.json"
        if output_profile != PARSEOTTER_FREE_OUTPUT_PROFILE and status_path.exists():
            zip_file.write(status_path, arcname="status.json")
        images_dir = job_dir / "images"
        if images_dir.exists() and images_dir.is_dir():
            for path in images_dir.rglob("*"):
                if path.is_symlink():
                    continue
                if path.is_file():
                    arc = path.relative_to(job_dir)
                    zip_file.write(path, arcname=str(arc))
    os.replace(tmp_path, zip_path)
    _commit_cache_if_available(ctx)


def _invoke_parsing(
    job_dir: Path,
    job_id: str,
    options: Dict[str, Any],
    ctx: Optional[JobContext] = None,
    config: Optional[Config] = None,
) -> Tuple[bool, Optional[str], Optional[str]]:
    config = config or load_config(strict_gateway=False)
    parser_handle = ctx.parser_handle if ctx is not None else None
    if parser_handle is not None:
        if hasattr(parser_handle, "remote"):
            outcome = parser_handle.remote(job_id, options)
        else:
            outcome = parser_handle(job_id, options)
    else:
        # Fallback: invoke parser via Modal SDK.
        try:
            import modal
        except ImportError:
            return False, ErrorCode.INTERNAL_ERROR, "Modal SDK is not available in this environment"
        try:
            parser_cls = modal.Cls.from_name(config.modal_app_name, "MarkerConversionService")
            parser = parser_cls()
            outcome = parser.run_marker_inference.remote(job_id, options)
        except Exception as exc:
            return False, ErrorCode.MODAL_PROCESSING_FAILED, f"Modal invocation failed: {exc}"

    if outcome.get("success"):
        return True, None, None

    return False, outcome.get("error_code") or ErrorCode.PARSE_ERROR, outcome.get("error_message")


def process_job_background(
    job_id: str,
    options: Optional[Dict[str, Any]] = None,
    *,
    ctx: Optional[JobContext] = None,
    config: Optional[Config] = None,
) -> Outcome:
    config = config or load_config(strict_gateway=False)
    ctx = ctx or JobContext()
    job_dir = _job_dir(job_id, config)
    if not job_dir.exists():
        return Outcome(
            job_id,
            "failed",
            "pending",
            0,
            error_code=ErrorCode.FILE_NOT_FOUND,
            error_message="job dir missing",
        )

    status_path = _status_path(job_dir)
    status = _read_json(status_path)
    status = _merge_status(status, {"job_id": job_id})

    next_retry_at = status.get("next_retry_at")
    if next_retry_at is not None and _now() < int(next_retry_at):
        return Outcome(
            job_id,
            status.get("status", "pending"),
            status.get("phase", "pending"),
            int(status.get("progress", 0)),
            error_code=ErrorCode.RETRY_SCHEDULED,
            error_message="retry scheduled later",
        )

    if not _acquire_lock(job_dir, config):
        return Outcome(
            job_id,
            status.get("status", "pending"),
            status.get("phase", "pending"),
            int(status.get("progress", 0)),
            error_code=ErrorCode.LOCK_HELD,
            error_message="job is already being processed",
        )

    try:
        options_for_cache = _load_options(job_dir, options)
        file_hash = status.get("file_hash")
        cache_signature: Optional[Dict[str, Any]] = None
        cache_hit = False
        if file_hash:
            cache_signature = _build_cache_signature(file_hash, options_for_cache)
            cache_key = _compute_cache_key(cache_signature)
            cache_hit = _restore_cached_parse(job_dir, _cache_dir(cache_key, config), cache_signature, ctx, config)

        parsing_already_done = _parsing_stage_done(job_dir)

        if cache_hit:
            status = _update_phase(
                status_path,
                status,
                "parsing",
                PARSING_PROGRESS_END,
                "parsing skipped (cache hit)",
                ctx,
            )
        elif parsing_already_done:
            status = _update_phase(
                status_path,
                status,
                "parsing",
                PARSING_PROGRESS_END,
                "parsing skipped (completed marker)",
                ctx,
            )
        else:
            status = _update_phase(status_path, status, "parsing", PARSING_PROGRESS_END, "parsing started", ctx)
        parsed_ok = False
        parse_error_code: Optional[str] = None
        parse_error_message: Optional[str] = None
        try:
            if cache_hit or parsing_already_done:
                parsed_ok = True
            else:
                parsed_ok, parse_error_code, parse_error_message = _invoke_parsing(
                    job_dir,
                    job_id,
                    options_for_cache,
                    ctx,
                    config,
                )
        except Exception as exc:
            parsed_ok = False
            if isinstance(exc, NotImplementedError):
                parse_error_code = ErrorCode.INTERNAL_ERROR
            else:
                parse_error_code = ErrorCode.MODAL_PROCESSING_FAILED
            parse_error_message = f"[{type(exc).__name__}] {exc}"
        if not parsed_ok:
            status = _record_failure(
                status_path,
                status,
                "parsing",
                parse_error_code or ErrorCode.PARSE_ERROR,
                parse_error_message or "parsing failed",
                ctx,
            )
            return Outcome(
                job_id,
                status["status"],
                status["phase"],
                int(status.get("progress", 0)),
                status.get("error_code"),
                status.get("error_message"),
            )

        _reload_cache_if_available(ctx)

        if not parsing_already_done:
            _mark_stage_done(
                job_dir,
                "parsing",
                {
                    "cache_hit": cache_hit,
                    "cache_signature": cache_signature,
                },
                ctx,
            )

        if cache_signature and not cache_hit:
            _store_cached_parse(job_dir, _cache_dir(_compute_cache_key(cache_signature), config), cache_signature, ctx)

        status = _record_success(status_path, status, ctx)
        _write_result_zip(job_dir, options_for_cache, ctx)
        return Outcome(
            job_id,
            status["status"],
            status["phase"],
            int(status.get("progress", 100)),
            None,
            None,
        )

    finally:
        _release_lock(job_dir)
        _commit_cache_if_available(ctx)


__all__ = [
    "process_job_background",
    "Outcome",
]
