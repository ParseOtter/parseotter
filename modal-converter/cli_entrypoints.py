"""Local Modal entrypoint implementations."""

from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from shared.atomic_write import atomic_write_json
from shared.config import load_config
from shared.context import JobContext


SetupModelsCallable = Callable[[Any, bool], Any]


def run_invoke_conversion(
    pdf_file: Optional[str],
    output_format: str,
    setup_models,
) -> None:
    import orchestrator
    from marker_inference import run_marker_inference_core

    normalized_output_format = (output_format or "markdown").strip().lower()
    if normalized_output_format != "markdown":
        print("Only markdown output is supported by this local entrypoint.")
        return

    if not pdf_file:
        print("No PDF file specified. Use --pdf-file /path/to/your.pdf")
        return

    source_path = Path(pdf_file)
    if not source_path.exists():
        print(f"File not found: {pdf_file}")
        return

    normalized_suffix = source_path.suffix.lower()
    if normalized_suffix not in {".pdf", ".epub"}:
        print("Only PDF and EPUB inputs are supported by this local entrypoint.")
        return

    logging.basicConfig(level=logging.INFO)
    logger = logging.getLogger(__name__)
    job_id = str(uuid.uuid4())
    output_dir = source_path.parent / f"{source_path.stem}_marker_output_{job_id[:8]}"

    class _LocalParserHandle:
        def __init__(self, job_root: Path, models_obj: Any):
            self._job_root = job_root
            self._models_obj = models_obj

        def remote(self, local_job_id: str, local_options: Dict[str, Any]) -> Dict[str, Any]:
            return run_marker_inference_core(
                self._models_obj,
                local_job_id,
                local_options,
                job_root=str(self._job_root),
            )

    with tempfile.TemporaryDirectory(prefix="marker-local-job-") as temp_root:
        temp_root_path = Path(temp_root)
        job_root = temp_root_path / "jobs"
        cache_root = temp_root_path / "cache"
        job_dir = job_root / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        cache_root.mkdir(parents=True, exist_ok=True)

        original_name = "original.epub" if normalized_suffix == ".epub" else "original.pdf"
        shutil.copyfile(str(source_path), str(job_dir / original_name))

        options_doc: Dict[str, Any] = {
            "page_range": "",
            "force_ocr": False,
            "paginate_output": False,
            "output_image_format": "JPEG",
            "output_profile": orchestrator.PARSEOTTER_FREE_OUTPUT_PROFILE,
        }
        atomic_write_json(job_dir / "options.json", options_doc)

        try:
            local_models = setup_models(logger, commit_volume=False)
        except Exception as exc:
            print(f"Failed to load models locally: {exc}")
            return

        previous_job_dir = os.environ.get("MARKER_JOB_DIR")
        previous_cache_dir = os.environ.get("MARKER_CACHE_DIR")
        try:
            os.environ["MARKER_JOB_DIR"] = str(job_root)
            os.environ["MARKER_CACHE_DIR"] = str(cache_root)
            ctx = JobContext(
                parser_handle=_LocalParserHandle(job_root, local_models),
                reload_cache=lambda: None,
                commit_cache=lambda: None,
            )
            outcome = orchestrator.process_job_background(job_id, options_doc, ctx=ctx)
        finally:
            if previous_job_dir is None:
                os.environ.pop("MARKER_JOB_DIR", None)
            else:
                os.environ["MARKER_JOB_DIR"] = previous_job_dir
            if previous_cache_dir is None:
                os.environ.pop("MARKER_CACHE_DIR", None)
            else:
                os.environ["MARKER_CACHE_DIR"] = previous_cache_dir

        shutil.copytree(job_dir, output_dir)
        response_doc = {
            "job_id": outcome.job_id,
            "status": outcome.status,
            "phase": outcome.current_phase,
            "progress": outcome.progress,
            "error_code": outcome.error_code,
            "error_message": outcome.error_message,
            "artifacts_dir": str(output_dir),
        }
        response_path = output_dir / "response.json"
        with response_path.open("w", encoding="utf-8") as file:
            json.dump(response_doc, file, ensure_ascii=False, indent=2)

    print(json.dumps(response_doc, indent=2, ensure_ascii=False))
    print(f"Artifacts saved to: {output_dir}")
    if (output_dir / "raw.md").exists():
        print(f"Markdown output: {output_dir / 'raw.md'}")
    if (output_dir / "result.zip").exists():
        print(f"ZIP output: {output_dir / 'result.zip'}")


def run_smoke_marker_inference(
    pdf_file: Optional[str],
    job_id: Optional[str],
    page_range: Optional[str],
    output_image_format: str,
    setup_models,
) -> None:
    from marker_inference import run_marker_inference_core

    logging.basicConfig(level=logging.INFO)
    logger = logging.getLogger(__name__)

    if not pdf_file:
        print("No PDF or EPUB file specified. Use --pdf-file /path/to/your.pdf")
        return

    src = Path(pdf_file)
    if not src.exists():
        print(f"File not found: {pdf_file}")
        return

    normalized_suffix = src.suffix.lower()
    if normalized_suffix not in {".pdf", ".epub"}:
        print("Only PDF and EPUB inputs are supported by this smoke entrypoint.")
        return

    job_root = Path(load_config(strict_gateway=False).marker_job_dir)
    job_root.mkdir(parents=True, exist_ok=True)

    resolved_job_id = job_id or str(uuid.uuid4())
    job_dir = job_root / resolved_job_id
    if job_dir.exists():
        shutil.rmtree(job_dir, ignore_errors=True)
    job_dir.mkdir(parents=True, exist_ok=True)

    original_name = "original.epub" if normalized_suffix == ".epub" else "original.pdf"
    shutil.copyfile(str(src), str(job_dir / original_name))

    options_doc = {
        "page_range": page_range or "",
        "force_ocr": False,
        "paginate_output": False,
        "output_image_format": output_image_format,
    }
    atomic_write_json(job_dir / "options.json", options_doc)

    try:
        try:
            local_models = setup_models(logger, commit_volume=False)
        except Exception as exc:
            print(f"Warning: failed to load models locally: {exc}")
            local_models = None

        print(f"Running inference locally for job_id={resolved_job_id} ...")
        outcome = run_marker_inference_core(local_models, resolved_job_id, options_doc, job_root=str(job_root))
        print(json.dumps(outcome, indent=2, ensure_ascii=False))

        outputs = list(job_dir.glob("**/*"))
        print("Artifacts written:")
        for path in outputs:
            rel = path.relative_to(job_dir)
            size = path.stat().st_size if path.is_file() else 0
            print(f" - {rel} ({size} bytes)")

        print(f"Job dir: {job_dir}")
    except Exception as exc:
        print(f"Smoke test failed: {exc}")
