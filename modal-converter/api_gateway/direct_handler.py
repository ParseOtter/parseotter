from fastapi import APIRouter, HTTPException, Request, UploadFile, File, Form
from typing import Any, Optional
import json
import uuid
import io
import base64
import os
from pathlib import Path
from shared.config import load_config
from shared.context import JobContext
from marker_inference import MARKDOWN_FILENAME, METADATA_FILENAME, IMAGES_DIRNAME
from api_gateway import storage, status_writer
from api_gateway.id_validation import validate_job_id
from orchestrator.pipeline import process_job_background

router = APIRouter()

MAX_IMAGE_BYTES = 10 * 1024 * 1024
SUPPORTED_EXTENSIONS = frozenset({".pdf", ".epub"})


def _require_direct_enabled():
    if os.environ.get("DIRECT_ENABLED", "").lower() not in ("1", "true", "yes"):
        raise HTTPException(
            503, detail="DIRECT_ENABLED is not set. Direct endpoints are disabled."
        )


def _read_images(job_dir: Path) -> list[dict[str, str]]:
    images: list[dict[str, str]] = []
    images_dir = job_dir / IMAGES_DIRNAME
    try:
        if images_dir.exists():
            for img_path in sorted(images_dir.iterdir()):
                if img_path.is_file() and img_path.stat().st_size <= MAX_IMAGE_BYTES:
                    img_b64 = base64.b64encode(img_path.read_bytes()).decode("ascii")
                    images.append({"name": img_path.name, "data": img_b64})
    except (OSError, PermissionError):
        pass
    return images


def _read_job_metadata(job_dir: Path) -> dict:
    metadata_raw = (job_dir / METADATA_FILENAME).read_text(encoding="utf-8")
    return json.loads(metadata_raw)


def _build_metadata_payload(metadata: dict) -> dict:
    runtime = metadata.get("runtime")
    if not isinstance(runtime, dict):
        runtime = {}
    return {
        "page_count": metadata.get("page_count", 0),
        "processing_time_ms": int(metadata.get("timings", {}).get("total_seconds", 0) * 1000),
        "gpu_type": runtime.get("gpu_type", "unknown"),
        "renderer_version": metadata.get("renderer_version", "marker-pdf"),
    }


@router.post("/direct/convert")
def convert_document(
    request: Request,
    file: UploadFile = File(...),
    page_range: Optional[str] = Form(None),
    max_pages: Optional[int] = Form(None),
):
    _require_direct_enabled()

    if not file.filename:
        raise HTTPException(400, detail="Filename is required")
    ext = Path(file.filename).suffix.lower()
    if ext not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            400,
            detail=f"Unsupported file type '{ext}'. Supported: {', '.join(sorted(SUPPORTED_EXTENSIONS))}",
        )

    cfg = load_config(strict_gateway=True)
    ctx: JobContext = request.app.state.job_ctx

    file_bytes = file.file.read()
    if len(file_bytes) > cfg.max_upload_bytes:
        raise HTTPException(413, detail=f"File exceeds maximum size of {cfg.max_upload_bytes} bytes")

    job_id = f"direct_{uuid.uuid4().hex}"

    try:
        validate_job_id(job_id)
    except ValueError as e:
        raise HTTPException(400, detail=f"Invalid job ID: {e}")

    try:
        original_name = "original.epub" if ext == ".epub" else "original.pdf"
        file_io = io.BytesIO(file_bytes)
        storage.write_job_files(
            cfg.marker_job_dir, job_id, file_io,
            file_name=original_name,
        )
        job_dir = Path(cfg.marker_job_dir) / job_id

        status_writer.create_initial_status(
            cfg.marker_job_dir, job_id,
            file_name=file.filename,
            file_size=len(file_bytes),
        )
        ctx.commit_cache()

        options: dict[str, Any] = {}
        if page_range is not None:
            options["page_range"] = page_range
        if max_pages is not None:
            options["max_pages"] = max_pages

        outcome = process_job_background(job_id, options=options, ctx=ctx)
        if outcome.status == "failed":
            raise HTTPException(500, detail=outcome.error_message or "Conversion failed")

        markdown = (job_dir / MARKDOWN_FILENAME).read_text(encoding="utf-8")
        images = _read_images(job_dir)
        metadata = _read_job_metadata(job_dir)
        metadata_payload = _build_metadata_payload(metadata)

        return {
            "job_id": job_id,
            "status": "complete",
            "markdown": markdown,
            "images": images,
            "metadata": metadata_payload,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, detail=f"Conversion failed: {e}")


@router.get("/direct/jobs/{job_id}")
def get_job_status(request: Request, job_id: str):
    _require_direct_enabled()
    try:
        validate_job_id(job_id)
    except ValueError as e:
        raise HTTPException(400, detail=f"Invalid job ID: {e}")

    cfg = load_config(strict_gateway=True)
    job_dir = Path(cfg.marker_job_dir) / job_id
    if not job_dir.exists():
        raise HTTPException(404, detail=f"Job {job_id} not found")

    status_file = job_dir / "status.json"
    if not status_file.exists():
        raise HTTPException(404, detail=f"Status not found for job {job_id}")

    try:
        status = json.loads(status_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise HTTPException(500, detail=f"Corrupted status file: {e}")

    return {"job_id": job_id, "status": status}


@router.get("/direct/jobs/{job_id}/result")
def get_job_result(request: Request, job_id: str):
    _require_direct_enabled()
    try:
        validate_job_id(job_id)
    except ValueError as e:
        raise HTTPException(400, detail=f"Invalid job ID: {e}")

    cfg = load_config(strict_gateway=True)
    job_dir = Path(cfg.marker_job_dir) / job_id
    if not job_dir.exists():
        raise HTTPException(404, detail=f"Job {job_id} not found")

    status_file = job_dir / "status.json"
    if not status_file.exists():
        raise HTTPException(404, detail=f"Status not found for job {job_id}")

    try:
        status = json.loads(status_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise HTTPException(500, detail=f"Corrupted status file: {e}")

    if not isinstance(status, dict):
        raise HTTPException(400, detail="Corrupted status: not a dict")

    if status.get("status") != "complete":
        raise HTTPException(400, detail="Job is not complete")

    markdown_file = job_dir / MARKDOWN_FILENAME
    if not markdown_file.exists():
        raise HTTPException(500, detail="Result markdown file not found")

    try:
        markdown = markdown_file.read_text(encoding="utf-8")
    except Exception as e:
        raise HTTPException(500, detail=f"Failed to read markdown: {e}")

    images = _read_images(job_dir)

    try:
        metadata = _read_job_metadata(job_dir)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        raise HTTPException(500, detail=f"Failed to read metadata: {e}")

    metadata_payload = _build_metadata_payload(metadata)

    return {
        "job_id": job_id,
        "status": "complete",
        "markdown": markdown,
        "images": images,
        "metadata": metadata_payload,
    }
