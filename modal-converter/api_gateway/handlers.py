from fastapi import APIRouter, Body, HTTPException, Header, Request
from fastapi.responses import FileResponse, JSONResponse
from typing import Any, Optional
import json
import os
import zipfile
from pathlib import Path

from shared.config import load_config
from shared.constants import PARSEOTTER_FREE_OUTPUT_PROFILE
from shared.context import JobContext

from api_gateway.id_validation import sanitize_job_id_for_header, validate_job_id
from shared.env import read_optional_str_env

from . import storage
from .dispatch import (
    CallbackConfigError,
    DispatchConflictError,
    DispatchValidationError,
    R2ConfigError,
    prepare_cloudflare_dispatch_job,
    process_cloudflare_dispatch_job,
    validate_dispatch_payload,
)

router = APIRouter()


def _read_options_profile(job_dir: Path) -> str:
    """Return the output_profile from *job_dir*/options.json, or empty string."""
    opt_path = job_dir / "options.json"
    if not opt_path.exists():
        return ""
    try:
        with open(opt_path, "r", encoding="utf-8") as f:
            opts = json.load(f)
    except Exception:
        return ""
    if isinstance(opts, dict):
        profile = opts.get("output_profile")
        if isinstance(profile, str):
            return profile
    return ""


def _enforce_api_secret(cfg, x_api_key: Optional[str]) -> None:
    if cfg.api_secret:
        if not x_api_key or x_api_key != cfg.api_secret:
            raise HTTPException(status_code=401, detail="invalid api key")


def _modal_app_name() -> str:
    return load_config(strict_gateway=False).modal_app_name


def _job_ctx(request: Request) -> JobContext:
    ctx = getattr(request.app.state, "job_ctx", None)
    return ctx if isinstance(ctx, JobContext) else JobContext()


def _invoke_cloudflare_dispatch_job(job_id: str, ctx: JobContext) -> None:
    if ctx.cloudflare_dispatch_handle is not None:
        try:
            ctx.cloudflare_dispatch_handle.spawn(job_id)
            return
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"failed to spawn Cloudflare dispatch job: {e}")

    if read_optional_str_env("MODAL_TASK_ID"):
        try:
            import modal
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"failed to import modal: {e}")

        try:
            env_name = read_optional_str_env("MODAL_ENVIRONMENT")
            app_name = _modal_app_name()
            if env_name:
                dispatch_fn = modal.Function.from_name(app_name, "run_cloudflare_dispatch_job", environment_name=env_name)
            else:
                dispatch_fn = modal.Function.from_name(app_name, "run_cloudflare_dispatch_job")
            dispatch_fn.spawn(job_id)
            return
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"failed to spawn Cloudflare dispatch job: {e}")

    try:
        process_cloudflare_dispatch_job(job_id, ctx=ctx)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"failed to process Cloudflare dispatch job: {e}")


@router.post("/internal/cloudflare/jobs/dispatch")
def post_cloudflare_job_dispatch(
    request: Request,
    body: Any = Body(...),
    x_api_key: Optional[str] = Header(None, alias="X-API-KEY"),
    x_idempotency_key: Optional[str] = Header(None, alias="X-Idempotency-Key"),
):
    try:
        cfg = load_config()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    _enforce_api_secret(cfg, x_api_key)
    ctx = _job_ctx(request)

    idempotency_key = x_idempotency_key.strip() if isinstance(x_idempotency_key, str) else ""
    if not idempotency_key:
        raise HTTPException(status_code=400, detail="X-Idempotency-Key is required")

    try:
        payload = validate_dispatch_payload(body)
        input_size = payload["input"]["sizeBytes"]
        if input_size > cfg.max_upload_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"input size {input_size} exceeds max upload {cfg.max_upload_bytes}",
            )
        result = prepare_cloudflare_dispatch_job(
            cfg.marker_job_dir,
            payload,
            idempotency_key,
        )
    except DispatchValidationError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except CallbackConfigError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except R2ConfigError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except DispatchConflictError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except storage.StorageError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

    try:
        if callable(ctx.commit_cache):
            ctx.commit_cache()
    except Exception:
        pass

    if result.get("duplicate") is not True:
        _invoke_cloudflare_dispatch_job(payload["jobId"], ctx)

    return JSONResponse(result, status_code=202)


@router.get("/jobs/{job_id}")
def get_job_status(request: Request, job_id: str, x_api_key: Optional[str] = Header(None, alias="X-API-KEY")):
    ctx = _job_ctx(request)
    if callable(ctx.reload_cache):
        try:
            ctx.reload_cache()
        except Exception:
            pass

    try:
        cfg = load_config()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    _enforce_api_secret(cfg, x_api_key)

    try:
        job_id = validate_job_id(job_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid job_id")

    job_dir = Path(cfg.marker_job_dir) / job_id
    status_path = job_dir / "status.json"
    if not status_path.exists():
        raise HTTPException(status_code=404, detail="job not found")

    try:
        with open(status_path, "r", encoding="utf-8") as f:
            status = json.load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"failed to read status: {e}")

    return JSONResponse(status)


@router.get("/jobs/{job_id}/download")
def download_job(request: Request, job_id: str, x_api_key: Optional[str] = Header(None, alias="X-API-KEY")):
    ctx = _job_ctx(request)
    if callable(ctx.reload_cache):
        try:
            ctx.reload_cache()
        except Exception:
            pass

    try:
        cfg = load_config()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    _enforce_api_secret(cfg, x_api_key)

    try:
        job_id = validate_job_id(job_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid job_id")

    job_dir = Path(cfg.marker_job_dir) / job_id
    status_path = job_dir / "status.json"
    if not status_path.exists():
        raise HTTPException(status_code=404, detail="job not found")

    try:
        with open(status_path, "r", encoding="utf-8") as f:
            status = json.load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"failed to read status: {e}")

    raw_md = job_dir / "raw.md"
    if not raw_md.exists():
        raise HTTPException(status_code=404, detail="job artifacts missing")

    zip_path = job_dir / "result.zip"
    if not zip_path.exists():
        # Determine whether to apply free-tier exclusions.
        output_profile = _read_options_profile(job_dir)
        is_free = output_profile == PARSEOTTER_FREE_OUTPUT_PROFILE

        tmp_path = job_dir / ".result.zip.tmp"
        if tmp_path.exists():
            tmp_path.unlink()
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
            if raw_md.exists():
                zf.write(raw_md, arcname="raw.md")
            if status_path.exists() and not is_free:
                zf.write(status_path, arcname="status.json")
            images_dir = job_dir / "images"
            if images_dir.exists() and images_dir.is_dir():
                for path in images_dir.rglob("*"):
                    if path.is_symlink():
                        continue
                    if path.is_file():
                        arc = path.relative_to(job_dir)
                        zf.write(path, arcname=str(arc))
        os.replace(tmp_path, zip_path)
    safe_job_id = sanitize_job_id_for_header(job_id)
    headers = {"Content-Disposition": f"attachment; filename={safe_job_id}.zip"}
    return FileResponse(zip_path, media_type="application/zip", headers=headers)
