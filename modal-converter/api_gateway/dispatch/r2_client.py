"""Cloudflare R2 SigV4 client helpers."""

from __future__ import annotations

import hashlib
import hmac
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional
from urllib.parse import quote

import requests

from shared.config import load_config
from shared.env import env_first, read_str_env
from shared.hashing import sha256_file

from .validation import R2ConfigError


@dataclass(frozen=True)
class R2TransferResult:
    size_bytes: int
    sha256_hex: str


class R2DownloadTooLargeError(RuntimeError):
    pass


def _r2_config() -> Dict[str, str]:
    account_id = env_first("CLOUDFLARE_R2_ACCOUNT_ID", "R2_ACCOUNT_ID")
    access_key_id = env_first("CLOUDFLARE_R2_ACCESS_KEY_ID", "R2_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID")
    secret_access_key = env_first(
        "CLOUDFLARE_R2_SECRET_ACCESS_KEY",
        "R2_SECRET_ACCESS_KEY",
        "AWS_SECRET_ACCESS_KEY",
    )
    bucket_name = env_first("CLOUDFLARE_R2_BUCKET_NAME", "R2_BUCKET_NAME")
    endpoint = env_first("CLOUDFLARE_R2_ENDPOINT_URL", "R2_ENDPOINT_URL")
    if not endpoint and account_id:
        endpoint = f"https://{account_id}.r2.cloudflarestorage.com"

    missing = [
        name
        for name, value in {
            "account_id": account_id,
            "access_key_id": access_key_id,
            "secret_access_key": secret_access_key,
            "bucket_name": bucket_name,
            "endpoint": endpoint,
        }.items()
        if not value
    ]
    if missing:
        raise R2ConfigError("r2 dispatch storage is not configured")

    return {
        "access_key_id": access_key_id,
        "secret_access_key": secret_access_key,
        "bucket_name": bucket_name,
        "endpoint": endpoint.rstrip("/"),
    }


def require_r2_configured() -> None:
    _r2_config()


def _amz_date() -> tuple[str, str]:
    now = time.gmtime()
    return time.strftime("%Y%m%dT%H%M%SZ", now), time.strftime("%Y%m%d", now)


def _signing_key(secret_access_key: str, date_stamp: str) -> bytes:
    key = ("AWS4" + secret_access_key).encode("utf-8")
    date_key = hmac.new(key, date_stamp.encode("utf-8"), hashlib.sha256).digest()
    region_key = hmac.new(date_key, b"auto", hashlib.sha256).digest()
    service_key = hmac.new(region_key, b"s3", hashlib.sha256).digest()
    return hmac.new(service_key, b"aws4_request", hashlib.sha256).digest()


def _signed_r2_request(
    method: str,
    object_key: str,
    *,
    data: bytes = b"",
    payload_hash: Optional[str] = None,
    content_type: Optional[str] = None,
):
    cfg = _r2_config()
    endpoint = cfg["endpoint"]
    bucket_name = cfg["bucket_name"]
    access_key_id = cfg["access_key_id"]
    secret_access_key = cfg["secret_access_key"]

    encoded_key = "/".join(quote(part, safe="") for part in object_key.split("/"))
    canonical_uri = f"/{quote(bucket_name, safe='')}/{encoded_key}"
    url = f"{endpoint}{canonical_uri}"
    host = endpoint.replace("https://", "").replace("http://", "")
    resolved_payload_hash = payload_hash or hashlib.sha256(data).hexdigest()
    amz_datetime, date_stamp = _amz_date()
    headers = {
        "host": host,
        "x-amz-content-sha256": resolved_payload_hash,
        "x-amz-date": amz_datetime,
    }
    if content_type:
        headers["content-type"] = content_type

    signed_header_names = sorted(headers.keys())
    canonical_headers = "".join(f"{name}:{headers[name]}\n" for name in signed_header_names)
    signed_headers = ";".join(signed_header_names)
    canonical_request = "\n".join(
        [
            method,
            canonical_uri,
            "",
            canonical_headers,
            signed_headers,
            resolved_payload_hash,
        ]
    )
    credential_scope = f"{date_stamp}/auto/s3/aws4_request"
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            amz_datetime,
            credential_scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )
    signature = hmac.new(
        _signing_key(secret_access_key, date_stamp),
        string_to_sign.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    headers["authorization"] = (
        "AWS4-HMAC-SHA256 "
        f"Credential={access_key_id}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, "
        f"Signature={signature}"
    )
    return url, headers


def _r2_timeout_seconds() -> float:
    return load_config(strict_gateway=False).r2_io_timeout_seconds


def download_r2_object_to_path(
    object_key: str,
    destination_path: Path,
    checksum_sha256: Optional[str] = None,
    *,
    max_bytes: Optional[int] = None,
) -> R2TransferResult:
    url, headers = _signed_r2_request("GET", object_key)
    response = requests.get(url, headers=headers, stream=True, timeout=_r2_timeout_seconds())
    wrote_destination = False
    try:
        if response.status_code != 200:
            raise RuntimeError(f"failed to download R2 object: {response.status_code}")

        destination_path.parent.mkdir(parents=True, exist_ok=True)
        hasher = hashlib.sha256()
        size_bytes = 0
        with open(destination_path, "wb") as file:
            wrote_destination = True
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if not chunk:
                    continue
                size_bytes += len(chunk)
                if max_bytes is not None and size_bytes > max_bytes:
                    raise R2DownloadTooLargeError(
                        f"R2 object exceeds max download size of {max_bytes} bytes"
                    )
                file.write(chunk)
                hasher.update(chunk)
            file.flush()
            try:
                os.fsync(file.fileno())
            except Exception:
                pass

        actual = hasher.hexdigest()
        if checksum_sha256 and actual.lower() != checksum_sha256.lower():
            raise RuntimeError("downloaded R2 object checksum mismatch")
        return R2TransferResult(size_bytes=size_bytes, sha256_hex=actual)
    except Exception:
        # Clean up corrupt or partial downloads. HTTP errors happen before the
        # destination is opened, so pre-existing files are left untouched there.
        try:
            if wrote_destination:
                destination_path.unlink()
        except OSError:
            pass
        raise
    finally:
        close_response = getattr(response, "close", None)
        if callable(close_response):
            close_response()


def download_r2_object(object_key: str, checksum_sha256: Optional[str] = None) -> bytes:
    tmp_path = Path(read_str_env("TMPDIR", "/tmp")) / f"r2-download-{os.getpid()}-{time.time_ns()}"
    try:
        download_r2_object_to_path(object_key, tmp_path, checksum_sha256)
        return tmp_path.read_bytes()
    finally:
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass


def upload_r2_object(object_key: str, data: bytes, content_type: str) -> None:
    url, headers = _signed_r2_request("PUT", object_key, data=data, content_type=content_type)
    response = requests.put(url, headers=headers, data=data, timeout=_r2_timeout_seconds())
    if response.status_code < 200 or response.status_code >= 300:
        raise RuntimeError(f"failed to upload R2 object: {response.status_code}")


def upload_r2_object_from_path(object_key: str, path: Path, content_type: str) -> None:
    payload_hash = sha256_file(path)
    url, headers = _signed_r2_request(
        "PUT",
        object_key,
        payload_hash=payload_hash,
        content_type=content_type,
    )
    headers["Content-Length"] = str(path.stat().st_size)
    with open(path, "rb") as file:
        response = requests.put(url, headers=headers, data=file, timeout=_r2_timeout_seconds())
    if response.status_code < 200 or response.status_code >= 300:
        raise RuntimeError(f"failed to upload R2 object: {response.status_code}")
