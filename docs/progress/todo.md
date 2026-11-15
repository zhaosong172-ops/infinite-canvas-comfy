---
title: TODO
description: 当前项目后续值得处理的事项
---

Verify RunningHub catalog candidates can return API JSON with the user's own key, then assess node, model, and media compatibility with Nebula Cloud ComfyUI. Catalog discovery alone does not make a workflow cross-platform executable.

# TODO

- 使用真实 DeepSeek、GRSAI 国际版、AA 与火山账号验证模型列表、聊天与适用生成入口；GRSAI 三款视频模型已完成调用适配，仍需真实账号验证；专用音频异步协议待适配。
- 实测仙宫云及其他主流云平台的 SSH 主机、端口、密码/私钥认证与 ComfyUI 远端端口；核对云平台防火墙、转发权限及重建实例后的主机指纹处理。
- 扩展 CC Switch 的 Responses、Anthropic、Gemini、Codex TOML 与数据库备份导入；目前只支持 OpenAI Chat 兼容的分享链接/JSON。
- Windows 个人版在真实使用中验证重启持久化、多工作流、云任务恢复与长期运行；后续按需增加多 Bridge 同时运行。
- 在画布模型选择器中实际选用工作流并验证节点结果显示；后端工作流任务接口到本机 Bridge、云端 `/prompt`、`/history` 和结果 URL 获取已用 Anima 完成真实调用。继续对 MOSS、千问 2.1、H3 分别执行最小真实任务，核实显存、媒体预览和结果质量。
- 修复原项目现有 TypeScript 类型检查错误，恢复完整类型检查后再考虑正式发布及 Windows 签名。
