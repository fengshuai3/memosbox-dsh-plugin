# Security Policy

## Supported versions

Only the latest release line receives security fixes while DeepSeek Harness remains in developer preview.

## Reporting

Do not file secrets, personal memory data, health data, Wiki raw sources, database files, or exploitable proof-of-concept payloads in a public issue. Contact maintainer 冯帅 privately at 714205152@qq.com and include the affected version, platform, configuration, impact, and a minimal redacted reproduction. No response-time or security-service SLA is promised.

## Runtime boundary

The package opens no HTTP/MCP listener or legacy Viewer. Wiki writes, capture, document processing, query-body logs and explicit memory import default off. Scope databases are physically separated by profile and workspace.

Mirobody uses a one-shot DSH-managed Python process, with macOS read/network confinement probes. Unvalidated platforms fail closed. Real health-file processing is not supported by this development build: use synthetic fixtures only. Host history and general-purpose tools require separate privacy validation.

## Dependency gate

Do not reuse the old claim that adm-zip 0.6.0 is safe: it has a known advisory and no verified fixed release in the baseline. Development overrides do not protect consumers or installation scripts.

The production package builds only selected MemOS core modules without the unused transformer/ONNX install chain. Verify exact source/output hashes and actual consumer dependencies. The full upstream development graph is a separate audit scope and must not accidentally ship. Python wheels, terminology and interpreter provenance require separate auditing.

Upstream npm metadata declares MIT, but its module has no LICENSE and the repository root uses Apache-2.0. Original evidence is preserved; the applicable redistribution terms remain unresolved. Review has resumed, not cleared. The development source repository is https://gitee.com/feng315/tomorrow; source availability is not release or health-privacy approval. Gitee release attachments remain subject to the same evidence checks; switching away from npm does not grant redistribution rights or certify safety.
