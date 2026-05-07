"""Shared constants used across modules."""

from __future__ import annotations

PARSEOTTER_FREE_OUTPUT_PROFILE = "parseotter_free_v1"
SUPPORTED_OUTPUT_PROFILES = frozenset({PARSEOTTER_FREE_OUTPUT_PROFILE})
SUPPORTED_OUTPUT_FORMATS = frozenset({"markdown", "zip"})
