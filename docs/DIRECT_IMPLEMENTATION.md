# Direct Modal MCP Server — 分阶段实施文档

> 配套方案文档: `docs/DIRECT_MCP_PLAN.md`
> 本文档覆盖 Modal 网关端 (Python) + MCP Server 端 (TypeScript) 全部实施阶段。
>
> Review 版本: v3 (基于 3 组独立 code review × 2 轮修正)

---

## 实施总览

### 分组与依赖关系

```
A组 Modal 网关端 (Python)        B组 MCP Server 端 (TypeScript)
  P1: direct_handler.py             P1: src/direct/client.ts
  P2: modal_app.py                  P2: src/direct/server.ts
  P3: test_direct_handler.py        P3: src/direct/index.ts + package.json
                                    P4 (可选): 重试与超时
```

- A 组内部：P1 → P2 → P3；B 组内部：P1 → P2 → P3
- **两组之间可完全并行**

### 进度追踪表格

| 组 | 阶段 | 文件 | 操作 | 预计行数 | 状态 |
|----|------|------|------|----------|------|
| A | P1 | `modal-converter/api_gateway/direct_handler.py` | 新建 | ~200 | ⬜ PENDING |
| A | P2 | `modal-converter/modal_app.py` | 修改 | +5 | ⬜ PENDING |
| A | P3 | `modal-converter/api_gateway/tests/test_direct_handler.py` | 新建 | ~200 | ⬜ PENDING |
| B | P1 | `mcp-server/src/direct/client.ts` | 新建 | ~100 | ⬜ PENDING |
| B | P2 | `mcp-server/src/direct/server.ts` | 新建 | ~80 | ⬜ PENDING |
| B | P3 | `mcp-server/src/direct/index.ts` + `package.json` | 新建+修改 | ~70+3 | ⬜ PENDING |
| B | P4 | `mcp-server/src/direct/client.ts` | 修改(可选) | ~30 | ⬜ PENDING |

### 估算总代码量

| 端 | 源文件 | 测试文件 | 合计 |
|----|--------|----------|------|
| Modal | ~220 行 | ~230 行 | ~450 行 |
| MCP | ~260 行 | — | ~260 行 |
| **总计** | **~480 行** | **~230 行** | **~710 行** |

---

## A 组: Modal 网关端 (Python)

### Phase A1: 创建 `direct_handler.py`（完整 3 端点）

**前置依赖**：无

**文件**：`modal-converter/api_gateway/direct_handler.py`（新建，~220 行）

#### 导入

```python
from fastapi import APIRouter, HTTPException, Request, UploadFile, File, Form
from typing import Any, Optional
import json, uuid, io, base64, os
from pathlib import Path
from shared.config import load_config
from shared.context import JobContext
from marker_inference import MARKDOWN_FILENAME, METADATA_FILENAME, IMAGES_DIRNAME
from api_gateway import storage, status_writer
from api_gateway.id_validation import validate_job_id
from orchestrator.pipeline import process_job_background
```

> ⚠️ `marker_inference` 是顶级模块（位于 `modal-converter/marker_inference.py`），非 `shared/` 子模块。
> `Optional` 显式导入用于 handler 签名。

```python
router = APIRouter()
```

#### 辅助函数和常量

```python
MAX_IMAGE_BYTES = 10 * 1024 * 1024  # 单图最多 10MB
SUPPORTED_EXTENSIONS = frozenset({".pdf", ".epub"})


def _require_direct_enabled():
    """运行时检查 DIRECT_ENABLED，防止未授权使用。

    该检查在 handler 函数级执行（而非模块级），确保 Modal import/deploy 不会因此阻塞。
    """
    if os.environ.get("DIRECT_ENABLED", "").lower() not in ("1", "true", "yes"):
        raise HTTPException(
            503, detail="DIRECT_ENABLED is not set. Direct endpoints are disabled."
        )


def _read_images(job_dir: Path) -> list[dict[str, str]]:
    """读取 job_dir/images/ 目录下的图片并返回 base64 列表。异常时静默返回空列表。"""
    images: list[dict[str, str]] = []
    images_dir = job_dir / IMAGES_DIRNAME
    try:
        if images_dir.exists():
            for img_path in sorted(images_dir.iterdir()):
                if img_path.is_file() and img_path.stat().st_size <= MAX_IMAGE_BYTES:
                    img_b64 = base64.b64encode(img_path.read_bytes()).decode("ascii")
                    images.append({"name": img_path.name, "data": img_b64})
    except (OSError, PermissionError):
        pass
    return images


def _read_job_metadata(job_dir: Path) -> dict:
    """读取 job_dir/metadata.json 并返回 dict。异常时向上传播。"""
    metadata_raw = (job_dir / METADATA_FILENAME).read_text(encoding="utf-8")
    return json.loads(metadata_raw)


def _build_metadata_payload(metadata: dict) -> dict:
    return {
        "page_count": metadata.get("page_count", 0),
        "processing_time_ms": int(metadata.get("timings", {}).get("total_seconds", 0) * 1000),
        "gpu_type": metadata.get("runtime", {}).get("gpu_type", "unknown"),
        "renderer_version": metadata.get("renderer_version", "marker-pdf"),
    }
```

#### `POST /api/direct/convert` — 同步转换

**关键设计决策**：
- 使用 `def` 而非 `async def`（`process_job_background()` 是同步阻塞函数，`def` 让 FastAPI 在线程池中执行，不阻塞事件循环）
- 使用 `file.file.read()` 同步读取（`def` handler 中不可用 `await`）

```python
@router.post("/direct/convert")
def post_direct_convert(
    request: Request,
    file: UploadFile = File(...),
    page_range: Optional[str] = Form(None),
    force_ocr: Optional[bool] = Form(None),
):
    _require_direct_enabled()

    # 客户端建议在上传前验证扩展名，服务端二次确认
    if file.filename:
        ext = Path(file.filename).suffix.lower()
        if ext not in SUPPORTED_EXTENSIONS:
            raise HTTPException(400, detail=f"unsupported file type: {ext}")

    cfg = load_config(strict_gateway=False)

    # 文件大小检查（当 file.size 为 None 时使用分块读取）
    max_upload = cfg.max_upload_bytes
    if file.size is None:
        raw = b""
        while True:
            chunk = file.file.read(8 * 1024 * 1024)
            if not chunk:
                break
            raw += chunk
            if max_upload > 0 and len(raw) > max_upload:
                file.file.close()
                raise HTTPException(413, detail=f"file exceeds {max_upload} bytes")
        file_bytes = raw
    else:
        if max_upload > 0 and file.size > max_upload:
            raise HTTPException(413, detail=f"file too large ({file.size} > {max_upload} bytes)")
        file_bytes = file.file.read()

    job_id = f"direct_{uuid.uuid4().hex}"

    options: dict[str, Any] = {}
    if page_range is not None:
        options["page_range"] = page_range
    if force_ocr is not None:
        options["force_ocr"] = force_ocr

    storage.write_job_files(
        cfg.marker_job_dir, job_id, io.BytesIO(file_bytes),
        file_name=file.filename or "original.pdf", options=options,
    )
    status_writer.create_initial_status(
        cfg.marker_job_dir, job_id,
        file_name=file.filename or "original.pdf",
        file_size=len(file_bytes), options=options,
    )

    ctx = getattr(request.app.state, "job_ctx", None)
    direct_ctx = JobContext(
        parser_handle=None,
        reload_cache=ctx.reload_cache if ctx else None,
        commit_cache=ctx.commit_cache if ctx else None,
    )
    outcome = process_job_background(job_id, options=options, ctx=direct_ctx, config=cfg)
    if outcome.status == "failed":
        raise HTTPException(500, detail=outcome.error_message or "conversion failed")

    job_dir = Path(cfg.marker_job_dir) / job_id
    try:
        markdown_content = (job_dir / MARKDOWN_FILENAME).read_text(encoding="utf-8")
    except (FileNotFoundError, PermissionError) as e:
        raise HTTPException(500, detail=f"markdown result not readable: {e}")

    try:
        metadata = _read_job_metadata(job_dir)
    except (FileNotFoundError, json.JSONDecodeError, PermissionError) as e:
        raise HTTPException(500, detail=f"metadata not readable: {e}")

    return {
        "job_id": job_id,
        "markdown": markdown_content,
        "images": _read_images(job_dir) or None,
        "metadata": _build_metadata_payload(metadata),
    }
```

#### `GET /api/direct/jobs/{job_id}` — 状态查询（调试用）

该端点为手动调试提供：直接查看 `status.json`。B 组客户端不调用该端点。

```python
@router.get("/direct/jobs/{job_id}")
def get_direct_job_status(job_id: str):
    _require_direct_enabled()

    try:
        cfg = load_config(strict_gateway=False)
    except Exception as e:
        raise HTTPException(500, detail=f"configuration error: {e}")

    try:
        validate_job_id(job_id)
    except ValueError:
        raise HTTPException(400, detail="invalid job_id")

    job_dir = Path(cfg.marker_job_dir) / job_id
    status_path = job_dir / "status.json"
    if not status_path.exists():
        raise HTTPException(404, detail="job not found")

    try:
        return json.loads(status_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, PermissionError, OSError) as e:
        raise HTTPException(500, detail=f"failed to read status: {e}")
```

> `load_config()` 和 `validate_job_id()` 分两个 try 块（参照 `handlers.py:162-172`），避免 `load_config ValueError` 被误认为 `invalid job_id`。

#### `GET /api/direct/jobs/{job_id}/result` — 结果获取（调试用）

该端点为手动调试提供：同步等待转换完成后获取结果。B 组客户端不调用该端点（B 组使用 POST 同步等待）。

```python
@router.get("/direct/jobs/{job_id}/result")
def get_direct_job_result(job_id: str):
    _require_direct_enabled()

    try:
        cfg = load_config(strict_gateway=False)
    except Exception as e:
        raise HTTPException(500, detail=f"configuration error: {e}")

    try:
        validate_job_id(job_id)
    except ValueError:
        raise HTTPException(400, detail="invalid job_id")

    job_dir = Path(cfg.marker_job_dir) / job_id
    status_path = job_dir / "status.json"
    if not status_path.exists():
        raise HTTPException(404, detail="job not found")

    try:
        status_raw = status_path.read_text(encoding="utf-8")
        status = json.loads(status_raw)
    except (json.JSONDecodeError, PermissionError, OSError) as e:
        raise HTTPException(500, detail=f"failed to read status: {e}")

    if not isinstance(status, dict) or status.get("status") != "complete":
        raise HTTPException(400, detail="job not complete")

    try:
        markdown_content = (job_dir / MARKDOWN_FILENAME).read_text(encoding="utf-8")
    except (FileNotFoundError, PermissionError) as e:
        raise HTTPException(500, detail=f"markdown result not readable: {e}")

    try:
        metadata = _read_job_metadata(job_dir)
    except (FileNotFoundError, json.JSONDecodeError, PermissionError) as e:
        raise HTTPException(500, detail=f"metadata not readable: {e}")

    return {
        "job_id": job_id,
        "markdown": markdown_content,
        "images": _read_images(job_dir) or None,
        "metadata": _build_metadata_payload(metadata),
    }
```

#### 验证检查点

```bash
python -c "import ast; ast.parse(open('modal-converter/api_gateway/direct_handler.py').read())"
ruff check modal-converter/api_gateway/direct_handler.py
```

---

### Phase A2: 注册路由 & 调整 `modal_app.py`

**前置依赖**：Phase A1

**文件**：`modal-converter/modal_app.py`（修改，+5 行）

| 行号 | 当前内容 | 修改为 |
|------|----------|--------|
| L12 | `from shared.context import JobContext` | 不动 |
| L209 | `from api_gateway import handlers` | 后面新增一行 `from api_gateway import direct_handler`（在 `gateway_app()` 函数内部，与 `handlers` 的导入并列） |
| L202–L207 | `@app.function(...)` + `@modal.asgi_app()` | `@app.function(...)` 增加 `timeout=900`。**保留 `@modal.asgi_app()` 不动** |
| L242 | `app.include_router(handlers.router, prefix="/api")` | 下一行新增 `app.include_router(direct_handler.router, prefix="/api")` |

```python
# 在 @app.function decorator 调整 (L202-L206: 保留 @modal.asgi_app() 不动)
@app.function(
    image=image,
    secrets=GATEWAY_SECRETS,
    volumes={"/cache": cache_volume},
    timeout=900,
)
@modal.asgi_app()
def gateway_app():
    import logging
    from pathlib import Path

    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware
    from api_gateway import handlers
    from api_gateway import direct_handler  # 惰性 import，不阻塞 Module 级加载

    # ... 现有代码 ...

    app.include_router(handlers.router, prefix="/api")
    app.include_router(direct_handler.router, prefix="/api")
```

> ⚠️ 修改时务必保留 `@modal.asgi_app()` 装饰器（`modal_app.py:L207`）。该装饰器绑定 FastAPI 到 Modal ASGI 网关，丢失后将无法部署。
> `from api_gateway import direct_handler` 放在 `gateway_app()` 函数内部（与 `from api_gateway import handlers` 并列），确保模块级 import 不会触发 `direct_handler.py` 的模块级代码，避免 Modal deploy 时因 `DIRECT_ENABLED` 检查而失败。
> `timeout=900` 与 `run_orchestrator` 函数一致（大文件转换可能需要 10+ 分钟）。无需额外 `memory=` — 网关层已继承默认值且仅做 I/O 转发。

#### 验证检查点

```bash
python -c "
import ast
tree = ast.parse(open('modal-converter/modal_app.py').read())

# 验证 decorator 链包含 @modal.asgi_app()
for node in ast.walk(tree):
    if isinstance(node, ast.FunctionDef) and node.name == 'gateway_app':
        decorator_ids = [d for d in node.decorator_list if isinstance(d, ast.Call) and hasattr(d.func, 'attr')]
        has_asgi = any(d.func.attr == 'asgi_app' for d in decorator_ids)
        print(f'gateway_app has @modal.asgi_app(): {has_asgi}')
        assert has_asgi, '@modal.asgi_app() must be preserved'

# 验证 include_router 数量
calls = [n for n in ast.walk(tree)
         if isinstance(n, ast.Call)
         and getattr(n.func, 'attr', None) == 'include_router']
print(f'include_router calls: {len(calls)}')  # 应输出 >= 2
"
```

---

### Phase A3: 单元测试

**前置依赖**：Phase A1 + A2

**文件**：`modal-converter/api_gateway/tests/test_direct_handler.py`（新建，~230 行）

**测试模式**：遵循现有 `test_handlers_routes.py` 模式：
- 使用 `importlib` 动态加载模块（而非 `@pytest.fixture` 共享模块状态）
- 每个测试通过 `tmp_path` 设置独立的 `MARKER_JOB_DIR`
- 使用 `build_app()` 辅助函数构建应用

**测试用例清单**（14 个）：

| # | 测试 | 端点 | 条件 | 预期 |
|---|------|------|------|------|
| 1 | `test_convert_success` | POST /direct/convert | 成功路径 | 200，含 job_id/markdown/metadata |
| 2 | `test_convert_orchestrator_failure` | POST /direct/convert | process_job_background 返回 failed | 500 |
| 3 | `test_convert_storage_failure` | POST /direct/convert | write_job_files 异常 | 500 |
| 4 | `test_convert_no_file` | POST /direct/convert | 不传 file | 422 |
| 5 | `test_convert_file_too_large` | POST /direct/convert | 文件超过 max_upload_bytes | 413 |
| 6 | `test_convert_result_file_missing` | POST /direct/convert | raw.md 不存在但 orchestrator 返回 success | 500 |
| 7 | `test_get_status_success` | GET /direct/jobs/{id} | status.json 存在 | 200 |
| 8 | `test_get_status_not_found` | GET /direct/jobs/{id} | status.json 不存在 | 404 |
| 9 | `test_get_status_invalid_job_id` | GET /direct/jobs/{id} | 路径遍历 job_id | 400 |
| 10 | `test_get_status_corrupt_json` | GET /direct/jobs/{id} | status.json 不是合法 JSON | 500 |
| 11 | `test_get_result_success` | GET /direct/jobs/{id}/result | job 完成 | 200 |
| 12 | `test_get_result_status_not_dict` | GET /direct/jobs/{id}/result | status.json 包含 `list` 等非 dict 值 | 400 |
| 13 | `test_get_result_not_complete` | GET /direct/jobs/{id}/result | status.json 是 dict 但 status != "complete" | 400 |
| 14 | `test_get_result_not_found` | GET /direct/jobs/{id}/result | job 不存在 | 404 |

```python
import importlib.util
import json
import os
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
from shared.context import JobContext


def load_direct_handler_module(job_root_env: str):
    os.environ["MARKER_JOB_DIR"] = job_root_env
    os.environ["DIRECT_ENABLED"] = "1"

    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location(
        "api_gateway.direct_handler",
        str(root / "direct_handler.py"),
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["api_gateway.direct_handler"] = mod
    spec.loader.exec_module(mod)
    return mod


def build_app(job_root_env: str):
    os.environ.pop("API_SECRET", None)  # 测试隔离
    mod = load_direct_handler_module(job_root_env)
    app = FastAPI()
    app.state.job_ctx = JobContext()
    app.include_router(mod.router, prefix="/api")
    return app
```

```bash
python -m pytest modal-converter/api_gateway/tests/test_direct_handler.py -v --tb=short
python -m pytest modal-converter/api_gateway/tests/test_direct_handler.py --cov=api_gateway.direct_handler -v
```

---

### Phase A: 错误场景清单

#### `post_direct_convert()`

| # | 场景 | 触发条件 | 处理 | HTTP |
|---|------|----------|------|------|
| 1 | 缺少 file | 未上传 | FastAPI 422 | 422 |
| 2 | 空文件 | file.size == 0 | parsing 可能失败 → 500 | 500 |
| 3 | 文件超限 | 超过 `max_upload_bytes` | → 413 | 413 |
| 4 | file.size is None（chunked） | ASGI chunked 编码 | 分块读取上限 200MB | 413 |
| 5 | job_dir 已存在 | job_id 冲突 | StorageError → 500 | 500 |
| 6 | Storage I/O 失败 | 磁盘满 | StorageError → 500 | 500 |
| 7 | Status 写入失败 | 磁盘满 | 异常 → 500 | 500 |
| 8 | Orchestrator 失败 | GPU OOM | Outcome.failed → 500 | 500 |
| 9 | Modal SDK 不可用 | 非 Modal 环境 | 异常 → 500 | 500 |
| 10 | 解析超时 | 大文件超 900s | Modal 终止 → 500 | 500 |
| 11 | 结果文件缺失 | raw.md 不存在 | FileNotFoundError → 500 | 500 |
| 12 | metadata 损坏 | 非 JSON | JSONDecodeError → 500 | 500 |
| 13 | 图片读取失败 | 单图 > 10MB | 跳过该图继续 | 200（缺图） |
| 14 | 图片目录异常 | 并发删除/权限 | OSError 捕获 | 200（无图） |
| 15 | 不支持的文件类型 | 扩展名非 .pdf/.epub | 服务端验证 → 400 | 400 |
| 16 | page_range 格式无效 | 不匹配 regex | orchestrator 验失败 → 500 | 500 |

#### `get_direct_job_status()` / `get_direct_job_result()`

| # | 场景 | 触发条件 | 处理 | HTTP |
|---|------|----------|------|------|
| 1 | 路径遍历 | `../../etc/passwd` | validate_job_id() → ValueError → 400 | 400 |
| 2 | job 不存在 | status.json 不存在 | → 404 | 404 |
| 3 | status.json 非 JSON | 损坏的文件 | json.loads 异常 → 500 | 500 |
| 4 | status.json 非 dict | 值是 list 等 | `isinstance(status, dict)` 为 False → 400 | 400 |
| 5 | job 未完成 | status != "complete" | → 400 | 400 |
| 6 | load_config 异常 | 配置缺失 | 单独 try/except → 500 | 500 |
| 7 | 结果文件缺失 | raw.md 不存在 | FileNotFoundError → 500 | 500 |
| 8 | metadata 损坏 | 非 JSON | JSONDecodeError → 500 | 500 |

---

## B 组: MCP Server 端 (TypeScript)

### 通用约定

- 所有新文件放在 `mcp-server/src/direct/` 目录下
- Node engine 要求 `>=18.13.0`（需要 `AbortSignal.timeout()`，详见 Phase B4）。修改 `package.json` 中的 engines 字段
- 复用现有 `src/types.ts` 中的 `ParseOtterError` 进行结构化错误处理。**注意**：`types.ts` 不导出 `ErrorCode` 枚举，使用 string literal 作为 `code` 参数（如 `"VALIDATION_ERROR"`）
- `ParseOtterError` 构造函数签名为 `(message: string, code: string, statusCode?: number, retryable?: boolean)`
- 遵循现有代码风格：`node:` 前缀导入、`.js` 后缀的 ESM 导入

### Phase B1: `src/direct/client.ts` — Direct 模式 HTTP 客户端

**前置依赖**：无

**文件**：`mcp-server/src/direct/client.ts`（新建，~110 行）

#### 类型定义

```typescript
export interface DirectConvertResult {
  job_id: string;
  markdown: string;
  images: Array<{ name: string; data: string }> | null;
  metadata: {
    page_count: number;
    processing_time_ms: number;
    gpu_type: string;
    renderer_version: string;
  };
}

export interface ConversionOptions {
  page_range?: string;
  force_ocr?: boolean;
}
```

#### 核心实现

```typescript
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { ParseOtterError } from "../types.js";

const MAX_FILE_SIZE = 150 * 1024 * 1024; // 150 MB
const SUPPORTED_EXTENSIONS = new Set([".pdf", ".epub"]);

export async function convertFileDirect(
  baseUrl: string,
  filePath: string,
  options?: ConversionOptions & { signal?: AbortSignal },
): Promise<DirectConvertResult> {
  // 文件存在性检查
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw new ParseOtterError(`Not a file: ${filePath}`, "VALIDATION_ERROR");
    }
    if (fileStat.size === 0) {
      throw new ParseOtterError("File is empty", "VALIDATION_ERROR");
    }
    if (fileStat.size > MAX_FILE_SIZE) {
      throw new ParseOtterError(
        `File too large (${fileStat.size} bytes)`, "VALIDATION_ERROR",
      );
    }
  } catch (error) {
    if (error instanceof ParseOtterError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ParseOtterError(`File not found: ${filePath}`, "FILE_NOT_FOUND");
    }
    if ((error as NodeJS.ErrnoException).code === "EACCES") {
      throw new ParseOtterError(`Permission denied: ${filePath}`, "PERMISSION_DENIED");
    }
    throw new ParseOtterError(`Unexpected file error: ${error}`, "INTERNAL_ERROR");
  }

  // 文件扩展名检查
  const ext = extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new ParseOtterError(
      `Unsupported file type: ${ext}. Only .pdf and .epub are supported`,
      "VALIDATION_ERROR",
    );
  }

  const buffer = await readFile(filePath);
  const blob = new Blob([buffer]);
  const formData = new FormData();
  formData.append("file", blob, basename(filePath));

  if (options?.page_range) {
    formData.append("page_range", options.page_range);
  }
  if (options?.force_ocr !== undefined) {
    formData.append("force_ocr", String(options.force_ocr));
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/api/direct/convert`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      body: formData,
      signal: options?.signal,
    });
  } catch (error) {
    // DOMException AbortError 或 TypeError（网络不可达）
    if (error instanceof TypeError && error.message.includes("fetch")) {
      throw new ParseOtterError(
        `Unable to connect to Modal gateway at ${baseUrl}`, "NETWORK_ERROR",
      );
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ParseOtterError("Request was aborted", "TIMEOUT_ERROR");
    }
    throw new ParseOtterError(`Request failed: ${error}`, "INTERNAL_ERROR");
  }

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 413) {
      throw new ParseOtterError("File too large (HTTP 413)", "VALIDATION_ERROR");
    }
    if (response.status === 422) {
      throw new ParseOtterError(
        `Invalid request (HTTP 422): ${body.slice(0, 200)}`, "VALIDATION_ERROR",
      );
    }
    throw new ParseOtterError(
      `Gateway returned ${response.status}: ${body.slice(0, 500)}`, "SERVER_ERROR",
    );
  }

  return response.json() as DirectConvertResult;
}

// 以下为 Phase B4 预留
export function isRetryableError(error: unknown): boolean {
  if (error instanceof ParseOtterError) {
    return error.code === "NETWORK_ERROR" || error.retryable;
  }
  if (error instanceof TypeError && (error as TypeError).message.includes("fetch")) {
    return true;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return false; // 用户或超时触发的 AbortError 应抛出而非重试
  }
  return false;
}
```

#### 验证检查点

```bash
cd mcp-server && npx tsc --noEmit
ls -la build/direct/client.js
```

---

### Phase B2: `src/direct/server.ts` — Direct 模式 MCP 工具注册

**前置依赖**：Phase B1

**文件**：`mcp-server/src/direct/server.ts`（新建，~80 行）

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { convertFileDirect } from "./client.js";
import { ParseOtterError } from "../types.js";

export interface DirectServerOptions {
  baseUrl: string;
}

export function createDirectMcpServer(options: DirectServerOptions): McpServer {
  const server = new McpServer({
    name: "parseotter-direct",
    version: "0.1.0",
  });

  server.tool(
    "convert_document_direct",
    "Convert a PDF/EPUB file to Markdown via the local Modal gateway",
    {
      file_path: z.string().describe("Absolute path to the PDF or EPUB file on the local filesystem"),
      page_range: z.string().optional().describe("Page range to convert, e.g. '1-5', '1,3,5-7'"),
      force_ocr: z.boolean().optional().describe("Force OCR for all pages (default false)"),
    },
    async ({ file_path, page_range, force_ocr }) => {
      try {
        const result = await convertFileDirect(options.baseUrl, file_path, {
          page_range,
          force_ocr,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: true, ...result }) }],
        };
      } catch (error) {
        const errorMessage =
          error instanceof ParseOtterError
            ? `${error.code}: ${error.message}`
            : `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: errorMessage }) }],
          isError: true,
        };
      }
    },
  );

  return server;
}
```

> 与现有 `src/server.ts:64-79` 一致：使用 4 参数 `tool(name, description, schema, callback)` 形式。
> 错误处理与现有 `src/server.ts:112-115` 完全一致：`error instanceof Error ? error.message : String(error)`。

#### 验证检查点

```bash
cd mcp-server && npx tsc --noEmit
node -e "import('./build/direct/server.js').then(m => console.log('OK:', typeof m.createDirectMcpServer))"
```

---

### Phase B3: `src/direct/index.ts` + `package.json`

**前置依赖**：Phase B2

#### `src/direct/index.ts`（新建，~70 行）

```typescript
#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDirectMcpServer } from "./server.js";

function log(...args: unknown[]) {
  process.stderr.write(args.map(String).join(" ") + "\n");
}

async function main() {
  const baseUrl = process.env.PARSEOTTER_MODAL_DIRECT_URL ?? "http://localhost:8000";

  if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
    log("Error: PARSEOTTER_MODAL_DIRECT_URL must start with http:// or https://");
    process.exit(1);
  }

  log(`Starting ParseOtter MCP Direct Server (gateway: ${baseUrl})`);
  const server = createDirectMcpServer({ baseUrl });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const cleanup = async () => {
    try { await server.close(); } finally { process.exit(0); }
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((error) => {
  log("Fatal error:", String(error));
  process.exit(1);
});
```

#### `package.json` 修改

文件 `mcp-server/package.json` 已有 `engines: { "node": ">=18.0.0" }` 和 `bin: { "parseotter-mcp": "build/index.js" }`。修改：

```json
{
  "engines": {
    "node": ">=18.13.0"
  },
  "bin": {
    "parseotter-mcp": "build/index.js",
    "parseotter-mcp-direct": "build/direct/index.js"
  }
}
```

> - `engines` 字段已存在于 `package.json:L40-L42`，此处为修改（版本从 `>=18.0.0` 提升至 `>=18.13.0`），原因：Phase B4 使用 `AbortSignal.timeout()`，该 API 在 Node 18.3+ 中可用。若应用层不使用 B4 可选功能，仍可回退到 `>=18.0.0`。
> - `bin` 字段已包含 `"parseotter-mcp"`，此处在其后追加 `"parseotter-mcp-direct"` 条目。**不要替换整个 bin 对象** — 仅新增条目。

#### 验证检查点

```bash
cd mcp-server && npx tsc --noEmit
ls -la build/direct/index.js
# package.json 是 ESM ("type": "module")，使用 node -e import 或 python
python3 -c "import json; p=json.load(open('package.json')); print(p['bin']['parseotter-mcp-direct'])"
PARSEOTTER_MODAL_DIRECT_URL=http://localhost:8000 timeout 5 node build/direct/index.js || true
```

---

### Phase B4 (可选): 错误重试与超时

**前置依赖**：Phase B1

**修改**：`mcp-server/src/direct/client.ts`（+~35 行）

```typescript
export async function convertFileDirectWithRetry(
  baseUrl: string,
  filePath: string,
  options?: ConversionOptions & { timeoutMs?: number; maxRetries?: number; signal?: AbortSignal },
): Promise<DirectConvertResult> {
  const timeoutMs = options?.timeoutMs ?? 900_000;
  const maxRetries = options?.maxRetries ?? 2;
  // 析构出内部参数，避免泄漏到内层 convertFileDirect
  const { timeoutMs: _t, maxRetries: _r, ...rest } = options ?? {};
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // 使用 AbortSignal.any() 合并调用者 signal 和超时 signal
      // Node 19+ 支持 AbortSignal.any；若仅支持 Node 18，回退到仅 timeout
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combined = typeof AbortSignal.any === "function" && rest.signal
        ? AbortSignal.any([rest.signal, timeoutSignal])
        : timeoutSignal;

      const result = await convertFileDirect(baseUrl, filePath, { ...rest, signal: combined });
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries && isRetryableError(error)) {
        const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 200, 10000);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError!;
}
```

> 使用 `AbortSignal.timeout()`（Node 18+ 原生）替代手动的 `AbortController` + `setTimeout`。此 API 在 Node 18.3+ 中可用。
> `AbortSignal.any()`（Node 19+）用于合并外部 AbortSignal 和超时信号。在仅限 Node 18 的环境中回退到仅使用 timeoutSignal。
> 超时默认值 900s 与 Modal 服务端 `timeout=900` 对齐。

---

### Phase B: 错误场景清单

| 类别 | 场景 | 表现 | 处理 |
|------|------|------|------|
| 文件 | 路径不存在 | stat ENOENT | `ParseOtterError("Not found", "FILE_NOT_FOUND")` |
| 文件 | 无读取权限 | stat EACCES | `ParseOtterError("Permission denied", "PERMISSION_DENIED")` |
| 文件 | 空文件 | stat.size === 0 | `ParseOtterError("File is empty", "VALIDATION_ERROR")` |
| 文件 | 文件超限 | stat.size > 150MB | `ParseOtterError("File too large", "VALIDATION_ERROR")` |
| 文件 | 类型不支持 | extname !== .pdf/.epub | `ParseOtterError("Unsupported file type", "VALIDATION_ERROR")` |
| 网络 | 网关不可达 | fetch TypeError("fetch") | `ParseOtterError("Connect failed", "NETWORK_ERROR")` |
| 网络 | 请求超时 | AbortSignal.timeout → AbortError | `ParseOtterError("Aborted", "TIMEOUT_ERROR")` |
| 网关 | 413 文件过大 | response.status === 413 | `ParseOtterError("File too large", "VALIDATION_ERROR")` |
| 网关 | 422 参数错误 | response.status === 422 | `ParseOtterError("Invalid request", "VALIDATION_ERROR")` |
| 网关 | 5xx 服务端错误 | response.status === 500/503 | `ParseOtterError("Gateway error", "SERVER_ERROR")` |
| 环境 | URL 格式错误 | 无 protocol 前缀 | 启动时校验 → process.exit(1) |

---

## 验证流程总览

### 编译/静态检查

```bash
# Modal 端
python -c "import ast; ast.parse(open('modal-converter/api_gateway/direct_handler.py').read())"
python -c "
import ast
tree = ast.parse(open('modal-converter/modal_app.py').read())
for node in ast.walk(tree):
    if isinstance(node, ast.FunctionDef) and node.name == 'gateway_app':
        decorator_ids = [d for d in node.decorator_list if isinstance(d, ast.Call) and hasattr(d.func, 'attr')]
        has_asgi = any(d.func.attr == 'asgi_app' for d in decorator_ids)
        assert has_asgi, '@modal.asgi_app() must be preserved on gateway_app'
        print('gateway_app decorators OK (asgi_app preserved)')
"
ruff check modal-converter/api_gateway/direct_handler.py

# MCP 端
cd mcp-server && npx tsc --noEmit
```

### 单元测试

```bash
python -m pytest modal-converter/api_gateway/tests/test_direct_handler.py -v --tb=short
```

### MCP Inspector 调试

```bash
cd mcp-server
PARSEOTTER_MODAL_DIRECT_URL=http://localhost:8000 npx @modelcontextprotocol/inspector node build/direct/index.js
```

浏览器打开 `http://localhost:5173` → Connect → Tools → `convert_document_direct`

### 端到端 Smoke Test

```bash
# 先验证 direct_handler.py 不因模块级检查阻塞
python -c "import ast; ast.parse(open('modal-converter/api_gateway/direct_handler.py').read()); print('syntax OK')"

# 部署（确保 deploy 环境中不设置 DIRECT_ENABLED — 由 handler 运行时检查保护）
DIRECT_ENABLED=0 modal deploy modal-converter/modal_app.py
export GATEWAY_URL="https://parseotter-converter-dev--gateway-app.modal.run"

# 验证 direct 端点返回 503（DIRECT_ENABLED 未设置）
curl -s -w "\nHTTP %{http_code}\n" "${GATEWAY_URL}/api/direct/convert" -X POST \
  -F "file=@test.pdf" -F "page_range=1-3"

# 设置 DIRECT_ENABLED 后重试
curl -s -w "\nHTTP %{http_code}\n" "${GATEWAY_URL}/api/direct/convert" \
  -H "X-Direct-Enable: 1" -X POST \
  -F "file=@test.pdf" -F "page_range=1-3"
# 注意：实际测试时需在 Modal 环境变量中设置 DIRECT_ENABLED=1

# GET status（使用前一步返回的实际 job_id）
export JOB_ID="direct_abc123..."
curl "${GATEWAY_URL}/api/direct/jobs/${JOB_ID}"

# GET result
curl "${GATEWAY_URL}/api/direct/jobs/${JOB_ID}/result"

# 验证两条 bin
timeout 5 node mcp-server/build/index.js || true
PARSEOTTER_MODAL_DIRECT_URL="${GATEWAY_URL}" timeout 5 node mcp-server/build/direct/index.js || true
```

---

## 安全注意事项

### 🔴 部署警告

`/api/direct/convert` 端点无认证。部署到 Modal 公网后 URL 可预测：
`https://{app-name}--gateway-app.modal.run/api/direct/convert`

**风险**：任何人知道 URL 即可消耗 GPU 资源进行转换。

**Mitigation**（必须至少选一项）：
1. ✅ **`DIRECT_ENABLED` 环境变量检查**（在 handler 运行时而非模块级检查）— 未设置 `DIRECT_ENABLED=1` 时所有 direct 端点返回 HTTP 503。本地开发设置 `DIRECT_ENABLED=1`
2. 部署后在 Modal Dashboard 中限制网关的 `secrets` 范围
3. 仅在 Modal 私有网络（`modal.Secret`）或 localhost 上暴露

---

## 不涉及的改动

- `api-worker/` — 完全不动
- 现有 `mcp-server/src/{client,server,config,types,index}.ts` — 完全不动
- Modal dispatch / R2 / callback 流程 — 完全不动
- 数据库 migration — 完全不动
- `tsconfig.json` — 无需修改（已有 `include: ["src/**/*"]`）
- `shared/error_codes.py` — A 组不使用该文件（错误以 HTTPException 返回）；B 组使用独立 string literal code，不依赖该枚举
