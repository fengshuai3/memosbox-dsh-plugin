# GitHub 社区发现与安装包发行

## 两种不同的状态

- 公开源码仓库添加 `dsh-plugin` Topic，是 DeepSeek Harness 官方 README 推荐的社区发现方式，不是官方审核或生产认证。
- 可安装的预构建 `.tgz` 和 SHA-256 校验文件，通过 GitHub Release 发布；本项目不发布到 npm 注册表。
- DSH Hub 是第三方社区索引，不是 DeepSeek 官方产品。本流程不依赖向其提交或授权。

源码仓库：https://github.com/fengshuai3/memosbox-dsh-plugin

官方说明：https://github.com/deepseek-ai/deepseek-harness#community-and-support

## 当前限制

当前仍是开发预览。`release/approval.json` 未批准正式发行；公开仓库和 Topic 不代表已有可安装的 Release 附件。

Git 源码未包含 `dist`，也未验收直接 Git URL 安装。使用 README 中的源码构建方式进行开发测试；不要把源码 ZIP 当作已构建插件包。只有发布检查通过后，才能将下述流程产生的附件作为发行包提供。

## 受检查约束的发行流程

1. 使用受支持的 Node 和 pnpm 版本运行 `pnpm run verify`、`pnpm run verify:consumer`、生产依赖审计及原生 DSH 验收。
2. 冻结候选安装包。绑定准确 SHA-256，补齐许可、安全、真实对话、自动记忆、真人 Web 审批、迁移回退证据；记录真实审核者。旧包通过记录不能自动用于新包。
3. 在验收通过后更新审批记录并提交。创建与包版本一致、指向已审查提交的 `v<version>` 标签。标签不能用于提前声称发行已通过。
4. 在 GitHub 中配置 `release` environment 的审核规则；从该标签运行 `guarded-release`，先保持 `publish=false` 检查候选。若远程构建哈希与已批准候选不一致，必须重新核对，不能自动改写批准哈希。
5. 所有检查和审核通过后，才使用 `publish=true`。流水线复核下载附件的哈希与发布证据，然后创建 GitHub **prerelease**，上传精确候选和 `SHA256SUMS`。不会执行 `npm publish`，也不会标成 latest 稳定版。
6. 从 Release 下载附件，核对 SHA-256，然后通过 `dsh plugin --profile <独立测试profile> add -w <安装包绝对路径>` 验证安装、挂载与卸载。

验证流水线中的 `npm pack`、干净消费者安装及 npm advisory 查询，是包验证步骤，不是向 npm 注册表发布。

未完成生产及健康数据隐私验收前，只允许合成测试数据。不要在发布说明中宣称支持真实患者资料或所有平台的 Mirobody 运行环境。
