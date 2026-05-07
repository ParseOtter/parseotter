import api_gateway.cloudflare_dispatch as legacy_dispatch
import api_gateway.dispatch as dispatch


def test_dispatch_package_exports_public_contract():
    assert set(dispatch.__all__) == {
        "DispatchValidationError",
        "R2ConfigError",
        "DispatchConflictError",
        "CallbackConfigError",
        "R2TransferResult",
        "PARSEOTTER_FREE_OUTPUT_PROFILE",
        "SUPPORTED_OUTPUT_FORMATS",
        "SUPPORTED_OUTPUT_PROFILES",
        "validate_dispatch_payload",
        "prepare_cloudflare_dispatch_job",
        "process_cloudflare_dispatch_job",
        "validate_callback_auth_config",
        "download_r2_object_to_path",
        "download_r2_object",
        "upload_r2_object",
        "upload_r2_object_from_path",
        "require_r2_configured",
    }


def test_legacy_cloudflare_dispatch_wrapper_reexports_public_symbols():
    for name in dispatch.__all__:
        assert getattr(legacy_dispatch, name) is getattr(dispatch, name)
