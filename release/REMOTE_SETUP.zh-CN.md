# Git 仓库配置后的远程验收

维护者已选择 Gitee 附件下载方式，不发布 npm 包。当前操作以 [Gitee 下载包发行](GITEE_RELEASE.zh-CN.md) 为准；下述 GitHub/npm 配置是保留的可选方案，不是本次发行前置条件。

这是尚待仓库所有者执行/授权的配置，不是远程已验收的证明。

当前源码主仓库为 Gitee：本页以下 GitHub Actions、环境保护及 npm GitHub Trusted Publisher 步骤仅适用于未来 GitHub 镜像，不会因推送 Gitee 自动生效。Gitee 流水线尚未配置；不能把仓库上传或本地验证算作远程运行成功。

1. 填写真实维护者、源码仓库、issue 地址及 SECURITY.md 安全联系方式。任何 package.json 或被打包文件的变化都会产生新候选，需要重新绑定证据，不能沿用旧包哈希。
2. 仅选择经过检查的源码提交。严禁把 reports、artifacts、.runtime、.test-runtime、数据库或凭据加入 Git。先运行 `pnpm release:source-check`，再人工审阅暂存区。
3. 在 GitHub 保护默认分支与版本标签；要求当前 CI 矩阵和安全作业通过。为 `release` 环境指定有权限的审核人、禁止自审（若账号方案支持）、限制部署标签；不要允许未经审查的工作流绕过保护。实际功能取决于仓库可见性与 GitHub 账号方案，需在仓库页面验证。
4. 先手动运行 guarded-release，保持 publish=false。检查 Node/平台矩阵、构建、依赖审计、源码扫描、候选归档与门禁结果。测试通过但 release gate BLOCKED 是未批准，不是可发布。
5. 修复本轮真实对话缺陷，补齐许可和验收证据；由真实负责人审核候选和 release/approval.json，再提交准确发行标签。不要由机器人伪填审批人或 UI 实测结果。
6. 按 [npm trusted publishing 官方说明](https://docs.npmjs.com/trusted-publishers/)配置 GitHub owner/repository、准确工作流文件名 `release.yml` 和环境名 `release`。需要 npm >=11.5.1、Node >=22.14、受支持的 GitHub 托管 runner。当前文档说明新配置默认允许 stage publish，直接 npm publish 的 allowed action 需要另行启用；此工作流采用直接发布，因此必须核对该权限。没有包所有权/首发身份时先解决账号流程，不在源码中塞长期 token。
7. 在准确版本标签上显式选择 publish=true，由环境审核人批准。发布后的 npm 版本、tarball integrity、provenance 和干净 DSH 消费者安装必须逐一核验，并保留运行链接。

可先配置仓库并运行验证，但许可、真实对话及最终审批未通过前不要选择 publish=true。本项目当前只准备 macOS arm64 + 外部 CPython 3.12 的受限测试版，不是医疗上线资格。
