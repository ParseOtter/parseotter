import io
import json
from pathlib import Path
import importlib.util

import pytest


def load_module():
    root = Path(__file__).resolve().parents[1]
    path = root / "storage.py"
    spec = importlib.util.spec_from_file_location("api_gateway.storage", str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_write_job_files_success(tmp_path):
    mod = load_module()
    job_root = str(tmp_path / "jobs")
    job_id = "job123"
    data = b"pdf-binary-content"
    stream = io.BytesIO(data)
    options = {"page_range": "1-2"}

    final_dir = mod.write_job_files(job_root, job_id, stream, file_name="original.pdf", options=options)

    assert final_dir.exists()
    original = final_dir / "original.pdf"
    opts = final_dir / "options.json"
    assert original.exists()
    assert original.read_bytes() == data
    assert opts.exists()
    loaded = json.loads(opts.read_text(encoding="utf-8"))
    assert loaded["page_range"] == "1-2"


def test_write_job_files_conflict(tmp_path):
    mod = load_module()
    job_root = str(tmp_path / "jobs")
    job_id = "job123"
    (tmp_path / "jobs" / job_id).mkdir(parents=True)
    stream = io.BytesIO(b"x")

    try:
        mod.write_job_files(job_root, job_id, stream)
        raised = False
    except Exception:
        raised = True

    assert raised


def test_write_job_files_cleans_temp_dir_when_options_write_fails(tmp_path, monkeypatch):
    mod = load_module()
    job_root = tmp_path / "jobs"
    job_id = "job123"

    def fail_write_json(_path, _data):
        raise ValueError("options cannot be serialized")

    monkeypatch.setattr(mod, "atomic_write_json", fail_write_json)

    with pytest.raises(mod.StorageError, match="options cannot be serialized"):
        mod.write_job_files(str(job_root), job_id, io.BytesIO(b"pdf"), options={"bad": object()})

    assert not (job_root / job_id).exists()
    assert not (job_root / f".{job_id}.tmp").exists()
