# 上游 GitHub Actions 工作流（需手动启用）

上游仓库把 CI / 镜像构建 / Canvas Agent 的工作流放在 `.github/workflows/` 下。本仓库初始化时使用的令牌**没有 `workflow` scope**，GitHub 会拒绝对该目录的写入（返回 404），所以这些文件先放在这里。

启用方式（任选其一）：

1. 网页操作：在 GitHub 仓库里把文件移动到 `.github/workflows/` 下，提交即可。
2. 本地操作：`git mv packaging/github-workflows/*.yml .github/workflows/` 后提交推送。
3. 换一个带 `workflow` scope 的令牌，用 API 写入。

| 文件 | 作用 |
| --- | --- |
| `ci.yml` | Go 测试 + 前端构建 |
| `docker-image.yml` | 构建并推送 Docker 镜像 |
| `canvas-agent.yml` | Canvas Agent 构建 |
| `windows-release.yml` | 推送 `v*` 标签时构建 Windows 便携包并发布 Release |

`windows-release.yml` 依赖本仓库的 `packaging/windows/`（启动器、env 模板、说明文件），发布产物与 `v0.8.4-comfy.1` 一致。
