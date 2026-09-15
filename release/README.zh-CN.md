# 发布门禁

当前源码更新为 0.2.0-beta.4 开发版。维护者选择通过 https://gitee.com/feng315/tomorrow 的 Gitee Releases 附件发行已构建 `.tgz`，不发布 npm 注册表包，不要求 npm 账号或 GitHub 镜像。Gitee 源码更新不代表安装包发行、插件市场收录或生产上线。`approval.json` 是默认拒绝的制品发布审批记录，不是自动生成的上线证明。操作清单见 [Gitee 下载包发行](GITEE_RELEASE.zh-CN.md)。

2026-09-15 的 beta.2 历史范围见 [执行记录](EXECUTION_2026-09-15.zh-CN.md)，beta.3 的历史缺口保留于 evidence/*beta3*。本次 beta.4 修复同轮拒绝后的重试绕路、双目的地调用歧义、分阶段导入关联、检索和回答来源问题。最终准确归档 SHA-256 为 `587f9f27ab644b1b846943a183a35e17ffdabcb026476ab263b86e2168743a82`，154 项单元/集成测试、24 场真实模型对话的 121 项检查、原生审批负向用例及单一合成数据升级回退通过。脱敏证据见 evidence/*beta4* 与 migration-rollback-0.2.0-beta.4-20260915071540048.json；较早的 beta.4 候选结果不能替代该哈希的证据。

这些是历史准确候选的有限合成场景验证，模型仍可能有错别字和冗余措辞，不是未来所有输出正确的保证。维护者已同意恢复许可核查；完整安全审核与真人 UI 未签为通过，不能将恢复核查的授权当作 beta.4 真人验收确认。仓库元数据和打包文档更新后的新候选需要重新核验并绑定证据；发布审批保持 publicationReady=false，正式 profile 未切换。

维护者于 2026-09-15 告知真人测试通过并要求更新、发布，已记录于 evidence/user-web-test-report-2026-09-15.json。由于未提供实际测试版本、归档标识或逐项 UI 证据，且本地最后记录启动的验收配置仍是 beta.2，本记录尚不能绑定为 beta.4 的 humanApproval；不否定其他环境可能已完成的测试。npm 登录不再是所选发行渠道的要求；远程验证及 Gitee 安装包发行尚未完成。

当前主仓库使用 Gitee。.github/workflows 仅是 GitHub 工作流模板，不在 Gitee 自动执行；[远程设置](REMOTE_SETUP.zh-CN.md) 的 GitHub 环境保护与 npm Trusted Publishing 步骤仅适用于未来 GitHub 镜像。没有远程执行记录时不得声称流水线通过。

1. 维护者填写真实的 package.json author、repository、bugs 和 SECURITY.md 安全联系渠道；不得使用占位身份。
2. 明确 MemOS 元数据与仓库许可差异，分别核对 Mirobody 和 LOINC 再分发要求。保留相应版权声明。
3. 完成真实对话、自动记忆、人工审批、迁移回退及安全验收，将脱敏且人工审阅的证据放在 release/evidence/。不要复制 reports/ 原始记录。
4. 显式选择公开源码，执行 release:source-check；reports/、artifacts/、运行时、凭据和数据库均不应加入 Git。扫描器只是基线检查，仍需人工隐私审查。
5. 使用 verify:consumer 生成独立候选和 SHA-256。审批人核对准确版本、每份证据的 SHA-256 和候选 SHA-256 后填写 approval.json；将审核结果提交并创建 v<version> 标签。
6. 执行 `pnpm release:check --artifact <候选路径>`。只要一项缺失就退出非零。prepublishOnly 默认执行同一检查；本地目录发布需要 MEMOSBOX_RELEASE_ARTIFACT 指定准确候选。
7. 在隔离环境执行验证并保留结果，由真实负责人审核。检查通过后，将准确版本标签推送到 Gitee，创建发行版，上传同一 `.tgz` 和 `SHA256SUMS`；重新下载核对 SHA-256，并在干净 DSH profile 实际安装。没有远程 CI 运行记录不得声称流水线通过；如使用人工发行，应如实记录渠道和审核过程。

本地检查可以被直接上传其他压缩包绕过，不是 Gitee 服务端权限边界。实际发行只能上传被审核的同一归档，限制具有发行权限的账号，并人工核对标签、附件和校验值。禁止把源码 ZIP 当作插件安装包，禁止把本地 `.runtime`、wheel 缓存、凭据和数据库作为附件。现有 npm/GitHub 工作流仅保留为可选历史方案，不属于当前发行路径。

支持范围仍是 macOS arm64 + CPython 3.12 的已锁定 Mirobody 子集。自动捕获默认关闭；OCR、真实健康数据、全通用工具环境、其他平台均不能因门禁通过而自动扩充为已支持范围。
