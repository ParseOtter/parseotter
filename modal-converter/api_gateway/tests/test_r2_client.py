import hashlib
from pathlib import Path
from types import SimpleNamespace

import pytest

from api_gateway.dispatch import r2_client
from api_gateway.dispatch.validation import R2ConfigError


R2_ENV_NAMES = [
    "CLOUDFLARE_R2_ACCOUNT_ID",
    "R2_ACCOUNT_ID",
    "CLOUDFLARE_R2_ACCESS_KEY_ID",
    "R2_ACCESS_KEY_ID",
    "AWS_ACCESS_KEY_ID",
    "CLOUDFLARE_R2_SECRET_ACCESS_KEY",
    "R2_SECRET_ACCESS_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "CLOUDFLARE_R2_BUCKET_NAME",
    "R2_BUCKET_NAME",
    "CLOUDFLARE_R2_ENDPOINT_URL",
    "R2_ENDPOINT_URL",
]


def _clear_r2_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in R2_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)


def _configure_r2_env(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_r2_env(monkeypatch)
    monkeypatch.setenv("CLOUDFLARE_R2_ACCOUNT_ID", "account-id")
    monkeypatch.setenv("CLOUDFLARE_R2_ACCESS_KEY_ID", "access-key")
    monkeypatch.setenv("CLOUDFLARE_R2_SECRET_ACCESS_KEY", "secret-key")
    monkeypatch.setenv("CLOUDFLARE_R2_BUCKET_NAME", "bucket name")
    monkeypatch.setenv("CLOUDFLARE_R2_ENDPOINT_URL", "https://r2.example.test")


def test_require_r2_configured_reports_missing_environment(monkeypatch: pytest.MonkeyPatch):
    _clear_r2_env(monkeypatch)

    with pytest.raises(R2ConfigError, match="r2 dispatch storage is not configured"):
        r2_client.require_r2_configured()


def test_signed_r2_request_encodes_bucket_and_object_key(
    monkeypatch: pytest.MonkeyPatch,
):
    _configure_r2_env(monkeypatch)
    monkeypatch.setattr(r2_client, "_amz_date", lambda: ("20260506T010203Z", "20260506"))

    url, headers = r2_client._signed_r2_request("GET", "folder name/\u4e2d\u6587.pdf")

    assert url == "https://r2.example.test/bucket%20name/folder%20name/%E4%B8%AD%E6%96%87.pdf"
    assert headers["host"] == "r2.example.test"
    assert headers["x-amz-date"] == "20260506T010203Z"
    assert headers["authorization"].startswith(
        "AWS4-HMAC-SHA256 Credential=access-key/20260506/auto/s3/aws4_request"
    )
    assert "SignedHeaders=host;x-amz-content-sha256;x-amz-date" in headers["authorization"]


def test_download_r2_object_raises_and_closes_response_on_http_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    _configure_r2_env(monkeypatch)
    closed = []

    class Response:
        status_code = 404

        def close(self):
            closed.append(True)

    monkeypatch.setattr(r2_client.requests, "get", lambda *_args, **_kwargs: Response())

    with pytest.raises(RuntimeError, match="failed to download R2 object: 404"):
        r2_client.download_r2_object_to_path("missing.pdf", tmp_path / "missing.pdf")

    assert closed == [True]
    assert not (tmp_path / "missing.pdf").exists()


def test_upload_r2_object_raises_on_http_error(monkeypatch: pytest.MonkeyPatch):
    _configure_r2_env(monkeypatch)
    monkeypatch.setattr(
        r2_client.requests,
        "put",
        lambda *_args, **_kwargs: SimpleNamespace(status_code=500),
    )

    with pytest.raises(RuntimeError, match="failed to upload R2 object: 500"):
        r2_client.upload_r2_object("out.md", b"markdown", "text/markdown")


def test_download_r2_object_removes_destination_on_checksum_mismatch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    _configure_r2_env(monkeypatch)
    payload = b"corrupt download"
    wrong_checksum = hashlib.sha256(b"expected").hexdigest()

    class Response:
        status_code = 200

        @staticmethod
        def iter_content(chunk_size):
            yield payload

    monkeypatch.setattr(r2_client.requests, "get", lambda *_args, **_kwargs: Response())

    destination = tmp_path / "input.pdf"
    with pytest.raises(RuntimeError, match="downloaded R2 object checksum mismatch"):
        r2_client.download_r2_object_to_path("input.pdf", destination, wrong_checksum)

    assert not destination.exists()
