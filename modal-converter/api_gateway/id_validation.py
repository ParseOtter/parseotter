"""Job ID validation shared between dispatch and public API endpoints."""

from __future__ import annotations

import re

_SAFE_JOB_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


def validate_job_id(job_id: str) -> str:
    """Validate and return the *job_id*, or raise :class:`ValueError`.

    This is the canonical guard for path-traversal prevention.  Every
    endpoint that interpolates a user-supplied ``job_id`` into a
    filesystem path **must** call this function first.
    """
    if not _SAFE_JOB_ID_PATTERN.fullmatch(job_id):
        raise ValueError("job_id is invalid")
    return job_id


def sanitize_job_id_for_header(job_id: str) -> str:
    """Return a safe variant of *job_id* suitable for HTTP header values.

    Strips backslashes and double-quote characters that could be used
    to escape the ``Content-Disposition`` filename parameter.
    """
    return job_id.replace("\\", "").replace('"', "")
