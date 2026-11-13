# 上游与改动说明

本仓库是 [tigerowo/infinite-canvas](https://github.com/tigerowo/infinite-canvas)（无限画布，AGPL-3.0）的衍生版本，保留上游 LICENSE 与作者信息。

## 与上游的差异

### 1. ComfyUI 多服务端直连

- 系统设置 → 私有配置新增「ComfyUI 服务地址」：默认地址、API Key、额外服务端列表。
- 未绑定 Bridge 的 ComfyUI 渠道由后端直接执行：上传参考素材 → 套用字段映射 → 提交 `/prompt` → 轮询 `/history` → 回写 `/view` 产物地址。
- 工作流可用 `comfyServerId` 绑定具体服务端；服务端被删除后自动回落到默认地址。
- 新增 `POST /api/v1/comfy-workflows/inspect`，没有 Bridge 也能解析 API JSON 并推断字段。

主要文件：`service/comfy_direct.go`、`service/settings.go`、`service/workflow_task.go`、`service/workflow_resolve.go`、`model/setting.go`、`handler/comfy_workflow.go`、`web/src/components/workflow/workflow-channel-pane.tsx`、`web/src/app/(admin)/admin/settings/page.tsx`。

### 2. Windows 便携版

- `packaging/windows-launcher/`：`InfiniteCanvas.exe` 启动器，拉起后端与前端并打开浏览器。
- `packaging/windows/`：环境变量模板、使用说明、构建步骤（`BUILD.md`）与发布工作流模板。
- 发布产物见 Releases：`InfiniteCanvas-Windows-x64-*.zip`（内置 Node.js 运行时与三个平台的 ComfyUI Bridge）。

### 3. 说明

- 上游的 `setup.exe` / `.msi` 由仓库之外的 Tauri 桌面壳构建，本仓库不包含该壳，因此提供的是免安装便携包。
- `.github/workflows/` 里是上游的 CI / 镜像 / Canvas Agent 工作流，另有本仓库新增的 `windows-release.yml`：推 `v*` 标签自动构建并发布 Windows 便携包。
