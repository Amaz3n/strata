# Trade schema and scope reconciliation

Verified read-only metadata and local implementation on 2026-10-05. No task or release acceptance claimed.

The connected production schema proves that purchase-order lines have no project_id. The previous trade fallback and its synthetic fixtures incorrectly assumed that field existed. The original owner now filters commitment.project_id and derives the home from that parent, with both line and parent organization predicates. A returned parent outside the reviewed reference batch fails before dispatch. Multiple fallback PO vendors keep the task unassigned instead of arbitrarily choosing a recipient; explicit schedule assignment remains authoritative.

Trade reads now use the existing getProjectReadScopeForUser helper. Active actor/org project membership predicates apply for assignment-restricted users, division access narrows before reads, and community/lot organization predicates narrow the project join at the database. Unscoped work retains homes without lots. The dynamic source projection is runtime-validated; malformed rows and failures cannot become empty/zero evidence.

Local original service/action/actual-SDK tests cover corrected parent projections, every bounded keyset predicate, assignment-only reads/dispatch, ambiguous vendors and malformed/out-of-batch sources. Final focused 22, auth 1,677 typecheck and lint pass. Earlier Starts 100 passed before the projection refinement. Logs retain the initial type error and malformed-fixture failure; see the manifest for terminal checks. Browser UI did not change; its isolated evidence remains in the prior trade manifest.

The connector lists only the production Arc project. Only relation/column/FK/policy metadata was queried, with no customer row access or writes. Broad live org policies are recorded as security reconciliation gaps, not treated as service-bound RLS proof. The new source queries do not imply public API/legacy writer acceptance.

## Remaining acceptance

- Database-side grouping/search/pagination still needs implementation and query-plan/SLO validation; service aggregates up to 100,000 schedules before producing bounded DTOs.
- Only production Arc is connected. No approved disposable QA database was found; no full-schema/current JWT/RLS/independent-session or authenticated workflow acceptance.
- Live policy metadata includes broad org access for projects and schedule assignments; service predicates do not prove direct Data API/storage/grant security. Composite parent/org FK coverage and all legacy writers remain under E02-02/F03.
- Schedule assignment/company child ancestry, embedded completeness and concurrent parent/permission movement still require full-schema proof and reconciliation.
- Dispatch requires atomic durable intents/claims/receipts, reviewed-scope daily policy, provider ambiguity/cancellation/recovery and current committing-actor authority.
- Physical-device/accessibility/customer/restore/release acceptance remains open. No migrations, production writes, provider sends or deployment occurred.

Evidence manifest. Unchanged UI evidence.
