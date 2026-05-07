import pytest

import orchestrator.retry as retry_mod
from shared.error_codes import ErrorCode


def test_should_retry_returns_backoff_timestamp(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(retry_mod, "_now", lambda: 1_000)

    should_retry, next_retry_at = retry_mod._should_retry(ErrorCode.PARSE_ERROR, retry_count=0)

    assert should_retry is True
    assert next_retry_at == 1_030


def test_should_retry_stops_at_attempt_limit(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(retry_mod, "_now", lambda: 1_000)

    should_retry, next_retry_at = retry_mod._should_retry(ErrorCode.GPU_OOM, retry_count=1)

    assert should_retry is False
    assert next_retry_at is None


def test_should_retry_rejects_unknown_error_code():
    assert retry_mod._should_retry("UNKNOWN_ERROR", retry_count=0) == (False, None)
