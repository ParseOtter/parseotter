import importlib.util
import io
import json
import os
import sys
import zipfile
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from shared.context import JobContext


def load_handlers_module(job_root_env: str):
    os.environ["MARKER_JOB_DIR"] = job_root_env

    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location(
        "api_gateway.handlers",
        str(root / "handlers.py"),
    )
    handlers = importlib.util.module_from_spec(spec)
    sys.modules["api_gateway.handlers"] = handlers
    spec.loader.exec_module(handlers)
    return handlers


def build_app(job_root_env: str, *, api_secret: str | None = None):
    if api_secret is None:
        os.environ.pop("API_SECRET", None)
    else:
        os.environ["API_SECRET"] = api_secret

    handlers = load_handlers_module(job_root_env)
    app = FastAPI()
    app.include_router(handlers.router, prefix="/api")
    return app


def test_get_job_status_api_key_required_when_secret_configured(tmp_path):
    job_root = tmp_path / "jobs"
    job_root.mkdir(parents=True, exist_ok=True)
    job_id = "api-key-job"
    job_dir = job_root / job_id
    job_dir.mkdir()
    (job_dir / "status.json").write_text(json.dumps({"job_id": job_id, "status": "pending"}), encoding="utf-8")

    client = TestClient(build_app(str(job_root), api_secret="s3cr3t"))

    denied = client.get(f"/api/jobs/{job_id}")
    assert denied.status_code == 401

    allowed = client.get(f"/api/jobs/{job_id}", headers={"X-API-KEY": "s3cr3t"})
    assert allowed.status_code == 200


def test_get_job_status_returns_status_payload(tmp_path):
    job_root = tmp_path / "jobs"
    job_root.mkdir(parents=True, exist_ok=True)
    job_id = "job-status"
    job_dir = job_root / job_id
    job_dir.mkdir()
    (job_dir / "status.json").write_text(
        json.dumps({"job_id": job_id, "status": "processing"}),
        encoding="utf-8",
    )

    client = TestClient(build_app(str(job_root)))

    response = client.get(f"/api/jobs/{job_id}")
    assert response.status_code == 200
    assert response.json() == {"job_id": job_id, "status": "processing"}


def test_get_job_status_ignores_reload_cache_failure(tmp_path):
    job_root = tmp_path / "jobs"
    job_root.mkdir(parents=True, exist_ok=True)
    job_id = "job-status"
    job_dir = job_root / job_id
    job_dir.mkdir()
    (job_dir / "status.json").write_text(
        json.dumps({"job_id": job_id, "status": "processing"}),
        encoding="utf-8",
    )
    app = build_app(str(job_root))
    app.state.job_ctx = JobContext(reload_cache=lambda: (_ for _ in ()).throw(RuntimeError("reload failed")))
    client = TestClient(app)

    response = client.get(f"/api/jobs/{job_id}")

    assert response.status_code == 200
    assert response.json()["status"] == "processing"


def test_public_job_routes_reject_unsafe_job_id(tmp_path):
    job_root = tmp_path / "jobs"
    job_root.mkdir(parents=True, exist_ok=True)
    client = TestClient(build_app(str(job_root)))

    for path in [
        "/api/jobs/../escape",
        "/api/jobs/bad%2Fid",
        "/api/jobs/bad id",
        "/api/jobs/.hidden",
    ]:
        response = client.get(path)
        assert response.status_code in {400, 404}
        if response.status_code == 400:
            assert response.json()["detail"] == "invalid job_id"

    response = client.get("/api/jobs/bad%5Cid/download")
    assert response.status_code == 400
    assert response.json()["detail"] == "invalid job_id"


def test_download_returns_zip_for_partial_artifacts(tmp_path):
    job_root = tmp_path / "jobs"
    job_root.mkdir(parents=True, exist_ok=True)
    job_id = "partial"
    job_dir = job_root / job_id
    job_dir.mkdir()
    (job_dir / "status.json").write_text(json.dumps({"job_id": job_id, "status": "failed"}), encoding="utf-8")
    (job_dir / "raw.md").write_text("raw", encoding="utf-8")

    client = TestClient(build_app(str(job_root)))

    response = client.get(f"/api/jobs/{job_id}/download")
    assert response.status_code == 200
    archive = io.BytesIO(response.content)
    with zipfile.ZipFile(archive, "r") as zip_file:
        assert set(zip_file.namelist()) == {"raw.md", "status.json"}


def test_download_uses_cached_zip_when_present(tmp_path):
    job_root = tmp_path / "jobs"
    job_root.mkdir(parents=True, exist_ok=True)
    job_id = "zip-cached"
    job_dir = job_root / job_id
    job_dir.mkdir()
    status = {"job_id": job_id, "status": "completed"}
    (job_dir / "status.json").write_text(json.dumps(status), encoding="utf-8")
    (job_dir / "raw.md").write_text("from-disk", encoding="utf-8")

    zip_path = job_dir / "result.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zip_file:
        zip_file.writestr("raw.md", "from-zip")
        zip_file.writestr("status.json", json.dumps(status))

    client = TestClient(build_app(str(job_root)))

    response = client.get(f"/api/jobs/{job_id}/download")
    assert response.status_code == 200
    archive = io.BytesIO(response.content)
    with zipfile.ZipFile(archive, "r") as zip_file:
        assert zip_file.read("raw.md").decode("utf-8") == "from-zip"


def test_download_creates_cached_zip_when_missing(tmp_path):
    job_root = tmp_path / "jobs"
    job_root.mkdir(parents=True, exist_ok=True)
    job_id = "zip-miss"
    job_dir = job_root / job_id
    job_dir.mkdir()
    (job_dir / "status.json").write_text(json.dumps({"job_id": job_id, "status": "completed"}), encoding="utf-8")
    (job_dir / "raw.md").write_text("raw", encoding="utf-8")

    client = TestClient(build_app(str(job_root)))

    response = client.get(f"/api/jobs/{job_id}/download")
    assert response.status_code == 200
    assert (job_dir / "result.zip").exists()


def test_download_zip_skips_symlinked_images(tmp_path):
    job_root = tmp_path / "jobs"
    job_root.mkdir(parents=True, exist_ok=True)
    job_id = "zip-symlink"
    job_dir = job_root / job_id
    job_dir.mkdir()
    (job_dir / "status.json").write_text(json.dumps({"job_id": job_id, "status": "completed"}), encoding="utf-8")
    (job_dir / "raw.md").write_text("raw", encoding="utf-8")
    images_dir = job_dir / "images"
    images_dir.mkdir()
    (images_dir / "img1.png").write_text("img", encoding="utf-8")
    outside_file = tmp_path / "secret.txt"
    outside_file.write_text("secret", encoding="utf-8")
    (images_dir / "leak.txt").symlink_to(outside_file)

    client = TestClient(build_app(str(job_root)))

    response = client.get(f"/api/jobs/{job_id}/download")
    assert response.status_code == 200
    archive = io.BytesIO(response.content)
    with zipfile.ZipFile(archive, "r") as zip_file:
        assert set(zip_file.namelist()) == {"raw.md", "status.json", "images/img1.png"}


def test_download_fallback_respects_free_output_profile(tmp_path):
    job_root = tmp_path / "jobs"
    job_root.mkdir(parents=True, exist_ok=True)
    job_id = "free-fallback"
    job_dir = job_root / job_id
    job_dir.mkdir()
    (job_dir / "status.json").write_text(json.dumps({"job_id": job_id, "status": "completed"}), encoding="utf-8")
    (job_dir / "options.json").write_text(
        json.dumps({"output_profile": "parseotter_free_v1"}),
        encoding="utf-8",
    )
    (job_dir / "raw.md").write_text("raw", encoding="utf-8")

    client = TestClient(build_app(str(job_root)))

    response = client.get(f"/api/jobs/{job_id}/download")
    assert response.status_code == 200
    archive = io.BytesIO(response.content)
    with zipfile.ZipFile(archive, "r") as zip_file:
        assert set(zip_file.namelist()) == {"raw.md"}


def test_cloudflare_dispatch_local_fallback_failure_returns_500(tmp_path, monkeypatch):
    job_root = tmp_path / "jobs"
    handlers = load_handlers_module(str(job_root))
    monkeypatch.delenv("MODAL_TASK_ID", raising=False)
    monkeypatch.setattr(
        handlers,
        "load_config",
        lambda: SimpleNamespace(api_secret="modal-api-key", max_upload_bytes=1024, marker_job_dir=str(job_root)),
    )
    payload = {
        "jobId": "job-local",
        "attempt": 1,
        "input": {"sizeBytes": 1},
    }
    monkeypatch.setattr(handlers, "validate_dispatch_payload", lambda _body: payload)
    monkeypatch.setattr(
        handlers,
        "prepare_cloudflare_dispatch_job",
        lambda *_args, **_kwargs: {"accepted": True, "duplicate": False, "jobId": "job-local", "attempt": 1},
    )
    monkeypatch.setattr(
        handlers,
        "process_cloudflare_dispatch_job",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("local dispatch failed")),
    )
    app = FastAPI()
    app.state.job_ctx = JobContext()
    app.include_router(handlers.router, prefix="/api")
    client = TestClient(app)

    response = client.post(
        "/api/internal/cloudflare/jobs/dispatch",
        json={"ignored": True},
        headers={"X-API-KEY": "modal-api-key", "X-Idempotency-Key": "dispatch-key"},
    )

    assert response.status_code == 500
    assert "failed to process Cloudflare dispatch job: local dispatch failed" in response.json()["detail"]
