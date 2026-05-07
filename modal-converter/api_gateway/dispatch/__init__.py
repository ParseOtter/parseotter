"""Cloudflare dispatch operations: validation, R2 I/O, callback, and orchestration."""

from __future__ import annotations

from api_gateway.dispatch.callback import CallbackConfigError, _post_callback, validate_callback_auth_config
from api_gateway.dispatch.processor import (
    prepare_cloudflare_dispatch_job,
    process_cloudflare_dispatch_job,
)
from api_gateway.dispatch.r2_client import (
    R2TransferResult,
    _amz_date,
    _r2_config,
    _r2_timeout_seconds,
    _signed_r2_request,
    _signing_key,
    download_r2_object,
    download_r2_object_to_path,
    require_r2_configured,
    upload_r2_object,
    upload_r2_object_from_path,
)
from api_gateway.dispatch.validation import (
    DispatchConflictError,
    DispatchValidationError,
    R2ConfigError,
    _is_safe_header_name,
    _is_safe_job_id,
    _is_safe_object_key,
    _required_dict,
    _required_string,
    _resolve_dispatch_options,
    validate_dispatch_payload,
)
from shared.constants import PARSEOTTER_FREE_OUTPUT_PROFILE, SUPPORTED_OUTPUT_FORMATS, SUPPORTED_OUTPUT_PROFILES

__all__ = [
    "DispatchValidationError",
    "R2ConfigError",
    "DispatchConflictError",
    "CallbackConfigError",
    "R2TransferResult",
    "PARSEOTTER_FREE_OUTPUT_PROFILE",
    "SUPPORTED_OUTPUT_FORMATS",
    "SUPPORTED_OUTPUT_PROFILES",
    "validate_dispatch_payload",
    "prepare_cloudflare_dispatch_job",
    "process_cloudflare_dispatch_job",
    "validate_callback_auth_config",
    "download_r2_object_to_path",
    "download_r2_object",
    "upload_r2_object",
    "upload_r2_object_from_path",
    "require_r2_configured",
]
