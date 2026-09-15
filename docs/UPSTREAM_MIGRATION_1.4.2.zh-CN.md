# Mirobody 1.4.2 迁移说明

本插件从 1.4.0 迁移到 1.4.2，不是只替换版本字符串。已更新官方 wheel 的 SHA-256、锁文件、运行时 generation 校验、资源指纹、worker 版本约束、测试入口和回归样本。

## 实际采用与未采用的变更

- 采用英文肌酐/总胆红素名称误匹配 MELD 的修复；回归覆盖 `Serum Creatinine` → `2160-0`、`Serum Total Bilirubin` → `1975-2`。两者仍可能有多个词法候选，不能宣称无歧义。
- 上游新增 `canonicalize(value, unit, loinc_code=...)`，用于基准单位比较；本插件不自动调用它，继续原样保留不等号、数值字符串和原单位，不悄悄换算。
- 1.4.1 的模型配置迁移、1.4.2 的遗传工具重命名和 MCP 全局访问方式变更，属于本插件未启用的完整应用能力。插件继续使用 DSH 的模型/凭据服务，不启动 Mirobody MCP、HTTP、遗传账号或独立模型路由。
- 上游的日志与个人 MCP 凭据改进，不代表 DSH 日志、健康数据、工作区权限已通过本插件的上线验收。

来源：[Mirobody 1.4.2 官方变更记录](https://github.com/thetahealth/mirobody/blob/1.4.2/CHANGELOG.md)。上游能力与本插件实测范围必须区分。

## 锁与资源

| 对象 | 指纹或版本 |
| --- | --- |
| wheel | mirobody-1.4.2-py3-none-any.whl |
| wheel SHA-256 | 7a075c7708dbc3995132cb6a40bebcb09ff59c268c9a99ac8bd4ddcfe7993997 |
| 完整运行锁 SHA-256 | 8670aebfecb5456c6d731d0bea896efbf3deb4db03f866ad13b4b984a2e88b6a |
| LOINC bundle 标签 | loinc-2.82+2026.08.28-af2524b7a285 |
| bundle SHA-256 | 2dcdb684d7687ff2e620a2729a9eb0dc0138da48f09caa83962680abe7d13bd0 |
| 设备目录标签 | 1.4.0（资源自己的版本，不是 Mirobody 包版本） |

相同 bundle 标签下归档字节已有变化，因此同步修改了资源 SHA-256，而不是禁用完整性检查。旧 runtime 保留在原位置，新版本在独立固定路径创建 venv；不要移动已经生成的 venv。

当前支持 macOS arm64 与外部 CPython 3.12。Python 子进程、导入和资源完整性经过测试，不等于完整上游应用或所有平台均受支持。
