"""Cryptographic hash utilities."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import BinaryIO


HASH_CHUNK_SIZE = 1024 * 1024


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with open(path, "rb") as file:
        for chunk in iter(lambda: file.read(HASH_CHUNK_SIZE), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def sha256_stream(stream: BinaryIO) -> str:
    hasher = hashlib.sha256()
    for chunk in iter(lambda: stream.read(HASH_CHUNK_SIZE), b""):
        hasher.update(chunk)
    return hasher.hexdigest()
