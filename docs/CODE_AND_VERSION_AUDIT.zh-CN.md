# 代码与版本审计

审计日期：2026-09-04。来源包括本地 `memOSbox-standalone-0.4.2` 源码/发布包、已安装 DeepSeek Harness checkout、npm/PyPI 元数据，以及 MemOS、Mirobody、DSH 官方仓库和文档。

## 代码规模

排除 vendored upstream、runtime、release artifacts 和缓存后，memOSbox 的 Python 主包为 48 个文件、18,192 行、65 个顶层类和 374 个顶层函数；tests 为 37 个文件、10,248 行；scripts 为 44 个文件、13,168 行。冻结上游另外包含 MemOS 1,843 个源文件、Mirobody 510 个源文件，以及独立的 npm `memos-local-plugin` runtime。原发布 zip 约 61 MiB、约 4,200 个文件。

复杂度集中在：`server.py` 2,102 行、`adapters/official_memos.py` 1,768 行、`operations.py` 1,589 行、Hermes provider 1,302 行、Mirobody provisioner 1,129 行、Mirobody identity 1,080 行、jobs 875 行、identity 815 行、CLI 744 行、Wiki adapter 513 行。该分布说明把 HTTP 控制面整体翻译成 Cordis 并不合理，应该用 DSH 的现有服务和官方适配器替换。

## 模块处置

| 旧模块组 | 职责 | DSH 插件处置 |
| --- | --- | --- |
| `adapters/official_memos.py`、冻结 Node bridge | 启动并通过 JSON-RPC 操作 MemoryCore | 由官方 `@memtensor/memos-local-plugin` DSH in-process adapter 完整替换 |
| `hermes_plugin/`、`client.py`、`server.py` | Hermes provider 与 HTTP API | 不移植；由 Cordis lifecycle、`dsh-tools` 和 profile 管理替换 |
| `adapters/wiki.py` | Wiki 查询、页面、摘要、治理写入 | 已移植为 TypeScript 原生 WikiAdapter，并加强路径/文件名检查 |
| `router.py`、`composer.py` | MemOS/Wiki/实时状态路由 | 转成静态 system-prompt 边界；MemOS 自动召回，Wiki 按需工具调用 |
| `runtime.py`、`jobs.py` | 多租户 runtime、队列、幂等任务 | 本地 DSH 使用 session/preset namespace 与官方 MemOS 队列，不重复实现 HTTP 作业系统 |
| `identity.py` | API key、tenant/user/agent scope | 不用于本地 profile；跨用户服务版应作为独立 provider，不放进本地插件 |
| `operations.py`、`upgrade.py`、`maintenance.py` | 服务备份、迁移、锁 | 0.1 保留数据目录并依赖 MemOS schema migration；发布前仍需补数据库升级/回滚验收 |
| `alerts.py`、`doctor.py` | 服务 readiness/告警 | 以 `wiki_status`、DSH 日志和后续 `memosbox_doctor` 管理命令替代 |
| `mirobody/*` | 医疗记录、身份、上传、MCP/HTTP | 0.1 不加载；需独立安全设计和 Python 3.12 本地库或受控服务 provider |
| release/audit scripts | 离线包、SBOM、黑盒/生产验收 | npm `prepack`、CI、tarball smoke、SBOM/provenance 阶段化重建 |

## 版本矩阵

| 组件 | 0.4.2 中版本 | 2026-09-04 官方稳定版 | 决策 |
| --- | --- | --- | --- |
| DeepSeek Harness | 本地 checkout commit `76fda729...`，包版本 `0.1.2-rc.1` | npm `0.1.2-rc.1` | 当前，作为验证主机，不修改官方仓库 |
| MemoryOS Python | tag `v2.0.22`，commit `b051e638...` | PyPI `2.0.33`，2026-09-03 | 旧服务 vendor 已过期；新 DSH 插件不嵌入 Python MemoryOS |
| `@memtensor/memos-local-plugin` | `2.0.5` | npm `2.0.18`，2026-09-01 | 新插件精确锁定 `2.0.18`，使用其官方 DSH 适配器 |
| Wiki | 自研，无独立 upstream 版本 | 不适用 | 以本插件 `0.1.0` 版本管理 TypeScript 移植 |
| Mirobody | `1.2.1`，commit `85647b...` | PyPI `1.3.0`，2026-08-31 | 旧 vendor 已过期；因无 API 原生要求暂不装入 0.1 runtime |

MemOS 2.0.18 的 peer range 使用 `>=0.1.0-rc.5 <0.2.0`，npm semver 对后续 pre-release 的匹配存在限制，会拒绝开发依赖中的 DSH `0.1.2-rc.1`。因此本包按官方 MemOS adapter 的编译基线使用 DSH `0.1.0-rc.6` 开发依赖，同时必须在本地 DSH `0.1.2-rc.1` 完成 tarball 真实组合验收。此兼容性风险已纳入 P2，不通过 `--force` 或 `--legacy-peer-deps` 掩盖。

生产依赖审计还发现 MemOS 2.0.18 的依赖范围会默认解析到 `ini 1.3.0`、`adm-zip 0.5.18` 和 `sharp 0.34.5`，分别命中 2026-09-04 时官方 registry 报告的高危公告。源工作区和已安装的本地 DSH profile 已覆盖为 `ini 1.3.8`、`adm-zip 0.6.0`、`sharp 0.35.3`；选择 sharp 0.35.3 是为了与验证主机 DSH 0.1.2-rc.1 完全一致，避免 macOS 同进程加载两套 libvips。由于依赖包自身的 override 不会传递到使用者 profile，插件增加了运行时 fail-closed 检查；社区正式版仍应等待 MemOS 修正依赖范围，或发布一个经过单独许可与审计的上游修复版。

## 最新能力

MemOS local plugin 2.0.18 提供本地 SQLite、FTS5 与向量混合检索、去重、L1 trace/L2 policy/L3 world model/Skill 四层结构、step/task feedback、reward backprop、skill crystallization、多 agent namespace、Viewer，以及 OpenClaw、Hermes 和 DSH adapters。DSH adapter 在同进程注册六个 `memos_*` 工具，对直接用户回合自动召回并后台 capture，复用当前 DSH provider/model/credential route，前台检索上限为 3 秒，失败时 fail-open。它不启动 Hermes 使用的 JSON-RPC bridge 或 daemon。

MemoryOS Python 2.0.33 是服务/库发行线，适用于 Python 自托管、云 API 和 provider 工厂；它不是 DSH 插件必须依赖的运行时。把 Python 2.0.33 与 npm local plugin 2.0.18 当成同一个版本号会导致错误升级。

Mirobody 1.3.0 的可复用本地库能力包括无需 key/网络的多语言离线指标解析、LOINC/SNOMED CT/RxNorm 概念映射、UCUM 单位归一化/转换，以及可选的文件解析；官方同时把语义召回声明为 opt-in 且要求嵌入矩阵与 provider/model 元数据一致。完整应用仍包含采集、数据库、身份、agent、HTTP 与 MCP，基础 wheel 也约 26.8 MB。医疗数据功能默认关闭是发布安全要求，不应为了表面“全功能”绕开授权和隔离。

## 发布包 0.4.2 的缺口

- 顶层 memOSbox 缺少明确 LICENSE/NOTICE 和 `pyproject.toml` license/project URL，SBOM 对 memOSbox/部分组件声明 `NOASSERTION`。
- 最新验收文档仍命名为 0.4.1；0.4.2 没有同版本的独立验收报告。
- 旧集成通过 HTTP/JSON-RPC/MCP，不能满足用户要求的 DSH 原生调用。
- DSH 是 developer preview，必须按每个 DSH release 重跑组合测试。
- Mirobody 是敏感健康数据系统，开发验收 profile 不能等同生产批准。

## 已采取的更新

本插件没有覆写旧 61 MiB 发布包或历史 vendor。它用 npm 精确依赖把实际 DSH runtime 更新到 `@memtensor/memos-local-plugin` 2.0.18，移除 DSH 对旧 Python API/Node bridge 的依赖；Wiki 以独立 TypeScript 源码纳入同一 npm 版本、测试与发布流程。当前 profile 对三个高危传递依赖做了显式安全覆盖并由启动门禁验证。Mirobody 版本差异已记录但没有冒充完成无 API 移植。

## 真实组合审计结论

- tarball 可由 DSH profile 安装，`--dump-config` 显示唯一 `memosbox-native` layer；临时 profile 完成 add、remove、reinstall，卸载后数据库与 Wiki 仍保留。
- 本地 `web` profile 已安装 0.1.0-beta.2；启动时 MemoryCore 创建/迁移 SQLite，Wiki 初始化三个导航文件，Web 仅绑定 127.0.0.1，MemOS Viewer 18801 未监听，SIGINT 后 SQLite 与端口干净关闭。
- 无密钥 headless 验收到达自动 recall 与 episode 建立后，按预期停在 DSH `MISSING_CREDENTIAL`；没有复制或读取用户凭据。因此真实模型 response/capture/restart recall 仍是发布前 canary。
- 未加 profile override 时复现了旧 sharp/libvips 与 DSH sharp/libvips 的双加载警告；对齐 0.35.3 后警告消失。这是必须保留的宿主兼容测试。
- 当前本地源码式 DSH 包装需要显式 pnpm 11 shim 与 `-w` workspace 标志；`.local/bin/dsh` 已在安装目录内修正为直接启动 CLI，官方 Git checkout 保持 clean。
