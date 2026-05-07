import os
import shutil
from typing import BinaryIO, Optional, Dict
from pathlib import Path

from shared.atomic_write import atomic_write_json


class StorageError(RuntimeError):
    pass


def write_job_files(
    job_root: str,
    job_id: str,
    file_stream: BinaryIO,
    file_name: str = "original.pdf",
    options: Optional[Dict] = None,
) -> Path:
    """Atomically write job files into job_root/{job_id}.

    Strategy:
    - Create job_root if needed
    - Create a temporary directory job_root/.{job_id}.tmp
    - Write original.pdf and options.json (if provided)
    - fsync files (where possible)
    - Atomically rename temp dir to final dir

    Returns Path to final job dir.
    Raises StorageError on failure.
    """
    job_root_p = Path(job_root)
    job_root_p.mkdir(parents=True, exist_ok=True)

    final_dir = job_root_p / job_id
    if final_dir.exists():
        raise StorageError(f"job directory already exists: {final_dir}")

    tmp_dir = job_root_p / f".{job_id}.tmp"
    if tmp_dir.exists():
        # remove stale tmp
        shutil.rmtree(tmp_dir, ignore_errors=True)

    try:
        tmp_dir.mkdir(parents=True, exist_ok=False)

        # write file
        target_file = tmp_dir / file_name
        with open(target_file, "wb") as f:
            # stream copy
            for chunk in iter(lambda: file_stream.read(65536), b""):
                f.write(chunk)
            f.flush()
            try:
                os.fsync(f.fileno())
            except Exception:
                # best effort
                pass

        if options is not None:
            atomic_write_json(tmp_dir / "options.json", options)

        # atomic move
        os.replace(str(tmp_dir), str(final_dir))
        return final_dir

    except Exception as e:
        # cleanup
        try:
            if tmp_dir.exists():
                shutil.rmtree(tmp_dir, ignore_errors=True)
        finally:
            raise StorageError(f"failed to write job files: {e}")
