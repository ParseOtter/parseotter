"""Retry policy for orchestrator failures."""

from __future__ import annotations

import time
from typing import Optional, Tuple

from shared.error_codes import ErrorCode


RETRY_POLICY = {
    ErrorCode.FILE_NOT_FOUND: (False, 0, None),
    ErrorCode.OPTIONS_INVALID: (False, 0, None),
    ErrorCode.GPU_OOM: (True, 1, 60),
    ErrorCode.PARSE_ERROR: (True, 2, 30),
    ErrorCode.INTERNAL_ERROR: (True, 1, 60),
    ErrorCode.MODAL_PROCESSING_FAILED: (True, 1, 60),
}


def _now() -> int:
    return int(time.time())


def _should_retry(error_code: str, retry_count: int) -> Tuple[bool, Optional[int]]:
    try:
        normalized_code = ErrorCode(error_code)
    except ValueError:
        normalized_code = error_code
    retryable, max_attempts, backoff = RETRY_POLICY.get(normalized_code, (False, 0, None))
    if not retryable:
        return False, None
    if retry_count >= max_attempts:
        return False, None
    delay = backoff or 0
    if delay and retry_count > 0:
        delay = delay * (2 ** (retry_count - 1))
    return True, _now() + delay if delay else _now()


should_retry = _should_retry
