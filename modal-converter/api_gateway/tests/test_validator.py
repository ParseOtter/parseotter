import importlib.util
from pathlib import Path
import json
import pytest


def load_module():
    root = Path(__file__).resolve().parents[1]
    path = root / "validator.py"
    spec = importlib.util.spec_from_file_location("api_gateway.validator", str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_validate_upload_success():
    mod = load_module()
    meta = mod.validate_upload(
        filename="doc.pdf",
        content_type="application/pdf",
        content_length=1024,
        max_upload_bytes=2048,
        options=json.dumps({"page_range": "1-2"}),
    )
    assert meta["file_name"] == "doc.pdf"
    assert meta["options"]["page_range"] == "1-2"


def test_validate_upload_accepts_content_type_parameters():
    mod = load_module()
    meta = mod.validate_upload(
        filename="doc.pdf",
        content_type="application/pdf; charset=binary",
        content_length=1024,
        max_upload_bytes=2048,
    )
    assert meta["content_type"] == "application/pdf; charset=binary"


def test_validate_upload_bad_extension():
    mod = load_module()
    with pytest.raises(mod.ValidationError):
        mod.validate_upload("doc.txt", "text/plain", 10)


def test_validate_upload_epub_success_with_epub_content_type():
    mod = load_module()
    meta = mod.validate_upload(
        filename="doc.epub",
        content_type="application/epub+zip",
        content_length=1024,
        max_upload_bytes=2048,
    )
    assert meta["file_name"] == "doc.epub"


def test_validate_upload_epub_success_with_octet_stream():
    mod = load_module()
    meta = mod.validate_upload(
        filename="doc.epub",
        content_type="application/octet-stream",
        content_length=1024,
        max_upload_bytes=2048,
    )
    assert meta["file_name"] == "doc.epub"


def test_validate_upload_epub_bad_mimetype():
    mod = load_module()
    with pytest.raises(mod.ValidationError):
        mod.validate_upload("doc.epub", "application/pdf", 100)


def test_validate_upload_bad_mimetype():
    mod = load_module()
    with pytest.raises(mod.ValidationError):
        mod.validate_upload("doc.pdf", "image/png", 100)


def test_validate_upload_oversize():
    mod = load_module()
    with pytest.raises(mod.ValidationError):
        mod.validate_upload("doc.pdf", "application/pdf", 5000, max_upload_bytes=1024)


@pytest.mark.parametrize("content_length", [0, -1])
def test_validate_upload_rejects_non_positive_content_length(content_length):
    mod = load_module()
    with pytest.raises(mod.ValidationError, match="content length must be positive"):
        mod.validate_upload("doc.pdf", "application/pdf", content_length)


def test_validate_options_invalid_json():
    mod = load_module()
    with pytest.raises(mod.ValidationError):
        mod.validate_options("not-json")


def test_validate_options_accepts_dict_directly():
    mod = load_module()
    options = {"page_range": "1-2"}

    assert mod.validate_options(options) is options


@pytest.mark.parametrize("options", ["[]", '"text"'])
def test_validate_options_rejects_json_non_object(options):
    mod = load_module()
    with pytest.raises(mod.ValidationError, match="options must be a JSON object"):
        mod.validate_options(options)
