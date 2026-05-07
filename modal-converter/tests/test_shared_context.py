from typing import get_args, get_type_hints

from shared.context import (
    CloudflareDispatchHandleProtocol,
    JobContext,
    ParserCallableProtocol,
    ParserRemoteProtocol,
)


def test_job_context_parser_handle_annotation_uses_protocols():
    hints = get_type_hints(JobContext)

    assert set(get_args(hints["parser_handle"])) == {
        ParserRemoteProtocol,
        ParserCallableProtocol,
        type(None),
    }


def test_job_context_cloudflare_dispatch_handle_annotation_uses_protocol():
    hints = get_type_hints(JobContext)

    assert set(get_args(hints["cloudflare_dispatch_handle"])) == {
        CloudflareDispatchHandleProtocol,
        type(None),
    }


def test_job_context_defaults_to_no_dependencies():
    ctx = JobContext()

    assert ctx.parser_handle is None
    assert ctx.cloudflare_dispatch_handle is None
    assert ctx.commit_cache is None
    assert ctx.reload_cache is None
