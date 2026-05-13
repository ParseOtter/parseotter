from __future__ import annotations

import json
import logging
import re
import time
from pathlib import Path
from typing import Any, Callable, Literal

from marker.config.parser import ConfigParser
from marker.converters.pdf import PdfConverter
from marker.output import text_from_rendered
from shared.atomic_write import atomic_write_json
from shared.config import Config, load_config
from shared.error_codes import ErrorCode

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PROGRESS_FILENAME = "progress.parsing.json"
MARKDOWN_FILENAME = "raw.md"
IMAGES_DIRNAME = "images"
METADATA_FILENAME = "metadata.json"
OPTIONS_FILENAME = "options.json"
ORIGINAL_PDF = "original.pdf"
ORIGINAL_EPUB = "original.epub"

# PIL format normalisation: some file extensions need mapping to PIL's names.
_PIL_FORMAT_MAP: dict[str, str] = {
    "JPG": "JPEG",
    "PNG": "PNG",
}

_PAGE_RANGE_RE: re.Pattern[str] = re.compile(r"^(\d+(?:-\d+)?)(?:,\d+(?:-\d+)?)*$")
_MARKDOWN_LINK_RE: re.Pattern[str] = re.compile(r"(\[[^\]]*\]\()([^)\s]+)(\))")

# ---------------------------------------------------------------------------
# Helper utilities
# ---------------------------------------------------------------------------


def _elapsed_seconds(started_at: float) -> float:
    return round(time.perf_counter() - started_at, 3)


def _find_original_path(job_dir: Path) -> Path | None:
    pdf_path = job_dir / ORIGINAL_PDF
    if pdf_path.exists():
        return pdf_path
    epub_path = job_dir / ORIGINAL_EPUB
    if epub_path.exists():
        return epub_path
    return None


def _resolve_job_dir(job_root_path: Path, job_id: str) -> Path | None:
    job_id_path = Path(job_id)
    if job_id_path.is_absolute() or ".." in job_id_path.parts:
        return None

    try:
        job_dir = (job_root_path / job_id_path).resolve()
        job_dir.relative_to(job_root_path)
    except (OSError, ValueError):
        return None
    return job_dir


def _is_gpu_oom_error(exc: BaseException) -> bool:
    """Return True if *exc* indicates a GPU out-of-memory condition."""
    try:
        import torch

        if isinstance(exc, torch.cuda.OutOfMemoryError):
            return True
    except ImportError:
        pass
    emsg = str(exc)
    return "out of memory" in emsg.lower()


def _rewrite_image_refs(text: str | None, images: dict[str, object]) -> str | None:
    """Rewrite image file-name references in *text* to use an ``images/`` prefix.

    Replacement is done in one regex pass so one image name is not rewritten
    inside another image name.
    """
    if text is None:
        return None
    if not text:
        return text

    image_names = sorted(
        (img_name for img_name in images if img_name),
        key=len,
        reverse=True,
    )
    if not image_names:
        return text

    replacements = {
        img_name: f"{IMAGES_DIRNAME}/{Path(img_name).name}"
        for img_name in image_names
    }
    pattern = re.compile(
        r"(?<![A-Za-z0-9_./-])("
        + "|".join(re.escape(img_name) for img_name in image_names)
        + r")(?![A-Za-z0-9_/-])"
    )
    return pattern.sub(lambda match: replacements[match.group(1)], text)


def _sanitize_markdown_links(text: str | None, job_dir: Path) -> str | None:
    if text is None:
        return None
    if not text:
        return text

    resolved_job_dir = job_dir.resolve()
    file_prefix = resolved_job_dir.as_uri().rstrip("/") + "/"

    def replace_link(match: re.Match[str]) -> str:
        before, url, after = match.groups()
        if not url.startswith(file_prefix):
            return match.group(0)

        target = url[len(file_prefix):]
        if not target or target.startswith("../") or "/../" in target:
            return f"{before}{after}"

        return f"{before}{target}{after}"

    return _MARKDOWN_LINK_RE.sub(replace_link, text)


# ---------------------------------------------------------------------------
# Option loading / validation
# ---------------------------------------------------------------------------


def _load_and_validate_options(
    job_dir: Path,
    options: dict[str, Any] | None,
    default_image_format: str,
) -> dict[str, Any]:
    """Load options from *options.json* (if present), merge with *options*,
    validate, and return the merged dict.

    Returns the merged options dict on success, or an error dict (with
    ``success``, ``error_code``, ``error_message``) on failure.
    """
    merged: dict[str, Any] = {}
    opt_file = job_dir / OPTIONS_FILENAME
    try:
        if opt_file.exists():
            with opt_file.open("r", encoding="utf-8") as f:
                file_opts = json.load(f)
                if not isinstance(file_opts, dict):
                    return {
                        "success": False,
                        "error_code": ErrorCode.OPTIONS_INVALID,
                        "error_message": f"{OPTIONS_FILENAME} must contain a JSON object",
                    }
                merged.update(file_opts)
    except (json.JSONDecodeError, OSError, UnicodeDecodeError) as exc:
        return {
            "success": False,
            "error_code": ErrorCode.OPTIONS_INVALID,
            "error_message": f"Failed to read {OPTIONS_FILENAME}: {exc}",
        }

    if options is not None and not isinstance(options, dict):
        return {
            "success": False,
            "error_code": ErrorCode.OPTIONS_INVALID,
            "error_message": "options must be a JSON object",
        }

    if options:
        merged.update(options)

    # Validate page_range
    raw_page_range = merged.get("page_range")
    page_range = None if raw_page_range in (None, "") else raw_page_range
    if page_range is not None:
        if not isinstance(page_range, str) or not _PAGE_RANGE_RE.match(page_range):
            return {
                "success": False,
                "error_code": ErrorCode.OPTIONS_INVALID,
                "error_message": "page_range format invalid",
            }

    # Validate image format
    img_fmt = str(merged.get("output_image_format", default_image_format)).upper()
    if img_fmt not in {"JPEG", "PNG"}:
        return {
            "success": False,
            "error_code": ErrorCode.OPTIONS_INVALID,
            "error_message": "output_image_format must be JPEG or PNG",
        }

    merged["page_range"] = page_range
    merged["output_image_format"] = img_fmt
    return merged


# ---------------------------------------------------------------------------
# Output writing
# ---------------------------------------------------------------------------


def _write_output_files(
    job_dir: Path,
    extracted_text: str | None,
    images: dict[str, Any],
    img_fmt: str,
    timings: dict[str, float],
) -> None:
    """Write markdown output, images, metadata and timing info to *job_dir*."""
    # Markdown
    t_start = time.perf_counter()
    (job_dir / MARKDOWN_FILENAME).write_text(extracted_text or "", encoding="utf-8")
    timings["write_markdown_seconds"] = _elapsed_seconds(t_start)

    # Images
    t_start = time.perf_counter()
    images_dir = job_dir / IMAGES_DIRNAME
    images_dir.mkdir(parents=True, exist_ok=True)
    for img_name, img_obj in images.items():
        safe_name = Path(img_name).name
        ext = Path(safe_name).suffix
        if not ext:
            safe_name = f"{safe_name}.{img_fmt.lower()}"
        fmt_for_pil = _PIL_FORMAT_MAP.get(ext[1:].upper(), img_fmt)
        out_path = images_dir / safe_name
        img_obj.save(str(out_path), format=fmt_for_pil)
    timings["write_images_seconds"] = _elapsed_seconds(t_start)


# ---------------------------------------------------------------------------
# Progress & error helpers
# ---------------------------------------------------------------------------


def _write_progress(
    job_dir: Path,
    phase: str,
    message: str,
    current_page: int = 0,
    total_pages: int = 0,
) -> None:
    atomic_write_json(
        job_dir / PROGRESS_FILENAME,
        {
            "phase": phase,
            "message": message,
            "current_page": int(current_page),
            "total_pages": int(total_pages),
            "ts": int(time.time()),
        },
    )


def _error_out(job_id: str, code: str, msg: str) -> dict[str, Any]:
    logger.error("[ModuleC] %s: %s", code, msg)
    return {"success": False, "job_id": job_id, "error_code": code, "error_message": msg}


# ---------------------------------------------------------------------------
# Core inference entry-point
# ---------------------------------------------------------------------------


def run_marker_inference_core(
    models_obj: dict[str, Any] | None,
    job_id: str,
    options: dict[str, Any] | None = None,
    *,
    job_root: str = "/cache/marker-jobs",
    commit_cache: Callable[[], None] | None = None,
    default_image_format: Literal["JPEG", "PNG"] = "JPEG",
    config: Config | None = None,
) -> dict[str, Any]:
    """Core parsing workflow (shared by modal.method and local smoke).

    Parameters
    ----------
    models_obj:
        Loaded marker models (artifact_dict) or ``None``.
    job_id:
        Job identifier.
    options:
        Optional dict (page_range, force_ocr, paginate_output,
        output_image_format).
    job_root:
        Root directory containing job folders.
    commit_cache:
        Optional callable to persist volume (best-effort).
    default_image_format:
        Default image format if none is provided.
    config:
        Application config; loaded from env if not provided.

    Returns
    -------
    ParseOutcome dict with ``success``, ``page_count`` (on success), or
    ``error_code`` / ``error_message``.
    """
    config = config or load_config(strict_gateway=False)

    # ----- guards ------------------------------------------------------------

    if models_obj is None:
        return _error_out(job_id, ErrorCode.MODEL_NOT_READY, "Models not loaded")

    # Resolve paths and guard against directory traversal
    job_root_path = Path(job_root).resolve()
    job_dir = _resolve_job_dir(job_root_path, job_id)
    if job_dir is None:
        return _error_out(job_id, ErrorCode.FILE_NOT_FOUND, f"Invalid job_id: {job_id}")
    if not job_dir.exists():
        return _error_out(job_id, ErrorCode.FILE_NOT_FOUND, f"Missing {job_dir}")
    original_path = _find_original_path(job_dir)
    if original_path is None:
        return _error_out(job_id, ErrorCode.FILE_NOT_FOUND, f"Missing {ORIGINAL_PDF} or {ORIGINAL_EPUB}")

    # ----- options -----------------------------------------------------------

    opt_result = _load_and_validate_options(job_dir, options, default_image_format)
    if not opt_result.get("success", True):
        return {**opt_result, "job_id": job_id}
    merged_options: dict[str, Any] = opt_result

    page_range: str | None = merged_options.get("page_range")
    force_ocr: bool = bool(merged_options.get("force_ocr", False))
    paginate_output: bool = bool(merged_options.get("paginate_output", False))
    img_fmt: str = str(merged_options.get("output_image_format", default_image_format))

    # ----- conversion --------------------------------------------------------

    t0 = time.perf_counter()
    timings: dict[str, float] = {}
    _write_progress(job_dir, "parsing", "loading models")

    try:
        t_start = time.perf_counter()
        cfg: dict[str, Any] = {
            "filepath": str(original_path),
            "page_range": page_range,
            "force_ocr": force_ocr,
            "paginate_output": paginate_output,
            "output_format": "markdown",
            "use_llm": False,
        }
        config_parser = ConfigParser(cfg)
        config_dict = config_parser.generate_config_dict()
        pdftext_workers: int = config.marker_pdftext_workers
        config_dict["pdftext_workers"] = pdftext_workers

        converter = PdfConverter(
            config=config_dict,
            artifact_dict=models_obj,
            processor_list=config_parser.get_processors(),
            renderer=config_parser.get_renderer(),
            llm_service=None,
        )
        timings["setup_seconds"] = _elapsed_seconds(t_start)

        _write_progress(job_dir, "parsing", "converting document")
        t_start = time.perf_counter()
        rendered_output = converter(str(original_path))
        timings["convert_seconds"] = _elapsed_seconds(t_start)

        _write_progress(job_dir, "parsing", "extracting content")
        t_start = time.perf_counter()
        extracted_text, _, images = text_from_rendered(rendered_output)
        timings["extract_seconds"] = _elapsed_seconds(t_start)

        # Rewire image references and remove environment-specific EPUB links.
        extracted_text = _rewrite_image_refs(extracted_text, images)
        extracted_text = _sanitize_markdown_links(extracted_text, job_dir)

        # ----- write output --------------------------------------------------

        _write_output_files(job_dir, extracted_text, images, img_fmt, timings)

        # ----- metadata ------------------------------------------------------

        meta = rendered_output.metadata
        page_count = int(len(meta.get("page_stats", []))) if isinstance(meta, dict) else 0
        timings["total_seconds"] = _elapsed_seconds(t0)

        metadata_doc: dict[str, Any] = {
            "page_count": page_count,
            "renderer_version": "marker-pdf",
            "model_versions": {},
            "timings": timings,
            "runtime": {
                "gpu_type": config.gpu_type or "unknown",
                "pdftext_workers": pdftext_workers,
                "input_extension": original_path.suffix.lower(),
                "output_image_format": img_fmt,
            },
        }
        atomic_write_json(job_dir / METADATA_FILENAME, metadata_doc)
        logger.info(
            "[ModuleC] Parsed job_id=%s pages=%s pdftext_workers=%s timings=%s",
            job_id,
            page_count,
            pdftext_workers,
            timings,
        )

        # Write progress *before* committing cache so external observers
        # never see stale progress when the container is killed post-commit.
        _write_progress(job_dir, "parsing", "completed", current_page=page_count, total_pages=page_count)

        # Commit cache volume to persist artifacts (best effort)
        if commit_cache:
            try:
                commit_cache()
            except Exception:
                logger.warning("commit_cache failed for job_id=%s", job_id, exc_info=True)

        return {"success": True, "job_id": job_id, "page_count": page_count}

    except RuntimeError as e:
        emsg = str(e)
        if _is_gpu_oom_error(e):
            return _error_out(job_id, ErrorCode.GPU_OOM, f"[{type(e).__name__}] {emsg}")
        return _error_out(job_id, ErrorCode.PARSE_ERROR, f"[{type(e).__name__}] {emsg}")
    except Exception as e:
        return _error_out(job_id, ErrorCode.PARSE_ERROR, f"[{type(e).__name__}] {e}")
