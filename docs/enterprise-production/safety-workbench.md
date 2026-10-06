# Production Safety workbench

Local implementation verified 2026-10-05. No parent task or release acceptance claimed.

Production and commercial homes expose Safety through project posture, including mixed organizations. Original reads and writes authorize the actual home. Read-only users can inspect records without create/save/resolve/delete controls. Thin actions validate record/home identities and pass expected ancestry to the original services. Companies and evidence files are checked before creation; update/delete predicates include the stored home.

Incidents, observations and toolbox talks have independent bounded keyset pages, server search/type/status filters and whole-filter counts. Cursor identity binds organization, home, actor and reviewed filters. An exhaustion probe prevents lower provider row caps from silently ending history. Selected records outside the current page load separately. Talk lists omit attendance rosters/notes; opening a talk loads full detail. Single-incident PDF uses the selected owner. Legacy register/export reads exhaust source pages and reject above10,000 instead of truncating. This cap is not enterprise capacity acceptance.

The isolated compiled browser fixture verifies reader controls, reviewed search/cursor navigation and writer pending/error/retry/refresh behavior. Original service tests exercise 351-row discovery, provider caps, actual-SDK scope predicates, references, wrong-home/moved-parent writes, source errors, mutation transitions and lean/full talk payloads. Native Safety posture/incident fields were reconciled, but physical-device QA remains open.

Final local focused16, authorization1655 and mobile83 tests pass. Financial regressions3404 pass predates the final lean-summary refinement; final focused/auth/mobile/typecheck/browser cover it. Typecheck, lint and compiled browser pass. See the durable manifest for logs, source fingerprints, failures and terminal command results. Static inventory has no source/dependency drift; it remains unaccepted and its checker exits1.

The new safety discovery index migration is staged and **unapplied; human approval is required**. No production writes, migration application, provider sends or deployment occurred.

## Remaining acceptance

- Full applicable schema/current JWT/RLS, independent PostgreSQL race tests and authenticated persona/browser/device QA remain unproven.
- Mutations still require atomic permission/reference checks, durable exact-request receipts and event/audit co-commit; serious-alert competing-writer/provider delivery remains unproven.
- Legacy exports/native history now fail explicitly beyond 10,000 records; enterprise streaming exports/native pagination and measured query/SLO capacity remain open.
- Offline drafts still need actor partition, durable binary evidence, reconciliation and exact-request recovery; no offline acceptance claimed.
- Global Safety desk, complete company/location rosters, reports, archive/retention, accessibility/dark/mobile QA and customer policy acceptance remain open.
- Staged discovery indexes are unapplied and require human migration approval; no query-plan/full-schema evidence.

[Evidence manifest](evidence/2026-10-05-safety-workbench/manifest.json).
