import io
import re
import importlib.util
from pathlib import Path


def load_id_utils_module():
    root = Path(__file__).resolve().parents[1]
    id_utils_path = root / "id_utils.py"
    spec = importlib.util.spec_from_file_location("api_gateway.id_utils", str(id_utils_path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


iu = load_id_utils_module()


def test_generate_job_id_format():
    job_id = iu.generate_job_id()
    # basic UUID4 regex check
    assert re.match(r"^[0-9a-fA-F-]{36}$", job_id)


def test_compute_sha256_from_bytes():
    # echo -n "hello world" | shasum -a 256 | awk '{ print $1 }'
    data = b"hello world"
    expected = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
    assert iu.compute_sha256_from_bytes(data) == expected


def test_compute_sha256_from_stream_and_file(tmp_path):
    data = b"streaming data for hash"
    stream = io.BytesIO(data)
    stream_hash = iu.compute_sha256_from_stream(stream)

    file_path = tmp_path / "test.bin"
    file_path.write_bytes(data)
    file_hash = iu.compute_sha256_from_file(str(file_path))

    assert stream_hash == file_hash


def test_compute_sha256_from_stream_restores_original_position():
    data = b"prefix-streaming data for hash"
    stream = io.BytesIO(data)
    stream.seek(7)

    digest = iu.compute_sha256_from_stream(stream)

    assert digest == iu.compute_sha256_from_bytes(data)
    assert stream.tell() == 7
