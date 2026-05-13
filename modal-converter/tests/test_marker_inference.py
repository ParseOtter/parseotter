"""Tests for marker_inference.py — TDD for refactoring."""

import importlib.util
import json
import logging
import sys
from pathlib import Path
from types import ModuleType
from unittest.mock import patch

import pytest


# ---------------------------------------------------------------------------
# Helpers: dummy marker modules
# ---------------------------------------------------------------------------

def _install_dummy_marker_modules() -> dict[str, ModuleType]:
    """Install stubs for marker.* packages so marker_inference imports cleanly."""
    marker_mod = ModuleType("marker")
    marker_config = ModuleType("marker.config")
    marker_config_parser = ModuleType("marker.config.parser")
    marker_converters = ModuleType("marker.converters")
    marker_converters_pdf = ModuleType("marker.converters.pdf")
    marker_output = ModuleType("marker.output")
    marker_settings = ModuleType("marker.settings")

    class DummyConfigParser:
        last_config = None

        def __init__(self, config):
            type(self).last_config = config
            self.config = config

        def generate_config_dict(self):
            return {}

        def get_processors(self):
            return []

        def get_renderer(self):
            return None

    class DummyRenderedOutput:
        metadata = {"page_stats": [{"page": 1}]}

    class DummyPdfConverter:
        last_config = None

        def __init__(self, *, config, **_kwargs):
            type(self).last_config = config

        def __call__(self, *_args, **_kwargs):
            return DummyRenderedOutput()

    def dummy_text_from_rendered(*_args, **_kwargs):
        return "converted markdown", None, {}

    class DummySettings:
        OUTPUT_IMAGE_FORMAT = "JPEG"

    setattr(marker_config_parser, "ConfigParser", DummyConfigParser)
    setattr(marker_converters_pdf, "PdfConverter", DummyPdfConverter)
    setattr(marker_output, "text_from_rendered", dummy_text_from_rendered)
    setattr(marker_settings, "settings", DummySettings())

    return {
        "marker": marker_mod,
        "marker.config": marker_config,
        "marker.config.parser": marker_config_parser,
        "marker.converters": marker_converters,
        "marker.converters.pdf": marker_converters_pdf,
        "marker.output": marker_output,
        "marker.settings": marker_settings,
    }


def _load_module():
    """Load marker_inference.py with dummy marker stubs installed."""
    root = Path(__file__).resolve().parents[1]
    path = root / "marker_inference.py"
    spec = importlib.util.spec_from_file_location("marker_inference", str(path))
    assert spec is not None, f"Could not find {path}"
    mod = importlib.util.module_from_spec(spec)

    dummies = _install_dummy_marker_modules()
    with patch.dict(sys.modules, dummies, clear=False):
        loader = spec.loader
        assert loader is not None, f"No loader for {path}"
        loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def mod():
    return _load_module()


@pytest.fixture
def job_dir(tmp_path: Path) -> Path:
    """Create a minimal valid job directory with original.pdf."""
    jd = tmp_path / "jobs" / "test_job"
    jd.mkdir(parents=True)
    (jd / "original.pdf").write_bytes(b"%PDF-1.7\n%%EOF")
    return jd


# ===================================================================
# _is_gpu_oom_error
# ===================================================================

class TestIsGpuOomError:
    def test_detects_torch_cuda_oom(self, mod):
        """Should detect torch.cuda.OutOfMemoryError without importing real torch."""
        fake_torch = ModuleType("torch")

        class FakeCudaOutOfMemoryError(RuntimeError):
            pass

        class FakeCuda:
            OutOfMemoryError = FakeCudaOutOfMemoryError

        fake_torch.cuda = FakeCuda()
        with patch.dict(sys.modules, {"torch": fake_torch}):
            oom = FakeCudaOutOfMemoryError("CUDA out of memory")
            assert mod._is_gpu_oom_error(oom) is True

    def test_detects_oom_in_string_fallback(self, mod):
        """Should detect 'out of memory' in exception message."""
        exc = RuntimeError("CUDA out of memory. Tried to allocate 2 GiB")
        assert mod._is_gpu_oom_error(exc) is True

    def test_returns_false_for_other_errors(self, mod):
        """Should return False for non-OOM errors."""
        exc = RuntimeError("Some other error")
        assert mod._is_gpu_oom_error(exc) is False

    def test_case_insensitive_match(self, mod):
        """Should match 'out of memory' case-insensitively."""
        exc = RuntimeError("Out Of Memory")
        assert mod._is_gpu_oom_error(exc) is True


# ===================================================================
# Path traversal prevention (CRITICAL)
# ===================================================================

class TestPathTraversalPrevention:
    """CRITICAL: job_id with .. segments must be rejected."""

    def test_rejects_traversal_in_job_id(self, mod, tmp_path):
        """job_id containing '../' should be rejected."""
        job_root = tmp_path / "jobs"
        job_root.mkdir()
        result = mod.run_marker_inference_core(
            {"model": object()},
            "../../etc/passwd",
            job_root=str(job_root),
        )
        assert result["success"] is False
        assert result["error_code"] == "FILE_NOT_FOUND"

    def test_rejects_absolute_path_job_id(self, mod, tmp_path):
        """job_id that resolves outside job_root should be rejected."""
        job_root = tmp_path / "jobs"
        job_root.mkdir()
        result = mod.run_marker_inference_core(
            {"model": object()},
            "/tmp/somewhere-else",
            job_root=str(job_root),
        )
        assert result["success"] is False
        assert result["error_code"] == "FILE_NOT_FOUND"

    def test_rejects_sibling_prefix_traversal(self, mod, tmp_path):
        """A sibling path sharing the job_root prefix must not be accepted."""
        job_root = tmp_path / "jobs"
        job_root.mkdir()
        sibling = tmp_path / "jobs_evil"
        sibling.mkdir()
        (sibling / "original.pdf").write_bytes(b"%PDF-1.7\n%%EOF")

        result = mod.run_marker_inference_core(
            {"model": object()},
            "../jobs_evil",
            job_root=str(job_root),
        )

        assert result["success"] is False
        assert result["error_code"] == "FILE_NOT_FOUND"

    def test_allows_valid_job_id(self, mod, job_dir):
        """Normal job_id should not be blocked."""
        result = mod.run_marker_inference_core(
            {"model": object()},
            job_dir.name,
            job_root=str(job_dir.parent),
        )
        assert result["success"] is True


# ===================================================================
# Image reference rewriting (HIGH)
# ===================================================================

class TestImageReferenceRewriting:
    """HIGH: substring-safe image path rewriting."""

    def test_rewrites_single_image_ref(self, mod):
        """Should rewrite a single image reference to images/ prefix."""
        images = {"diagram.png": object()}
        text = "See diagram.png for details."
        rewritten = mod._rewrite_image_refs(text, images)
        assert rewritten == "See images/diagram.png for details."

    def test_rewrites_without_matching_inside_other_names(self, mod):
        """Image names should not be rewritten inside other image names."""
        images = {"image.png": object(), "myimage.png": object()}
        text = "See image.png and myimage.png."
        rewritten = mod._rewrite_image_refs(text, images)
        assert rewritten == "See images/image.png and images/myimage.png."

    def test_no_images_returns_original(self, mod):
        """When images dict is empty, text should be unchanged."""
        text = "Just text, no images."
        assert mod._rewrite_image_refs(text, {}) == text

    def test_empty_text_handling(self, mod):
        """Should handle None or empty text gracefully."""
        assert mod._rewrite_image_refs(None, {"a.png": object()}) is None
        assert mod._rewrite_image_refs("", {"a.png": object()}) == ""


class TestMarkdownLinkSanitization:
    def test_rewrites_file_links_under_job_dir_to_relative_links(self, mod, tmp_path: Path):
        job_dir = tmp_path / "jobs" / "job-1"
        job_dir.mkdir(parents=True)
        link = f"{job_dir.as_uri()}/text/chapter-1.xhtml#note-1"
        text = f"See [Chapter I]({link}) and [site](https://example.com)."

        sanitized = mod._sanitize_markdown_links(text, job_dir)

        assert sanitized == "See [Chapter I](text/chapter-1.xhtml#note-1) and [site](https://example.com)."

    def test_rewrites_file_links_to_files_at_job_root(self, mod, tmp_path: Path):
        job_dir = tmp_path / "jobs" / "job-1"
        job_dir.mkdir(parents=True)
        link = f"{job_dir.as_uri()}/uncopyright.xhtml"

        sanitized = mod._sanitize_markdown_links(f"See [Uncopyright]({link}).", job_dir)

        assert sanitized == "See [Uncopyright](uncopyright.xhtml)."

    def test_leaves_external_file_links_unchanged(self, mod, tmp_path: Path):
        job_dir = tmp_path / "jobs" / "job-1"
        other_dir = tmp_path / "jobs" / "job-2"
        job_dir.mkdir(parents=True)
        other_dir.mkdir(parents=True)
        link = f"{other_dir.as_uri()}/text/chapter-1.xhtml"
        text = f"See [Other]({link})."

        assert mod._sanitize_markdown_links(text, job_dir) == text

    def test_handles_empty_text(self, mod, tmp_path: Path):
        job_dir = tmp_path / "jobs" / "job-1"
        job_dir.mkdir(parents=True)

        assert mod._sanitize_markdown_links(None, job_dir) is None
        assert mod._sanitize_markdown_links("", job_dir) == ""


# ===================================================================
# commit_cache error logging (HIGH)
# ===================================================================

class TestCommitCacheErrorLogging:
    """HIGH: commit_cache exceptions must be logged, not silently swallowed."""

    def test_logs_warning_on_commit_failure(self, mod, job_dir, caplog):
        """commit_cache failure should produce a warning log."""
        def failing_commit():
            raise RuntimeError("volume write failed")

        caplog.set_level(logging.WARNING)

        mod.run_marker_inference_core(
            {"model": object()},
            job_dir.name,
            job_root=str(job_dir.parent),
            commit_cache=failing_commit,
        )

        assert any("commit_cache" in msg.lower() for msg in caplog.messages)


# ===================================================================
# Options validation
# ===================================================================

class TestOptionsValidation:
    def test_page_range_valid(self, mod, job_dir):
        """Valid page_range should pass."""
        result = mod.run_marker_inference_core(
            {"model": object()},
            job_dir.name,
            options={"page_range": "1,3-5,7"},
            job_root=str(job_dir.parent),
        )
        assert result["success"] is True

    def test_page_range_invalid_format(self, mod, job_dir):
        """Invalid page_range should be rejected."""
        result = mod.run_marker_inference_core(
            {"model": object()},
            job_dir.name,
            options={"page_range": "abc"},
            job_root=str(job_dir.parent),
        )
        assert result["success"] is False
        assert result["error_code"] == "OPTIONS_INVALID"

    def test_output_image_format_validation(self, mod, job_dir):
        """Only JPEG and PNG should be accepted."""
        result = mod.run_marker_inference_core(
            {"model": object()},
            job_dir.name,
            options={"output_image_format": "WEBP"},
            job_root=str(job_dir.parent),
        )
        assert result["success"] is False
        assert result["error_code"] == "OPTIONS_INVALID"

    def test_options_from_file_merged(self, mod, job_dir):
        """Options from options.json should be loaded."""
        (job_dir / "options.json").write_text(
            json.dumps({"force_ocr": True, "paginate_output": True}),
            encoding="utf-8",
        )
        result = mod.run_marker_inference_core(
            {"model": object()},
            job_dir.name,
            job_root=str(job_dir.parent),
        )
        assert result["success"] is True
        assert mod.ConfigParser.last_config["force_ocr"] is True
        assert mod.ConfigParser.last_config["paginate_output"] is True

    def test_invalid_options_file_returns_error(self, mod, job_dir):
        """Corrupt options.json should return OPTIONS_INVALID."""
        (job_dir / "options.json").write_text("not json", encoding="utf-8")
        result = mod.run_marker_inference_core(
            {"model": object()},
            job_dir.name,
            job_root=str(job_dir.parent),
        )
        assert result["success"] is False
        assert result["error_code"] == "OPTIONS_INVALID"

    def test_non_object_options_file_returns_error(self, mod, job_dir):
        """options.json must contain a JSON object."""
        (job_dir / "options.json").write_text("[1, 2]", encoding="utf-8")
        result = mod.run_marker_inference_core(
            {"model": object()},
            job_dir.name,
            job_root=str(job_dir.parent),
        )
        assert result["success"] is False
        assert result["error_code"] == "OPTIONS_INVALID"


# ===================================================================
# Error scenarios
# ===================================================================

class TestErrorHandling:
    def test_returns_error_when_models_none(self, mod, job_dir):
        """None models_obj should produce MODEL_NOT_READY."""
        result = mod.run_marker_inference_core(
            None,
            job_dir.name,
            job_root=str(job_dir.parent),
        )
        assert result["success"] is False
        assert result["error_code"] == "MODEL_NOT_READY"

    def test_returns_error_when_job_dir_missing(self, mod, tmp_path):
        """Non-existent job dir should produce FILE_NOT_FOUND."""
        result = mod.run_marker_inference_core(
            {"model": object()},
            "nonexistent",
            job_root=str(tmp_path / "jobs"),
        )
        assert result["success"] is False
        assert result["error_code"] == "FILE_NOT_FOUND"

    def test_returns_error_when_no_original_file(self, mod, tmp_path):
        """Job dir without original.pdf/epub should produce FILE_NOT_FOUND."""
        job_dir = tmp_path / "jobs" / "empty_job"
        job_dir.mkdir(parents=True)
        result = mod.run_marker_inference_core(
            {"model": object()},
            "empty_job",
            job_root=str(tmp_path / "jobs"),
        )
        assert result["success"] is False
        assert result["error_code"] == "FILE_NOT_FOUND"

    def test_gpu_oom_error_mapped_correctly(self, mod, job_dir, monkeypatch):
        """RuntimeError with OOM message should map to GPU_OOM."""
        def failing_converter(*_args, **_kwargs):
            raise RuntimeError("CUDA out of memory. Tried to allocate 2 GiB")

        monkeypatch.setattr(mod, "PdfConverter", lambda **kw: failing_converter)

        result = mod.run_marker_inference_core(
            {"model": object()},
            job_dir.name,
            job_root=str(job_dir.parent),
        )
        assert result["success"] is False
        assert result["error_code"] == "GPU_OOM"


# ===================================================================
# Runtime metadata
# ===================================================================

class TestRuntimeMetadata:
    def test_metadata_file_written(self, mod, job_dir):
        """Metadata JSON should be written on success."""
        result = mod.run_marker_inference_core(
            {"model": object()},
            job_dir.name,
            job_root=str(job_dir.parent),
        )
        assert result["success"] is True
        meta_path = job_dir / "metadata.json"
        assert meta_path.exists()
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        assert meta["page_count"] == 1
        assert meta["renderer_version"] == "marker-pdf"

    def test_progress_file_written(self, mod, job_dir):
        """Progress JSON should be written during parsing."""
        mod.run_marker_inference_core(
            {"model": object()},
            job_dir.name,
            job_root=str(job_dir.parent),
        )
        prog_path = job_dir / "progress.parsing.json"
        assert prog_path.exists()
        prog = json.loads(prog_path.read_text(encoding="utf-8"))
        assert prog["phase"] == "parsing"
