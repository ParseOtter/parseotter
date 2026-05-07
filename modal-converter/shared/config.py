"""Central configuration for the Modal backend."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import List, Optional

from shared.env import read_float_env, read_int_env, read_optional_str_env, read_str_env


def _parse_csv_env(name: str, default: str) -> List[str]:
    raw = os.getenv(name, default)
    if isinstance(raw, str):
        parts = [part.strip() for part in raw.split(",") if part.strip()]
        return parts if parts else ["*"]
    return ["*"]


def _parse_positive_int_env(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None or value == "":
        return default
    try:
        parsed = int(value)
    except ValueError as exc:
        raise ValueError(f"environment variable {name} must be an integer") from exc
    if parsed <= 0:
        raise ValueError(f"environment variable {name} must be positive")
    return parsed


@dataclass(frozen=True)
class Config:
    modal_app_name: str = "parseotter-converter-dev"
    gpu_type: str = "L40S"
    cloudflare_dispatch_secret_name: str = "parseotter-dispatch-secrets-dev"
    modal_models_volume_name: str = "parseotter-models"
    modal_cache_volume_name: str = "parseotter-cache-dev"

    marker_job_dir: str = "/cache/marker-jobs"
    marker_cache_dir: str = "/cache/marker-cache"
    cache_ttl_seconds: int = 86400
    lock_ttl_seconds: int = 900
    parsing_progress_end: int = 40

    marker_pdftext_workers: int = 2

    max_upload_bytes: int = 150 * 1024 * 1024
    cors_origins: List[str] = field(default_factory=lambda: ["*"])
    api_secret: Optional[str] = None

    callback_timeout_seconds: float = 10.0
    callback_max_attempts: int = 3
    callback_retry_base_delay_seconds: float = 1.0
    callback_hmac_secret: Optional[str] = None
    callback_internal_api_key: Optional[str] = None
    r2_io_timeout_seconds: float = 300.0

    service_scaledown_window: int = 100
    service_min_containers: int = 0
    service_max_containers: int = 5


def load_config(*, strict_gateway: bool = True) -> Config:
    marker_job_dir = read_str_env("MARKER_JOB_DIR", "/cache/marker-jobs")
    if not marker_job_dir:
        raise ValueError("MARKER_JOB_DIR must be set")

    return Config(
        modal_app_name=read_str_env("MODAL_APP_NAME", "parseotter-converter-dev"),
        gpu_type=read_str_env("GPU_TYPE", "L40S"),
        cloudflare_dispatch_secret_name=read_str_env(
            "CLOUDFLARE_DISPATCH_SECRET_NAME",
            "parseotter-dispatch-secrets-dev",
        ),
        modal_models_volume_name=read_str_env("MODAL_MODELS_VOLUME_NAME", "parseotter-models"),
        modal_cache_volume_name=read_str_env("MODAL_CACHE_VOLUME_NAME", "parseotter-cache-dev"),
        marker_job_dir=marker_job_dir,
        marker_cache_dir=read_str_env("MARKER_CACHE_DIR", "/cache/marker-cache"),
        cache_ttl_seconds=read_int_env("MARKER_CACHE_TTL_SECONDS", 86400, minimum=0),
        lock_ttl_seconds=read_int_env("ORCH_LOCK_TTL_SECONDS", 900, minimum=1),
        marker_pdftext_workers=read_int_env("MARKER_PDFTEXT_WORKERS", 2, minimum=1, maximum=8),
        max_upload_bytes=(
            _parse_positive_int_env("MAX_UPLOAD_BYTES", 150 * 1024 * 1024)
            if strict_gateway
            else read_int_env("MAX_UPLOAD_BYTES", 150 * 1024 * 1024, minimum=1)
        ),
        cors_origins=_parse_csv_env("CORS_ORIGINS", "*"),
        api_secret=read_optional_str_env("API_SECRET"),
        callback_timeout_seconds=read_float_env("MODAL_CALLBACK_TIMEOUT_SECONDS", 10.0, minimum=0.001),
        callback_max_attempts=read_int_env("MODAL_CALLBACK_MAX_ATTEMPTS", 3, minimum=1),
        callback_retry_base_delay_seconds=read_float_env(
            "MODAL_CALLBACK_RETRY_BASE_DELAY_SECONDS",
            1.0,
            minimum=0.0,
        ),
        callback_hmac_secret=read_optional_str_env("MODAL_CALLBACK_HMAC_SECRET"),
        callback_internal_api_key=read_optional_str_env("CALLBACK_INTERNAL_API_KEY"),
        r2_io_timeout_seconds=read_float_env("R2_IO_TIMEOUT_SECONDS", 300.0, minimum=0.001),
        service_scaledown_window=read_int_env(
            "MARKER_SERVICE_SCALEDOWN_WINDOW",
            100,
            minimum=2,
            maximum=1200,
        ),
        service_min_containers=read_int_env("MARKER_SERVICE_MIN_CONTAINERS", 0, minimum=0),
        service_max_containers=read_int_env("MARKER_SERVICE_MAX_CONTAINERS", 5, minimum=1),
    )
