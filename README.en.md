# memosbox-dsh-plugin

A native DeepSeek Harness bundle combining Mirobody local terminology/document tools, a governed Markdown Wiki, and authorized MemOS memory. DSH manages tools and lifecycle. No legacy HTTP service, MCP server or Python daemon is used.

[中文](README.md) | English

**0.2.0-beta.3 is an unreleased development build, not production-ready.** Real health-file processing is unsupported pending host privacy validation. Mirobody currently targets macOS arm64 and an explicitly prepared CPython 3.12 environment; unsupported platforms fail closed.

## Components

| Component | Implemented role | Boundary |
| --- | --- | --- |
| Mirobody 1.4.2 | LOINC lookup, reading/unit normalization, metric metadata, text/PDF/XLSX extraction | One-shot Python, no hidden model request, no diagnostic claims; original values never arithmetically converted |
| Wiki | Scoped search/read, governed writes, provenance, versions and journal recovery | Writes off by default; sources append-only |
| MemOS 2.0.19 core | Authorized persistence, deduplicated import, lexical recall, opt-in capture | Scoped databases; no embedding download, Viewer, Hub or skill evolution |

Selected unmodified MemOS modules are built into a hash-verified local bundle without the unused transformer/ONNX installation chain. This is a packaging adaptation, not an upstream release. **Upstream npm metadata says MIT, while the repository provides an Apache-2.0 root license without a module-specific license; public redistribution requires clarification.** Original evidence is preserved in the vendor source manifest, not replaced with an invented license.

## Development

Requirements: Node 22.19+ or 24, Corepack/pnpm 11.7.0, DSH **0.1.2-rc.1**. DSH alpha APIs are not claimed compatible.

```sh
corepack pnpm install --frozen-lockfile --registry=https://registry.npmjs.org
corepack pnpm run verify
corepack pnpm run verify:consumer
```

Explicit Python preparation, using absolute paths:

```sh
node scripts/provision-runtime.mjs --python /absolute/path/to/python3.12 \
  --runtime-root /absolute/path/to/memosbox/runtime/mirobody --download
```

`--download` fetches locked, hash-verified wheels. Omit it to prepare from an existing wheelhouse offline. Tool calls never install dependencies. Set `mirobodyRuntimePath` to this root. The venv is private; system Python is not modified.

Install only the tested tarball into a disposable DSH profile before considering a live upgrade. The package has not been published to npm. See [source build and installation](README.md#从源码构建并安装) and [runtime/configuration](docs/RUNTIME_GUIDE.zh-CN.md).

Maintainer: 冯帅 <714205152@qq.com>. Source: https://gitee.com/guandalaifu/memosbox-dsh-plugin . This source upload is not an npm release or a marketplace listing. GitHub Actions files are templates for a future GitHub mirror; uploading them to Gitee does not run GitHub Actions.

## Tools

- Mirobody: `mirobody_status`, `mirobody_resolve`, `mirobody_normalize_readings`, `mirobody_parse_document`, `mirobody_preview_import`, `mirobody_commit_import`.
- Wiki: `wiki_status`, `wiki_search`, `wiki_get`, `wiki_summarize`; `wiki_write` only when enabled.
- Memory: `memos_search`, `memos_get`, bounded automatic recall and separately enabled capture.
- Diagnostics: `memosbox_status` reports actual degradation and release blockers.

Document processing, model extraction, Wiki writes, explicit memory writes, capture and query-body logs default off. File access, model transmission, Wiki and MemOS grants are separate. `sensitiveMode: true` blocks ordinary data capabilities; it does not hide content already in DSH history.

The document workflow currently accepts operator-staged **synthetic fixtures only**. Text-model extraction uses DSH routing with separate consent. Scanned pages explicitly report `needs_ocr`; completed vision/OCR support remains a release task. Incomplete/unresolved candidates cannot be committed. Partial commits recover forward without deleting approved Wiki content.

The synthetic-only setting is a development-use restriction, not an automatic detector or anonymizer of patient information. Do not stage real records or put sensitive values into ordinary tool arguments. The separate `sensitiveMode` capability remains unavailable.

## Data and migration

All runtime state lives under configured `$DSH_HOME/memosbox/`, partitioned by a hash of profile and workspace. Presets do not change ownership. Legacy `MEMOS_HOME` or `.env` files do not redirect the controlled adapter. No user data belongs in `node_modules`.

Old MemOS/Wiki directories, Docker data and live profiles are **not automatically migrated**. Uninstall preserves data and runtime caches. Old documentation is retained under `reports/history/` and excluded from the distributable.

See [architecture](docs/ARCHITECTURE.zh-CN.md), [release gates](docs/DEVELOPMENT_PLAN.zh-CN.md) and [security](SECURITY.md).
