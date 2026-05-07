import ast
import tomllib
from pathlib import Path


def _load_marker_modal_module() -> ast.Module:
    source = Path(__file__).resolve().parents[2] / "modal_app.py"
    return ast.parse(source.read_text(encoding="utf-8"))


def _version_tuple(value: str) -> tuple[int, ...]:
    return tuple(int(part) for part in value.split("."))


def _find_debian_slim_call(module: ast.Module) -> ast.Call:
    return next(
        node
        for node in ast.walk(module)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "debian_slim"
    )


def _find_decorator_call(node: ast.AST, decorator_attr: str) -> ast.Call:
    decorator_list = getattr(node, "decorator_list")
    return next(
        decorator
        for decorator in decorator_list
        if isinstance(decorator, ast.Call)
        and isinstance(decorator.func, ast.Attribute)
        and decorator.func.attr == decorator_attr
    )


def _keyword_name(call: ast.Call, keyword_name: str) -> str:
    keyword = next(keyword for keyword in call.keywords if keyword.arg == keyword_name)
    assert isinstance(keyword.value, ast.Name)
    return keyword.value.id


def _function_def(module: ast.Module, name: str) -> ast.FunctionDef:
    return next(
        node
        for node in module.body
        if isinstance(node, ast.FunctionDef) and node.name == name
    )


def _decorator_keyword(call: ast.Call, keyword_name: str) -> ast.AST:
    return next(keyword.value for keyword in call.keywords if keyword.arg == keyword_name)


def test_cloudflare_dispatch_worker_binds_gateway_secrets():
    module = _load_marker_modal_module()
    function = _function_def(module, "run_cloudflare_dispatch_job")
    app_function = _find_decorator_call(function, "function")
    secrets_value = _decorator_keyword(app_function, "secrets")

    assert isinstance(secrets_value, ast.Name)
    assert secrets_value.id == "GATEWAY_SECRETS"


def test_modal_app_name_is_deploy_time_configurable():
    module = _load_marker_modal_module()
    assignment = next(
        node
        for node in module.body
        if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == "app" for target in node.targets)
    )
    assert isinstance(assignment.value, ast.Call)
    assert isinstance(assignment.value.func, ast.Attribute)
    assert assignment.value.func.attr == "App"
    assert len(assignment.value.args) == 1
    assert isinstance(assignment.value.args[0], ast.Name)
    assert assignment.value.args[0].id == "MODAL_APP_NAME"


def test_gpu_type_is_shared_by_model_download_and_parser_service():
    module = _load_marker_modal_module()
    download_models = next(
        node
        for node in module.body
        if isinstance(node, ast.FunctionDef) and node.name == "download_models"
    )
    marker_service = next(
        node
        for node in module.body
        if isinstance(node, ast.ClassDef) and node.name == "MarkerConversionService"
    )

    assert _keyword_name(_find_decorator_call(download_models, "function"), "gpu") == "GPU_TYPE"
    assert _keyword_name(_find_decorator_call(marker_service, "cls"), "gpu") == "GPU_TYPE"


def test_parser_service_uses_tunable_warm_pool_settings():
    module = _load_marker_modal_module()
    marker_service = next(
        node
        for node in module.body
        if isinstance(node, ast.ClassDef) and node.name == "MarkerConversionService"
    )
    app_cls = _find_decorator_call(marker_service, "cls")

    assert _keyword_name(app_cls, "scaledown_window") == "MARKER_SERVICE_SCALEDOWN_WINDOW"
    assert _keyword_name(app_cls, "min_containers") == "MARKER_SERVICE_MIN_CONTAINERS"
    assert _keyword_name(app_cls, "max_containers") == "MARKER_SERVICE_MAX_CONTAINERS"


def test_cloudflare_dispatch_worker_caps_container_fanout():
    module = _load_marker_modal_module()
    function = _function_def(module, "run_cloudflare_dispatch_job")
    app_function = _find_decorator_call(function, "function")

    assert _keyword_name(app_function, "max_containers") == "MARKER_SERVICE_MAX_CONTAINERS"


def test_modal_runtime_functions_mount_cache_volume():
    module = _load_marker_modal_module()
    for function_name in ["run_orchestrator", "run_cloudflare_dispatch_job", "gateway_app"]:
        function = _function_def(module, function_name)
        app_function = _find_decorator_call(function, "function")
        volumes = _decorator_keyword(app_function, "volumes")
        assert isinstance(volumes, ast.Dict)
        assert any(
            isinstance(key, ast.Constant) and key.value == "/cache"
            for key in volumes.keys
        )


def test_cloudflare_dispatch_worker_commits_cache_volume_in_finally():
    module = _load_marker_modal_module()
    function = _function_def(module, "run_cloudflare_dispatch_job")
    try_nodes = [node for node in ast.walk(function) if isinstance(node, ast.Try)]

    assert any(
        any(
            isinstance(final_node, ast.Expr)
            and isinstance(final_node.value, ast.Call)
            and isinstance(final_node.value.func, ast.Attribute)
            and final_node.value.func.attr == "commit"
            and isinstance(final_node.value.func.value, ast.Name)
            and final_node.value.func.value.id == "cache_volume"
            for final_node in try_node.finalbody
        )
        for try_node in try_nodes
    )


def test_image_exports_runtime_tuning_environment():
    module = _load_marker_modal_module()
    env_call = next(
        node
        for node in ast.walk(module)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "env"
    )
    env_dict = env_call.args[0]
    assert isinstance(env_dict, ast.Dict)

    env_keys = {
        key.value
        for key in env_dict.keys
        if isinstance(key, ast.Constant) and isinstance(key.value, str)
    }
    assert "MODAL_APP_NAME" in env_keys
    assert "GPU_TYPE" in env_keys
    assert "MARKER_PDFTEXT_WORKERS" in env_keys
    assert "MARKER_SERVICE_MAX_CONTAINERS" in env_keys


def test_modal_python_version_satisfies_project_requirement():
    module = _load_marker_modal_module()
    debian_slim_call = _find_debian_slim_call(module)
    python_version_keyword = next(keyword for keyword in debian_slim_call.keywords if keyword.arg == "python_version")
    assert isinstance(python_version_keyword.value, ast.Constant)
    assert isinstance(python_version_keyword.value.value, str)

    pyproject_path = Path(__file__).resolve().parents[2] / "pyproject.toml"
    pyproject = tomllib.loads(pyproject_path.read_text(encoding="utf-8"))
    requires_python = pyproject["project"]["requires-python"]
    assert requires_python.startswith(">=")

    image_version = _version_tuple(python_version_keyword.value.value)
    required_version = _version_tuple(requires_python.removeprefix(">="))
    assert image_version >= required_version
