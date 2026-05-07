"""Cloudflare dispatch job preparation and processing."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict, Optional

import orchestrator
from shared.atomic_write import atomic_write_json
from shared.config import Config, load_config
from shared.constants import PARSEOTTER_FREE_OUTPUT_PROFILE
from shared.context import JobContext
from shared.error_codes import ErrorCode

from api_gateway import status_writer, storage

from .callback import _post_callback, validate_callback_auth_config
from . import r2_client
from .validation import (
    DispatchConflictError,
    _resolve_dispatch_options,
)


DISPATCH_METADATA_FILE = "cloudflare-dispatch.json"


def _original_file_name(content_type: str, object_key: str) -> str:
    suffix = Path(object_key).suffix.lower()
    if suffix in {".pdf", ".epub"}:
        return f"original{suffix}"
    if content_type == "application/epub+zip":
        return "original.epub"
    return "original.pdf"


def _metadata_path(job_dir: Path) -> Path:
    return job_dir / DISPATCH_METADATA_FILE


def _write_dispatch_metadata(job_dir: Path, payload: Dict[str, Any], dispatch_idempotency_key: str) -> None:
    data = {
        "dispatchIdempotencyKey": dispatch_idempotency_key,
        "payload": payload,
        "createdAt": int(time.time()),
    }
    atomic_write_json(_metadata_path(job_dir), data)


def _read_dispatch_metadata(job_dir: Path) -> Dict[str, Any]:
    path = _metadata_path(job_dir)
    if not path.exists():
        return {}
    with open(path, "r", encoding="utf-8") as file:
        loaded = json.load(file)
    return loaded if isinstance(loaded, dict) else {}


def _read_json_file(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as file:
            loaded = json.load(file)
    except Exception:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _job_dir_matches_prepared_payload(job_dir: Path, payload: Dict[str, Any]) -> bool:
    """Return True when existing staged files match the dispatch payload."""
    input_payload = payload["input"]
    expected_file_name = _original_file_name(input_payload["contentType"], input_payload["objectKey"])
    original_path = job_dir / expected_file_name
    if not original_path.exists():
        return False

    status = _read_json_file(job_dir / "status.json")
    if not status:
        return False
    if status.get("job_id") != payload["jobId"]:
        return False
    if status.get("file_name") != expected_file_name:
        return False
    try:
        status_file_size = int(status.get("file_size") or -1)
    except (TypeError, ValueError):
        return False
    if status_file_size != original_path.stat().st_size:
        return False

    checksum = input_payload.get("checksumSha256")
    if isinstance(checksum, str) and checksum.strip():
        if str(status.get("file_hash") or "").lower() != checksum.strip().lower():
            return False

    expected_options = _resolve_dispatch_options(payload)
    status_options = status.get("options")
    if (status_options or None) != (expected_options or None):
        return False

    options_path = job_dir / "options.json"
    if expected_options is None:
        return not options_path.exists()
    return _read_json_file(options_path) == expected_options


def prepare_cloudflare_dispatch_job(
    job_root: str,
    payload: Dict[str, Any],
    dispatch_idempotency_key: str,
) -> Dict[str, Any]:
    r2_client.require_r2_configured()
    config = load_config(strict_gateway=False)
    validate_callback_auth_config(payload, config)
    job_id = payload["jobId"]
    job_dir = Path(job_root) / job_id

    # --- Idempotency check --------------------------------------------------
    existing = _read_dispatch_metadata(job_dir)
    if existing:
        if existing.get("dispatchIdempotencyKey") == dispatch_idempotency_key:
            return {"accepted": True, "duplicate": True, "jobId": job_id, "attempt": payload["attempt"]}
        raise DispatchConflictError("job was already accepted with a different dispatch idempotency key")

    # Recovery path: job directory exists but metadata is missing (partial
    # failure in a previous attempt).  If the staged artifacts look intact,
    # write the metadata and treat as a duplicate.
    if job_dir.exists():
        if _job_dir_matches_prepared_payload(job_dir, payload):
            _write_dispatch_metadata(job_dir, payload, dispatch_idempotency_key)
            return {"accepted": True, "duplicate": True, "jobId": job_id, "attempt": payload["attempt"]}
        raise DispatchConflictError("job directory exists without matching dispatch metadata")

    # ------------------------------------------------------------------------

    input_payload = payload["input"]
    file_name = _original_file_name(input_payload["contentType"], input_payload["objectKey"])
    options = _resolve_dispatch_options(payload)
    job_root_path = Path(job_root)
    job_root_path.mkdir(parents=True, exist_ok=True)
    download_path = job_root_path / f".{job_id}.r2-download.tmp"
    if download_path.exists():
        download_path.unlink()
    try:
        download_result = r2_client.download_r2_object_to_path(
            input_payload["objectKey"],
            download_path,
            input_payload.get("checksumSha256"),
            max_bytes=config.max_upload_bytes,
        )
        with open(download_path, "rb") as file:
            job_dir = storage.write_job_files(
                job_root,
                job_id,
                file,
                file_name=file_name,
                options=options,
            )
        status_writer.create_initial_status(
            job_root,
            job_id,
            file_name,
            download_result.size_bytes,
            file_hash=download_result.sha256_hex,
            options=options,
        )
    finally:
        try:
            download_path.unlink()
        except FileNotFoundError:
            pass
    _write_dispatch_metadata(job_dir, payload, dispatch_idempotency_key)
    return {"accepted": True, "duplicate": False, "jobId": job_id, "attempt": payload["attempt"]}


def _load_prepared_payload(job_id: str, config: Optional[Config] = None) -> Dict[str, Any]:
    config = config or load_config(strict_gateway=False)
    job_dir = Path(config.marker_job_dir) / job_id
    metadata = _read_dispatch_metadata(job_dir)
    payload = metadata.get("payload")
    if not isinstance(payload, dict):
        raise RuntimeError("cloudflare dispatch metadata is missing")
    return payload


def _resolve_output_artifact(job_dir: Path, output_format: str) -> tuple[Path, str]:
    if output_format == "zip":
        return job_dir / "result.zip", "application/zip"
    return job_dir / "raw.md", "text/markdown; charset=utf-8"


def process_cloudflare_dispatch_job(
    job_id: str,
    *,
    ctx: Optional[JobContext] = None,
    config: Optional[Config] = None,
) -> Dict[str, Any]:
    provided_ctx = ctx
    provided_config = config
    config = config or load_config(strict_gateway=False)
    ctx = ctx or JobContext()
    payload = _load_prepared_payload(job_id, config)
    job_dir = Path(config.marker_job_dir) / job_id
    output_object_key = payload["output"]["objectKey"]
    attempt = payload["attempt"]
    callback_key = payload["callback"]["idempotencyKey"]

    try:
        options = _resolve_dispatch_options(payload)
        orchestrator_kwargs: Dict[str, Any] = {
            "options": options,
        }
        if provided_ctx is not None:
            orchestrator_kwargs["ctx"] = ctx
        if provided_config is not None:
            orchestrator_kwargs["config"] = config
        outcome = orchestrator.process_job_background(job_id, **orchestrator_kwargs)
        if getattr(outcome, "status", "") != "completed":
            body = {
                "jobId": job_id,
                "status": "failed",
                "outputObjectKey": None,
                "errorCode": getattr(outcome, "error_code", None) or ErrorCode.MODAL_PROCESSING_FAILED,
                "errorMessage": getattr(outcome, "error_message", None) or "Modal processing failed",
                "attempt": attempt,
                "idempotencyKey": callback_key,
            }
            _post_callback(payload, body)
            return body

        output_path, output_content_type = _resolve_output_artifact(job_dir, payload["output"]["format"])
        if not output_path.exists():
            raise RuntimeError("job output artifact is missing")
        r2_client.upload_r2_object_from_path(output_object_key, output_path, output_content_type)
    except Exception as exc:
        body = {
            "jobId": job_id,
            "status": "failed",
            "outputObjectKey": None,
            "errorCode": ErrorCode.MODAL_PROCESSING_FAILED,
            "errorMessage": str(exc)[:500],
            "attempt": attempt,
            "idempotencyKey": callback_key,
        }
        try:
            _post_callback(payload, body)
        except Exception:
            pass
        return body

    body = {
        "jobId": job_id,
        "status": "completed",
        "outputObjectKey": output_object_key,
        "outputContentType": output_content_type,
        "errorCode": None,
        "errorMessage": None,
        "attempt": attempt,
        "idempotencyKey": callback_key,
    }
    _post_callback(payload, body)
    return body
