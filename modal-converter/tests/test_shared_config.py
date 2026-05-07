import pytest

from shared.config import load_config
from shared.env import env_first, read_float_env, read_optional_str_env
from shared.error_codes import ErrorCode
from orchestrator.retry import RETRY_POLICY


def test_load_config_covers_core_env_overrides(monkeypatch):
    monkeypatch.setenv("MODAL_APP_NAME", "marker-prod")
    monkeypatch.setenv("MODAL_MODELS_VOLUME_NAME", "parseotter-models-test")
    monkeypatch.setenv("MODAL_CACHE_VOLUME_NAME", "parseotter-cache-test")
    monkeypatch.setenv("GPU_TYPE", "H100")
    monkeypatch.setenv("MARKER_JOB_DIR", "/tmp/jobs")
    monkeypatch.setenv("MARKER_CACHE_DIR", "/tmp/cache")
    monkeypatch.setenv("MARKER_PDFTEXT_WORKERS", "6")
    monkeypatch.setenv("MODAL_CALLBACK_MAX_ATTEMPTS", "5")
    monkeypatch.setenv("MARKER_SERVICE_MAX_CONTAINERS", "9")

    cfg = load_config(strict_gateway=False)

    assert cfg.modal_app_name == "marker-prod"
    assert cfg.modal_models_volume_name == "parseotter-models-test"
    assert cfg.modal_cache_volume_name == "parseotter-cache-test"
    assert cfg.gpu_type == "H100"
    assert cfg.marker_job_dir == "/tmp/jobs"
    assert cfg.marker_cache_dir == "/tmp/cache"
    assert cfg.marker_pdftext_workers == 6
    assert cfg.callback_max_attempts == 5
    assert cfg.service_max_containers == 9


def test_load_config_gateway_strictness_is_opt_in(monkeypatch):
    monkeypatch.setenv("MAX_UPLOAD_BYTES", "invalid")

    with pytest.raises(ValueError):
        load_config()

    cfg = load_config(strict_gateway=False)
    assert cfg.max_upload_bytes == 150 * 1024 * 1024


def test_load_config_empty_cors_origins_falls_back_to_wildcard(monkeypatch):
    monkeypatch.setenv("CORS_ORIGINS", " , ")

    cfg = load_config(strict_gateway=False)

    assert cfg.cors_origins == ["*"]


def test_read_float_env_supports_maximum(monkeypatch):
    monkeypatch.setenv("FLOAT_LIMIT", "3.5")
    assert read_float_env("FLOAT_LIMIT", 1.0, minimum=0.0, maximum=2.0) == 2.0

    monkeypatch.setenv("FLOAT_LIMIT", "-1")
    assert read_float_env("FLOAT_LIMIT", 1.0, minimum=0.0, maximum=2.0) == 1.0


def test_read_float_env_rejects_non_finite_values(monkeypatch):
    monkeypatch.setenv("FLOAT_LIMIT", "nan")
    assert read_float_env("FLOAT_LIMIT", 1.0, minimum=0.0) == 1.0

    monkeypatch.setenv("FLOAT_LIMIT", "inf")
    assert read_float_env("FLOAT_LIMIT", 1.0, minimum=0.0) == 1.0


def test_env_first_skips_empty_values(monkeypatch):
    monkeypatch.setenv("FIRST", " ")
    monkeypatch.setenv("SECOND", " value ")

    assert env_first("FIRST", "SECOND") == "value"


def test_read_optional_str_env_returns_none_for_blank(monkeypatch):
    monkeypatch.setenv("OPTIONAL_VALUE", " ")

    assert read_optional_str_env("OPTIONAL_VALUE") is None


def test_error_codes_match_retry_policy_codes():
    expected_retry_codes = {
        ErrorCode.FILE_NOT_FOUND,
        ErrorCode.OPTIONS_INVALID,
        ErrorCode.GPU_OOM,
        ErrorCode.PARSE_ERROR,
        ErrorCode.INTERNAL_ERROR,
        ErrorCode.MODAL_PROCESSING_FAILED,
    }

    assert ErrorCode.FILE_NOT_FOUND == "FILE_NOT_FOUND"
    assert set(RETRY_POLICY) == expected_retry_codes
    assert RETRY_POLICY[ErrorCode.MODAL_PROCESSING_FAILED][0] is True
