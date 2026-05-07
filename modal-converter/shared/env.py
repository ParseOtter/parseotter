"""Environment variable parsing utilities."""

from __future__ import annotations

import math
import os
from typing import Optional


def read_str_env(name: str, default: str) -> str:
    value = os.environ.get(name, default).strip()
    return value or default


def read_optional_str_env(name: str) -> Optional[str]:
    value = os.environ.get(name, "").strip()
    return value or None


def env_first(*names: str) -> str:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


def read_int_env(
    name: str,
    default: int,
    *,
    minimum: int,
    maximum: Optional[int] = None,
) -> int:
    raw_value = os.environ.get(name, str(default)).strip()
    try:
        value = int(raw_value)
    except (TypeError, ValueError):
        return default

    if value < minimum:
        return default

    if maximum is not None and value > maximum:
        return maximum

    return value


def read_float_env(
    name: str,
    default: float,
    *,
    minimum: float = 0.0,
    maximum: Optional[float] = None,
) -> float:
    raw_value = os.environ.get(name, str(default)).strip()
    try:
        value = float(raw_value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(value):
        return default
    if value < minimum:
        return default
    if maximum is not None and value > maximum:
        return maximum
    return value
