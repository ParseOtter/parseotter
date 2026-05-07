import concurrent.futures
import importlib
import json
import os
import sys
import zipfile
from pathlib import Path

import pytest

from shared.context import JobContext


def _reload_orchestrator(monkeypatch: pytest.MonkeyPatch, job_root: Path):
    monkeypatch.setenv("MARKER_JOB_DIR", str(job_root))
    for name in list(sys.modules):
        if name == "orchestrator" or name.startswith("orchestrator."):
            sys.modules.pop(name)
    return importlib.import_module("orchestrator")


def test_missing_job_dir_returns_error(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    orch = _reload_orchestrator(monkeypatch, tmp_path)

    outcome = orch.process_job_background("nope")

    assert outcome.status == "failed"
    assert outcome.error_code == "FILE_NOT_FOUND"


def test_lock_held_returns_lock_error(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    orch = _reload_orchestrator(monkeypatch, tmp_path)
    job_id = "job-lock"
    job_dir = tmp_path / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    # seed status
    orch._atomic_write_json(job_dir / "status.json", orch._default_status(job_id))
    # active lock (not stale)
    orch._atomic_write_json(job_dir / ".processing.lock", {
        "owner": "tester",
        "created_ts": orch._now(),
        "phase": "pending",
        "retry_count": 0,
    })

    outcome = orch.process_job_background(job_id)

    assert outcome.error_code == "LOCK_HELD"


def test_concurrent_lock_acquire_has_single_winner(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    orch = _reload_orchestrator(monkeypatch, tmp_path)
    job_dir = tmp_path / "job-concurrent-lock"
    job_dir.mkdir(parents=True, exist_ok=True)

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        results = list(executor.map(lambda _idx: orch._acquire_lock(job_dir), range(10)))

    assert results.count(True) == 1
    assert results.count(False) == 9


def test_stale_malformed_lock_can_be_reacquired(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("ORCH_LOCK_TTL_SECONDS", "1")
    orch = _reload_orchestrator(monkeypatch, tmp_path)
    job_dir = tmp_path / "job-stale-malformed-lock"
    job_dir.mkdir(parents=True, exist_ok=True)

    lock_path = job_dir / ".processing.lock"
    lock_path.write_text("", encoding="utf-8")
    stale_ts = orch._now() - 10
    os.utime(lock_path, (stale_ts, stale_ts))

    assert orch._acquire_lock(job_dir) is True
    assert orch._read_json(lock_path).get("created_ts", 0) >= stale_ts


def test_retry_scheduled_skips_execution(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    orch = _reload_orchestrator(monkeypatch, tmp_path)
    job_id = "job-retry"
    job_dir = tmp_path / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    future = orch._now() + 120
    status = orch._default_status(job_id)
    status["next_retry_at"] = future
    orch._atomic_write_json(job_dir / "status.json", status)

    outcome = orch.process_job_background(job_id)

    assert outcome.error_code == "RETRY_SCHEDULED"
    assert outcome.status == status["status"]


def test_happy_path_updates_status_and_clears_lock(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    orch = _reload_orchestrator(monkeypatch, tmp_path)
    job_id = "job-ok"
    job_dir = tmp_path / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    orch._atomic_write_json(job_dir / "status.json", orch._default_status(job_id))

    monkeypatch.setattr(orch.pipeline, "_invoke_parsing", lambda *_args, **_kwargs: (True, None, None))

    outcome = orch.process_job_background(job_id)

    status = orch._read_json(job_dir / "status.json")

    assert outcome.status == "completed"
    assert status.get("status") == "completed"
    assert status.get("progress") == 100
    assert not status.get("warnings")
    assert not (job_dir / ".processing.lock").exists()


def test_success_commits_after_releasing_lock(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    orch = _reload_orchestrator(monkeypatch, tmp_path)
    job_id = "job-commit-lock-release"
    job_dir = tmp_path / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    orch._atomic_write_json(job_dir / "status.json", orch._default_status(job_id))

    monkeypatch.setattr(orch.pipeline, "_invoke_parsing", lambda *_args, **_kwargs: (True, None, None))
    commit_snapshots = []

    def commit_cache():
        commit_snapshots.append((job_dir / ".processing.lock").exists())

    outcome = orch.process_job_background(job_id, ctx=JobContext(commit_cache=commit_cache))

    assert outcome.status == "completed"
    assert commit_snapshots[-1] is False


def test_success_creates_result_zip(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    orch = _reload_orchestrator(monkeypatch, tmp_path)
    job_id = "job-zip"
    job_dir = tmp_path / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    orch._atomic_write_json(job_dir / "status.json", orch._default_status(job_id))
    (job_dir / "raw.md").write_text("raw", encoding="utf-8")
    images_dir = job_dir / "images"
    images_dir.mkdir()
    (images_dir / "img1.png").write_text("img", encoding="utf-8")

    monkeypatch.setattr(orch.pipeline, "_invoke_parsing", lambda *_args, **_kwargs: (True, None, None))

    outcome = orch.process_job_background(job_id)

    assert outcome.status == "completed"
    zip_path = job_dir / "result.zip"
    assert zip_path.exists()
    with zipfile.ZipFile(zip_path, "r") as zf:
        assert set(zf.namelist()) == {"raw.md", "status.json", "images/img1.png"}


def test_success_zip_skips_symlinked_images(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    orch = _reload_orchestrator(monkeypatch, tmp_path)
    job_id = "job-zip-symlink"
    job_dir = tmp_path / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    orch._atomic_write_json(job_dir / "status.json", orch._default_status(job_id))
    (job_dir / "raw.md").write_text("raw", encoding="utf-8")
    images_dir = job_dir / "images"
    images_dir.mkdir()
    (images_dir / "img1.png").write_text("img", encoding="utf-8")
    outside_file = tmp_path / "secret.txt"
    outside_file.write_text("secret", encoding="utf-8")
    (images_dir / "leak.txt").symlink_to(outside_file)

    monkeypatch.setattr(orch.pipeline, "_invoke_parsing", lambda *_args, **_kwargs: (True, None, None))

    outcome = orch.process_job_background(job_id)

    assert outcome.status == "completed"
    with zipfile.ZipFile(job_dir / "result.zip", "r") as zf:
        assert set(zf.namelist()) == {"raw.md", "status.json", "images/img1.png"}


def test_free_output_profile_zip_excludes_status(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    orch = _reload_orchestrator(monkeypatch, tmp_path)
    job_id = "job-free-zip"
    job_dir = tmp_path / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    orch._atomic_write_json(job_dir / "status.json", orch._default_status(job_id))
    (job_dir / "raw.md").write_text("raw", encoding="utf-8")
    images_dir = job_dir / "images"
    images_dir.mkdir()
    (images_dir / "img1.png").write_text("img", encoding="utf-8")

    monkeypatch.setattr(orch.pipeline, "_invoke_parsing", lambda *_args, **_kwargs: (True, None, None))

    outcome = orch.process_job_background(
        job_id,
        options={
            "output_profile": "parseotter_free_v1",
        },
    )

    assert outcome.status == "completed"
    zip_path = job_dir / "result.zip"
    assert zip_path.exists()
    with zipfile.ZipFile(zip_path, "r") as zf:
        assert set(zf.namelist()) == {"raw.md", "images/img1.png"}


def test_parsing_failure_propagates_error(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    orch = _reload_orchestrator(monkeypatch, tmp_path)
    job_id = "job-parse-fail"
    job_dir = tmp_path / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    orch._atomic_write_json(job_dir / "status.json", orch._default_status(job_id))

    def fail_parse(*_args, **_kwargs):
        return {"success": False, "error_code": "GPU_OOM", "error_message": "oom"}

    monkeypatch.setattr(orch.pipeline, "_invoke_parsing", lambda *_args, **_kwargs: (False, "GPU_OOM", "oom"))

    outcome = orch.process_job_background(job_id)

    assert outcome.error_code == "GPU_OOM"
    status = orch._read_json(job_dir / "status.json")
    assert status.get("error_code") == "GPU_OOM"


def test_parsing_exception_records_failed_status_and_releases_lock(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    orch = _reload_orchestrator(monkeypatch, tmp_path)
    job_id = "job-parse-exception"
    job_dir = tmp_path / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    orch._atomic_write_json(job_dir / "status.json", orch._default_status(job_id))

    def fail_parse(*_args, **_kwargs):
        raise RuntimeError("modal crashed")

    monkeypatch.setattr(orch.pipeline, "_invoke_parsing", fail_parse)

    outcome = orch.process_job_background(job_id)
    status = orch._read_json(job_dir / "status.json")

    assert outcome.status == "failed"
    assert outcome.error_code == "MODAL_PROCESSING_FAILED"
    assert "RuntimeError" in status["error_message"]
    assert not (job_dir / ".processing.lock").exists()


def test_cache_hit_skips_parsing(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    job_root = tmp_path / "jobs"
    cache_root = tmp_path / "cache"
    job_root.mkdir(parents=True, exist_ok=True)
    cache_root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("MARKER_CACHE_DIR", str(cache_root))

    orch = _reload_orchestrator(monkeypatch, job_root)
    job_id = "job-cache-hit"
    job_dir = job_root / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    options = {"page_range": "", "force_ocr": False}
    (job_dir / "options.json").write_text(json.dumps(options), encoding="utf-8")
    status = orch._default_status(job_id)
    status["file_hash"] = "abc123"
    status["options"] = options
    orch._atomic_write_json(job_dir / "status.json", status)

    signature = orch._build_cache_signature("abc123", options)
    cache_key = orch._compute_cache_key(signature)
    cache_dir = cache_root / cache_key
    cache_dir.mkdir(parents=True, exist_ok=True)
    (cache_dir / "raw.md").write_text("cached", encoding="utf-8")
    images_dir = cache_dir / "images"
    images_dir.mkdir()
    (images_dir / "img1.png").write_text("img", encoding="utf-8")
    orch._atomic_write_json(cache_dir / "cache.json", {"signature": signature, "created_at": orch._now()})

    called = {"parsing": False}

    def fail_parse(*_args, **_kwargs):
        called["parsing"] = True
        return False, "PARSE_ERROR", "should not run"

    monkeypatch.setattr(orch.pipeline, "_invoke_parsing", fail_parse)

    outcome = orch.process_job_background(job_id)

    assert outcome.status == "completed"
    assert called["parsing"] is False
    assert (job_dir / "raw.md").read_text(encoding="utf-8") == "cached"
    assert (job_dir / "images" / "img1.png").exists()


def test_cache_hit_removes_stale_images_when_cache_has_none(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    job_root = tmp_path / "jobs"
    cache_root = tmp_path / "cache"
    job_root.mkdir(parents=True, exist_ok=True)
    cache_root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("MARKER_CACHE_DIR", str(cache_root))

    orch = _reload_orchestrator(monkeypatch, job_root)
    job_id = "job-cache-hit-no-images"
    job_dir = job_root / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    options = {"page_range": "", "force_ocr": False}
    (job_dir / "options.json").write_text(json.dumps(options), encoding="utf-8")
    status = orch._default_status(job_id)
    status["file_hash"] = "abc123"
    status["options"] = options
    orch._atomic_write_json(job_dir / "status.json", status)

    stale_images_dir = job_dir / "images"
    stale_images_dir.mkdir()
    (stale_images_dir / "stale.png").write_text("stale", encoding="utf-8")

    signature = orch._build_cache_signature("abc123", options)
    cache_dir = cache_root / orch._compute_cache_key(signature)
    cache_dir.mkdir(parents=True, exist_ok=True)
    (cache_dir / "raw.md").write_text("cached", encoding="utf-8")
    orch._atomic_write_json(cache_dir / "cache.json", {"signature": signature, "created_at": orch._now()})

    called = {"parsing": False}

    def fail_parse(*_args, **_kwargs):
        called["parsing"] = True
        return False, "PARSE_ERROR", "should not run"

    monkeypatch.setattr(orch.pipeline, "_invoke_parsing", fail_parse)

    outcome = orch.process_job_background(job_id)

    assert outcome.status == "completed"
    assert called["parsing"] is False
    assert (job_dir / "raw.md").read_text(encoding="utf-8") == "cached"
    assert not stale_images_dir.exists()
    with zipfile.ZipFile(job_dir / "result.zip", "r") as zf:
        assert set(zf.namelist()) == {"raw.md", "status.json"}


def test_cache_signature_mismatch_does_not_restore_old_cache(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    job_root = tmp_path / "jobs"
    cache_root = tmp_path / "cache"
    job_root.mkdir(parents=True, exist_ok=True)
    cache_root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("MARKER_CACHE_DIR", str(cache_root))

    orch = _reload_orchestrator(monkeypatch, job_root)
    job_id = "job-cache-miss-signature"
    job_dir = job_root / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    current_options = {"page_range": "2"}
    status = orch._default_status(job_id)
    status["file_hash"] = "abc123"
    orch._atomic_write_json(job_dir / "status.json", status)

    old_signature = orch._build_cache_signature("abc123", {"page_range": "1"})
    cache_dir = cache_root / orch._compute_cache_key(orch._build_cache_signature("abc123", current_options))
    cache_dir.mkdir(parents=True)
    (cache_dir / "raw.md").write_text("old-cache", encoding="utf-8")
    orch._atomic_write_json(cache_dir / "cache.json", {"signature": old_signature, "created_at": orch._now()})

    called = {"parsing": False}

    def parse(*_args, **_kwargs):
        called["parsing"] = True
        (job_dir / "raw.md").write_text("fresh", encoding="utf-8")
        return True, None, None

    monkeypatch.setattr(orch.pipeline, "_invoke_parsing", parse)

    outcome = orch.process_job_background(job_id, options=current_options)

    assert outcome.status == "completed"
    assert called["parsing"] is True
    assert (job_dir / "raw.md").read_text(encoding="utf-8") == "fresh"


def test_completed_stage_marker_skips_repeated_parse(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    orch = _reload_orchestrator(monkeypatch, tmp_path)
    job_id = "job-stage-markers"
    job_dir = tmp_path / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    orch._atomic_write_json(job_dir / "status.json", orch._default_status(job_id))
    (job_dir / "raw.md").write_text("raw", encoding="utf-8")
    orch._mark_stage_done(job_dir, "parsing", {"cache_hit": False})

    called = {"parse": False}

    def parse(*_args, **_kwargs):
        called["parse"] = True
        return False, "PARSE_ERROR", "should not run"

    monkeypatch.setattr(orch.pipeline, "_invoke_parsing", parse)

    outcome = orch.process_job_background(job_id)

    assert outcome.status == "completed"
    assert called == {"parse": False}
