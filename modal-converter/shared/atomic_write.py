"""Atomic file write utilities shared across modules."""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any, Dict


def atomic_write_json(path: Path, data: Dict[str, Any]) -> None:
    """Write JSON atomically via a temporary file and os.replace.

    The temporary file uses a random UUID suffix to avoid collisions
    when multiple writers target the same destination concurrently.
    """
    tmp = path.parent / f".{path.name}.{uuid.uuid4().hex}.tmp"
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(tmp, "w", encoding="utf-8") as file:
            json.dump(data, file, ensure_ascii=False, indent=2, allow_nan=False)
            file.flush()
            try:
                os.fsync(file.fileno())
            except OSError:
                pass
        os.replace(str(tmp), str(path))
    finally:
        # Clean up the temp file if something went wrong before replace.
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
