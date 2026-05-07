"""Cloudflare dispatch payload validation."""

from __future__ import annotations

import ipaddress
import json
import re
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlparse

from api_gateway.id_validation import validate_job_id
from shared.constants import PARSEOTTER_FREE_OUTPUT_PROFILE, SUPPORTED_OUTPUT_FORMATS


class DispatchValidationError(ValueError):
    pass


class R2ConfigError(RuntimeError):
    pass


class DispatchConflictError(RuntimeError):
    pass


_SAFE_HEADER_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,127}$")
_SHA256_HEX_PATTERN = re.compile(r"^[A-Fa-f0-9]{64}$")
_RESERVED_CALLBACK_HEADER_NAMES = {
    "connection",
    "content-length",
    "content-type",
    "host",
    "transfer-encoding",
    "x-idempotency-key",
}


def _is_safe_object_key(value: str) -> bool:
    if not value or value.startswith("/"):
        return False
    parts = value.split("/")
    return all(part not in {"", ".", ".."} for part in parts)


def _is_safe_job_id(value: str) -> bool:
    try:
        validate_job_id(value)
    except ValueError:
        return False
    return True


def _is_safe_header_name(value: str) -> bool:
    return (
        bool(_SAFE_HEADER_NAME_PATTERN.fullmatch(value))
        and value.lower() not in _RESERVED_CALLBACK_HEADER_NAMES
    )


def _is_positive_int(value: Any) -> bool:
    return type(value) is int and value > 0


def _is_public_callback_hostname(hostname: str) -> bool:
    normalized = hostname.rstrip(".").lower()
    if normalized == "localhost" or normalized.endswith(".localhost"):
        return False
    try:
        return ipaddress.ip_address(normalized).is_global
    except ValueError:
        return True


def _content_type_base(content_type: str) -> str:
    return content_type.split(";", 1)[0].strip().lower()


def _is_supported_input_file(content_type: str, object_key: str) -> bool:
    content_type_base = _content_type_base(content_type)
    suffix = Path(object_key).suffix.lower()
    if suffix == ".pdf":
        return content_type_base == "application/pdf"
    if suffix == ".epub":
        return content_type_base in {"application/epub+zip", "application/octet-stream"}
    if suffix:
        return False
    return content_type_base in {"application/pdf", "application/epub+zip"}


def _required_string(payload: Dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise DispatchValidationError(f"{key} is required")
    return value.strip()


def _required_dict(payload: Dict[str, Any], key: str) -> Dict[str, Any]:
    value = payload.get(key)
    if not isinstance(value, dict):
        raise DispatchValidationError(f"{key} is required")
    return value


def _validate_callback_url(raw_url: Optional[str]) -> Optional[str]:
    """Validate and normalise *raw_url*, returning the stripped URL or None.

    Rejects non-HTTPS schemes and URLs with missing hostnames to prevent
    SSRF / open-redirect abuse.
    """
    if raw_url is None:
        return None
    if not isinstance(raw_url, str):
        raise DispatchValidationError("callback.url must be a string or null")
    url = raw_url.strip()
    if not url:
        return None
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise DispatchValidationError("callback.url must use https scheme")
    if not parsed.hostname:
        raise DispatchValidationError("callback.url hostname is required")
    if not _is_public_callback_hostname(parsed.hostname):
        raise DispatchValidationError("callback.url hostname is not allowed")
    return url


def validate_dispatch_payload(payload: Any) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise DispatchValidationError("request body must be an object")

    job_id = _required_string(payload, "jobId")
    if not _is_safe_job_id(job_id):
        raise DispatchValidationError("jobId is invalid")

    user_id = _required_string(payload, "userId")
    attempt = payload.get("attempt")
    if not _is_positive_int(attempt):
        raise DispatchValidationError("attempt must be a positive integer")

    input_payload = _required_dict(payload, "input")
    input_object_key = _required_string(input_payload, "objectKey")
    input_content_type = _required_string(input_payload, "contentType")
    input_size_bytes = input_payload.get("sizeBytes")
    if not _is_positive_int(input_size_bytes):
        raise DispatchValidationError("input.sizeBytes must be a positive integer")
    if not _is_safe_object_key(input_object_key):
        raise DispatchValidationError("input.objectKey is invalid")
    if not _is_supported_input_file(input_content_type, input_object_key):
        raise DispatchValidationError("input file type is invalid")

    checksum_sha256 = input_payload.get("checksumSha256")
    if checksum_sha256 is not None and not isinstance(checksum_sha256, str):
        raise DispatchValidationError("input.checksumSha256 must be a string or null")
    normalized_checksum = checksum_sha256.strip() if isinstance(checksum_sha256, str) else None
    if normalized_checksum is not None and not _SHA256_HEX_PATTERN.fullmatch(normalized_checksum):
        raise DispatchValidationError("input.checksumSha256 is invalid")

    output_payload = _required_dict(payload, "output")
    output_object_key = _required_string(output_payload, "objectKey")
    output_format = _required_string(output_payload, "format").lower()
    if output_format not in SUPPORTED_OUTPUT_FORMATS:
        raise DispatchValidationError("output.format is invalid")
    if not _is_safe_object_key(output_object_key):
        raise DispatchValidationError("output.objectKey is invalid")

    options = payload.get("options")
    if options is not None and not isinstance(options, dict):
        raise DispatchValidationError("options must be an object or null")
    if isinstance(options, dict) and len(json.dumps(options, ensure_ascii=False).encode("utf-8")) > 4096:
        raise DispatchValidationError("options must be at most 4096 bytes")
    if isinstance(options, dict):
        output_profile = options.get("output_profile")
        if output_profile is not None:
            if not isinstance(output_profile, str) or output_profile != PARSEOTTER_FREE_OUTPUT_PROFILE:
                raise DispatchValidationError("options.output_profile is invalid")
            if output_profile == PARSEOTTER_FREE_OUTPUT_PROFILE and output_format != "zip":
                raise DispatchValidationError("options.output_profile requires output.format zip")

    callback_payload = _required_dict(payload, "callback")
    callback_url = _validate_callback_url(callback_payload.get("url"))
    callback_auth_header = _required_string(callback_payload, "authHeaderName")
    if not _is_safe_header_name(callback_auth_header):
        raise DispatchValidationError("callback.authHeaderName is invalid")
    callback_idempotency_key = _required_string(callback_payload, "idempotencyKey")

    return {
        "jobId": job_id,
        "userId": user_id,
        "attempt": attempt,
        "input": {
            "objectKey": input_object_key,
            "contentType": input_content_type,
            "sizeBytes": input_size_bytes,
            "checksumSha256": normalized_checksum,
        },
        "output": {
            "objectKey": output_object_key,
            "format": output_format,
        },
        "options": options,
        "callback": {
            "url": callback_url,
            "authHeaderName": callback_auth_header,
            "idempotencyKey": callback_idempotency_key,
        },
    }


def _resolve_dispatch_options(payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    options = payload.get("options")
    return options if isinstance(options, dict) else None
