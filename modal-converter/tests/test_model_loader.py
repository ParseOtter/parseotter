"""Tests for model_loader.py."""

import sys
from types import ModuleType
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture
def logger():
    return MagicMock()


@pytest.fixture
def mock_create_model_dict():
    marker_mod = ModuleType("marker")
    marker_models = ModuleType("marker.models")
    marker_mod.models = marker_models

    mock = MagicMock(return_value={"detector": "model1", "recognizer": "model2"})
    marker_models.create_model_dict = mock

    with patch.dict(sys.modules, {"marker": marker_mod, "marker.models": marker_models}):
        yield mock


class TestSetupModelsWithCacheCheck:
    """TDD tests for setup_models_with_cache_check()."""

    def test_loads_models_and_logs_success(self, logger, mock_create_model_dict, tmp_path):
        """Should load models and log success with model count."""
        from model_loader import setup_models_with_cache_check

        models = setup_models_with_cache_check(
            logger, model_path_prefix=str(tmp_path)
        )

        assert models == {"detector": "model1", "recognizer": "model2"}
        mock_create_model_dict.assert_called_once()
        logger.info.assert_any_call(
            f"Successfully loaded {len(mock_create_model_dict.return_value)} models"
        )

    def test_logs_cache_hit_when_models_exist(self, logger, mock_create_model_dict, tmp_path):
        """Should log cache hit when volume already has models."""
        from model_loader import setup_models_with_cache_check

        (tmp_path / "some_model.pt").touch()

        setup_models_with_cache_check(logger, model_path_prefix=str(tmp_path))

        logger.info.assert_any_call(
            f"Models cache directory contents: {['some_model.pt']}"
        )

    def test_logs_cache_miss_when_no_models(self, logger, mock_create_model_dict, tmp_path):
        """Should warn about model download when cache is empty."""
        from model_loader import setup_models_with_cache_check

        setup_models_with_cache_check(logger, model_path_prefix=str(tmp_path))

        logger.warning.assert_called_once_with(
            "No models found in volume cache. Models will be downloaded now "
            "(this may take several minutes)."
        )

    def test_commits_volume_when_flag_set(self, logger, mock_create_model_dict, tmp_path):
        """Should call commit_callback when commit_volume=True."""
        from model_loader import setup_models_with_cache_check

        commit_callback = MagicMock()

        setup_models_with_cache_check(
            logger,
            model_path_prefix=str(tmp_path),
            commit_volume=True,
            commit_callback=commit_callback,
        )

        commit_callback.assert_called_once()
        logger.info.assert_any_call("Attempting to commit volume...")
        logger.info.assert_any_call("Volume committed successfully")

    def test_skips_commit_when_flag_is_false(self, logger, mock_create_model_dict, tmp_path):
        """Should not call commit_callback when commit_volume=False."""
        from model_loader import setup_models_with_cache_check

        commit_callback = MagicMock()

        setup_models_with_cache_check(
            logger,
            model_path_prefix=str(tmp_path),
            commit_volume=False,
            commit_callback=commit_callback,
        )

        commit_callback.assert_not_called()

    def test_skips_commit_when_callback_is_none(self, logger, mock_create_model_dict, tmp_path):
        """Should not fail when commit_volume=True but callback is None."""
        from model_loader import setup_models_with_cache_check

        # Should not raise
        setup_models_with_cache_check(
            logger,
            model_path_prefix=str(tmp_path),
            commit_volume=True,
            commit_callback=None,
        )

    def test_logs_cache_contents_when_dir_exists(self, logger, mock_create_model_dict, tmp_path):
        """Should log cached file listing when model path exists."""
        from model_loader import setup_models_with_cache_check

        (tmp_path / "model_a.pt").touch()
        (tmp_path / "model_b.pt").touch()

        setup_models_with_cache_check(logger, model_path_prefix=str(tmp_path))

        # Find the "Models in cache:" call and verify both files appear
        cache_log_calls = [
            c for c in logger.info.call_args_list
            if c[0][0].startswith("Models in cache:")
        ]
        assert len(cache_log_calls) == 1
        logged = cache_log_calls[0][0][0]
        assert "model_a.pt" in logged
        assert "model_b.pt" in logged

    def test_handles_nonexistent_directory(self, logger, mock_create_model_dict):
        """Should handle model_path_prefix that does not exist."""
        from model_loader import setup_models_with_cache_check

        models = setup_models_with_cache_check(
            logger, model_path_prefix="/nonexistent/path"
        )

        assert models is not None
        logger.info.assert_any_call("Models cache directory exists: False")

    def test_treats_file_path_as_cache_miss(self, logger, mock_create_model_dict, tmp_path):
        """Should not fail when model_path_prefix exists but is not a directory."""
        from model_loader import setup_models_with_cache_check

        cache_path = tmp_path / "models"
        cache_path.write_text("not a directory", encoding="utf-8")

        models = setup_models_with_cache_check(
            logger, model_path_prefix=str(cache_path)
        )

        assert models == {"detector": "model1", "recognizer": "model2"}
        logger.info.assert_any_call("Models cache directory exists: False")
        logger.warning.assert_called_once_with(
            "No models found in volume cache. Models will be downloaded now "
            "(this may take several minutes)."
        )
