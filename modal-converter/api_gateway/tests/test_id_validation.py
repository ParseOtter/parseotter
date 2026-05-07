import pytest

from api_gateway.id_validation import sanitize_job_id_for_header, validate_job_id


@pytest.mark.parametrize(
    "job_id",
    [
        "550e8400-e29b-41d4-a716-446655440000",
        "abc_123.456-789",
        "A",
        "a" * 128,
    ],
)
def test_validate_job_id_accepts_safe_ids(job_id: str):
    assert validate_job_id(job_id) == job_id


@pytest.mark.parametrize(
    "job_id",
    [
        "",
        ".hidden",
        "_hidden",
        "-hidden",
        "../escape",
        "bad/id",
        "bad id",
        "a" * 129,
    ],
)
def test_validate_job_id_rejects_unsafe_ids(job_id: str):
    with pytest.raises(ValueError, match="job_id is invalid"):
        validate_job_id(job_id)


def test_sanitize_job_id_for_header_removes_filename_escape_characters():
    assert sanitize_job_id_for_header('job\\"id') == "jobid"
