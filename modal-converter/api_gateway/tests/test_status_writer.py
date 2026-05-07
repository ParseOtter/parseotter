import importlib.util
from pathlib import Path
import json
import io
import time

import pytest


def load_module():
    root = Path(__file__).resolve().parents[1]
    path = root / "status_writer.py"
    spec = importlib.util.spec_from_file_location("api_gateway.status_writer", str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_create_initial_status_success(tmp_path):
    mod_storage_spec = importlib.util.spec_from_file_location(
        "api_gateway.storage", str(Path(__file__).resolve().parents[1] / "storage.py")
    )
    storage = importlib.util.module_from_spec(mod_storage_spec)
    mod_storage_spec.loader.exec_module(storage)

    # create job dir using storage writer
    job_root = str(tmp_path / "jobs")
    job_id = "job-1"
    data = b"pdf content"
    stream = io.BytesIO(data)
    storage.write_job_files(job_root, job_id, stream, file_name="original.pdf", options={"o":1})

    mod = load_module()
    status_path = mod.create_initial_status(job_root, job_id, "original.pdf", len(data), file_hash="abc123", options={"o":1})

    assert status_path.exists()
    content = json.loads(status_path.read_text(encoding="utf-8"))
    assert content["job_id"] == job_id
    assert content["status"] == "pending"
    assert content["file_name"] == "original.pdf"
    assert content["file_size"] == len(data)
    assert content["file_hash"] == "abc123"
    assert content["options"]["o"] == 1


def test_create_initial_status_missing_dir(tmp_path):
    mod = load_module()
    job_root = str(tmp_path / "jobs")
    job_id = "missing"
    try:
        mod.create_initial_status(job_root, job_id, "original.pdf", 10)
        raised = False
    except Exception:
        raised = True
    assert raised


def test_create_initial_status_uses_none_defaults(tmp_path, monkeypatch):
    mod = load_module()
    job_root = tmp_path / "jobs"
    job_id = "job-defaults"
    (job_root / job_id).mkdir(parents=True)
    monkeypatch.setattr(mod.time, "time", lambda: 1234.9)

    status_path = mod.create_initial_status(str(job_root), job_id, "original.pdf", 12)

    content = json.loads(status_path.read_text(encoding="utf-8"))
    assert content["created_at"] == 1234
    assert content["file_hash"] is None
    assert content["options"] is None


def test_create_initial_status_rejects_invalid_json_without_clobbering(tmp_path):
    mod = load_module()
    job_root = tmp_path / "jobs"
    job_id = "job-existing"
    job_dir = job_root / job_id
    job_dir.mkdir(parents=True)
    status_path = job_dir / "status.json"
    status_path.write_text(json.dumps({"status": "old"}), encoding="utf-8")

    with pytest.raises(mod.StatusWriterError, match="failed to write status.json"):
        mod.create_initial_status(str(job_root), job_id, "original.pdf", 12, file_hash=float("nan"))

    assert json.loads(status_path.read_text(encoding="utf-8")) == {"status": "old"}
