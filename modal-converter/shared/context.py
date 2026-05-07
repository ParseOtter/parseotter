"""Explicit dependency context for job processing."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Protocol


class ParserRemoteProtocol(Protocol):
    def remote(self, job_id: str, options: Dict[str, Any]) -> Dict[str, Any]:
        ...


class ParserCallableProtocol(Protocol):
    def __call__(self, job_id: str, options: Dict[str, Any]) -> Dict[str, Any]:
        ...


ParserHandleProtocol = ParserRemoteProtocol | ParserCallableProtocol


class CloudflareDispatchHandleProtocol(Protocol):
    def spawn(self, job_id: str) -> Any:
        ...


@dataclass
class JobContext:
    """Dependencies injected into the job processing pipeline."""

    parser_handle: Optional[ParserHandleProtocol] = None
    cloudflare_dispatch_handle: Optional[CloudflareDispatchHandleProtocol] = None
    commit_cache: Optional[Callable[[], None]] = None
    reload_cache: Optional[Callable[[], None]] = None
