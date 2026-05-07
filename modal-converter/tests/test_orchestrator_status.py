import json
from pathlib import Path

import pytest

import orchestrator.retry as retry_mod
import orchestrator.status as status_mod
from shared.context import JobContext
from shared.error_codes import ErrorCode


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_record_failure_updates_retry_state_and_caps_history(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    status_path = tmp_path / "status.json"
    monkeypatch.setattr(status_mod, "_now", lambda: 1_000)
    monkeypatch.setattr(retry_mod, "_now", lambda: 1_000)
    commits = []
    base = {
        "job_id": "job-status",
        "progress": 25,
        "retry_count": 0,
        "retry_history": [
            {"ts": 1, "phase": "old-1"},
            {"ts": 2, "phase": "old-2"},
            {"ts": 3, "phase": "old-3"},
        ],
    }

    updated = status_mod._record_failure(
        status_path,
        base,
        "parsing",
        ErrorCode.PARSE_ERROR,
        "parse failed",
        ctx=JobContext(commit_cache=lambda: commits.append("commit")),
    )

    assert updated["status"] == "failed"
    assert updated["phase"] == "parsing"
    assert updated["progress"] == 25
    assert updated["retry_count"] == 1
    assert updated["next_retry_at"] == 1_030
    assert [item["phase"] for item in updated["retry_history"]] == ["old-2", "old-3", "parsing"]
    assert commits == ["commit"]
    assert _read_json(status_path) == updated


def test_record_success_with_warning_deduplicates_by_code_and_source(tmp_path: Path):
    status_path = tmp_path / "status.json"
    base = {
        "job_id": "job-status",
        "warnings": [
            {"code": "metadata_unavailable", "source": "marker", "message": "old"},
        ],
    }

    first = status_mod._record_success_with_warning(
        status_path,
        base,
        {"code": "metadata_unavailable", "source": "marker", "message": "new"},
        "completed with warning",
    )
    second = status_mod._record_success_with_warning(
        status_path,
        first,
        {"code": "metadata_unavailable", "source": "cache", "message": "new source"},
        "completed with warning",
    )

    assert first["status"] == "completed"
    assert len(first["warnings"]) == 1
    assert len(second["warnings"]) == 2
    assert second["warnings"][1]["source"] == "cache"


def test_status_write_succeeds_when_commit_callback_fails(tmp_path: Path):
    status_path = tmp_path / "status.json"

    def fail_commit() -> None:
        raise RuntimeError("volume commit failed")

    updated = status_mod._record_success(
        status_path,
        {"job_id": "job-status"},
        ctx=JobContext(commit_cache=fail_commit),
    )

    assert updated["status"] == "completed"
    assert _read_json(status_path)["status"] == "completed"


def test_read_json_returns_empty_dict_for_non_object_json(tmp_path: Path):
    status_path = tmp_path / "status.json"
    status_path.write_text("[1, 2]", encoding="utf-8")

    assert status_mod._read_json(status_path) == {}
