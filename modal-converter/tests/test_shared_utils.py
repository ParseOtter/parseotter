import concurrent.futures
import io
import json

import pytest

from shared.atomic_write import atomic_write_json
from shared.hashing import sha256_file, sha256_stream


def test_atomic_write_json_concurrent_writes_leave_valid_json(tmp_path):
    path = tmp_path / "status.json"

    def write(index: int) -> None:
        atomic_write_json(path, {"index": index, "payload": f"value-{index}"})

    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as executor:
        list(executor.map(write, range(64)))

    loaded = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(loaded["index"], int)
    assert loaded["payload"] == f"value-{loaded['index']}"
    assert list(tmp_path.glob("*.tmp")) == []
    assert list(tmp_path.glob(".*.tmp")) == []


def test_atomic_write_json_rejects_non_finite_numbers_without_clobbering(tmp_path):
    path = tmp_path / "status.json"
    atomic_write_json(path, {"status": "previous"})

    with pytest.raises(ValueError):
        atomic_write_json(path, {"value": float("nan")})

    assert json.loads(path.read_text(encoding="utf-8")) == {"status": "previous"}
    assert list(tmp_path.glob("*.tmp")) == []
    assert list(tmp_path.glob(".*.tmp")) == []


def test_sha256_file_and_stream_match_for_large_payload(tmp_path):
    payload = (b"0123456789abcdef" * 100_000) + b"tail"
    path = tmp_path / "payload.bin"
    path.write_bytes(payload)

    assert sha256_file(path) == sha256_stream(io.BytesIO(payload))
