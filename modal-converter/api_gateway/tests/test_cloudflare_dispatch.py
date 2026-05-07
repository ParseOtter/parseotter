import importlib.util
import hashlib
import hmac
import json
import os
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from shared.config import Config
from shared.context import JobContext


def load_dispatch_module():
    for name in list(sys.modules):
        if name == "api_gateway.dispatch" or name.startswith("api_gateway.dispatch."):
            sys.modules.pop(name)
    import api_gateway.dispatch as dispatch

    return dispatch


def load_handlers_app(job_root_env: str):
    os.environ["MARKER_JOB_DIR"] = job_root_env
    os.environ["API_SECRET"] = "modal-api-key"

    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location(
        "api_gateway.handlers",
        str(root / "handlers.py"),
    )
    handlers = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(handlers)
    class StubHandle:
        def __init__(self):
            self.spawned = []

        def spawn(self, *args, **kwargs):
            self.spawned.append((args, kwargs))

    stub = StubHandle()

    app = FastAPI()
    app.state.job_ctx = JobContext(cloudflare_dispatch_handle=stub)
    app.include_router(handlers.router, prefix="/api")
    return app, stub


def valid_dispatch_payload():
    return {
        "jobId": "job_cloudflare_dispatch",
        "userId": "user_1",
        "attempt": 1,
        "input": {
            "objectKey": "jobs/job_cloudflare_dispatch/input/source.pdf",
            "contentType": "application/pdf",
            "sizeBytes": 24,
            "checksumSha256": None,
        },
        "output": {
            "objectKey": "jobs/job_cloudflare_dispatch/output/output.md",
            "format": "markdown",
        },
        "options": {
            "force_ocr": False,
        },
        "callback": {
            "url": "https://api.example.test/api/internal/processing/modal-callback",
            "authHeaderName": "x-billing-internal-key",
            "idempotencyKey": "modal-callback:job_cloudflare_dispatch:1",
        },
    }


def free_dispatch_payload():
    payload = valid_dispatch_payload()
    payload["userId"] = "parseotter_free"
    payload["output"] = {
        "objectKey": "parseotter/job_cloudflare_dispatch/output/result.zip",
        "format": "zip",
    }
    payload["options"] = {
        "output_profile": "parseotter_free_v1",
    }
    payload["callback"] = {
        "url": "https://backend.test/api/internal/modal/callback",
        "authHeaderName": "X-Modal-Signature",
        "idempotencyKey": "job_cloudflare_dispatch:callback:1",
    }
    return payload


def configure_r2_env(monkeypatch):
    monkeypatch.setenv("CLOUDFLARE_R2_ACCOUNT_ID", "account-id")
    monkeypatch.setenv("CLOUDFLARE_R2_ACCESS_KEY_ID", "access-key")
    monkeypatch.setenv("CLOUDFLARE_R2_SECRET_ACCESS_KEY", "secret-key")
    monkeypatch.setenv("CLOUDFLARE_R2_BUCKET_NAME", "bucket-name")
    monkeypatch.setenv("CALLBACK_INTERNAL_API_KEY", "internal-callback-key")
    monkeypatch.setenv("MODAL_CALLBACK_HMAC_SECRET", "callback-secret")


def test_dispatch_endpoint_accepts_r2_object_job_and_spawns_worker(tmp_path, monkeypatch):
    configure_r2_env(monkeypatch)
    dispatch = load_dispatch_module()

    def fake_download_to_path(object_key, destination_path, checksum_sha256=None, *, max_bytes=None):
        Path(destination_path).write_bytes(b"%PDF-1.4 r2 pdf")
        return dispatch.R2TransferResult(size_bytes=15, sha256_hex="input-sha")

    monkeypatch.setattr(dispatch.r2_client, "download_r2_object_to_path", fake_download_to_path)

    app, stub = load_handlers_app(str(tmp_path / "jobs"))
    client = TestClient(app)

    response = client.post(
        "/api/internal/cloudflare/jobs/dispatch",
        json=valid_dispatch_payload(),
        headers={
            "X-API-KEY": "modal-api-key",
            "X-Idempotency-Key": "dispatch-key-1",
        },
    )

    assert response.status_code == 202
    assert response.json() == {
        "accepted": True,
        "duplicate": False,
        "jobId": "job_cloudflare_dispatch",
        "attempt": 1,
    }
    job_dir = tmp_path / "jobs" / "job_cloudflare_dispatch"
    assert (job_dir / "original.pdf").read_bytes() == b"%PDF-1.4 r2 pdf"
    assert json.loads((job_dir / "options.json").read_text(encoding="utf-8")) == {
        "force_ocr": False,
    }
    assert (job_dir / "status.json").exists()
    dispatch_meta = json.loads((job_dir / "cloudflare-dispatch.json").read_text(encoding="utf-8"))
    assert dispatch_meta["dispatchIdempotencyKey"] == "dispatch-key-1"
    assert dispatch_meta["payload"]["input"]["objectKey"] == "jobs/job_cloudflare_dispatch/input/source.pdf"
    assert stub.spawned == [(("job_cloudflare_dispatch",), {})]


def test_dispatch_endpoint_replays_same_idempotency_key_without_respawn(tmp_path, monkeypatch):
    configure_r2_env(monkeypatch)
    dispatch = load_dispatch_module()
    downloads = []

    def fake_download_to_path(_object_key, destination_path, checksum_sha256=None, *, max_bytes=None):
        downloads.append(True)
        Path(destination_path).write_bytes(b"%PDF-1.4 r2 pdf")
        return dispatch.R2TransferResult(size_bytes=15, sha256_hex="input-sha")

    monkeypatch.setattr(dispatch.r2_client, "download_r2_object_to_path", fake_download_to_path)
    app, stub = load_handlers_app(str(tmp_path / "jobs"))
    client = TestClient(app)
    headers = {
        "X-API-KEY": "modal-api-key",
        "X-Idempotency-Key": "dispatch-key-1",
    }

    first = client.post("/api/internal/cloudflare/jobs/dispatch", json=valid_dispatch_payload(), headers=headers)
    replay = client.post("/api/internal/cloudflare/jobs/dispatch", json=valid_dispatch_payload(), headers=headers)

    assert first.status_code == 202
    assert replay.status_code == 202
    assert replay.json()["duplicate"] is True
    assert downloads == [True]
    assert len(stub.spawned) == 1


def test_dispatch_endpoint_ignores_commit_cache_failure(tmp_path, monkeypatch):
    configure_r2_env(monkeypatch)
    dispatch = load_dispatch_module()

    def fake_download_to_path(_object_key, destination_path, checksum_sha256=None, *, max_bytes=None):
        Path(destination_path).write_bytes(b"%PDF-1.4 r2 pdf")
        return dispatch.R2TransferResult(size_bytes=15, sha256_hex="input-sha")

    monkeypatch.setattr(dispatch.r2_client, "download_r2_object_to_path", fake_download_to_path)
    app, stub = load_handlers_app(str(tmp_path / "jobs"))
    app.state.job_ctx = JobContext(
        cloudflare_dispatch_handle=stub,
        commit_cache=lambda: (_ for _ in ()).throw(RuntimeError("commit failed")),
    )
    client = TestClient(app)

    response = client.post(
        "/api/internal/cloudflare/jobs/dispatch",
        json=valid_dispatch_payload(),
        headers={
            "X-API-KEY": "modal-api-key",
            "X-Idempotency-Key": "dispatch-key-1",
        },
    )

    assert response.status_code == 202
    assert stub.spawned == [(("job_cloudflare_dispatch",), {})]


def test_dispatch_endpoint_returns_500_when_spawn_fails(tmp_path, monkeypatch):
    configure_r2_env(monkeypatch)
    dispatch = load_dispatch_module()

    def fake_download_to_path(_object_key, destination_path, checksum_sha256=None, *, max_bytes=None):
        Path(destination_path).write_bytes(b"%PDF-1.4 r2 pdf")
        return dispatch.R2TransferResult(size_bytes=15, sha256_hex="input-sha")

    class FailingHandle:
        def spawn(self, *_args, **_kwargs):
            raise RuntimeError("spawn failed")

    monkeypatch.setattr(dispatch.r2_client, "download_r2_object_to_path", fake_download_to_path)
    app, _stub = load_handlers_app(str(tmp_path / "jobs"))
    app.state.job_ctx = JobContext(cloudflare_dispatch_handle=FailingHandle())
    client = TestClient(app)

    response = client.post(
        "/api/internal/cloudflare/jobs/dispatch",
        json=valid_dispatch_payload(),
        headers={
            "X-API-KEY": "modal-api-key",
            "X-Idempotency-Key": "dispatch-key-1",
        },
    )

    assert response.status_code == 500
    assert "failed to spawn Cloudflare dispatch job" in response.json()["detail"]


def test_prepare_cloudflare_dispatch_job_recovers_partial_metadata_write(tmp_path, monkeypatch):
    configure_r2_env(monkeypatch)
    dispatch = load_dispatch_module()
    job_root = tmp_path / "jobs"
    job_id = "job_cloudflare_dispatch"
    payload = valid_dispatch_payload()
    job_dir = job_root / job_id
    job_dir.mkdir(parents=True)
    (job_dir / "original.pdf").write_bytes(b"%PDF-1.4 r2 pdf")
    (job_dir / "options.json").write_text(json.dumps(payload["options"]), encoding="utf-8")
    (job_dir / "status.json").write_text(
        json.dumps(
            {
                "job_id": job_id,
                "file_name": "original.pdf",
                "file_size": 15,
                "file_hash": "input-sha",
                "options": payload["options"],
            }
        ),
        encoding="utf-8",
    )
    downloads = []
    monkeypatch.setattr(dispatch.r2_client, "download_r2_object_to_path", lambda *args, **kwargs: downloads.append(True))

    result = dispatch.prepare_cloudflare_dispatch_job(str(job_root), payload, "dispatch-key-1")

    assert result["duplicate"] is True
    assert downloads == []
    metadata = json.loads((job_dir / "cloudflare-dispatch.json").read_text(encoding="utf-8"))
    assert metadata["dispatchIdempotencyKey"] == "dispatch-key-1"


def test_prepare_cloudflare_dispatch_job_rejects_mismatched_partial_job(tmp_path, monkeypatch):
    configure_r2_env(monkeypatch)
    dispatch = load_dispatch_module()
    job_root = tmp_path / "jobs"
    job_id = "job_cloudflare_dispatch"
    payload = valid_dispatch_payload()
    job_dir = job_root / job_id
    job_dir.mkdir(parents=True)
    (job_dir / "original.pdf").write_bytes(b"%PDF-1.4 r2 pdf")
    (job_dir / "options.json").write_text(json.dumps({"force_ocr": True}), encoding="utf-8")
    (job_dir / "status.json").write_text(
        json.dumps(
            {
                "job_id": job_id,
                "file_name": "original.pdf",
                "file_size": 15,
                "file_hash": "input-sha",
                "options": {"force_ocr": True},
            }
        ),
        encoding="utf-8",
    )

    try:
        dispatch.prepare_cloudflare_dispatch_job(str(job_root), payload, "dispatch-key-1")
        raised = False
    except dispatch.DispatchConflictError as exc:
        raised = "without matching dispatch metadata" in str(exc)

    assert raised is True
    assert not (job_dir / "cloudflare-dispatch.json").exists()


def test_prepare_cloudflare_dispatch_job_fails_fast_without_callback_key(tmp_path, monkeypatch):
    configure_r2_env(monkeypatch)
    monkeypatch.delenv("CALLBACK_INTERNAL_API_KEY", raising=False)
    dispatch = load_dispatch_module()
    downloads = []
    monkeypatch.setattr(dispatch.r2_client, "download_r2_object_to_path", lambda *args, **kwargs: downloads.append(True))

    try:
        dispatch.prepare_cloudflare_dispatch_job(str(tmp_path / "jobs"), valid_dispatch_payload(), "dispatch-key-1")
        raised = False
    except dispatch.CallbackConfigError as exc:
        raised = "callback_internal_api_key" in str(exc)

    assert raised is True
    assert downloads == []


def test_prepare_cloudflare_dispatch_job_fails_fast_without_hmac_secret(tmp_path, monkeypatch):
    configure_r2_env(monkeypatch)
    monkeypatch.delenv("MODAL_CALLBACK_HMAC_SECRET", raising=False)
    dispatch = load_dispatch_module()
    downloads = []
    monkeypatch.setattr(dispatch.r2_client, "download_r2_object_to_path", lambda *args, **kwargs: downloads.append(True))

    try:
        dispatch.prepare_cloudflare_dispatch_job(str(tmp_path / "jobs"), free_dispatch_payload(), "dispatch-key-1")
        raised = False
    except dispatch.CallbackConfigError as exc:
        raised = "hmac secret" in str(exc)

    assert raised is True
    assert downloads == []


def test_dispatch_endpoint_rejects_missing_r2_config(tmp_path, monkeypatch):
    monkeypatch.delenv("CLOUDFLARE_R2_ACCOUNT_ID", raising=False)
    monkeypatch.delenv("R2_ACCOUNT_ID", raising=False)
    app, _stub = load_handlers_app(str(tmp_path / "jobs"))
    client = TestClient(app)

    response = client.post(
        "/api/internal/cloudflare/jobs/dispatch",
        json=valid_dispatch_payload(),
        headers={
            "X-API-KEY": "modal-api-key",
            "X-Idempotency-Key": "dispatch-key-1",
        },
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "r2 dispatch storage is not configured"


def test_dispatch_endpoint_rejects_declared_input_size_over_limit(tmp_path, monkeypatch):
    configure_r2_env(monkeypatch)
    monkeypatch.setenv("MAX_UPLOAD_BYTES", "10")
    app, stub = load_handlers_app(str(tmp_path / "jobs"))
    client = TestClient(app)
    payload = valid_dispatch_payload()
    payload["input"]["sizeBytes"] = 11

    response = client.post(
        "/api/internal/cloudflare/jobs/dispatch",
        json=payload,
        headers={
            "X-API-KEY": "modal-api-key",
            "X-Idempotency-Key": "dispatch-key-1",
        },
    )

    assert response.status_code == 413
    assert stub.spawned == []


def test_validate_dispatch_payload_rejects_unknown_output_profile():
    dispatch = load_dispatch_module()
    payload = free_dispatch_payload()
    payload["options"]["output_profile"] = "unknown_profile"

    try:
        dispatch.validate_dispatch_payload(payload)
        raised = False
    except dispatch.DispatchValidationError as exc:
        raised = "options.output_profile is invalid" in str(exc)

    assert raised is True


def test_validate_dispatch_payload_rejects_unknown_output_format():
    dispatch = load_dispatch_module()
    payload = valid_dispatch_payload()
    payload["output"]["format"] = "pdf"

    try:
        dispatch.validate_dispatch_payload(payload)
        raised = False
    except dispatch.DispatchValidationError as exc:
        raised = "output.format is invalid" in str(exc)

    assert raised is True


def test_validate_dispatch_payload_rejects_unsafe_job_id():
    dispatch = load_dispatch_module()
    payload = free_dispatch_payload()
    payload["jobId"] = "../escape"

    try:
        dispatch.validate_dispatch_payload(payload)
        raised = False
    except dispatch.DispatchValidationError as exc:
        raised = "jobId is invalid" in str(exc)

    assert raised is True


def test_validate_dispatch_payload_rejects_unsafe_callback_header_name():
    dispatch = load_dispatch_module()
    payload = free_dispatch_payload()
    payload["callback"]["authHeaderName"] = "X-Modal-Signature\nX-Bad"

    try:
        dispatch.validate_dispatch_payload(payload)
        raised = False
    except dispatch.DispatchValidationError as exc:
        raised = "callback.authHeaderName is invalid" in str(exc)

    assert raised is True


@pytest.mark.parametrize(
    "callback_header_name",
    [
        "Content-Type",
        "X-Idempotency-Key",
        "Host",
    ],
)
def test_validate_dispatch_payload_rejects_reserved_callback_header_names(callback_header_name):
    dispatch = load_dispatch_module()
    payload = free_dispatch_payload()
    payload["callback"]["authHeaderName"] = callback_header_name

    with pytest.raises(dispatch.DispatchValidationError, match="callback.authHeaderName is invalid"):
        dispatch.validate_dispatch_payload(payload)


@pytest.mark.parametrize(
    "callback_url",
    [
        "http://api.example.test/callback",
        "https:///missing-host",
        "https://localhost/callback",
        "https://127.0.0.1/callback",
        "https://[::1]/callback",
        "https://10.0.0.1/callback",
        "https://169.254.169.254/latest/meta-data",
        42,
    ],
)
def test_validate_dispatch_payload_rejects_unsafe_callback_url(callback_url):
    dispatch = load_dispatch_module()
    payload = free_dispatch_payload()
    payload["callback"]["url"] = callback_url

    with pytest.raises(dispatch.DispatchValidationError):
        dispatch.validate_dispatch_payload(payload)


@pytest.mark.parametrize("object_key", ["/leading.pdf", "folder//file.pdf", "folder/./file.pdf", "folder/../file.pdf"])
def test_validate_dispatch_payload_rejects_unsafe_object_key(object_key):
    dispatch = load_dispatch_module()
    payload = free_dispatch_payload()
    payload["input"]["objectKey"] = object_key

    with pytest.raises(dispatch.DispatchValidationError, match="input.objectKey is invalid"):
        dispatch.validate_dispatch_payload(payload)


@pytest.mark.parametrize("object_key", ["/leading.md", "folder//out.md", "folder/./out.md", "folder/../out.md"])
def test_validate_dispatch_payload_rejects_unsafe_output_object_key(object_key):
    dispatch = load_dispatch_module()
    payload = free_dispatch_payload()
    payload["output"]["objectKey"] = object_key

    with pytest.raises(dispatch.DispatchValidationError, match="output.objectKey is invalid"):
        dispatch.validate_dispatch_payload(payload)


def test_validate_dispatch_payload_rejects_oversized_options():
    dispatch = load_dispatch_module()
    payload = free_dispatch_payload()
    payload["options"]["extra"] = "x" * 5000

    with pytest.raises(dispatch.DispatchValidationError, match="options must be at most 4096 bytes"):
        dispatch.validate_dispatch_payload(payload)


def test_validate_dispatch_payload_counts_options_limit_in_utf8_bytes():
    dispatch = load_dispatch_module()
    payload = free_dispatch_payload()
    payload["options"]["extra"] = "\u754c" * 1400

    with pytest.raises(dispatch.DispatchValidationError, match="options must be at most 4096 bytes"):
        dispatch.validate_dispatch_payload(payload)


@pytest.mark.parametrize(
    ("field_path", "value", "message"),
    [
        (("attempt",), True, "attempt must be a positive integer"),
        (("input", "sizeBytes"), True, "input.sizeBytes must be a positive integer"),
    ],
)
def test_validate_dispatch_payload_rejects_boolean_integer_fields(field_path, value, message):
    dispatch = load_dispatch_module()
    payload = free_dispatch_payload()
    target = payload
    for key in field_path[:-1]:
        target = target[key]
    target[field_path[-1]] = value

    with pytest.raises(dispatch.DispatchValidationError, match=message):
        dispatch.validate_dispatch_payload(payload)


@pytest.mark.parametrize(
    "checksum",
    [
        "",
        "abc",
        "g" * 64,
        "a" * 63,
        "a" * 65,
    ],
)
def test_validate_dispatch_payload_rejects_invalid_checksum(checksum):
    dispatch = load_dispatch_module()
    payload = free_dispatch_payload()
    payload["input"]["checksumSha256"] = checksum

    with pytest.raises(dispatch.DispatchValidationError, match="input.checksumSha256 is invalid"):
        dispatch.validate_dispatch_payload(payload)


@pytest.mark.parametrize(
    ("object_key", "content_type"),
    [
        ("jobs/job_cloudflare_dispatch/input/source.txt", "text/plain"),
        ("jobs/job_cloudflare_dispatch/input/source.pdf", "image/png"),
        ("jobs/job_cloudflare_dispatch/input/source.epub", "application/pdf"),
    ],
)
def test_validate_dispatch_payload_rejects_unsupported_input_file_type(object_key, content_type):
    dispatch = load_dispatch_module()
    payload = free_dispatch_payload()
    payload["input"]["objectKey"] = object_key
    payload["input"]["contentType"] = content_type

    with pytest.raises(dispatch.DispatchValidationError, match="input file type is invalid"):
        dispatch.validate_dispatch_payload(payload)


def test_prepare_cloudflare_dispatch_job_streams_r2_input_to_job_file(tmp_path, monkeypatch):
    configure_r2_env(monkeypatch)
    dispatch = load_dispatch_module()
    job_root = tmp_path / "jobs"
    destinations = []

    def fake_download_to_path(object_key, destination_path, checksum_sha256=None, *, max_bytes=None):
        destinations.append(Path(destination_path))
        Path(destination_path).write_bytes(b"%PDF-1.4 streamed pdf")
        return dispatch.R2TransferResult(size_bytes=21, sha256_hex="streamed-sha")

    monkeypatch.setattr(dispatch.r2_client, "download_r2_object_to_path", fake_download_to_path)

    result = dispatch.prepare_cloudflare_dispatch_job(
        str(job_root),
        free_dispatch_payload(),
        "dispatch-key-1",
    )

    assert result == {
        "accepted": True,
        "duplicate": False,
        "jobId": "job_cloudflare_dispatch",
        "attempt": 1,
    }
    assert destinations
    assert not destinations[0].exists()
    job_dir = job_root / "job_cloudflare_dispatch"
    assert (job_dir / "original.pdf").read_bytes() == b"%PDF-1.4 streamed pdf"
    status = json.loads((job_dir / "status.json").read_text(encoding="utf-8"))
    assert status["file_size"] == 21
    assert status["file_hash"] == "streamed-sha"


def test_prepare_cloudflare_dispatch_job_preserves_epub_input_extension(tmp_path, monkeypatch):
    configure_r2_env(monkeypatch)
    dispatch = load_dispatch_module()
    job_root = tmp_path / "jobs"
    payload = free_dispatch_payload()
    payload["input"] = {
        "objectKey": "parseotter/job_cloudflare_dispatch/input/original.epub",
        "contentType": "application/epub+zip",
        "sizeBytes": 12,
        "checksumSha256": None,
    }

    def fake_download_to_path(_object_key, destination_path, checksum_sha256=None, *, max_bytes=None):
        Path(destination_path).write_bytes(b"epub-content")
        return dispatch.R2TransferResult(size_bytes=12, sha256_hex="epub-sha")

    monkeypatch.setattr(dispatch.r2_client, "download_r2_object_to_path", fake_download_to_path)

    dispatch.prepare_cloudflare_dispatch_job(str(job_root), payload, "dispatch-key-1")

    job_dir = job_root / "job_cloudflare_dispatch"
    assert (job_dir / "original.epub").read_bytes() == b"epub-content"
    status = json.loads((job_dir / "status.json").read_text(encoding="utf-8"))
    assert status["file_name"] == "original.epub"


def test_download_r2_object_to_path_streams_chunks_and_checks_checksum(tmp_path, monkeypatch):
    dispatch = load_dispatch_module()
    chunks = [b"%PDF-", b"1.4 ", b"streamed"]
    payload = b"".join(chunks)
    checksum = hashlib.sha256(payload).hexdigest()

    class Response:
        status_code = 200

        @staticmethod
        def iter_content(chunk_size):
            assert chunk_size == 1024 * 1024
            yield from chunks

    monkeypatch.setattr(dispatch.r2_client, "_signed_r2_request", lambda *_args, **_kwargs: ("https://r2.test/object", {}))
    monkeypatch.setattr(dispatch.r2_client.requests, "get", lambda *_args, **_kwargs: Response())

    destination = tmp_path / "input.pdf"
    result = dispatch.download_r2_object_to_path("input.pdf", destination, checksum)

    assert destination.read_bytes() == payload
    assert result.size_bytes == len(payload)
    assert result.sha256_hex == checksum


def test_download_r2_object_to_path_aborts_and_removes_partial_file_when_too_large(tmp_path, monkeypatch):
    dispatch = load_dispatch_module()

    class Response:
        status_code = 200

        @staticmethod
        def iter_content(chunk_size):
            yield b"1234"
            yield b"5678"

        @staticmethod
        def close():
            pass

    monkeypatch.setattr(dispatch.r2_client, "_signed_r2_request", lambda *_args, **_kwargs: ("https://r2.test/object", {}))
    monkeypatch.setattr(dispatch.r2_client.requests, "get", lambda *_args, **_kwargs: Response())

    destination = tmp_path / "input.pdf"
    try:
        dispatch.download_r2_object_to_path("input.pdf", destination, max_bytes=5)
        raised = False
    except dispatch.r2_client.R2DownloadTooLargeError:
        raised = True

    assert raised is True
    assert not destination.exists()


def test_upload_r2_object_from_path_streams_file_object(tmp_path, monkeypatch):
    dispatch = load_dispatch_module()
    payload = b"zip-bytes"
    zip_path = tmp_path / "result.zip"
    zip_path.write_bytes(payload)
    signed_requests = []
    put_calls = []

    def fake_signed_request(method, object_key, **kwargs):
        signed_requests.append({"method": method, "object_key": object_key, "kwargs": kwargs})
        return "https://r2.test/result.zip", {"authorization": "signed"}

    def fake_put(url, headers=None, data=None, timeout=None):
        put_calls.append(
            {
                "url": url,
                "headers": headers or {},
                "is_bytes": isinstance(data, bytes),
                "body": data.read(),
                "timeout": timeout,
            }
        )
        return type("Response", (), {"status_code": 200})()

    monkeypatch.setattr(dispatch.r2_client, "_signed_r2_request", fake_signed_request)
    monkeypatch.setattr(dispatch.r2_client.requests, "put", fake_put)

    dispatch.upload_r2_object_from_path("output/result.zip", zip_path, "application/zip")

    assert signed_requests == [
        {
            "method": "PUT",
            "object_key": "output/result.zip",
            "kwargs": {
                "payload_hash": hashlib.sha256(payload).hexdigest(),
                "content_type": "application/zip",
            },
        }
    ]
    assert put_calls == [
        {
            "url": "https://r2.test/result.zip",
            "headers": {
                "authorization": "signed",
                "Content-Length": str(len(payload)),
            },
            "is_bytes": False,
            "body": payload,
            "timeout": 300.0,
        }
    ]


def test_process_cloudflare_dispatch_job_uploads_output_and_posts_callback(tmp_path, monkeypatch):
    dispatch = load_dispatch_module()
    job_root = tmp_path / "jobs"
    job_id = "job_cloudflare_dispatch"
    job_dir = job_root / job_id
    job_dir.mkdir(parents=True)
    (job_dir / "raw.md").write_text("# Converted\n", encoding="utf-8")
    (job_dir / "cloudflare-dispatch.json").write_text(
        json.dumps(
            {
                "dispatchIdempotencyKey": "dispatch-key-1",
                "payload": valid_dispatch_payload(),
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("MARKER_JOB_DIR", str(job_root))
    monkeypatch.setenv("CALLBACK_INTERNAL_API_KEY", "internal-callback-key")
    uploaded = []
    callbacks = []
    orchestrator_calls = []

    class Outcome:
        status = "completed"
        current_phase = "done"
        progress = 100
        error_code = None
        error_message = None

    def process_job_background(*args, **kwargs):
        orchestrator_calls.append({"args": args, "kwargs": kwargs})
        return Outcome()

    monkeypatch.setattr(dispatch.processor.orchestrator, "process_job_background", process_job_background)
    monkeypatch.setattr(
        dispatch.r2_client,
        "upload_r2_object_from_path",
        lambda object_key, path, content_type: uploaded.append(
            {"object_key": object_key, "data": Path(path).read_bytes(), "content_type": content_type}
        ),
    )
    monkeypatch.setattr(
        dispatch.callback.requests,
        "post",
        lambda url, headers=None, data=None, timeout=None: callbacks.append(
            {
                "url": url,
                "headers": headers or {},
                "json": json.loads(data or "{}"),
                "timeout": timeout,
            }
        )
        or type("Response", (), {"status_code": 200, "text": "ok"})(),
    )

    result = dispatch.process_cloudflare_dispatch_job(job_id)

    assert result["status"] == "completed"
    assert orchestrator_calls == [
        {
            "args": ("job_cloudflare_dispatch",),
            "kwargs": {
                "options": {
                    "force_ocr": False,
                },
            },
        }
    ]
    assert uploaded == [
        {
            "object_key": "jobs/job_cloudflare_dispatch/output/output.md",
            "data": b"# Converted\n",
            "content_type": "text/markdown; charset=utf-8",
        }
    ]
    assert callbacks[0]["url"] == "https://api.example.test/api/internal/processing/modal-callback"
    assert callbacks[0]["headers"]["x-billing-internal-key"] == "internal-callback-key"
    assert callbacks[0]["headers"]["X-Idempotency-Key"] == "modal-callback:job_cloudflare_dispatch:1"
    assert callbacks[0]["json"]["status"] == "completed"
    assert callbacks[0]["json"]["outputObjectKey"] == "jobs/job_cloudflare_dispatch/output/output.md"
    assert callbacks[0]["json"]["outputContentType"] == "text/markdown; charset=utf-8"


def test_process_cloudflare_dispatch_job_returns_failed_when_output_artifact_missing(tmp_path, monkeypatch):
    dispatch = load_dispatch_module()
    job_root = tmp_path / "jobs"
    job_id = "job_cloudflare_dispatch"
    job_dir = job_root / job_id
    job_dir.mkdir(parents=True)
    (job_dir / "cloudflare-dispatch.json").write_text(
        json.dumps(
            {
                "dispatchIdempotencyKey": "dispatch-key-1",
                "payload": valid_dispatch_payload(),
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("MARKER_JOB_DIR", str(job_root))
    callbacks = []

    class Outcome:
        status = "completed"
        current_phase = "done"
        progress = 100
        error_code = None
        error_message = None

    monkeypatch.setattr(dispatch.processor.orchestrator, "process_job_background", lambda *_args, **_kwargs: Outcome())
    monkeypatch.setattr(dispatch.processor, "_post_callback", lambda _payload, body: callbacks.append(body))

    result = dispatch.process_cloudflare_dispatch_job(job_id)

    assert result["status"] == "failed"
    assert result["errorCode"] == "MODAL_PROCESSING_FAILED"
    assert result["errorMessage"] == "job output artifact is missing"
    assert callbacks == [result]


def test_process_cloudflare_dispatch_job_truncates_upload_failure_message(tmp_path, monkeypatch):
    dispatch = load_dispatch_module()
    job_root = tmp_path / "jobs"
    job_id = "job_cloudflare_dispatch"
    job_dir = job_root / job_id
    job_dir.mkdir(parents=True)
    (job_dir / "raw.md").write_text("# Converted\n", encoding="utf-8")
    (job_dir / "cloudflare-dispatch.json").write_text(
        json.dumps(
            {
                "dispatchIdempotencyKey": "dispatch-key-1",
                "payload": valid_dispatch_payload(),
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("MARKER_JOB_DIR", str(job_root))
    callbacks = []

    class Outcome:
        status = "completed"
        current_phase = "done"
        progress = 100
        error_code = None
        error_message = None

    monkeypatch.setattr(dispatch.processor.orchestrator, "process_job_background", lambda *_args, **_kwargs: Outcome())
    monkeypatch.setattr(dispatch.r2_client, "upload_r2_object_from_path", lambda *_args: (_ for _ in ()).throw(RuntimeError("x" * 600)))
    monkeypatch.setattr(dispatch.processor, "_post_callback", lambda _payload, body: callbacks.append(body))

    result = dispatch.process_cloudflare_dispatch_job(job_id)

    assert result["status"] == "failed"
    assert len(result["errorMessage"]) == 500
    assert callbacks == [result]


def test_process_cloudflare_dispatch_job_passes_provided_context_and_config(tmp_path, monkeypatch):
    dispatch = load_dispatch_module()
    job_root = tmp_path / "jobs"
    job_id = "job_cloudflare_dispatch"
    job_dir = job_root / job_id
    job_dir.mkdir(parents=True)
    (job_dir / "raw.md").write_text("# Converted\n", encoding="utf-8")
    (job_dir / "cloudflare-dispatch.json").write_text(
        json.dumps(
            {
                "dispatchIdempotencyKey": "dispatch-key-1",
                "payload": valid_dispatch_payload(),
            }
        ),
        encoding="utf-8",
    )
    config = Config(marker_job_dir=str(job_root))
    ctx = JobContext(reload_cache=lambda: None)
    calls = []

    class Outcome:
        status = "completed"
        current_phase = "done"
        progress = 100
        error_code = None
        error_message = None

    def fake_process(*args, **kwargs):
        calls.append({"args": args, "kwargs": kwargs})
        return Outcome()

    monkeypatch.setattr(dispatch.processor.orchestrator, "process_job_background", fake_process)
    monkeypatch.setattr(dispatch.r2_client, "upload_r2_object_from_path", lambda *_args: None)
    monkeypatch.setattr(dispatch.processor, "_post_callback", lambda _payload, _body: None)

    result = dispatch.process_cloudflare_dispatch_job(job_id, ctx=ctx, config=config)

    assert result["status"] == "completed"
    assert calls[0]["kwargs"]["ctx"] is ctx
    assert calls[0]["kwargs"]["config"] is config


def test_hmac_callback_signs_exact_utf8_request_body(monkeypatch):
    dispatch = load_dispatch_module()
    payload = free_dispatch_payload()
    monkeypatch.setenv("MODAL_CALLBACK_HMAC_SECRET", "callback-secret")
    monkeypatch.setattr(dispatch.callback.time, "time", lambda: 1710000000.2)
    callbacks = []

    def fake_post(url, headers=None, data=None, timeout=None):
        callbacks.append({"url": url, "headers": headers or {}, "data": data, "timeout": timeout})
        return type("Response", (), {"status_code": 200, "text": "ok"})()

    monkeypatch.setattr(dispatch.callback.requests, "post", fake_post)

    dispatch._post_callback(
        payload,
        {
            "jobId": "job_cloudflare_dispatch",
            "status": "failed",
            "errorMessage": "\u8f6c\u6362\u5931\u8d25",
            "attempt": 1,
            "idempotencyKey": "job_cloudflare_dispatch:callback:1",
        },
    )

    callback = callbacks[0]
    body = callback["data"].decode("utf-8")
    expected_signature = hmac.new(
        b"callback-secret",
        f"1710000000.{body}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    assert callback["headers"]["X-Modal-Timestamp"] == "1710000000"
    assert callback["headers"]["X-Modal-Signature"] == expected_signature
    assert json.loads(body)["errorMessage"] == "\u8f6c\u6362\u5931\u8d25"


def test_post_callback_skips_network_when_callback_url_missing(monkeypatch):
    dispatch = load_dispatch_module()
    payload = valid_dispatch_payload()
    payload["callback"]["url"] = None
    calls = []
    monkeypatch.setattr(dispatch.callback.requests, "post", lambda *args, **kwargs: calls.append((args, kwargs)))

    dispatch._post_callback(payload, {"jobId": "job_cloudflare_dispatch", "status": "completed"})

    assert calls == []


def test_process_cloudflare_dispatch_job_uses_free_zip_profile_and_hmac_callback(
    tmp_path,
    monkeypatch,
):
    dispatch = load_dispatch_module()
    job_root = tmp_path / "jobs"
    job_id = "job_cloudflare_dispatch"
    job_dir = job_root / job_id
    job_dir.mkdir(parents=True)
    (job_dir / "raw.md").write_text("raw", encoding="utf-8")
    (job_dir / "status.json").write_text(json.dumps({"job_id": job_id}), encoding="utf-8")
    (job_dir / "cloudflare-dispatch.json").write_text(
        json.dumps(
            {
                "dispatchIdempotencyKey": "dispatch-key-1",
                "payload": free_dispatch_payload(),
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("MARKER_JOB_DIR", str(job_root))
    monkeypatch.setenv("MODAL_CALLBACK_HMAC_SECRET", "callback-secret")
    uploaded = []
    callbacks = []
    orchestrator_calls = []

    class Outcome:
        status = "completed"
        current_phase = "done"
        progress = 100
        error_code = None
        error_message = None

    def process_job_background(*args, **kwargs):
        orchestrator_calls.append({"args": args, "kwargs": kwargs})
        # This file should be uploaded instead of an in-memory bytes payload.
        (job_dir / "result.zip").write_bytes(b"zip-bytes")
        return Outcome()

    def fake_upload(object_key, path, content_type):
        uploaded.append({"object_key": object_key, "path": Path(path), "content_type": content_type})

    def fake_post(url, headers=None, data=None, timeout=None, **_kwargs):
        callbacks.append({"url": url, "headers": headers or {}, "data": data, "timeout": timeout})
        return type("Response", (), {"status_code": 200, "text": "ok"})()

    monkeypatch.setattr(dispatch.processor.orchestrator, "process_job_background", process_job_background)
    monkeypatch.setattr(dispatch.r2_client, "upload_r2_object_from_path", fake_upload)
    monkeypatch.setattr(dispatch.callback.requests, "post", fake_post)
    monkeypatch.setattr(dispatch.callback.time, "time", lambda: 1710000000.2)

    result = dispatch.process_cloudflare_dispatch_job(job_id)

    assert result["status"] == "completed"
    assert orchestrator_calls == [
        {
            "args": ("job_cloudflare_dispatch",),
            "kwargs": {
                "options": {
                    "output_profile": "parseotter_free_v1",
                },
            },
        }
    ]
    assert uploaded == [
        {
            "object_key": "parseotter/job_cloudflare_dispatch/output/result.zip",
            "path": job_dir / "result.zip",
            "content_type": "application/zip",
        }
    ]
    callback = callbacks[0]
    assert callback["headers"]["X-Idempotency-Key"] == "job_cloudflare_dispatch:callback:1"
    assert callback["headers"]["X-Modal-Timestamp"] == "1710000000"
    body = callback["data"].decode("utf-8")
    expected_signature = hmac.new(
        b"callback-secret",
        f"1710000000.{body}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    assert callback["headers"]["X-Modal-Signature"] == expected_signature
    assert json.loads(body)["status"] == "completed"


def test_process_cloudflare_dispatch_job_does_not_emit_failed_callback_after_completed_callback_failure(
    tmp_path,
    monkeypatch,
):
    dispatch = load_dispatch_module()
    job_root = tmp_path / "jobs"
    job_id = "job_cloudflare_dispatch"
    job_dir = job_root / job_id
    job_dir.mkdir(parents=True)
    (job_dir / "raw.md").write_text("# Converted\n", encoding="utf-8")
    (job_dir / "cloudflare-dispatch.json").write_text(
        json.dumps(
            {
                "dispatchIdempotencyKey": "dispatch-key-1",
                "payload": valid_dispatch_payload(),
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("MARKER_JOB_DIR", str(job_root))
    monkeypatch.setenv("CALLBACK_INTERNAL_API_KEY", "internal-callback-key")
    callbacks = []

    class Outcome:
        status = "completed"
        current_phase = "done"
        progress = 100
        error_code = None
        error_message = None

    class CallbackFailureResponse:
        status_code = 503
        text = "temporarily unavailable"

    monkeypatch.setattr(dispatch.processor.orchestrator, "process_job_background", lambda *_args, **_kwargs: Outcome())
    monkeypatch.setattr(dispatch.r2_client, "upload_r2_object_from_path", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(dispatch.callback, "_sleep_before_callback_retry", lambda _delay: None)

    def failing_callback(url, headers=None, data=None, timeout=None):
        callbacks.append(json.loads(data or "{}"))
        return CallbackFailureResponse()

    monkeypatch.setattr(dispatch.callback.requests, "post", failing_callback)

    try:
        dispatch.process_cloudflare_dispatch_job(job_id)
        raised = False
    except RuntimeError as exc:
        raised = "modal callback rejected: 503" in str(exc)

    assert raised is True
    assert [callback["status"] for callback in callbacks] == ["completed", "completed", "completed"]


def test_post_callback_retries_retryable_failures_until_success(monkeypatch):
    dispatch = load_dispatch_module()
    payload = free_dispatch_payload()
    monkeypatch.setenv("MODAL_CALLBACK_HMAC_SECRET", "callback-secret")
    monkeypatch.setattr(dispatch.callback.time, "time", lambda: 1710000000.2)

    calls = []
    sleeps = []

    class RetryResponse:
        def __init__(self, status_code):
            self.status_code = status_code
            self.text = "retry"

    responses = [RetryResponse(503), RetryResponse(503), RetryResponse(200)]

    def fake_post(url, headers=None, data=None, timeout=None):
        calls.append({"url": url, "headers": headers or {}, "data": data, "timeout": timeout})
        return responses.pop(0)

    monkeypatch.setattr(dispatch.callback.requests, "post", fake_post)
    monkeypatch.setattr(dispatch.callback, "_sleep_before_callback_retry", lambda delay: sleeps.append(delay))

    dispatch._post_callback(
        payload,
        {
            "jobId": "job_cloudflare_dispatch",
            "status": "completed",
            "outputObjectKey": "parseotter/job_cloudflare_dispatch/output/result.zip",
            "outputContentType": "application/zip",
            "attempt": 1,
            "idempotencyKey": "job_cloudflare_dispatch:callback:1",
        },
    )

    assert len(calls) == 3
    assert sleeps == [1.0, 2.0]


def test_post_callback_does_not_retry_non_retryable_status(monkeypatch):
    dispatch = load_dispatch_module()
    payload = valid_dispatch_payload()
    monkeypatch.setenv("CALLBACK_INTERNAL_API_KEY", "internal-callback-key")
    calls = []

    def fake_post(url, headers=None, data=None, timeout=None):
        calls.append({"url": url, "headers": headers or {}, "data": data, "timeout": timeout})
        return type("Response", (), {"status_code": 400, "text": "bad request"})()

    monkeypatch.setattr(dispatch.callback.requests, "post", fake_post)

    with pytest.raises(RuntimeError, match="modal callback rejected: 400"):
        dispatch._post_callback(
            payload,
            {
                "jobId": "job_cloudflare_dispatch",
                "status": "failed",
                "attempt": 1,
                "idempotencyKey": "modal-callback:job_cloudflare_dispatch:1",
            },
        )

    assert len(calls) == 1


def test_post_callback_retries_request_exception_until_max_attempts(monkeypatch):
    dispatch = load_dispatch_module()
    payload = valid_dispatch_payload()
    monkeypatch.setenv("CALLBACK_INTERNAL_API_KEY", "internal-callback-key")
    monkeypatch.setenv("MODAL_CALLBACK_MAX_ATTEMPTS", "2")
    calls = []
    sleeps = []

    def fail_post(*_args, **_kwargs):
        calls.append(True)
        raise dispatch.callback.requests.RequestException("network down")

    monkeypatch.setattr(dispatch.callback.requests, "post", fail_post)
    monkeypatch.setattr(dispatch.callback, "_sleep_before_callback_retry", lambda delay: sleeps.append(delay))

    with pytest.raises(RuntimeError, match="modal callback request failed: network down"):
        dispatch._post_callback(
            payload,
            {
                "jobId": "job_cloudflare_dispatch",
                "status": "failed",
                "attempt": 1,
                "idempotencyKey": "modal-callback:job_cloudflare_dispatch:1",
            },
        )

    assert calls == [True, True]
    assert sleeps == [1.0]
