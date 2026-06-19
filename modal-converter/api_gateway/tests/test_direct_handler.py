import os
import sys
import json
import importlib.util
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient
from fastapi import FastAPI


def load_direct_handler_module(job_root_env: str):
    os.environ["MARKER_JOB_DIR"] = job_root_env
    os.environ["DIRECT_ENABLED"] = "1"

    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location(
        "api_gateway.direct_handler",
        str(root / "direct_handler.py"),
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["api_gateway.direct_handler"] = mod
    spec.loader.exec_module(mod)
    return mod


class FakeOutcome:
    def __init__(self, status="complete", error_message=None):
        self.status = status
        self.error_message = error_message


def build_app(job_root_env: str):
    os.environ.pop("API_SECRET", None)
    mod = load_direct_handler_module(job_root_env)
    app = FastAPI()
    app.state.job_ctx = MagicMock()
    app.include_router(mod.router, prefix="/api")
    return app


@pytest.fixture
def job_dir(tmp_path):
    return tmp_path


@pytest.fixture
def client(job_dir):
    app = build_app(str(job_dir))
    return TestClient(app)


def simulate_job_output(job_dir_path: Path, job_id: str):
    (job_dir_path / "raw.md").write_text("# Hello World\n", encoding="utf-8")
    (job_dir_path / "metadata.json").write_text(
        json.dumps({"page_count": 5, "timings": {"total_seconds": 12.5}, "runtime": {"gpu_type": "H100"}}),
        encoding="utf-8",
    )
    (job_dir_path / "images").mkdir(exist_ok=True)
    (job_dir_path / "status.json").write_text(
        json.dumps({"status": "complete", "job_id": job_id, "page_count": 5}),
        encoding="utf-8",
    )


# ---- POST /api/direct/convert ----


def test_convert_success(client, job_dir):
    pdf_content = b"dummy pdf content"
    files = {"file": ("test.pdf", pdf_content, "application/pdf")}

    with patch("api_gateway.direct_handler.process_job_background") as mock_process:
        def side_effect(job_id, options=None, ctx=None):
            simulate_job_output(job_dir / job_id, job_id)
            return FakeOutcome(status="complete")

        mock_process.side_effect = side_effect

        resp = client.post("/api/direct/convert", files=files)

    assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
    data = resp.json()
    assert data["status"] == "complete"
    assert data["markdown"] == "# Hello World\n"
    assert data["images"] == []
    assert data["metadata"]["page_count"] == 5
    assert data["metadata"]["processing_time_ms"] == 12500
    assert data["metadata"]["gpu_type"] == "H100"
    assert data["metadata"]["renderer_version"] == "marker-pdf"
    assert data["job_id"].startswith("direct_")


def test_convert_unsupported_extension(client):
    files = {"file": ("test.txt", b"hello", "text/plain")}
    resp = client.post("/api/direct/convert", files=files)
    assert resp.status_code == 400
    assert "Unsupported file type" in resp.text


def test_convert_with_options(client, job_dir):
    pdf_content = b"dummy"
    files = {"file": ("test.pdf", pdf_content, "application/pdf")}

    with patch("api_gateway.direct_handler.process_job_background") as mock_process:
        def side_effect(job_id, options=None, ctx=None):
            simulate_job_output(job_dir / job_id, job_id)
            return FakeOutcome(status="complete")
        mock_process.side_effect = side_effect

        resp = client.post(
            "/api/direct/convert",
            files=files,
            data={"page_range": "1-3", "max_pages": 5},
        )

    assert resp.status_code == 200
    call_kwargs = mock_process.call_args_list[0][1]
    assert call_kwargs["options"] == {"page_range": "1-3", "max_pages": 5}


def test_convert_disabled(tmp_path, monkeypatch):
    app = build_app(str(tmp_path))
    monkeypatch.delenv("DIRECT_ENABLED", raising=False)
    client = TestClient(app)
    files = {"file": ("test.pdf", b"dummy", "application/pdf")}
    resp = client.post("/api/direct/convert", files=files)
    assert resp.status_code == 503


def test_convert_file_too_large(client, job_dir):
    pdf_content = b"x" * (150 * 1024 * 1024 + 1)
    files = {"file": ("test.pdf", pdf_content, "application/pdf")}
    resp = client.post("/api/direct/convert", files=files)
    assert resp.status_code == 413


def test_convert_internal_error(client, job_dir):
    files = {"file": ("test.pdf", b"dummy", "application/pdf")}

    with patch("api_gateway.direct_handler.process_job_background") as mock_process:
        mock_process.side_effect = RuntimeError("GPU OOM")

        resp = client.post("/api/direct/convert", files=files)

    assert resp.status_code == 500
    assert "GPU OOM" in resp.text


def test_convert_orchestrator_failure(client, job_dir):
    pdf_content = b"dummy"
    files = {"file": ("test.pdf", pdf_content, "application/pdf")}

    with patch("api_gateway.direct_handler.process_job_background") as mock_process:
        mock_process.return_value = FakeOutcome(status="failed", error_message="Model load error")

        resp = client.post("/api/direct/convert", files=files)

    assert resp.status_code == 500
    assert "Model load error" in resp.text


# ---- GET /api/direct/jobs/{job_id} ----


def test_get_status_success(client, job_dir):
    job_id = "direct_test_job"
    job_path = job_dir / job_id
    job_path.mkdir(parents=True)
    (job_path / "status.json").write_text(
        json.dumps({"status": "processing", "job_id": job_id}),
        encoding="utf-8",
    )

    resp = client.get(f"/api/direct/jobs/{job_id}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["job_id"] == job_id
    assert data["status"]["status"] == "processing"


def test_get_status_not_found(client, job_dir):
    resp = client.get("/api/direct/jobs/nonexistent_job")
    assert resp.status_code == 404


def test_get_status_no_status_file(client, job_dir):
    job_id = "no_status_job"
    (job_dir / job_id).mkdir(parents=True)
    resp = client.get(f"/api/direct/jobs/{job_id}")
    assert resp.status_code == 404


def test_get_status_corrupted(client, job_dir):
    job_id = "corrupted_status"
    job_path = job_dir / job_id
    job_path.mkdir(parents=True)
    (job_path / "status.json").write_text("not json", encoding="utf-8")

    resp = client.get(f"/api/direct/jobs/{job_id}")
    assert resp.status_code == 500


def test_get_status_invalid_job_id(client, job_dir):
    resp = client.get("/api/direct/jobs/.hidden")
    assert resp.status_code == 400


# ---- GET /api/direct/jobs/{job_id}/result ----


def test_get_result_success(client, job_dir):
    job_id = "direct_result_job"
    job_path = job_dir / job_id
    job_path.mkdir(parents=True)
    (job_path / "status.json").write_text(
        json.dumps({"status": "complete", "job_id": job_id}),
        encoding="utf-8",
    )
    (job_path / "raw.md").write_text("# Result\n", encoding="utf-8")
    (job_path / "images").mkdir()
    (job_path / "metadata.json").write_text(
        json.dumps({"page_count": 3, "timings": {"total_seconds": 5.0}, "runtime": {"gpu_type": "H100"}}),
        encoding="utf-8",
    )

    resp = client.get(f"/api/direct/jobs/{job_id}/result")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "complete"
    assert data["markdown"] == "# Result\n"
    assert data["metadata"]["processing_time_ms"] == 5000


def test_get_result_not_complete(client, job_dir):
    job_id = "incomplete"
    job_path = job_dir / job_id
    job_path.mkdir(parents=True)
    (job_path / "status.json").write_text(
        json.dumps({"status": "processing"}),
        encoding="utf-8",
    )

    resp = client.get(f"/api/direct/jobs/{job_id}/result")
    assert resp.status_code == 400


def test_get_result_status_not_found(client, job_dir):
    job_id = "no_result_status"
    job_path = job_dir / job_id
    job_path.mkdir(parents=True)

    resp = client.get(f"/api/direct/jobs/{job_id}/result")
    assert resp.status_code == 404


def test_get_result_missing_markdown(client, job_dir):
    job_id = "missing_md"
    job_path = job_dir / job_id
    job_path.mkdir(parents=True)
    (job_path / "status.json").write_text(
        json.dumps({"status": "complete"}),
        encoding="utf-8",
    )

    resp = client.get(f"/api/direct/jobs/{job_id}/result")
    assert resp.status_code == 500


def test_get_result_status_not_dict(client, job_dir):
    job_id = "not_dict"
    job_path = job_dir / job_id
    job_path.mkdir(parents=True)
    (job_path / "status.json").write_text(
        json.dumps(["not_a_dict"]),
        encoding="utf-8",
    )

    resp = client.get(f"/api/direct/jobs/{job_id}/result")
    assert resp.status_code == 400
    assert "not a dict" in resp.text
