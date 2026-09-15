export const PAGE_DIRECTORIES = ['entities', 'concepts', 'comparisons', 'queries'] as const

export const SCHEMA_TEMPLATE = `# Wiki Schema

## Domain

This Wiki stores stable, source-backed project knowledge. MemOS stores durable experience, preferences, task traces, learned policies, world models, and reusable skills. Live process, port, file, and deployment state must be checked with runtime tools.

## Conventions

- File names are lowercase, hyphenated, and ASCII-only.
- Every page starts with YAML frontmatter.
- Every page contains at least two outbound [[wikilinks]].
- Every page is listed by its complete Wiki-relative path in index.md's managed blocks.
- Every committed operation is recorded once in log.md; incomplete writes retain a recovery intent.
- Raw sources live under raw/ and are not edited by Wiki page updates.
- Conflicts are explicit; uncertain claims use medium or low confidence.
- Writes accept a stable operationId for exact retries; source files are immutable once added.
- Paths returned by tools are relative to this Wiki root; internal journal files are not readable through Wiki tools.

## Frontmatter

Required fields: title, created, updated, type, tags, sources, confidence, and contested.

Allowed types: entity, concept, comparison, query, summary.

Allowed tags: dsh, hermes, skill, wiki, memory, memos, provider, context, file-management, governance, comparison, architecture, testing, configuration.

Confidence values: high, medium, low. High-confidence pages require at least one existing source below raw/.
`

export const INDEX_TEMPLATE = `# Wiki Index

> Content catalog. Read this first to find relevant pages for any query.
> Last updated: 1970-01-01 | Total pages: 0

## Entities

## Concepts

## Comparisons

## Queries
`

export const LOG_TEMPLATE = `# Wiki Log

> Chronological record of all Wiki actions. Append-only.
`
