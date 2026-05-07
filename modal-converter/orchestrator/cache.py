"""Parse artifact cache helpers for orchestrator job processing."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from shared.atomic_write import atomic_write_json
from shared.config import Config, load_config
from shared.context import JobContext


def _now() -> int:
    return int(time.time())


def _read_json(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as file:
            loaded = json.load(file)
    except Exception:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _commit_cache_if_available(ctx: Optional[JobContext]) -> None:
    callback = ctx.commit_cache if ctx is not None else None
    if callable(callback):
        try:
            callback()
        except Exception:
            pass


def _build_cache_signature(file_hash: str, options: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "file_hash": file_hash,
        "options": options or {},
    }


def _compute_cache_key(signature: Dict[str, Any]) -> str:
    payload = json.dumps(signature, sort_keys=True).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _cache_dir(cache_key: str, config: Optional[Config] = None) -> Path:
    config = config or load_config(strict_gateway=False)
    return Path(config.marker_cache_dir) / cache_key


def _cache_is_valid(cache_dir: Path, signature: Dict[str, Any], config: Optional[Config] = None) -> bool:
    config = config or load_config(strict_gateway=False)
    info_path = cache_dir / "cache.json"
    raw_path = cache_dir / "raw.md"
    if not info_path.exists() or not raw_path.exists():
        return False

    info = _read_json(info_path)
    if info.get("signature") != signature:
        return False

    created_at = info.get("created_at")
    if created_at and config.cache_ttl_seconds > 0:
        if time.time() - float(created_at) > config.cache_ttl_seconds:
            shutil.rmtree(cache_dir, ignore_errors=True)
            return False

    return True


def _copy_file_if_exists(src: Path, dst: Path) -> None:
    _remove_path_if_exists(dst)
    if not src.exists():
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def _remove_path_if_exists(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    elif path.exists() or path.is_symlink():
        path.unlink()


def _copy_tree_if_exists(src: Path, dst: Path) -> None:
    _remove_path_if_exists(dst)
    if not src.exists():
        return
    shutil.copytree(src, dst)


def _restore_cached_parse(
    job_dir: Path,
    cache_dir: Path,
    signature: Dict[str, Any],
    ctx: Optional[JobContext] = None,
    config: Optional[Config] = None,
) -> bool:
    if not _cache_is_valid(cache_dir, signature, config):
        return False

    _copy_file_if_exists(cache_dir / "raw.md", job_dir / "raw.md")
    _copy_file_if_exists(cache_dir / "metadata.json", job_dir / "metadata.json")
    _copy_file_if_exists(cache_dir / "progress.parsing.json", job_dir / "progress.parsing.json")
    _copy_tree_if_exists(cache_dir / "images", job_dir / "images")
    _commit_cache_if_available(ctx)
    return True


def _store_cached_parse(
    job_dir: Path,
    cache_dir: Path,
    signature: Dict[str, Any],
    ctx: Optional[JobContext] = None,
) -> None:
    raw_path = job_dir / "raw.md"
    if not raw_path.exists():
        return

    cache_dir.parent.mkdir(parents=True, exist_ok=True)
    # Use a randomised tmp directory name to avoid collisions when two
    # different jobs targeting the same cache key race to populate it.
    tmp_dir = cache_dir.parent / f".{cache_dir.name}.{uuid.uuid4().hex}.tmp"
    try:
        tmp_dir.mkdir(parents=True, exist_ok=True)

        _copy_file_if_exists(job_dir / "raw.md", tmp_dir / "raw.md")
        _copy_file_if_exists(job_dir / "metadata.json", tmp_dir / "metadata.json")
        _copy_file_if_exists(job_dir / "progress.parsing.json", tmp_dir / "progress.parsing.json")
        _copy_tree_if_exists(job_dir / "images", tmp_dir / "images")

        atomic_write_json(tmp_dir / "cache.json", {"signature": signature, "created_at": _now()})

        if cache_dir.exists():
            shutil.rmtree(cache_dir, ignore_errors=True)
        os.replace(str(tmp_dir), str(cache_dir))
    finally:
        # Clean up the temp directory if something failed before replace.
        if tmp_dir.exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)
    _commit_cache_if_available(ctx)


restore_cached_parse = _restore_cached_parse
store_cached_parse = _store_cached_parse
