# 开发运行与文件管理

## 安装与准备

基线：DSH 0.1.2-rc.1、Node 22.19+/24、macOS arm64、CPython 3.12。先在 checkout 完成 `verify`、`verify:consumer`，再将验证过的 tarball 装入独立测试 profile；包尚未公开发布，不使用未经确认的同名 registry 包。

```sh
dsh plugin --profile memosbox-dev add -w /absolute/path/to/tested-candidate.tgz
dsh --profile memosbox-dev --dump-config
```

DSH 会转发到 PATH 中的 `pnpm`；先确认 `pnpm --version` 为 11.7.0，避免系统另一份旧 pnpm 被调用。全新 profile 的 `pnpm-workspace.yaml` 仅显式允许已审查的 `better-sqlite3` 原生构建，不开启全局自动批准所有安装脚本。测试脚本在私有临时目录提供固定 pnpm 入口，不修改全局安装。

Python 准备命令见 README。`--runtime-root` 放在统一根内 `runtime/mirobody`；`--download` 只用于显式准备，后续从 wheelhouse 离线构建。venv 必须在最终固定目录新建后切换 active manifest，不随意移动。

## 配置

DSH patch 可能替换整行 config；保留现有完整字段后合并本包 `cordis.patch.yml`，不要只写一个字段。本次开发不自动覆盖 live profile。

| 字段 | 默认值/作用 |
| --- | --- |
| dataHome | 空：`$DSH_HOME/memosbox` |
| profileId | default 标签绑定 Loader 所属 profile 目录，再与工作区生成 scope；直接嵌入宿主无 Loader 时须显式提供唯一 ID |
| memoryEnabled / recallEnabled | true，延迟初始化、词法召回 |
| captureEnabled / queryLogEnabled | false，自动保存和查询正文日志独立 |
| explicitMemoryWriteEnabled | false，批准记忆导入的独立开关 |
| wikiEnabled / wikiWriteEnabled | true / false |
| memoryHome / wikiPath | 自定义 scope 子目录父根，不自动复用旧库 |
| mirobodyEnabled | true，缺运行时返回 unavailable，不下载 |
| mirobodyRuntimePath | 空：数据根内 runtime/mirobody |
| mirobodySourcePath | 空：拒绝读文件；须显式指定合成 fixture inbox |
| mirobodySyntheticDocumentsEnabled | false，只供合成数据开发测试 |
| mirobodyModelExtractionEnabled | false，开启仍需单次外发批准 |
| sensitiveMode | true 时关闭普通数据能力；真实敏感模式尚未完成 |

旧 viewerEnabled/hostLlmEnabled 为迁移保留，但当前 MemOS 适配器不启用；status 明示实际能力。Mirobody 的 DSH 文本模型请求是另一条单独授权的路径。

## 合成文档流程

1. inbox 内文件名为 32–64 位小写十六进制/连字符 ID，加 `.txt/.pdf/.xlsx`。不使用姓名，不放真实健康资料；命名本身不是身份验证。
2. `mirobody_status` 检查环境，`mirobody_resolve` 验证本地解析。
3. `mirobody_parse_document` 传 sourceId，批准读取；如使用模型，另批准外发。无模型只形成部分文本候选。
4. `mirobody_preview_import` 返回候选 JSON 文件位置；用户检查来源、原值、标准化结果和目标。模型结果不回显原文。
5. 对完整且已解决的候选执行 `mirobody_commit_import`，分别批准 Wiki/记忆。部分失败保留 Wiki，在同一候选上重试核对。

扫描页当前返回 needs_ocr/partial，禁止强行提交。宿主可能持久化模型输入/输出，故测试只能使用合成数据。

`mirobodySyntheticDocumentsEnabled` 不是自动检测真实档案或脱敏的功能。默认关闭文档入口、启用 sensitiveMode 时拒绝普通数据能力，不等于已经实现患者信息隔离。不要将真实文件放入开发 inbox。

## 仓库验收入口

```sh
node tests/python/run-real-provider.mjs --dsh-root /absolute/path/to/deepseek-harness --native-tools
node tests/run-dsh-loader.mjs --dsh-root /absolute/path/to/deepseek-harness \
  --artifact /absolute/path/to/tested-candidate.tgz
```

第二条只创建独立临时 DSH_HOME，实测 CLI 安装/卸载、Loader 启停、原生工具、宿主审批和新进程读回。模型及审批答复器使用明确的合成测试实现，不能代替远程模型、完整 agent loop、交互界面及患者数据隐私验收。成功后清理临时合成数据；失败时保留私有调试目录。

## 数据目录

```text
<dataHome>/
  memory/<scope>/          SQLite / skills / logs
  scopes/<scope>/wiki/     页面、来源、journal、回执
  scopes/<scope>/imports/  候选与跨目标回执
  runtime/mirobody/        wheel缓存、固定venv、active manifest
  runtime-jobs/           worker临时输入，整树退出后清理
```

卸载移除能力而不删除数据/缓存。旧 MemOS/Wiki/Docker 数据保持原样，需要另行备份、迁移 dry-run 和授权。回退代码不等于数据库可降级；请使用停写后的完整备份。状态 unavailable 不能通过改全局环境、关闭门禁或启动旧服务来掩盖。
