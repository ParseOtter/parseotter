"""
Modal deployment for the ParseOtter document conversion service.
"""

from functools import partial
from typing import Any, Dict, Optional

import modal

from model_loader import setup_models_with_cache_check
from shared.config import load_config
from shared.context import JobContext


CONFIG = load_config(strict_gateway=False)
GPU_TYPE = CONFIG.gpu_type  # Override via env if needed.
MARKER_PDFTEXT_WORKERS = CONFIG.marker_pdftext_workers
MARKER_SERVICE_SCALEDOWN_WINDOW = CONFIG.service_scaledown_window
MARKER_SERVICE_MIN_CONTAINERS = CONFIG.service_min_containers
MARKER_SERVICE_MAX_CONTAINERS = CONFIG.service_max_containers
MODEL_PATH_PREFIX = "/root/.cache/datalab/models"
MARKER_JOB_DIR = CONFIG.marker_job_dir
MODAL_APP_NAME = CONFIG.modal_app_name
CLOUDFLARE_DISPATCH_SECRET_NAME = CONFIG.cloudflare_dispatch_secret_name
GATEWAY_SECRETS = [modal.Secret.from_name(CLOUDFLARE_DISPATCH_SECRET_NAME)]

# Modal app definition.
app = modal.App(MODAL_APP_NAME)

# Base runtime image.
image = (
    modal.Image.debian_slim(python_version="3.13")
    .apt_install(["git", "wget", "weasyprint"])
    .env(
        {
            "TORCH_DEVICE": "cuda",
            "MODAL_APP_NAME": MODAL_APP_NAME,
            "CLOUDFLARE_DISPATCH_SECRET_NAME": CLOUDFLARE_DISPATCH_SECRET_NAME,
            "GPU_TYPE": GPU_TYPE,
            "MARKER_PDFTEXT_WORKERS": str(MARKER_PDFTEXT_WORKERS),
            "MARKER_SERVICE_MAX_CONTAINERS": str(MARKER_SERVICE_MAX_CONTAINERS),
        }
    )
    .pip_install(
        [
            "marker-pdf[full]>=1.10.1",
            "fastapi>=0.121.3",
            "python-multipart>=0.0.20",
            "requests>=2.31.0",
            "torch>=2.2.2,<3.0.0",
            "weasyprint>=63.1",
            "torchvision>=0.17.0",
            "uvicorn>=0.30.0",
        ]
    )
    .add_local_python_source("marker_inference")
    .add_local_python_source("orchestrator")
    .add_local_python_source("api_gateway")
    .add_local_python_source("shared")
    .add_local_python_source("model_loader")
    .add_local_python_source("cli_entrypoints")
)

# Persistent volumes for models, cache, and job data.
models_volume = modal.Volume.from_name(CONFIG.modal_models_volume_name, create_if_missing=True)
cache_volume = modal.Volume.from_name(CONFIG.modal_cache_volume_name, create_if_missing=True)


setup_models_for_modal = partial(
    setup_models_with_cache_check,
    model_path_prefix=MODEL_PATH_PREFIX,
    commit_callback=models_volume.commit,
)


@app.function(
    image=image,
    volumes={MODEL_PATH_PREFIX: models_volume},
    gpu=GPU_TYPE,
    timeout=600,
)
def download_models():
    """Warm the persistent volume by downloading Marker models ahead of time."""
    import logging

    logging.basicConfig(level=logging.INFO)
    logger = logging.getLogger(__name__)

    logger.info("Downloading models to persistent volume...")
    logger.info(f"Volume mounted at: {MODEL_PATH_PREFIX}")

    try:
        models = setup_models_for_modal(logger, commit_volume=True)
        return f"Models downloaded successfully: {list(models.keys())}"
    except Exception as e:  # pragma: no cover - surfaced via Modal logs
        logger.error(f"Failed to download models: {e}")
        raise


@app.cls(
    image=image,
    gpu=GPU_TYPE,
    memory=16384,  # CPU RAM in MB
    timeout=600,  # 10 minute timeout for large documents
    volumes={
        MODEL_PATH_PREFIX: models_volume,
        "/cache": cache_volume,
    },
    scaledown_window=MARKER_SERVICE_SCALEDOWN_WINDOW,
    min_containers=MARKER_SERVICE_MIN_CONTAINERS,
    max_containers=MARKER_SERVICE_MAX_CONTAINERS,
)
class MarkerConversionService:
    @modal.enter()
    def load_models(self):
        """Load models once per container using @modal.enter() for efficiency."""
        import logging
        import traceback

        logging.basicConfig(
            level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
        )
        logger = logging.getLogger(__name__)

        logger.info("Loading Marker models using @modal.enter()...")
        try:
            self.models = setup_models_for_modal(logger, commit_volume=True)
        except Exception as e:
            logger.error(f"Error loading models: {e}")
            traceback.print_exc()
            self.models = None

    @modal.method()
    def run_marker_inference(
        self, job_id: str, options: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """GPU parsing worker per Module C Frozen v1.0 (remote callable)."""
        from marker_inference import run_marker_inference_core

        # Ensure this parser container sees latest uploads to /cache from gateway/test harness.
        cache_volume.reload()
        return run_marker_inference_core(
            getattr(self, "models", None),
            job_id,
            options,
            job_root=MARKER_JOB_DIR,
            commit_cache=lambda: cache_volume.commit(),
        )


@app.function(
    image=image,
    secrets=GATEWAY_SECRETS,
    volumes={"/cache": cache_volume},
    timeout=900,
)
def run_orchestrator(job_id: str, options: Optional[Dict[str, Any]] = None) -> dict:
    """CPU orchestrator wrapper for async job processing."""
    import orchestrator

    cache_volume.reload()
    ctx = JobContext(
        parser_handle=MarkerConversionService().run_marker_inference,
        reload_cache=cache_volume.reload,
        commit_cache=cache_volume.commit,
    )
    outcome = orchestrator.process_job_background(job_id, options=options, ctx=ctx)
    return {
        "job_id": outcome.job_id,
        "status": outcome.status,
        "phase": outcome.current_phase,
        "progress": outcome.progress,
        "error_code": outcome.error_code,
        "error_message": outcome.error_message,
    }


@app.function(
    image=image,
    secrets=GATEWAY_SECRETS,
    volumes={"/cache": cache_volume},
    timeout=900,
    max_containers=MARKER_SERVICE_MAX_CONTAINERS,
)
def run_cloudflare_dispatch_job(job_id: str) -> dict:
    """Process a Cloudflare-native R2-backed dispatch and callback the Worker."""
    from api_gateway.dispatch import process_cloudflare_dispatch_job

    cache_volume.reload()
    ctx = JobContext(
        parser_handle=MarkerConversionService().run_marker_inference,
        reload_cache=cache_volume.reload,
        commit_cache=cache_volume.commit,
    )
    try:
        result = process_cloudflare_dispatch_job(job_id, ctx=ctx)
        return result
    finally:
        cache_volume.commit()


@app.function(
    image=image,
    secrets=GATEWAY_SECRETS,
    volumes={"/cache": cache_volume},
)
@modal.asgi_app()
def gateway_app():
    import logging
    from pathlib import Path

    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware
    from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

    from api_gateway import handlers

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
    )

    job_root = Path(MARKER_JOB_DIR)
    job_root.mkdir(parents=True, exist_ok=True)

    def _commit_cache() -> None:
        cache_volume.commit()

    app = FastAPI()
    app.add_middleware(ProxyHeadersMiddleware, trusted_hosts="*")
    app.state.job_ctx = JobContext(
        cloudflare_dispatch_handle=run_cloudflare_dispatch_job,
        commit_cache=_commit_cache,
        reload_cache=cache_volume.reload,
    )

    origins = CONFIG.cors_origins
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(handlers.router, prefix="/api")

    @app.get("/healthz")
    async def healthz():
        return {"status": "ok"}

    return app


#
# This does not get deployed. It's a useful local CLI helper that runs the
# shared conversion pipeline without relying on the removed legacy web API.
#
@app.local_entrypoint()
def invoke_conversion(pdf_file: Optional[str] = None, output_format: str = "markdown"):
    """
    Local entrypoint to run a single conversion through the current OSS pipeline.

    Usage:
        modal run modal-converter/modal_app.py::invoke_conversion --pdf-file /path/to/file.pdf
    """
    from cli_entrypoints import run_invoke_conversion

    run_invoke_conversion(pdf_file, output_format, setup_models_for_modal)


@app.local_entrypoint()
def smoke_run_marker_inference(
    pdf_file: Optional[str] = None,
    job_id: Optional[str] = None,
    page_range: Optional[str] = None,
    output_image_format: str = "JPEG",
):
    """Local smoke test for Module B -> C call path.

    Prepares a job directory under MARKER_JOB_DIR, writes the original input file
    and options.json, then runs the shared local inference core and prints the outcome.

    Usage:
        modal run modal-converter/modal_app.py::smoke_run_marker_inference \
          --pdf-file /path/to/file.pdf --page-range 1-3 --output-image-format PNG
    """
    from cli_entrypoints import run_smoke_marker_inference

    run_smoke_marker_inference(
        pdf_file,
        job_id,
        page_range,
        output_image_format,
        setup_models_for_modal,
    )
