"""
End-to-end (optional) integration test for Orchestrator with real Module C/D.

This test is opt-in to avoid heavy dependencies (models, GPU). To run:

  ORCH_E2E=1 \
  ORCH_SAMPLE_PDF=tests/part.pdf \
  MARKER_JOB_DIR=/cache/marker-jobs \
  pytest tests/test_orchestrator_e2e.py -q

Requirements:
- Module C must be able to load models in the current environment (run_marker_inference_core(models_obj=...)).
- This test will xfail gracefully when prerequisites are missing (e.g., model not ready).
"""

from __future__ import annotations

import io
import json
import os
import uuid
from pathlib import Path, PurePosixPath

import modal
import pytest


DEFAULT_APP_NAME = "parseotter-converter-dev"
DEFAULT_CACHE_VOLUME_NAME = "parseotter-cache-dev"
DEFAULT_MARKER_JOB_DIR = "/cache/marker-jobs"
CACHE_MOUNT_PATH = "/cache"


def _app_name() -> str:
    return os.getenv("ORCH_MODAL_APP", DEFAULT_APP_NAME)


def _cache_volume_name() -> str:
    return os.getenv("ORCH_CACHE_VOLUME_NAME", DEFAULT_CACHE_VOLUME_NAME)


def _modal_env_name() -> str:
    return os.getenv("ORCH_MODAL_ENV", "main").strip()


def _modal_environment_kwargs() -> dict[str, str]:
    env_name = _modal_env_name()
    return {"environment_name": env_name} if env_name else {}


def _normalize_volume_path(value: str) -> str:
    path = PurePosixPath(value.strip())
    if not path.is_absolute():
        path = PurePosixPath("/") / path
    if ".." in path.parts:
        raise ValueError("volume paths must not contain '..'")
    normalized = str(path)
    return normalized.rstrip("/") if normalized != "/" else normalized


def _remote_job_root() -> str:
    explicit_root = os.getenv("ORCH_REMOTE_JOB_ROOT", "").strip()
    if explicit_root:
        return _normalize_volume_path(explicit_root)

    marker_job_dir = (
        os.getenv("MARKER_JOB_DIR", DEFAULT_MARKER_JOB_DIR).strip()
        or DEFAULT_MARKER_JOB_DIR
    )
    marker_path = PurePosixPath(marker_job_dir)
    try:
        relative_to_mount = marker_path.relative_to(CACHE_MOUNT_PATH)
    except ValueError as exc:
        raise ValueError(
            "MARKER_JOB_DIR must be under /cache for this E2E test, "
            "or set ORCH_REMOTE_JOB_ROOT to the volume-relative job path"
        ) from exc
    return _normalize_volume_path(str(relative_to_mount))


def _join_volume_path(root: str, *parts: str) -> str:
    normalized_root = _normalize_volume_path(root)
    suffix = "/".join(part.strip("/") for part in parts if part.strip("/"))
    if not suffix:
        return normalized_root
    if normalized_root == "/":
        return f"/{suffix}"
    return f"{normalized_root}/{suffix}"


def _get_run_orchestrator():
    return modal.Function.from_name(
        _app_name(),
        "run_orchestrator",
        **_modal_environment_kwargs(),
    )


def _prepare_remote_job(sample_pdf: Path) -> tuple[modal.Volume, str]:
    vol = modal.Volume.from_name(_cache_volume_name(), **_modal_environment_kwargs())
    job_id = f"e2e-job-{uuid.uuid4().hex[:8]}"
    remote_job_dir = _join_volume_path(_remote_job_root(), job_id)
    with vol.batch_upload() as batch:
        batch.put_file(str(sample_pdf), f"{remote_job_dir}/original.pdf")
        batch.put_file(io.BytesIO(b"{}"), f"{remote_job_dir}/options.json")
    return vol, job_id


def _read_status(vol: modal.Volume, job_id: str) -> dict:
    try:
        payload = b"".join(
            vol.read_file(_join_volume_path(_remote_job_root(), job_id, "status.json"))
        )
        return json.loads(payload.decode("utf-8"))
    except Exception:
        return {}


def _list_artifacts(vol: modal.Volume, job_id: str) -> list[str]:
    try:
        entries = vol.listdir(_join_volume_path(_remote_job_root(), job_id))
    except Exception:
        return []
    return sorted(entry.path.rsplit("/", 1)[-1] for entry in entries)


def test_remote_job_root_follows_marker_job_dir(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("ORCH_REMOTE_JOB_ROOT", raising=False)
    monkeypatch.setenv("MARKER_JOB_DIR", "/cache/custom-jobs")

    assert _remote_job_root() == "/custom-jobs"


def test_remote_job_root_accepts_explicit_volume_path(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ORCH_REMOTE_JOB_ROOT", "custom-volume-root/jobs")
    monkeypatch.setenv("MARKER_JOB_DIR", "/not-mounted/jobs")

    assert _remote_job_root() == "/custom-volume-root/jobs"


def test_modal_environment_kwargs_omits_empty_environment(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ORCH_MODAL_ENV", "")

    assert _modal_environment_kwargs() == {}


def test_join_volume_path_handles_root_path():
    assert _join_volume_path("/", "job-1", "status.json") == "/job-1/status.json"


def test_prepare_remote_job_uses_configured_volume_path(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    uploads: list[tuple[object, str]] = []
    calls: list[tuple[str, dict[str, str]]] = []

    class FakeBatch:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def put_file(self, local_file, remote_path):
            uploads.append((local_file, remote_path))

    class FakeVolume:
        @staticmethod
        def from_name(name, **kwargs):
            calls.append((name, kwargs))
            return FakeVolume()

        def batch_upload(self):
            return FakeBatch()

    sample_pdf = tmp_path / "sample.pdf"
    sample_pdf.write_bytes(b"%PDF-1.7\n%%EOF")
    monkeypatch.setattr(modal, "Volume", FakeVolume)
    monkeypatch.setenv("ORCH_CACHE_VOLUME_NAME", "test-cache-volume")
    monkeypatch.setenv("ORCH_MODAL_ENV", "")
    monkeypatch.delenv("ORCH_REMOTE_JOB_ROOT", raising=False)
    monkeypatch.setenv("MARKER_JOB_DIR", "/cache/custom-jobs")

    _vol, job_id = _prepare_remote_job(sample_pdf)

    assert calls == [("test-cache-volume", {})]
    assert uploads[0] == (str(sample_pdf), f"/custom-jobs/{job_id}/original.pdf")
    assert uploads[1][1] == f"/custom-jobs/{job_id}/options.json"


@pytest.mark.skipif(
    os.getenv("ORCH_E2E") != "1",
    reason="Set ORCH_E2E=1 and ORCH_SAMPLE_PDF to run E2E integration",
)
def test_orchestrator_end_to_end():
    sample_pdf_env = os.getenv("ORCH_SAMPLE_PDF")
    if not sample_pdf_env:
        pytest.skip("ORCH_SAMPLE_PDF not set")
    sample_pdf = Path(sample_pdf_env)
    if not sample_pdf.exists():
        pytest.skip("ORCH_SAMPLE_PDF does not exist")

    env_snapshot = {
        "MARKER_JOB_DIR": os.getenv("MARKER_JOB_DIR"),
        "ORCH_E2E": os.getenv("ORCH_E2E"),
        "ORCH_SAMPLE_PDF": sample_pdf_env,
        "ORCH_MODAL_APP": _app_name(),
        "ORCH_MODAL_ENV": _modal_env_name(),
        "ORCH_CACHE_VOLUME_NAME": _cache_volume_name(),
    }

    try:
        vol, job_id = _prepare_remote_job(sample_pdf)
        remote_job_root = _remote_job_root()
    except ValueError as exc:
        pytest.skip(str(exc))
    run_orchestrator = _get_run_orchestrator()

    print(f"[E2E] env={env_snapshot}")

    outcome = run_orchestrator.remote(job_id, {})
    status = _read_status(vol, job_id)
    artifacts = _list_artifacts(vol, job_id)
    status_path = _join_volume_path(remote_job_root, job_id, "status.json")

    print(f"[E2E] outcome={outcome}")
    print(f"[E2E] status_path={status_path}")
    print(f"[E2E] status={status}")
    print(f"[E2E] artifacts={artifacts}")

    if outcome.get("error_code") in {"MODEL_NOT_READY", "FILE_NOT_FOUND"}:
        pytest.xfail(
            f"Prerequisite missing: {outcome.get('error_code')}; status={status}; artifacts={artifacts}"
        )

    # Expect success if models are available.
    assert outcome.get("status") == "completed", f"Outcome={outcome}, status={status}, artifacts={artifacts}"
    assert "raw.md" in artifacts, f"raw.md missing; status={status}, artifacts={artifacts}"
    assert ".processing.lock" not in artifacts, f"stale lock persisted; status={status}, artifacts={artifacts}"
