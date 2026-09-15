# Gitee 发行准备复核 — 2026-09-15

## 结论

已按维护者要求改为 Gitee 发行附件路线，不需要 npm 发布账号或 GitHub 镜像。源码地址已更新为 https://gitee.com/feng315/tomorrow 。安装包仅在本地准备，未创建发行标签或公开上传附件；publicationReady 仍为 false。

候选：`memosbox-dsh-plugin-0.2.0-beta.4.tgz`。

SHA-256：`b1ae143719ad44232c0a8390939a4a63ee2e4afb3e624dd0e1d8ed2b7f14acf7`。

候选在项目 artifacts/0.2.0-beta.4/gitee-preparation 的对应哈希目录内，旧候选保留。与此前 587f9f27… 候选相比，292 个文件没有增删，仅 package.json、README.md、README.en.md、SECURITY.md 改变。编译代码、Python worker、vendor 和运行时锁未改变。该对比不是新候选真人对话验收。

## 本轮已验证

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| typecheck、测试、构建、打包 | 通过 | 154 项测试 / 25 个文件；292 个打包文件 |
| 干净消费者 | 通过 | 逐文件一致；Node 生产依赖公开审计 0 条已知漏洞 |
| Python 依赖公告与版本 | 重试后通过所查范围 | 8 个包均与当前 PyPI 最新版本相同；17 次查询成功，OSV/PyPI 未列出所查版本漏洞，安装版本与 wheel 元数据符合锁定值 |
| 原生 DSH | 通过 | CLI 安装/移除、Loader、真实工具执行、独立进程读回、8 个拒绝/取消场景；批准者与模型是测试替身，不是真人 Web 或远程模型验收 |
| 升级回退 | 通过 | 13 项检查；单条合成记忆及 Wiki 页面，从 0.1.0-beta.2 升级后恢复离线快照；正式 profile 未改变 |
| 许可清单 | 清点完成，适用许可审核未通过 | 8 个 wheel 哈希匹配，92 个声明文件；上游 3 份原始文件已获取并保留哈希 |

Python 首次查询有 16 次失败，保留在私有 reports 中；重试没有覆盖失败报告。干净公告结果不代表 Python 解释器、所有嵌入二进制或 DSH 数据保留已完成安全审查。

## 许可核查结果与后续

1. [MemOS 2.0.19 模块清单](https://github.com/MemTensor/MemOS/blob/memos-local-plugin-v2.0.19/apps/memos-local-plugin/package.json) 声明 MIT，[相同标签的根许可证](https://github.com/MemTensor/MemOS/blob/memos-local-plugin-v2.0.19/LICENSE) 为 Apache-2.0。当前没有取得对所选模块适用条款的明确上游答复；不把声明差异擅自解释为已获全部授权。可向上游询问，或交由具备相应能力的许可审核人判断；本报告不代替法律意见。
2. [Mirobody 1.4.2 第三方声明](https://github.com/thetahealth/mirobody/blob/1.4.2/LICENSE-3RD-PARTY) 与本地 wheel 内同名文件哈希相同。wheel 中有代码许可证和 [LOINC bundle NOTICE](https://github.com/thetahealth/mirobody/blob/1.4.2/mirobody/res/fhir_loinc_bundle.NOTICE)，后者明确源版本为 2.82。当前插件 tarball 不携带 wheel；用户显式准备步骤安装锁定 wheel，并保留其 dist-info 与资源声明。
3. 检查 wheel 文件名未发现 fhir_snomed_ct_bundle.tar.gz、fhir_concept_graph.bin、fhir_meta.csv.gz 或 fhir_id_map.npy；存在 EXTERNAL.tsv、SNOMED NOTICE 和概念图代码。此清单不能证明没有任何衍生术语内容，也不能将默认 LOINC 功能理解为所有术语许可通行证。当前不应额外下载或打包未核查的外部资源。
4. [LOINC 官方条款](https://loinc.org/kb/license) 应按实际资源及分发方式核对版本、归属声明和使用限制。用户另行下载不自动免除其使用条件。未发送外部 Issue、邮件或取得新的权利人批准。

## 待办

- 完成 MemOS 适用许可澄清，以及所选术语资源的最终条件审核。
- 完成外部 CPython、原生组件及 DSH 历史/日志/传输/保留的剩余安全检查，不处理真实健康数据。
- 对准确的新候选补齐真实模型对话、自动 capture 和真人 UI 验收。历史证据完整保留在 history/approval-beta4-before-gitee-preparation-2026-09-15.json 引用的文件中，不改哈希冒充重测。
- 最终审批、发行标签、远程验证记录、Gitee 附件上传与下载后安装核验尚未完成。不得声称远程 CI 已通过。

## 上游询问草稿（尚未发送）

拟发送给 MemOS 维护者：我们在独立 DSH 插件中使用 @memtensor/memos-local-plugin 2.0.19 的部分未修改 core/adapter 模块，保留源码哈希、构建来源和版权声明，计划通过 Gitee 发行 tarball。该版本 package.json 标注 MIT，但仓库根 LICENSE 为 Apache-2.0，模块目录/安装包没有独立 LICENSE。请确认这些模块的适用许可，以及应保留的版权/NOTICE 和分发条件。我们不请求商标授权，也不把插件称为官方产品。

回复应保存为可引用的原始链接或邮件记录，经维护者审核后再填写许可证证据；单纯发出询问不代表获批。
