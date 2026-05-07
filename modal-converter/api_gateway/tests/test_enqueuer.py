import importlib.util
import builtins
import json
from pathlib import Path

import pytest


def load_module():
    root = Path(__file__).resolve().parents[1]
    path = root / "enqueuer.py"
    spec = importlib.util.spec_from_file_location("api_gateway.enqueuer", str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_create_enqueue_success(tmp_path):
    # prepare a job dir
    job_root = tmp_path / "jobs"
    job_id = "jobA"
    job_dir = job_root / job_id
    job_dir.mkdir(parents=True)

    mod = load_module()
    path = mod.create_enqueue_trigger(str(job_root), job_id, payload="test")

    assert path.exists()
    text = path.read_text(encoding="utf-8")
    loaded = json.loads(text)
    assert isinstance(loaded["enqueued_at"], int)
    assert loaded["payload"] == "test"


def test_create_enqueue_missing_dir(tmp_path):
    job_root = tmp_path / "jobs"
    job_id = "doesnotexist"
    mod = load_module()
    try:
        mod.create_enqueue_trigger(str(job_root), job_id)
        raised = False
    except Exception:
        raised = True
    assert raised


def test_create_enqueue_overwrites_existing_trigger(tmp_path, monkeypatch):
    job_root = tmp_path / "jobs"
    job_id = "jobA"
    job_dir = job_root / job_id
    job_dir.mkdir(parents=True)
    (job_dir / ".enqueue").write_text("old\n", encoding="utf-8")
    mod = load_module()
    monkeypatch.setattr(mod.time, "time", lambda: 1234.9)

    path = mod.create_enqueue_trigger(str(job_root), job_id, payload="new")

    loaded = json.loads(path.read_text(encoding="utf-8"))
    assert loaded == {"enqueued_at": 1234, "payload": "new"}


def test_create_enqueue_failure_does_not_clobber_existing_trigger(tmp_path, monkeypatch):
    job_root = tmp_path / "jobs"
    job_id = "jobA"
    job_dir = job_root / job_id
    job_dir.mkdir(parents=True)
    enqueue_path = job_dir / ".enqueue"
    enqueue_path.write_text("old\n", encoding="utf-8")
    mod = load_module()
    original_open = builtins.open

    class FailingFile:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def write(self, _content):
            raise OSError("disk full")

        def flush(self):
            pass

    def fail_open(path, mode="r", *args, **kwargs):
        path_obj = Path(path)
        if path_obj.name.startswith(".enqueue") and mode == "w":
            if path_obj == enqueue_path:
                original_open(path, mode, encoding=kwargs.get("encoding", "utf-8")).close()
            return FailingFile()
        return original_open(path, mode, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", fail_open)

    with pytest.raises(mod.EnqueueError, match="failed to create enqueue trigger"):
        mod.create_enqueue_trigger(str(job_root), job_id, payload="new")

    assert enqueue_path.read_text(encoding="utf-8") == "old\n"
