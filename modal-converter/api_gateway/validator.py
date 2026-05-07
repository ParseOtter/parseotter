import json
from typing import Optional, Dict, Any


class ValidationError(ValueError):
    pass


class UploadTooLargeError(ValidationError):
    pass


def _is_pdf_filename(filename: str) -> bool:
    return filename.lower().endswith(".pdf")


def _is_epub_filename(filename: str) -> bool:
    return filename.lower().endswith(".epub")


def validate_options(options_str: Optional[str]) -> Optional[Dict[str, Any]]:
    if options_str is None:
        return None
    if isinstance(options_str, dict):
        return options_str
    try:
        parsed = json.loads(options_str)
    except Exception as e:
        raise ValidationError(f"invalid options JSON: {e}")
    if not isinstance(parsed, dict):
        raise ValidationError("options must be a JSON object")
    return parsed


def validate_upload(
    filename: str,
    content_type: Optional[str],
    content_length: Optional[int],
    max_upload_bytes: int = 150 * 1024 * 1024,
    options: Optional[str] = None,
) -> Dict[str, Any]:
    """Validate upload metadata.

    Returns a normalized metadata dict or raises ValidationError.
    """
    if not filename:
        raise ValidationError("filename is required")

    is_pdf = _is_pdf_filename(filename)
    is_epub = _is_epub_filename(filename)
    if not (is_pdf or is_epub):
        raise ValidationError("only .pdf or .epub files are allowed")

    if content_type:
        ct = content_type.split(";")[0].strip().lower()
        if is_pdf:
            if ct != "application/pdf":
                raise ValidationError(f"invalid content type: {content_type}")
        elif is_epub:
            if ct not in {"application/epub+zip", "application/octet-stream"}:
                raise ValidationError(f"invalid content type: {content_type}")

    if content_length is not None:
        if content_length <= 0:
            raise ValidationError("content length must be positive")
        if content_length > max_upload_bytes:
            raise UploadTooLargeError("file size exceeds maximum allowed")

    parsed_options = validate_options(options)

    return {
        "file_name": filename,
        "content_type": content_type,
        "content_length": content_length,
        "options": parsed_options,
    }
