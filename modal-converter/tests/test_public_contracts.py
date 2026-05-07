import orchestrator
from shared.constants import (
    PARSEOTTER_FREE_OUTPUT_PROFILE,
    SUPPORTED_OUTPUT_FORMATS,
    SUPPORTED_OUTPUT_PROFILES,
)
from shared.error_codes import ErrorCode


def test_orchestrator_package_exports_public_contract():
    assert set(orchestrator.__all__) == {
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
    }


def test_shared_output_constants_are_stable():
    assert PARSEOTTER_FREE_OUTPUT_PROFILE == "parseotter_free_v1"
    assert SUPPORTED_OUTPUT_PROFILES == frozenset({"parseotter_free_v1"})
    assert SUPPORTED_OUTPUT_FORMATS == frozenset({"markdown", "zip"})


def test_error_code_values_are_stable():
    assert {code.value for code in ErrorCode} == {
        "FILE_NOT_FOUND",
        "OPTIONS_INVALID",
        "GPU_OOM",
        "PARSE_ERROR",
        "INTERNAL_ERROR",
        "RETRY_SCHEDULED",
        "LOCK_HELD",
        "MODEL_NOT_READY",
        "MODAL_PROCESSING_FAILED",
    }
