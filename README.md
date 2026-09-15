# memOSbox — DSH 原生记忆与知识库插件

中文 | [English](README.en.md)

memOSbox 将 MemOS 记忆、Markdown Wiki 和 Mirobody 指标/文档处理组合为一个 DeepSeek Harness 原生 bundle，由 DSH 统一安装、加载、调用和卸载。不依赖旧版 HTTP 服务、MCP 服务或常驻 Python 守护进程；DSH 对话模型本身仍可使用远程 API。

**当前为 0.2.0-beta.3 开发源码，未发布 npm 版本，未完成生产验收，也不表示已被插件市场收录。仅使用合成测试数据，不处理真实患者资料。**

维护者：冯帅 · [714205152@qq.com](mailto:714205152@qq.com)

源码：[Gitee 仓库](https://gitee.com/guandalaifu/memosbox-dsh-plugin) · [问题反馈](https://gitee.com/guandalaifu/memosbox-dsh-plugin/issues)

## 能做什么

| 组件 | 当前功能 | 限制 |
| --- | --- | --- |
| MemOS 2.0.19 精选模块 | 工作区隔离、词法检索、批准导入、可选自动捕获与跨会话召回 | 不自动翻译，不下载 embedding；自动捕获默认关闭 |
| Markdown Wiki | 按项目搜索/读取、来源与版本管理、审批后写入 | 写入默认关闭；不能将文档视为实时状态证明 |
| Mirobody 1.4.2 | LOINC 词法映射、原始读数保留、合成文档提取及预览 | 单次 Python 子进程；不是诊断工具，OCR 未完成 |

文档导入依次执行：读取审批 → 模型外发审批（如使用）→ 生成并预览候选 → 独立 Wiki/MemOS 写入审批 → 实际读回。批准不等于已经写入，取消与拒绝分别报告。

## 运行要求

- 已准备 DeepSeek Harness **0.1.2-rc.1**；其他快速迭代版本未保证兼容。
- Node.js **^22.19.0 或 >=24.0.0**，pnpm **11.7.0**，可用的 Corepack。
- Mirobody 目前仅验证 **macOS arm64 + CPython 3.12**，Python 需由使用者另行准备；其他平台不能视为完整支持。
- DSH 的模型与凭据由 DSH 自身管理，不写入本仓库或插件配置。

## 从源码构建并安装

以下是开发测试安装，不是已公开发行的 npm 包安装。先克隆源码，在本仓库内保留生成文件：

```sh
git clone https://gitee.com/guandalaifu/memosbox-dsh-plugin.git
cd memosbox-dsh-plugin
corepack pnpm install --frozen-lockfile --registry=https://registry.npmjs.org
corepack pnpm run verify
node scripts/verify-consumer.mjs --output-dir artifacts/local-check
```

最后一条生成带哈希目录的安装包，核对干净消费者安装及生产依赖审计。将它输出的实际绝对路径替换到下面命令，安装到独立测试 profile：

```sh
dsh plugin --profile memosbox-dev add -w /absolute/path/to/memosbox-dsh-plugin-0.2.0-beta.3.tgz
dsh --profile memosbox-dev --dump-config
```

这是模板路径，不能原样执行。确保 DSH 能从 PATH 找到 pnpm 11.7.0。仅按提示批准已审查的 better-sqlite3 原生构建，不全局放行安装脚本。不要直接把本仓库 Git URL 当作已构建插件安装：源码不包含 dist，也不提供 Git 安装时自动 prepare。

在本仓库内集中准备 Mirobody 私有运行环境：

```sh
node scripts/provision-runtime.mjs --python /absolute/path/to/python3.12 \
  --runtime-root "$PWD/.runtime/mirobody" --download
```

将 Python 参数替换为实际解释器绝对路径，并将生成的运行根配置为 mirobodyRuntimePath；后续不要移动该虚拟环境。下载仅发生在显式准备步骤，工具调用不会自行安装依赖。完整配置见[运行指南](docs/RUNTIME_GUIDE.zh-CN.md)。

## 对话测试示例

配置运行环境与 DSH 模型后，在同一工作区测试：

- “请核对 Serum Creatinine 的本地标准编号，只查询，不保存。”
- “请原样整理 Glucose [Mass/volume] in Serum or Plasma，数值 <5.60 mg/dL，不换算。”
- 手动启用 captureEnabled 后，自然说出一个合成项目的偏好，结束会话，再开新会话询问该偏好；不能把预置数据读取当作自动记忆成功。

可用工具包括 memosbox_status、memos_search/get、wiki_status/search/get/summarize，以及 mirobody_status/resolve/normalize_readings/parse_document/preview_import/commit_import。仅在开关允许时提供 Wiki 写入。

## 权限、数据与已知问题

- 文档入口、模型提取、Wiki 写入、显式记忆导入、capture 和查询正文日志均默认关闭。
- 读取文件、向提取模型外发、Wiki 写入、MemOS 写入分别授权；不要用“合成数据”设置冒充脱敏。
- 没有业务写入不等于没有文件修改：DSH 会话历史、工具结果、日志和初始化文件仍可能持久化。
- 原始运行数据在配置的数据根内按 profile/workspace 隔离。卸载保留数据和运行缓存，不自动迁移旧库。
- 普通回答仍有冗长、保存范围措辞及不相关提示问题；真实人工 Web 审批、最终候选迁移回退和真实健康数据隐私尚未全部验收。
- 此次只公开源码；此前测试回执绑定各自安装包哈希，不能自动认证后续文档/元数据修改产生的新包。

## 文件管理与验证

源码提交排除 reports、artifacts、.runtime、.test-runtime、数据库、凭据、日志和本机历史配置。公开测试只使用合成数据，原始运行记录不随仓库上传。

```sh
corepack pnpm run verify
corepack pnpm run release:source-check
```

.github/workflows 是为 GitHub 准备的流水线模板，上传 Gitee 不会自动运行 GitHub Actions，也不代表已配置 Gitee 流水线。发布审批仍为 publicationReady=false；不通过篡改审批或跳过检查声称可上线。

## 许可与贡献

本项目自有代码声明 Apache-2.0；第三方内容保留原版权及声明。MemOS 上游 npm 元数据与仓库许可的适用范围仍待澄清，相关核对已暂停，不宣称整体再分发授权已确认。Mirobody、LOINC 及其他依赖各自的条件不能由本项目许可证覆盖。详见 [NOTICE](NOTICE)、[SECURITY](SECURITY.md) 和[发布说明](release/README.zh-CN.md)。

欢迎通过 Gitee 提交不含敏感数据的 Issue 或 Pull Request。安全问题请私发维护者邮箱，不要公开密钥、患者资料或可直接利用的攻击载荷。开发规范见 [CONTRIBUTING](CONTRIBUTING.md)。
