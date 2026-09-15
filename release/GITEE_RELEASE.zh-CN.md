# Gitee 下载包发行清单

仓库：https://gitee.com/feng315/tomorrow

状态：准备中，尚未创建安装包发行版。使用 Gitee 账号和当前仓库权限，不需要 npm 登录或 GitHub 仓库。`.tgz` 是 DSH 可安装的本地包格式；使用 npm 工具构建或下载依赖，不等于发布到 npm 注册表。

## 交付物

- 已构建并通过准确候选验证的 `memosbox-dsh-plugin-<版本>.tgz`。
- 对应的 `SHA256SUMS`，以及脱敏的版本、支持环境、依赖、权限、安装及回退说明。
- 不附带个人 Key、`.credentials`、数据库、会话记录、原始报告、运行环境或 wheel 缓存。
- Gitee 自动源码归档不含 `dist`，不能替代安装包。Python 解释器不自包含，Mirobody 运行时需要使用者另行准备。普通 Node 依赖仍可能需要联网下载。

## 按顺序执行

1. 更新实际源码地址，运行 `corepack pnpm run verify` 和公开源码检查。
2. 运行 `node scripts/verify-consumer.mjs --output-dir artifacts/<版本>/gitee-preparation`，保留哈希目录中的候选和消费者证据；此前候选不覆盖。
3. 针对该候选完成许可、安全、真实对话、跨会话自动记忆、真人 Web 审批及升级回退核验。历史候选证据不能只修改哈希后当作新测试。
4. 由真实负责人核对并审批，提交干净源码和准确的版本标签，然后执行 `node scripts/release-check.mjs --artifact <候选绝对路径>`。任何缺项退出非零时不上传安装包。
5. 推送版本标签，在 Gitee Releases 创建对应发行版，只上传同一候选及校验文件。不把发布说明写成已通过生产、真实患者资料或所有平台验证。
6. 从公开发行版重新下载附件，使用 `shasum -a 256 <下载的tgz>` 与批准的校验值比对。
7. 在独立 DSH profile 执行 `dsh plugin --profile memosbox-dev add -w <tgz绝对路径>`，验证加载、实际对话、卸载保留数据及回退。记录真实结果、发行 URL 和附件 SHA-256。

## 审批和远程验证

本地 Git push 权限不自动证明 Web 发行页面已登录或可上传附件。远程 CI 与人工执行需明确区分；没有实际 CI 运行链接不得声称流水线通过。当前 `.github/workflows` 不在 Gitee 运行。

真人验收记录应包含测试日期、候选版本及哈希、测试 profile/端口、逐项批准/拒绝/取消与重启读回结果以及审核人。截图不得出现鉴权 URL、API Key 或真实健康信息。维护者的一般继续授权不代替这些测试事实。
