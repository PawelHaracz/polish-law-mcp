# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Data refresh to Dziennik Ustaw of 2026-11-16: 20,791 acts (9,343 ustawy + 11,448 in-force rozporządzenia), 1,463,410 provisions.
- Re-ingested acts changed upstream since the previous census (1,180 ustawy, 1,431 rozporządzenia), preferring the newest consolidated text; 376 ustawy whose consolidated text is PDF-only re-ingested from PDF.
- Pruned 154 rozporządzenia that are no longer in force.
- 401 rozporządzenia whose newest consolidated text is PDF-only re-ingested from PDF; 44 amending ustawy from 2025–2026 added.

### Added
- PDF ingestion of rozporządzenia (`ingest:pdf -- --regulations --from YEAR`): since 2025 the Sejm ELI API serves new acts as PDF only. PDF parser handles § as the top-level unit and keeps annexes (załączniki) as separate `zalN` provisions instead of gluing them onto the last unit.
- `ingest:regulations` resolves consolidated texts and supports `--id-file` and `--prune`.

### Fixed
- `ingest` no longer overwrites an existing seed with the base act's original wording when the newest consolidated text is PDF-only.
- `census` keeps manual `not_ingestable` reclassifications across re-runs.
- PDF quality gate (built for scanned OCR) no longer rejects born-digital acts (post-2000) with large annexes, e.g. the 2026 budget act.

## [1.0.0] - 2026-XX-XX
### Added
- Initial release of Polish Law MCP
- `search_legislation` tool for full-text search across all Polish legislation (Polish)
- `get_provision` tool for retrieving specific articles
- `get_provision_eu_basis` tool for EU cross-references (DPA 2018 to GDPR/RODO)
- `list_laws` tool for browsing available legislation
- `get_law_structure` tool for law table of contents
- `search_rozporzadzenia` tool for rozporzadzenia and executive instruments (Professional tier)
- `get_uodo_guidance` tool for UODO decisions and guidance (Professional tier)
- Contract tests with 12 golden test cases
- Drift detection with 6 stable provision anchors
- Health and version endpoints
- Vercel deployment (dual tier bundled free)
- npm package with stdio transport
- MCP Registry publishing
- Polish language full-text search support
- ISAP structured data integration

[Unreleased]: https://github.com/Ansvar-Systems/polish-law-mcp/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Ansvar-Systems/polish-law-mcp/releases/tag/v1.0.0
