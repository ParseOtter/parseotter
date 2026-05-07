"""Public orchestrator package API."""

from . import cache, lock, pipeline, retry, status
from orchestrator.cache import (
    _build_cache_signature,
    _cache_dir,
    _cache_is_valid,
    _compute_cache_key,
    _copy_file_if_exists,
    _copy_tree_if_exists,
    _restore_cached_parse,
    _store_cached_parse,
    restore_cached_parse,
    store_cached_parse,
)
from orchestrator.lock import _acquire_lock, _lock_path, _release_lock, acquire_lock, release_lock
from orchestrator.pipeline import (
    PARSING_PROGRESS_END,
    PARSING_DONE_SENTINEL,
    PARSEOTTER_FREE_OUTPUT_PROFILE,
    Outcome,
    _invoke_parsing,
    _job_dir,
    _load_options,
    _mark_stage_done,
    _parsing_stage_done,
    _stage_sentinel_path,
    _write_result_zip,
    _write_result_zip_for_profile,
    process_job_background,
)
from orchestrator.retry import RETRY_POLICY, _should_retry, should_retry
from orchestrator.status import (
    _atomic_write_json,
    _default_status,
    _merge_status,
    _now,
    _read_json,
    _record_failure,
    _record_success,
    _record_success_with_warning,
    _status_path,
    _update_phase,
)

__all__ = [
    "Outcome",
    "process_job_background",
    "PARSING_PROGRESS_END",
    "PARSING_DONE_SENTINEL",
    "PARSEOTTER_FREE_OUTPUT_PROFILE",
    "RETRY_POLICY",
    "acquire_lock",
    "release_lock",
    "restore_cached_parse",
    "store_cached_parse",
]
