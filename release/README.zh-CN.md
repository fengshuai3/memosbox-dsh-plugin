# 发布门禁

当前源码更新为 0.2.0-beta.4 开发版。Gitee 源码更新不代表 npm/Git Release 发行、插件市场收录或生产上线。`approval.json` 是默认拒绝的制品发布审批记录，不是自动生成的上线证明。

2026-09-15 的 beta.2 历史范围见 [执行记录](EXECUTION_2026-09-15.zh-CN.md)，beta.3 的历史缺口保留于 evidence/*beta3*。本次 beta.4 修复同轮拒绝后的重试绕路、双目的地调用歧义、分阶段导入关联、检索和回答来源问题。最终准确归档 SHA-256 为 `587f9f27ab644b1b846943a183a35e17ffdabcb026476ab263b86e2168743a82`，154 项单元/集成测试、24 场真实模型对话的 121 项检查、原生审批负向用例及单一合成数据升级回退通过。脱敏证据见 evidence/*beta4* 与 migration-rollback-0.2.0-beta.4-20260915071540048.json；较早的 beta.4 候选结果不能替代该哈希的证据。

这些是有限合成场景的验证，模型仍可能有错别字和冗余措辞，不是未来所有输出正确的保证。许可审查暂停，完整安全审核与真人 UI 未签为通过；发布审批保持 publicationReady=false，正式 profile 未切换。

维护者于 2026-09-15 告知真人测试通过并要求更新、发布，已记录于 evidence/user-web-test-report-2026-09-15.json。由于未提供实际测试版本、归档标识或逐项 UI 证据，且本地最后启动的验收配置仍是 beta.2，本记录尚不能绑定为 beta.4 的 humanApproval；不否定其他环境可能已完成的测试。当前本机 npm 身份检查返回 ENEEDAUTH；远程发布工作流未验证运行。

当前主仓库使用 Gitee。.github/workflows 仅是 GitHub 工作流模板，不在 Gitee 自动执行；[远程设置](REMOTE_SETUP.zh-CN.md) 的 GitHub 环境保护与 npm Trusted Publishing 步骤仅适用于未来 GitHub 镜像。没有远程执行记录时不得声称流水线通过。

1. 维护者填写真实的 package.json author、repository、bugs 和 SECURITY.md 安全联系渠道；不得使用占位身份。
2. 明确 MemOS 元数据与仓库许可差异，分别核对 Mirobody 和 LOINC 再分发要求。保留相应版权声明。
3. 完成真实对话、自动记忆、人工审批、迁移回退及安全验收，将脱敏且人工审阅的证据放在 release/evidence/。不要复制 reports/ 原始记录。
4. 显式选择公开源码，执行 release:source-check；reports/、artifacts/、运行时、凭据和数据库均不应加入 Git。扫描器只是基线检查，仍需人工隐私审查。
5. 使用 verify:consumer 生成独立候选和 SHA-256。审批人核对准确版本、每份证据的 SHA-256 和候选 SHA-256 后填写 approval.json；将审核结果提交并创建 v<version> 标签。
6. 执行 `pnpm release:check --artifact <候选路径>`。只要一项缺失就退出非零。prepublishOnly 默认执行同一检查；本地目录发布需要 MEMOSBOX_RELEASE_ARTIFACT 指定准确候选。
7. 配置远程 CI、受保护的 release 环境、人工审批者及 npm 发布身份，运行手动发布工作流。当前未配置或执行远程发布。

本地生命周期脚本可以被 --ignore-scripts 或直接发布其他压缩包绕过，不是注册表级安全边界。实际发布只应使用受保护工作流产生并核验的同一归档，并限制可直接发布的账号。工作流文件本身不能替代仓库权限设置和 npm 首次发布/可信发布者设置。

支持范围仍是 macOS arm64 + CPython 3.12 的已锁定 Mirobody 子集。自动捕获默认关闭；OCR、真实健康数据、全通用工具环境、其他平台均不能因门禁通过而自动扩充为已支持范围。
