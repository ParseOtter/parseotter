"""Shared model loading helpers for Modal entrypoints."""

from __future__ import annotations

import gc
import logging
import os
from collections.abc import Callable


def setup_models_with_cache_check(
    logger: logging.Logger,
    *,
    model_path_prefix: str,
    commit_volume: bool = False,
    commit_callback: Callable[[], None] | None = None,
):
    """Load Marker models and optionally persist the model cache volume."""
    from marker.models import create_model_dict

    models_dir_exists = os.path.isdir(model_path_prefix)
    models_dir_contents = os.listdir(model_path_prefix) if models_dir_exists else []

    logger.info(f"Models cache directory exists: {models_dir_exists}")
    logger.info(f"Models cache directory contents: {models_dir_contents}")

    if models_dir_exists and models_dir_contents:
        logger.info("Found existing models in volume cache, loading from cache...")
    else:
        logger.warning(
            "No models found in volume cache. Models will be downloaded now (this may take several minutes)."
        )

    models = create_model_dict()
    logger.info(f"Successfully loaded {len(models)} models")

    if models_dir_exists:
        contents = os.listdir(model_path_prefix)
        logger.info(f"Models in cache: {contents}")

    if commit_volume and commit_callback is not None:
        gc.collect()
        logger.info("Attempting to commit volume...")
        commit_callback()
        logger.info("Volume committed successfully")

    return models
