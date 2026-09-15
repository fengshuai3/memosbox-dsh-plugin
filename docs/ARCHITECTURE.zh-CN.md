# 原生插件架构：0.2 开发版

唯一顶层配置行为 `memosbox-native`，由 DSH/Cordis 管理；核心接口锁定 0.1.2-rc.1。

```text
DSH tools / approval / llm / subprocess / sandbox
  └─ memosbox-native
      ├─ MemOS 精选核心：Node 进程内，独立 scope 数据库
      ├─ Wiki：Node 文件层、只增来源、版本与恢复 journal
      └─ Mirobody：固定 Python worker，单次 JSON 输入/输出后退出
          └─ 本地提取 → 获准 DSH 文本模型 → 本地标准化 → 审批入库
```

## MemOS

使用上游 2.0.19 的已选公共核心及生命周期桥，不改算法；构建时移除未用应用模块及 transformer/ONNX 下载链。源码/制品 hash、SQL migration 和原始许可证据随 bundle 提供。npm 的 MIT 声明与上游仓库根 Apache-2.0 许可尚需确认，不能声称公开再分发已获明确许可。

数据库按 profile+workspace 物理隔离：配置标签先绑定 Loader 的 profile 目录，避免两个 profile 都用 default 而意外共享；上游同 profile 的默认可见性规则不足以隔离工作区。capture、查询正文日志和显式导入分别受控。`api_logs` 默认在仓库接口边界移除 input/output 正文，不等于 DSH 历史没有持久化。

显式写入使用 `importBundle` 固定外部 ID，然后用 `getTrace` 核对内容与归属。不直接写 SQLite。重复 ID 不会再次插入；冲突拒绝，未知结果先核对。导入 priority 只用于检索准入，不是医学可信度或学习奖励。

当前是 local-only/词法模式，不创建 embedding provider，不启用 Hub/Viewer/自动技能演化。旧 hostLlm/viewer 字段保留用于迁移，但不会静默开启这些能力。

## Mirobody

Python 使用显式准备的 3.12 venv、Mirobody 1.4.2 与最小完整 wheel 闭包，不调用 `parse_file()`、Config.init 或上游模型配置。包、词库和设备目录分别记录版本/hash；上游 canonicalize 的算术换算不进入本插件原值保持流程。

解析复用 `resolve_reading`，单位复用 `normalize_unit/parse_value_unit`。保留原始字符串；异常/未知单位/歧义不编造代码。来源使用真实页码、单元格、行号；没有 bbox 时标 unavailable。扫描页保留 needs_ocr，Excel 数值/日期不能伪称恢复了原始显示格式。

DSH subprocess 负责固定 argv、显式环境、有界输入/输出、deadline、取消和整树退出。macOS 另外应用只读/网络拒绝 Seatbelt profile 并运行同策略探针。不能将 DSH 的普通写入沙盒当成完整读取/网络隔离；未验证平台拒绝运行。

## 审批、恢复和隐私

文件读取、模型外发、Wiki、MemOS 四个授权分开。候选包含源 hash、原始/标准化字段、证据、目标和 expectedVersion。DSH `approval.request` 在开启回合中授予后，插件创建绑定 digest/scope/session/目标/期限的内部记录；模型传布尔值或 token 不产生权限。

Wiki 页面/index/log 使用可恢复 journal；跨 Wiki/MemOS 不宣称原子事务。Wiki 成功而 MemOS 失败时保留 Wiki，并核对回执后补全剩余目的地。raw 来源只增，不覆盖已存在的不同内容。

真实健康模式仍未提供：宿主日志、普通工具读取、受保护审阅、视觉模型/OCR与全平台隔离尚未全部验收。synthetic-only 只能使用合成数据，不会自动判别患者资料，也不是健康脱敏功能。

memory/wiki scope 延迟初始化；禁用先撤销 tools/hooks，再排空记忆与 worker。可变数据统一管理，旧目录不自动迁移。资源准备是显式开发步骤，不在查询或插件 load 中运行。
