import json
from pathlib import Path

import pytest

import orchestrator.cache as cache_mod
from shared.config import Config


def _config(tmp_path: Path, *, cache_ttl_seconds: int = 86400) -> Config:
    return Config(
        marker_job_dir=str(tmp_path / "jobs"),
        marker_cache_dir=str(tmp_path / "cache"),
        cache_ttl_seconds=cache_ttl_seconds,
    )


def _write_cache_info(cache_dir: Path, signature: dict, *, created_at: int = 1_000) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    (cache_dir / "cache.json").write_text(
        json.dumps({"signature": signature, "created_at": created_at}),
        encoding="utf-8",
    )


def test_cache_is_valid_removes_expired_cache(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    signature = {"file_hash": "abc", "options": {}}
    cache_dir = tmp_path / "cache" / "key"
    _write_cache_info(cache_dir, signature, created_at=1_000)
    (cache_dir / "raw.md").write_text("cached", encoding="utf-8")
    monkeypatch.setattr(cache_mod.time, "time", lambda: 1_100)

    assert cache_mod._cache_is_valid(cache_dir, signature, _config(tmp_path, cache_ttl_seconds=10)) is False
    assert not cache_dir.exists()


def test_cache_is_valid_treats_non_object_cache_info_as_invalid(tmp_path: Path):
    signature = {"file_hash": "abc", "options": {}}
    cache_dir = tmp_path / "cache" / "key"
    cache_dir.mkdir(parents=True)
    (cache_dir / "cache.json").write_text("[1, 2]", encoding="utf-8")
    (cache_dir / "raw.md").write_text("cached", encoding="utf-8")

    assert cache_mod._cache_is_valid(cache_dir, signature, _config(tmp_path, cache_ttl_seconds=0)) is False


def test_store_cached_parse_replaces_existing_cache_without_stale_artifacts(tmp_path: Path):
    signature = {"file_hash": "abc", "options": {"page_range": "1"}}
    job_dir = tmp_path / "jobs" / "job-cache"
    cache_dir = tmp_path / "cache" / "key"
    job_dir.mkdir(parents=True)
    job_dir.joinpath("raw.md").write_text("new raw", encoding="utf-8")
    cache_dir.joinpath("images").mkdir(parents=True)
    cache_dir.joinpath("images", "stale.png").write_bytes(b"stale")
    cache_dir.joinpath("metadata.json").write_text("{}", encoding="utf-8")
    cache_dir.joinpath("raw.md").write_text("old raw", encoding="utf-8")

    cache_mod._store_cached_parse(job_dir, cache_dir, signature)

    assert (cache_dir / "raw.md").read_text(encoding="utf-8") == "new raw"
    assert not (cache_dir / "images").exists()
    assert not (cache_dir / "metadata.json").exists()
    assert json.loads((cache_dir / "cache.json").read_text(encoding="utf-8"))["signature"] == signature


def test_restore_cached_parse_removes_stale_optional_job_artifacts(tmp_path: Path):
    signature = {"file_hash": "abc", "options": {}}
    job_dir = tmp_path / "jobs" / "job-cache"
    cache_dir = tmp_path / "cache" / "key"
    job_dir.mkdir(parents=True)
    job_dir.joinpath("raw.md").write_text("old raw", encoding="utf-8")
    job_dir.joinpath("metadata.json").write_text("old metadata", encoding="utf-8")
    job_dir.joinpath("progress.parsing.json").write_text("old progress", encoding="utf-8")
    job_dir.joinpath("images").mkdir()
    job_dir.joinpath("images", "stale.png").write_bytes(b"stale")
    _write_cache_info(cache_dir, signature)
    cache_dir.joinpath("raw.md").write_text("cached raw", encoding="utf-8")

    assert cache_mod._restore_cached_parse(
        job_dir,
        cache_dir,
        signature,
        config=_config(tmp_path, cache_ttl_seconds=0),
    ) is True

    assert (job_dir / "raw.md").read_text(encoding="utf-8") == "cached raw"
    assert not (job_dir / "metadata.json").exists()
    assert not (job_dir / "progress.parsing.json").exists()
    assert not (job_dir / "images").exists()


def test_store_cached_parse_cleans_temp_dir_on_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    signature = {"file_hash": "abc", "options": {}}
    job_dir = tmp_path / "jobs" / "job-cache"
    cache_dir = tmp_path / "cache" / "key"
    job_dir.mkdir(parents=True)
    job_dir.joinpath("raw.md").write_text("new raw", encoding="utf-8")

    def fail_copy(_src: Path, _dst: Path) -> None:
        raise RuntimeError("copy failed")

    monkeypatch.setattr(cache_mod, "_copy_file_if_exists", fail_copy)

    with pytest.raises(RuntimeError, match="copy failed"):
        cache_mod._store_cached_parse(job_dir, cache_dir, signature)

    assert list(cache_dir.parent.glob(f".{cache_dir.name}.*.tmp")) == []
    assert not cache_dir.exists()
