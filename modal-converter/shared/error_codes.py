"""Stable error codes shared across backend modules."""

from __future__ import annotations

import sys

if sys.version_info >= (3, 11):
    from enum import StrEnum
else:
    # Python 3.10 fallback — StrEnum was added in 3.11
    import enum

    class StrEnum(str, enum.Enum):
        __str__ = str.__str__
        __format__ = str.__format__


class ErrorCode(StrEnum):
    FILE_NOT_FOUND = "FILE_NOT_FOUND"
    OPTIONS_INVALID = "OPTIONS_INVALID"
    GPU_OOM = "GPU_OOM"
    PARSE_ERROR = "PARSE_ERROR"
    INTERNAL_ERROR = "INTERNAL_ERROR"
    RETRY_SCHEDULED = "RETRY_SCHEDULED"
    LOCK_HELD = "LOCK_HELD"
    MODEL_NOT_READY = "MODEL_NOT_READY"
    MODAL_PROCESSING_FAILED = "MODAL_PROCESSING_FAILED"
