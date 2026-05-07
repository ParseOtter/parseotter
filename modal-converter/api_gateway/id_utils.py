import uuid
from pathlib import Path
from typing import BinaryIO

from shared.hashing import sha256_file, sha256_hex, sha256_stream


def generate_job_id() -> str:
    """Generate a UUID4-based job id string."""
    return str(uuid.uuid4())


def compute_sha256_from_bytes(data: bytes) -> str:
    return sha256_hex(data)


def compute_sha256_from_file(path: str) -> str:
    return sha256_file(Path(path))


def compute_sha256_from_stream(stream: BinaryIO) -> str:
    """Read from a binary stream and compute sha256. Stream will be rewound if seekable."""
    pos = None
    try:
        if stream.seekable():
            pos = stream.tell()
            stream.seek(0)
    except Exception:
        pos = None

    digest = sha256_stream(stream)

    try:
        if pos is not None:
            stream.seek(pos)
    except Exception:
        pass

    return digest
