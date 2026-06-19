# Direct Modal MCP Server — 实现方案

## 目标

实现一个**本地 MCP 服务器**，直接接入 Modal 后端进行 PDF/EPUB → Markdown 转换。
绕过 Cloudflare Worker / R2 / API key 认证 / 用量跟踪，适用于本地开发调试。

## 架构

```
MCP Server (本地 stdio)
  └─ POST /api/direct/convert (multipart) ──→ Modal Gateway (FastAPI)
       ├─ storage.write_job_files()          写入作业目录
       ├─ status_writer.create_initial_status()  创建状态
       ├─ orchestrator.process_job_background()  同步执行转换
       │    └─ _invoke_parsing() ──→ modal.Cls.from_name().run_marker_inference.remote()
       │         (fallback 路径, parser_handle=None)
       └─ 返回 { markdown, images, metadata }
```

## 改动清单

### A. Modal 网关端 (Python)

#### A1. 新建 `modal-converter/api_gateway/direct_handler.py`

无认证 router，包含以下端点：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/direct/convert` | multipart 上传文件，同步转换，返回 markdown + images + metadata |
| GET  | `/api/direct/jobs/{job_id}` | 轮询转换状态 |
| GET  | `/api/direct/jobs/{job_id}/result` | 获取转换结果 |

**POST `/api/direct/convert` 逻辑：**

1. 接收 multipart 表单：`file` (必填)、`page_range` (可选，格式如 `"1,3-5,7"`)、`force_ocr` (可选 bool)
2. 生成 job_id (`direct_{uuid4().hex}`)
3. 构建 options dict：
   ```python
   options = {
       "page_range": page_range or "",       # 空 = 所有页面
       "force_ocr": bool(force_ocr) if force_ocr is not None else False,
   }
   ```
4. 调用 `storage.write_job_files(cfg.marker_job_dir, job_id, file.file, file_name=..., options=options)` 将文件写入 `{MARKER_JOB_DIR}/{job_id}/`
5. 调用 `status_writer.create_initial_status(cfg.marker_job_dir, job_id, file_name, file_size, options=options)` 创建初始状态
6. 构建 `JobContext`：
   - `parser_handle` = None（回退到 `modal.Cls.from_name()` 自动解析）
   - `reload_cache` = `request.app.state.job_ctx.reload_cache`
   - `commit_cache` = `request.app.state.job_ctx.commit_cache`
7. 调用 `orchestrator.process_job_background(job_id, options=options, ctx=ctx)` 同步执行
   - 内部 `_invoke_parsing()` 因 `parser_handle=None` 而回退到 `modal.Cls.from_name("parseotter-converter-dev", "MarkerConversionService").run_marker_inference.remote(job_id, options)` — 在远程 GPU 容器上执行转换
8. 读取结果文件：
   - `job_dir / "raw.md"` → markdown 内容（FIXED: 使用 `marker_inference.MARKDOWN_FILENAME`）
   - `job_dir / "metadata.json"` → 元数据（如 page_count, timings）（FIXED: 之前误写为 status.json）
   - `job_dir / "images/"` → 图片列表
9. 返回 JSON：
   ```python
   {
       "job_id": str,
       "markdown": str,
       "images": [{"name": str, "data": str (base64)}] | null,
       "metadata": {
           "page_count": int,
           "processing_time_ms": int,    # metadata.json → timings.total_seconds * 1000
           "gpu_type": str,
           "renderer_version": str,
       }
   }
   ```

**要点：**
- 不对该 router 施加 `_enforce_api_secret` — 局域无认证端点
- 每个请求生成独立 job_id，互不干扰
- parser_handle 为 None 时 orchestrator 会自动 Fallback 到 `modal.Cls.from_name()`，适用于本地部署环境
- processor 内部的 `_reload_cache_if_available(ctx)` 会在远程解析完成后正确刷新共享卷

#### A2. 修改 `modal-converter/modal_app.py`

```python
from api_gateway import direct_handler

# 注册 direct router
app.include_router(direct_handler.router, prefix="/api")
```

需要给 `gateway_app` 所在 `@app.function` 增加 `timeout=900`，因为同步转换可能耗时较长（大文件最多 15 分钟）。

### B. MCP Server 端 (TypeScript)

在现有 `mcp-server/` 下新增 `src/direct/` 目录，互不干扰。

#### B1. 新建 `mcp-server/src/direct/client.ts`

简化版 HTTP 客户端：
- 使用原生 `FormData` + `Blob`（兼容 Node 18+，不使用 `File` 构造函数）
- 无 API key 认证
- 调用 `POST {baseUrl}/api/direct/convert`（同步端点）
- 返回 JSON 结果

```typescript
// 核心模式（无需外部依赖）
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const buffer = await readFile(filePath);
const blob = new Blob([buffer], { type: "application/pdf" });
const formData = new FormData();
formData.append("file", blob, filename);
formData.append("page_range", "1-5");
formData.append("force_ocr", "true");

const response = await fetch(`${url}/api/direct/convert`, {
  method: "POST",
  body: formData,
});
```

#### B2. 新建 `mcp-server/src/direct/server.ts`

注册 MCP 工具（单一工具）：
- `convert_document` — 接收 `file_path`（必填）、`page_range`（可选）、`force_ocr`（可选）
- 调用 `client.ts` 的转换函数
- 返回 markdown + images + metadata

#### B3. 新建 `mcp-server/src/direct/index.ts`

入口文件：
- `#!/usr/bin/env node`
- 环境变量 `PARSEOTTER_MODAL_DIRECT_URL` 配置 Modal 网关地址（默认 `http://localhost:8000`）
- 不需要 `PARSEOTTER_API_KEY`
- 创建 `StdioServerTransport` 连接
- 无需修改 `tsconfig.json`（已有 `include: ["src/**/*"]`）

#### B4. 更新 `mcp-server/package.json`

```json
"bin": {
  "parseotter-mcp": "build/index.js",
  "parseotter-mcp-direct": "build/direct/index.js"
}
```

## 不涉及的改动

- `api-worker/` — 完全不动
- 现有 `mcp-server/src/{client,server,config,types,index}.ts` — 完全不动
- Modal dispatch / R2 / callback 流程 — 完全不动
- 数据库 migration — 完全不动

## 环境变量

### MCP Server

| 变量 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `PARSEOTTER_MODAL_DIRECT_URL` | 否 | `http://localhost:8000` | Modal 网关地址 |

### Modal 网关端

无需新增环境变量（复用现有 `MARKER_JOB_DIR` 等）

## Review 修正记录

| # | 问题 | 修正 |
|---|------|------|
| 1 | parser_handle 在 gateway 的 JobContext 中为 None，无法从 `request.app.state.job_ctx.parser_handle` 获取 | 修正：parser_handle 设置为 None，让 `_invoke_parsing` 回退到 `modal.Cls.from_name()` — 这在 Modal 环境中可以工作，且网关无 GPU 依赖 |
| 2 | metadata 来源误用 `status.json` | 修正：实际元数据在 `metadata.json`（page_count, timings） |
| 3 | page_range 格式未说明 | 修正：格式为 `"1,3-5,7"`，与 `marker_inference._PAGE_RANGE_RE` 一致 |
| 4 | Node 18 兼容性 | 使用 `Blob` 而非 `File` 构造函数，确保 Node 18 兼容 |
