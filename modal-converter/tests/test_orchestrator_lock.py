import os
from pathlib import Path

import pytest

import orchestrator.lock as lock_mod
from shared.config import Config


def _config(tmp_path: Path, *, lock_ttl_seconds: int = 10) -> Config:
    return Config(
        marker_job_dir=str(tmp_path / "jobs"),
        marker_cache_dir=str(tmp_path / "cache"),
        lock_ttl_seconds=lock_ttl_seconds,
    )


def test_active_json_lock_cannot_be_reacquired(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    job_dir = tmp_path / "jobs" / "job-lock"
    job_dir.mkdir(parents=True)
    monkeypatch.setattr(lock_mod, "_now", lambda: 1_000)
    lock_mod.atomic_write_json(
        job_dir / ".processing.lock",
        {"owner": "first", "created_ts": 995, "phase": "pending", "retry_count": 0},
    )

    assert lock_mod._acquire_lock(job_dir, _config(tmp_path, lock_ttl_seconds=10)) is False
    assert lock_mod._read_json(job_dir / ".processing.lock")["owner"] == "first"


def test_stale_json_lock_can_be_reacquired(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    job_dir = tmp_path / "jobs" / "job-lock"
    job_dir.mkdir(parents=True)
    monkeypatch.setattr(lock_mod, "_now", lambda: 1_000)
    lock_mod.atomic_write_json(
        job_dir / ".processing.lock",
        {"owner": "first", "created_ts": 900, "phase": "pending", "retry_count": 0},
    )

    assert lock_mod._acquire_lock(job_dir, _config(tmp_path, lock_ttl_seconds=10)) is True
    lock_data = lock_mod._read_json(job_dir / ".processing.lock")
    assert lock_data["created_ts"] == 1_000
    assert lock_data["owner"]


def test_malformed_active_json_lock_cannot_be_reacquired(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    job_dir = tmp_path / "jobs" / "job-lock"
    job_dir.mkdir(parents=True)
    lock_path = job_dir / ".processing.lock"
    lock_path.write_text("[1, 2]", encoding="utf-8")
    os.utime(lock_path, (995, 995))
    monkeypatch.setattr(lock_mod, "_now", lambda: 1_000)

    assert lock_mod._acquire_lock(job_dir, _config(tmp_path, lock_ttl_seconds=10)) is False
    assert lock_path.read_text(encoding="utf-8") == "[1, 2]"
