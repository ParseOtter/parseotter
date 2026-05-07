"""Compatibility wrapper for the shared backend configuration."""

from shared.config import Config, _parse_csv_env, _parse_positive_int_env, load_config


def _parse_int_env(key: str, default: int) -> int:
    return _parse_positive_int_env(key, default)


__all__ = ["Config", "load_config", "_parse_int_env", "_parse_csv_env"]
