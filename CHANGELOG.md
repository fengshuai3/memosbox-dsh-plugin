# Changelog

## 0.2.0-beta.4 - Unreleased

- Stop document parsing and commits for the rest of a DSH turn after refused, cancelled or unavailable approval; block destination downgrade and candidate retries, including after plugin reload. A later host turn requires fresh approvals.
- Discover unscoped synthetic report imports using metadata-only matches, followed by actual page verification; named project queries never use this fallback.
- Keep a non-certifying MemOS lookup reference in new Wiki-only imports, preserving readback after a later separately approved memory extension. Explain that a dual-destination commit requests independent grants within one call.
- Return result-specific terminology caveats and tool-scoped business-write effects instead of repeating every disclaimer.
- Distinguish memory import, lightweight capture, mixed labels and unverified provenance; tags are not proof of human approval.
- Separate project search guidance from clinical mapping guidance and request short, evidence-led answers without mandatory boilerplate sections.
- Add automated answer-quality regressions alongside real DSH dialogue verification; no release or health-data approval is implied.

## 0.2.0-beta.3 - Unreleased

- Return independent source/model/Wiki/memory approval decisions and stage-specific effects; distinguish business writes from host persistence.
- Explain and safely recover a source ID mistakenly submitted as a candidate ID without reading files or granting approval.
- Add deterministic, workspace-scoped MemOS lookup references to dual-destination Wiki imports. References require actual memory readback and do not certify successful writes.
- Clarify lexical retrieval has no automatic translation; verify related records by exact ID instead of broadening entity scope.
- Keep public release and real-health-data approval disabled; redistribution review remains deferred.

## 0.2.0-beta.2 - Unreleased

- Upgrade the pinned local Mirobody library to 1.4.2; preserve raw values and add serum creatinine / total bilirubin regression coverage.
- Constrain named Wiki queries by exact entity identity; broad searches return metadata-only matches, with navigation opt-in.
- State evidence, language, unrelated-data and host-persistence boundaries in the native plugin prompt.
- Scope all Vitest temporary files under the plugin and clean them after each suite.
- Read diagnostic version from the manifest; add fail-closed release/source checks. License, publisher identity, human UI approval and health privacy are not approved by these changes.

## 0.2.0-beta.1 - Unreleased

- Added required native Mirobody tools, pinned Python preparation and one-shot DSH-managed execution.
- Added synthetic document extraction, evidence-checked text-model orchestration, candidate review, separate approvals and recover-forward import.
- Fixed Wiki path/navigation escapes, cancellation, journal recovery, renderer metadata, search priority, path round trips, same-stem indexing and CRLF parsing.
- Added profile/workspace data isolation, independent capture/query-log/import policy and verified idempotent MemOS import.
- Bound profile labels to their Loader directory, drained active tools on disable, and preserved durable receipts across host/plugin cancellation.
- Pinned the offline pip 26.2.1 installer; new private environments bootstrap directly from its verified wheel without running the external interpreter's ensurepip.
- Built selected MemOS core modules with tracked provenance, excluding the unused transformer/ONNX runtime install chain; clarified unresolved upstream licensing.
- Updated DSH target to 0.1.2-rc.1. No live profile, old data, Docker service or public release was changed.
- Real health data, completed OCR, full-platform packaging and community publication remain gated.

## 0.1.0-beta.2 - 2026-09-04

- Corrected the current Mirobody audit from 1.2.2 to 1.3.0 after a final official-source refresh.
- Repacked the tested source and documentation so the installed beta matches the review artifact.

## 0.1.0-beta.1 - 2026-09-04

- Added one DSH-managed Cordis bundle around official `@memtensor/memos-local-plugin` 2.0.18.
- Added native governed Wiki search, read, status, extractive summary, and opt-in write tools.
- Disabled HTTP Viewer and Wiki mutation by default.
- Added traversal, symlink, size, taxonomy, source, atomic-write, and optimistic-concurrency controls.
- Added a fail-closed gate for known-vulnerable MemOS transitive dependency resolutions.
- Validated DSH profile composition, local Web startup/shutdown, Viewer-off behavior, and uninstall/reinstall data retention.
