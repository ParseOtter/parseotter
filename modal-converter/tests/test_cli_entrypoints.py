import json
import os
import sys
import uuid
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

import cli_entrypoints


def _install_fake_marker_inference(monkeypatch: pytest.MonkeyPatch, run_core) -> None:
    module = ModuleType("marker_inference")
    module.run_marker_inference_core = run_core
    monkeypatch.setitem(sys.modules, "marker_inference", module)


def _install_fake_orchestrator(monkeypatch: pytest.MonkeyPatch, process_job) -> None:
    module = ModuleType("orchestrator")
    module.PARSEOTTER_FREE_OUTPUT_PROFILE = "parseotter-free"
    module.process_job_background = process_job
    monkeypatch.setitem(sys.modules, "orchestrator", module)


def _outcome(job_id: str):
    return SimpleNamespace(
        job_id=job_id,
        status="completed",
        current_phase="completed",
        progress=100,
        error_code=None,
        error_message=None,
    )


def test_run_invoke_conversion_stages_epub_and_restores_environment(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    source = tmp_path / "sample.epub"
    source.write_bytes(b"epub-content")
    fixed_job_id = uuid.UUID("12345678-1234-5678-1234-567812345678")
    monkeypatch.setattr(cli_entrypoints.uuid, "uuid4", lambda: fixed_job_id)
    monkeypatch.setenv("MARKER_JOB_DIR", "previous-job-root")
    monkeypatch.delenv("MARKER_CACHE_DIR", raising=False)

    def fake_core(*_args, **_kwargs):
        raise AssertionError("local parser should not be invoked by this test")

    def fake_process(job_id, options, ctx):
        assert job_id == str(fixed_job_id)
        assert options["output_profile"] == "parseotter-free"
        assert os.environ["MARKER_JOB_DIR"].endswith("/jobs")
        assert os.environ["MARKER_CACHE_DIR"].endswith("/cache")

        job_dir = Path(os.environ["MARKER_JOB_DIR"]) / job_id
        assert (job_dir / "original.epub").read_bytes() == b"epub-content"
        assert not (job_dir / "original.pdf").exists()
        assert ctx.parser_handle is not None
        (job_dir / "raw.md").write_text("# converted", encoding="utf-8")
        return _outcome(job_id)

    _install_fake_marker_inference(monkeypatch, fake_core)
    _install_fake_orchestrator(monkeypatch, fake_process)

    cli_entrypoints.run_invoke_conversion(
        str(source),
        "markdown",
        setup_models=lambda _logger, commit_volume: {"commit_volume": commit_volume},
    )

    assert os.environ["MARKER_JOB_DIR"] == "previous-job-root"
    assert "MARKER_CACHE_DIR" not in os.environ

    output_dir = tmp_path / "sample_marker_output_12345678"
    assert (output_dir / "original.epub").read_bytes() == b"epub-content"
    response = json.loads((output_dir / "response.json").read_text(encoding="utf-8"))
    assert response["status"] == "completed"
    assert response["artifacts_dir"] == str(output_dir)


@pytest.mark.parametrize(
    ("pdf_file", "output_format", "expected_message"),
    [
        (None, "markdown", "No PDF file specified"),
        ("missing.pdf", "markdown", "File not found"),
        ("sample.txt", "markdown", "Only PDF and EPUB inputs are supported"),
        ("sample.pdf", "html", "Only markdown output is supported"),
    ],
)
def test_run_invoke_conversion_rejects_invalid_inputs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    pdf_file: str | None,
    output_format: str,
    expected_message: str,
):
    _install_fake_marker_inference(monkeypatch, lambda *_args, **_kwargs: {})
    _install_fake_orchestrator(monkeypatch, lambda *_args, **_kwargs: _outcome("unused"))
    if pdf_file in {"sample.txt", "sample.pdf"}:
        (tmp_path / pdf_file).write_text("content", encoding="utf-8")
        pdf_file = str(tmp_path / pdf_file)
    elif isinstance(pdf_file, str):
        pdf_file = str(tmp_path / pdf_file)

    cli_entrypoints.run_invoke_conversion(
        pdf_file,
        output_format,
        setup_models=lambda _logger, commit_volume: {},
    )

    assert expected_message in capsys.readouterr().out


def test_run_invoke_conversion_model_load_failure_does_not_create_output_dir(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
):
    source = tmp_path / "sample.pdf"
    source.write_bytes(b"%PDF-1.7\n%%EOF")
    fixed_job_id = uuid.UUID("12345678-1234-5678-1234-567812345678")
    monkeypatch.setattr(cli_entrypoints.uuid, "uuid4", lambda: fixed_job_id)
    _install_fake_marker_inference(monkeypatch, lambda *_args, **_kwargs: {})
    _install_fake_orchestrator(monkeypatch, lambda *_args, **_kwargs: _outcome(str(fixed_job_id)))

    cli_entrypoints.run_invoke_conversion(
        str(source),
        "markdown",
        setup_models=lambda _logger, commit_volume: (_ for _ in ()).throw(RuntimeError("model failed")),
    )

    assert "Failed to load models locally: model failed" in capsys.readouterr().out
    assert not (tmp_path / "sample_marker_output_12345678").exists()


def test_run_invoke_conversion_restores_environment_when_processing_raises(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    source = tmp_path / "sample.pdf"
    source.write_bytes(b"%PDF-1.7\n%%EOF")
    monkeypatch.setenv("MARKER_JOB_DIR", "previous-job-root")
    monkeypatch.setenv("MARKER_CACHE_DIR", "previous-cache-root")

    _install_fake_marker_inference(monkeypatch, lambda *_args, **_kwargs: {})

    def fake_process(_job_id, _options, *, ctx):
        assert ctx is not None
        raise RuntimeError("orchestrator failed")

    _install_fake_orchestrator(monkeypatch, fake_process)

    with pytest.raises(RuntimeError, match="orchestrator failed"):
        cli_entrypoints.run_invoke_conversion(
            str(source),
            "markdown",
            setup_models=lambda _logger, commit_volume: {},
        )

    assert os.environ["MARKER_JOB_DIR"] == "previous-job-root"
    assert os.environ["MARKER_CACHE_DIR"] == "previous-cache-root"


def test_run_smoke_marker_inference_preserves_epub_input_extension(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    source = tmp_path / "sample.epub"
    source.write_bytes(b"epub-content")
    job_root = tmp_path / "jobs"

    monkeypatch.setattr(
        cli_entrypoints,
        "load_config",
        lambda strict_gateway=False: SimpleNamespace(marker_job_dir=str(job_root)),
    )

    def fake_core(_models, job_id, options, *, job_root):
        job_dir = Path(job_root) / job_id
        assert options["output_image_format"] == "PNG"
        assert (job_dir / "original.epub").read_bytes() == b"epub-content"
        assert not (job_dir / "original.pdf").exists()
        return {"status": "completed"}

    _install_fake_marker_inference(monkeypatch, fake_core)

    cli_entrypoints.run_smoke_marker_inference(
        str(source),
        job_id="smoke-epub",
        page_range="",
        output_image_format="PNG",
        setup_models=lambda _logger, commit_volume: {"commit_volume": commit_volume},
    )

    job_dir = job_root / "smoke-epub"
    assert (job_dir / "original.epub").read_bytes() == b"epub-content"
    assert not (job_dir / "original.pdf").exists()


def test_run_smoke_marker_inference_rejects_unsupported_extension(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
):
    source = tmp_path / "sample.txt"
    source.write_text("text", encoding="utf-8")
    _install_fake_marker_inference(monkeypatch, lambda *_args, **_kwargs: {})

    cli_entrypoints.run_smoke_marker_inference(
        str(source),
        job_id="smoke",
        page_range="",
        output_image_format="PNG",
        setup_models=lambda _logger, commit_volume: {},
    )

    assert "Only PDF and EPUB inputs are supported by this smoke entrypoint." in capsys.readouterr().out
