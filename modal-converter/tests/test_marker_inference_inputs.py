import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

import pytest


def _install_dummy_marker_modules():
    marker_mod = ModuleType("marker")
    marker_config = ModuleType("marker.config")
    marker_config_parser = ModuleType("marker.config.parser")
    marker_converters = ModuleType("marker.converters")
    marker_converters_pdf = ModuleType("marker.converters.pdf")
    marker_output = ModuleType("marker.output")
    marker_settings = ModuleType("marker.settings")

    class DummyConfigParser:
        def __init__(self, config):
            self.config = config

        def generate_config_dict(self):
            return {}

        def get_processors(self):
            return []

        def get_renderer(self):
            return None

    class DummyRenderedOutput:
        metadata = {
            "page_stats": [
                {"page": 1},
                {"page": 2},
            ],
        }

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

    marker_config_parser.ConfigParser = DummyConfigParser
    marker_converters_pdf.PdfConverter = DummyPdfConverter
    marker_output.text_from_rendered = dummy_text_from_rendered
    marker_settings.settings = DummySettings()

    sys.modules["marker"] = marker_mod
    sys.modules["marker.config"] = marker_config
    sys.modules["marker.config.parser"] = marker_config_parser
    sys.modules["marker.converters"] = marker_converters
    sys.modules["marker.converters.pdf"] = marker_converters_pdf
    sys.modules["marker.output"] = marker_output
    sys.modules["marker.settings"] = marker_settings


def _load_module():
    module_keys = [
        "marker",
        "marker.config",
        "marker.config.parser",
        "marker.converters",
        "marker.converters.pdf",
        "marker.output",
        "marker.settings",
    ]
    previous = {key: sys.modules.get(key) for key in module_keys}
    _install_dummy_marker_modules()
    root = Path(__file__).resolve().parents[1]
    path = root / "marker_inference.py"
    spec = importlib.util.spec_from_file_location("marker_inference", str(path))
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    finally:
        for key in module_keys:
            if previous[key] is None:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = previous[key]
    return mod


def test_find_original_path_prefers_epub_when_pdf_missing(tmp_path: Path):
    mod = _load_module()
    job_dir = tmp_path / "job"
    job_dir.mkdir()
    epub = job_dir / "original.epub"
    epub.write_text("content", encoding="utf-8")

    resolver = getattr(mod, "_find_original_path", None)
    assert callable(resolver)
    assert resolver(job_dir) == epub


def test_read_int_env_uses_default_for_invalid_values(monkeypatch: pytest.MonkeyPatch):
    from shared.env import read_int_env

    monkeypatch.setenv("MARKER_PDFTEXT_WORKERS", "invalid")
    assert read_int_env("MARKER_PDFTEXT_WORKERS", 2, minimum=1, maximum=8) == 2

    monkeypatch.setenv("MARKER_PDFTEXT_WORKERS", "0")
    assert read_int_env("MARKER_PDFTEXT_WORKERS", 2, minimum=1, maximum=8) == 2

    monkeypatch.setenv("MARKER_PDFTEXT_WORKERS", "99")
    assert read_int_env("MARKER_PDFTEXT_WORKERS", 2, minimum=1, maximum=8) == 8


def test_run_marker_inference_records_runtime_metadata(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    mod = _load_module()
    monkeypatch.setenv("MARKER_PDFTEXT_WORKERS", "4")
    monkeypatch.setenv("GPU_TYPE", "H100")

    job_root = tmp_path / "jobs"
    job_id = "job_runtime_metadata"
    job_dir = job_root / job_id
    job_dir.mkdir(parents=True)
    (job_dir / "original.pdf").write_bytes(b"%PDF-1.7\n%%EOF")

    result = mod.run_marker_inference_core(
        {"model": object()},
        job_id,
        job_root=str(job_root),
    )

    assert result == {"success": True, "job_id": job_id, "page_count": 2}
    assert (job_dir / "raw.md").read_text(encoding="utf-8") == "converted markdown"
    assert mod.PdfConverter.last_config["pdftext_workers"] == 4

    metadata = json.loads((job_dir / "metadata.json").read_text(encoding="utf-8"))
    assert metadata["runtime"] == {
        "gpu_type": "H100",
        "pdftext_workers": 4,
        "input_extension": ".pdf",
        "output_image_format": "JPEG",
    }
    assert metadata["timings"]["total_seconds"] >= 0
    assert set(metadata["timings"]) >= {
        "setup_seconds",
        "convert_seconds",
        "extract_seconds",
        "write_markdown_seconds",
        "write_images_seconds",
        "total_seconds",
    }
