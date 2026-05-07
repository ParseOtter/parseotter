import os
import importlib.util
from pathlib import Path
import pytest


def load_config_module():
    root = Path(__file__).resolve().parents[1]
    cfg_path = root / "config.py"
    spec = importlib.util.spec_from_file_location("api_gateway.config", str(cfg_path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_load_config_defaults(monkeypatch):
    monkeypatch.delenv("MARKER_JOB_DIR", raising=False)
    monkeypatch.delenv("MAX_UPLOAD_BYTES", raising=False)
    monkeypatch.delenv("CORS_ORIGINS", raising=False)
    monkeypatch.delenv("API_SECRET", raising=False)

    cfg_mod = load_config_module()
    cfg = cfg_mod.load_config()

    assert cfg.marker_job_dir == "/cache/marker-jobs"
    assert cfg.max_upload_bytes == 150 * 1024 * 1024
    assert isinstance(cfg.cors_origins, list)


def test_load_config_overrides(monkeypatch):
    monkeypatch.setenv("MARKER_JOB_DIR", "/tmp/jobs")
    monkeypatch.setenv("MAX_UPLOAD_BYTES", "1024")
    monkeypatch.setenv("CORS_ORIGINS", "https://example.com, https://a.com")
    monkeypatch.setenv("API_SECRET", "s3cr3t")

    cfg_mod = load_config_module()
    cfg = cfg_mod.load_config()

    assert cfg.marker_job_dir == "/tmp/jobs"
    assert cfg.max_upload_bytes == 1024
    assert cfg.cors_origins == ["https://example.com", "https://a.com"]
    assert cfg.api_secret == "s3cr3t"


def test_invalid_max_upload_bytes(monkeypatch):
    monkeypatch.setenv("MAX_UPLOAD_BYTES", "not-an-int")
    cfg_mod = load_config_module()
    with pytest.raises(ValueError):
        cfg_mod.load_config()
