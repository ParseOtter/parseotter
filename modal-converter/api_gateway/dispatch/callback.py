"""Cloudflare Worker callback helpers."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, Dict

import requests

from shared.config import Config, load_config


MODAL_SIGNATURE_HEADER = "x-modal-signature"
MODAL_TIMESTAMP_HEADER = "X-Modal-Timestamp"
SIGNATURE_PAYLOAD_SEPARATOR = "."


class CallbackConfigError(RuntimeError):
    pass


def _callback_timeout_seconds() -> float:
    return load_config(strict_gateway=False).callback_timeout_seconds


def _callback_max_attempts() -> int:
    return load_config(strict_gateway=False).callback_max_attempts


def _callback_retry_base_delay_seconds() -> float:
    return load_config(strict_gateway=False).callback_retry_base_delay_seconds


def _is_retryable_callback_status(status_code: int) -> bool:
    return status_code in {408, 425, 429} or 500 <= status_code < 600


def _sleep_before_callback_retry(delay_seconds: float) -> None:
    time.sleep(delay_seconds)


def validate_callback_auth_config(payload: Dict[str, Any], config: Config | None = None) -> None:
    """Validate callback auth configuration before a dispatch is accepted."""
    callback = payload.get("callback") if isinstance(payload, dict) else None
    if not isinstance(callback, dict) or not callback.get("url"):
        return

    config = config or load_config(strict_gateway=False)
    auth_header = callback.get("authHeaderName")
    if not isinstance(auth_header, str) or not auth_header:
        raise CallbackConfigError("callback auth header is missing")

    if auth_header.lower() == MODAL_SIGNATURE_HEADER:
        if not config.callback_hmac_secret:
            raise CallbackConfigError("modal callback hmac secret is not configured")
    elif not config.callback_internal_api_key:
        raise CallbackConfigError("callback_internal_api_key is required for non-HMAC auth")


def _post_callback(payload: Dict[str, Any], body: Dict[str, Any]) -> None:
    callback = payload["callback"]
    callback_url = callback.get("url")
    if not callback_url:
        return

    config = load_config(strict_gateway=False)
    validate_callback_auth_config(payload, config)
    body_json = json.dumps(body, separators=(",", ":"), ensure_ascii=False)
    body_bytes = body_json.encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "X-Idempotency-Key": callback["idempotencyKey"],
    }
    auth_header = callback["authHeaderName"]
    if auth_header.lower() == MODAL_SIGNATURE_HEADER:
        secret = config.callback_hmac_secret
        timestamp = str(int(time.time()))
        signature_payload = f"{timestamp}{SIGNATURE_PAYLOAD_SEPARATOR}{body_json}"
        signature = hmac.new(secret.encode("utf-8"), signature_payload.encode("utf-8"), hashlib.sha256).hexdigest()
        headers[MODAL_TIMESTAMP_HEADER] = timestamp
        headers[auth_header] = signature
    else:
        internal_key = config.callback_internal_api_key
        headers[auth_header] = internal_key

    max_attempts = _callback_max_attempts()
    timeout_seconds = _callback_timeout_seconds()

    for attempt_index in range(max_attempts):
        try:
            response = requests.post(
                callback_url,
                headers=headers,
                data=body_bytes,
                timeout=timeout_seconds,
            )
        except requests.RequestException as exc:
            if attempt_index + 1 >= max_attempts:
                raise RuntimeError(f"modal callback request failed: {exc}") from exc

            _sleep_before_callback_retry(_callback_retry_base_delay_seconds() * (2**attempt_index))
            continue

        if 200 <= response.status_code < 300:
            return

        if not _is_retryable_callback_status(response.status_code) or attempt_index + 1 >= max_attempts:
            raise RuntimeError(f"modal callback rejected: {response.status_code}")

        _sleep_before_callback_retry(_callback_retry_base_delay_seconds() * (2**attempt_index))
