# QBO integration completion goal

Status: ACTIVE —28/125 code clauses verified. Q07 code acceptance DONE; Q02-06 reopened for atomic outbound invoice-adoption compatibility; Q03 parser/receipts and Q04 recovery/import closure integrated. Q04-06/Q17 portable PostgreSQL and actual facade contention acceptance, remaining feature packages and full program acceptance remain outstanding. Four parent direct SQL contention probes now pass; see014j for their exact scope.
Planned against commit `9f1549af` plus the existing uncommitted workspace, October 4, 2026. Snapshot: `014-qbo-source-baseline.json`. Isolated implementation checkout: `/private/tmp/arc-qbo-goal-01a109ed`.

## Objective and completion boundary

Improve the existing integration's performance, reliability, maintainability and efficiency, and complete the missing accounting workflows below. Preserve the provider-neutral boundary, existing customer data, organization/division/project authorization, posted-money invariants and ledger-authority policy. A package is code-complete only with implementation, meaningful behavioral tests and recorded evidence. Writing this plan does not complete implementation.

The user authorized implementation of this goal. Production deployment, production migrations, customer-data repair and real financial/provider mutations are separate reviewed rollout activities. Do not load production `.env.local`, run production seeds, run `db push`, apply pending D2 SQL, or start another development server. Existing Books and drawings work is outside this goal except narrow accounting seams named below.

Use the current workspace snapshot, not bare HEAD: the shared checkout contains substantial unrelated uncommitted work. Before integrating any executor change, compare its baseline source hash to the shared file; changed shared files require a fresh three-way review. Never replace a changed shared file wholesale. Secrets were excluded from the isolated copy. Do not commit the snapshot manifest containing unrelated file hashes back into application code.

## Architecture and conventions

`lib/integrations/accounting/provider.ts` defines capabilities; `registry.ts` certifies them. QBO owns transport/OAuth/settings/translation; `lib/services/accounting-*.ts` own routing, permission checks, durable delivery and canonical persistence. Identities are scoped by org, connection and remote entity type. Never add provider identifiers as business-table columns or fall back to legacy QBO columns.

Use service-owned business logic, Zod-validated action boundaries and the nearest existing ActionResult convention. Retain integer-cent money and explicit currency. Use token-based UI components, dense tables and distinct empty/loading/error states. Read `docs/design.md` before adding a surface. Reuse existing integration sheets and Books reconciliation rather than creating a competing ledger or standalone redundant dashboard. Relevant exemplars: `tests/accounting-inbound-closure.test.js`, `tests/accounting-sync-lifecycle.test.js`, `tests/accounting-qbo-recovery.test.js`, `components/integrations/accounting-sync-sheet.tsx` and `lib/services/accounting-delivery.ts`.

## Verification commands

Run in the isolated checkout. Never treat source-text regex assertions as proof of money-moving behavior.

| Gate | Command | Required result |
|---|---|---|
| Targeted baseline | `node --test tests/accounting-*.test.js tests/qbo-*.test.js` | zero failed tests; report skips individually |
| Financial regressions | `pnpm test:financials` | exit 0 |
| Authorization regressions | `pnpm test:auth` | exit 0 |
| TypeScript | `pnpm typecheck` | exit 0; no generated artifacts copied into shared source |
| Lint | `pnpm lint` | exit 0 |
| Full suite | `pnpm test` | exit 0; identify environment-dependent skips |
| Schema check | `pnpm db:schema:check` | exit 0 against source only; inspect script first and do not give it production access |
| D2 compatibility | `pnpm accounting:d2:check` | passing source compatibility; do not mistake live release gates for local tests |

Database contracts must execute in explicitly disposable PGlite/local Postgres, with RLS role/privilege checks in an engine supporting the needed semantics. Reuse the existing database-contract CI runner after reading `.github/workflows/verify.yml`; do not invent a production DATABASE_URL. New browser fixtures use mocked actions/provider responses and synthetic data. Application builds remain CI-owned. Report pre-existing verification failures separately and repair goal-caused failures.

## Execution packages and code definitions of done

Every package requires named behavioral tests, changed-file scope review, lint/typecheck and an evidence entry in `014-qbo-completion-checklist.json`. Estimates are sequencing aids. Dependencies refer to package IDs in this document.

### Q01 — Reproducible baseline and failure fixtures (M, low risk)

Scope: accounting/QBO tests, isolated test helpers, this plan/checklist/baseline; no application behavior changes.

Current state: existing suites cover fenced delivery, uncertain create recovery and inbound conflicts, but the audit reproduced an unsupported CloudEvents payload and same-total bill allocation mismatch. Some import tests only inspect source text.

Steps: record scoped source hashes and test results; extend the existing transpiled-module/in-memory database fixture pattern with abort-aware provider doubles, immutable request recording and project/company fixtures. Capture request/query counts and wall-clock measurements separately from financial assertions.

DoD: baseline command above passes or has precisely documented pre-existing failures; no network/provider/customer writes; fixtures can reproduce signed CloudEvents, malformed/saturated CDC, same-total allocation edits, expired reconnect, failed queue reads and partial imports. Tests fail against the old behavior where applicable. Timing tests use controllable clocks rather than long sleeps.

### Q02 — Database authorization and credential isolation (M–L, medium risk; depends Q01)

Scope: new additive migration, `accounting-connections.ts`, `accounting-target.ts`, authorized integration actions, relevant SQL contracts. Inspect every direct connection/map/sync-record writer before changing grants. Routing upserts already use an authorized service client; preserve that path, and add any missing resource/division authorization rather than unnecessarily converting it. Include any surviving compatibility views or legacy credential tables in denial tests; pending D2 cleanup is not assumed deployed.

Current state: `20260719011735_accounting_connections.sql:49` and `20260719011920_accounting_entity_map.sql:59` use membership-only FOR ALL policies; sync records inherit a similar policy. Application administrative actions separately require stronger permission.

DoD: anonymous and ordinary organization-member roles cannot read credential columns or insert/update/delete connection, routing or sync identities directly. Permitted metadata reads expose an explicit column list. Authorized admin/routing actions work through scoped server/RPC paths; cross-org and division-scope attempts fail. Internal delivery/import RPCs remain service-only. Denial tests execute real database privileges/policies, including direct access, not just action mocks. Existing mapping identity, reconnect and outbox flows remain functional. Migration is written and rehearsed locally; never applied to production by this package.

### Q03 — Webhook format compatibility and durable acknowledgement (M, low risk; depends Q01)

Scope: `qbo/webhook.ts`, `qbo/reconcile.ts` webhook intake, existing webhook route/tests; optional focused parser type module.

Current state: `extractIntuitEntityEvents` reads only `payload.eventNotifications`; valid signed CloudEvents arrays produce zero rows and HTTP success.

DoD: legacy and CloudEvents payloads normalize `type`, `intuitentityid`, `intuitaccountid`, `time` to the existing canonical representation. Normalize entity and operation spelling explicitly. Preserve provider event IDs as metadata while deduping semantically with CDC. Multi-company arrays, duplicate delivery and out-of-order updates pass. Invalid signatures fail before persistence; malformed/unsupported nonempty shapes receive non-successful acknowledgment; valid empty notifications remain explicit no-ops. Database failure prevents acknowledgment. No legacy shared-secret bypass. Signed route-boundary tests run under Node and the standard suite.

Primary reference: https://static.developer.intuit.com/output_html/qbo/docs/develop/webhooks/configure-webhooks.html (verify current docs when implementing).

### Q04 — Complete CDC catch-up and visible recovery gaps (L, medium risk; depends Q01, Q03)

Scope: `qbo/reconcile.ts` CDC ingestion, `qbo/client.ts` CDC/query methods, process-changes route, provider contracts, additive cursor/recovery migration only if required.

Current state: absent envelopes become empty arrays and checkpoints advance to now after storing received rows. Intuit caps CDC at 1,000 objects and 30 days. API accepts changedSince, not an arbitrary changedUntil window; do not implement fictional time-window pagination.

DoD: strict response validation distinguishes valid empty from malformed results; cap-sized or ambiguous results cannot authorize a now checkpoint. Catch-up uses supported per-entity/safe watermark recovery with explicit completeness proof; ties, deletion ordering and full-cap same-timestamp groups never silently skip records. If proof is impossible, preserve the checkpoint and persist a visible recovery-required state with resumable full reconciliation/import. A >30-day gap is durable operator-visible evidence, not only a log warning. Cursor update happens only after all required events are durably stored; replays do not reset terminal rows. Tests cover 0, 999, 1000, >1000 synthetic changes, timestamp ties, malformed envelopes, deletion groups, partial DB failure, outage/reconnect and concurrent polls. Capture per-connection outcomes and fairness.

### Q05 — Bill/expense line fidelity and source revision safety (L, medium/high risk; depends Q01, Q04)

Scope: inbound bill/expense reconciliation, invoice/bill line identity/coding helpers, local-change fingerprints, provider-neutral delivery, financial contracts.

Current state: bill reconciliation compares TotalAmt and updates a header from the first account line, never reading `bill_lines`; importer preserves per-line allocations. Fingerprints omit important line/description/project/item fields.

DoD: compare full normalized source lines, remote IDs, account/item/class/customer refs and project allocations. Same-total redistribution across accounts/projects is a conflict for posted obligations; no posted job costs are silently moved or recreated. Mutable documents may update header and children atomically only through established domain operations. Add/remove/reorder lines, item-based lines, credit signs and multi-project groups are covered. Fingerprints/revisions include all outbound-owned financial/content fields and stable line identity; edits during delivery remain queued even when totals are unchanged. Successful receipts describe the revision actually delivered. Retry/duplicate/out-of-order tests preserve one financial fact.

### Q06 — Invoice discounts, currency and document-shape preflight (M–L, medium risk; depends Q01, Q05)

Scope: shared QBO invoice translation, importer/reconciler, canonical invoice totals representation and fixtures; restrict changes to existing financial contracts.

Current state: invoice import/reconciliation filters SalesItemLineDetail while outbound emits DiscountLineDetail; imports label money USD without inspecting CurrencyRef.

DoD: fixed/percentage discounts, taxable/exempt ordering, groups/subtotals and rounding have one normalized translation used in both inbound paths. Gross lines minus discount plus tax equals header total in cents. Recalculation/export/round trip preserves the discount; no unexplained fabricated balancing line. USD support is explicit; foreign-currency/exchange-rate transactions fail preflight before any financial mutation with actionable errors unless real multicurrency support is deliberately implemented and tested. Unknown material document shapes do not import as misleading partial documents. Fixtures include zero-tax, percentage/fixed discount, mixed tax, cent rounding, bundle/group and non-USD cases.

### Q07 — Bounded OAuth/worker transport and truthful maintenance outcomes (M, low/medium risk; depends Q01)

Scope: QBO auth/client/connections, process-changes/outbox routes, accounting logger/cron status only as needed.

DoD: OAuth exchange/refresh/revoke/company fetch and QBO transport obey explicit timeouts plus the inherited worker deadline. No new request starts after budget exhaustion. Timeout ambiguity retains credential rotation/remote identity safeguards. Keepalive DB lookup failures throw or produce explicit failure, and cron status includes maintenance failure even with no outbound jobs. Per-connection failures cannot starve every other tenant; unfinished work remains eligible. Retry-After is respected or rescheduled without consuming the whole invocation; no blind uncertain POST retries. Abort-aware tests prove bounded exit without real sleeps. Intuit correlation IDs are retained without credential/body leakage.

### Q08 — Company-bound expired OAuth recovery (S–M, low/medium risk; depends Q01, Q07)

Scope: connection sheet, integration OAuth actions/callback and existing state/identity guards.

DoD: expired/error connections offer OAuth reconnect, active ones offer token refresh. Reconnect binds existing connection and expected realm; wrong-company callbacks are refused without changing credentials/routes. Successful reconnect preserves scoped mappings and revives eligible backlog exactly once. Button/action/callback fixtures cover expired, active, disconnected, denied permission, wrong realm, cancellation and provider failure. Error/confirmation copy accurately names the operation.

### Q09 — Truthful sync status, outcomes and receipt presentation (S–M, low risk; depends Q01)

Scope: `accounting-sync-sheet.tsx`, shared accounting presentation rules, import sheet result rendering and action fixtures.

DoD: unloaded/loading/error/loaded are distinct. Failed reads render persistent retryable errors; stale data is labeled stale and never green merely because empty. An explicit outcome map covers synced/skipped/deferred/review/conflict/error. Only delivered outcomes advance last-successful delivery. Inbound/outbound success clocks are distinguishable. Partial and failed-only imports retain receipts; item lists reflect actual outcomes rather than all submitted records. Tests cover every outcome and failure transition.

### Q10 — Scoped queue/history pagination and company-file health (M–L, medium risk; depends Q02, Q09)

Scope: shared queue/history/health service, accounting-sync actions/sheet, existing integration panel and Books reconciliation read seams; additive indexes if query plans justify them.

DoD: authorized org/division/project/connection filters apply before row limits. Keyset cursors have stable timestamp+ID ordering and no duplicates/omissions under fixed fixtures. A project with 600 older pending records remains discoverable behind another project's 600 newer rows. Counts describe complete authorized scope separately from displayed pages. Each row identifies its company/provider. Health shows oldest actionable work, inbound/outbound/CDC success, maintenance failure and recovery-required findings. Loading/error/empty states are truthful. A page contains at most 100 rows. Query counts stay at or below 12 database calls per page, independent of page-row count (no per-row queries); counts and authorization lookups are included. Record EXPLAIN/fixture evidence for indexes. Tenant isolation and division authorization remain intact.

### Q11 — Durable per-item import receipts and centralized import entry (L, medium risk; depends Q02, Q06, Q09, Q10)

Scope: provider-neutral import contract/service, QBO importer/action/sheet, existing integrations workspace, new receipt storage migration/contracts if needed.

DoD: each run has a durable identity and records every submitted item's imported/adopted/skipped/failed outcome, resulting Arc IDs, destination projects, amounts and error. Retry resumes incomplete items without duplicating money or successful child rows. Organization-level entry uses existing import workflow with explicit company/project destinations and permission checks; no fake destination project is required. Receipt links navigate to actual records/projects, including multi-project allocations. Failed-only runs remain inspectable. Repeated viewing reads persisted results rather than recomputing from submission. Authorization and partial-failure SQL tests pass; no credentials/full provider payloads are retained in receipts.

### Q12 — Conflict comparison and authorized correction workflow (L, high risk; depends Q02, Q05, Q06, Q10)

Scope: provider-neutral conflict read/resolve service, QBO snapshot translation, sync sheet comparison UI, existing financial correction actions/RPCs.

DoD: comparison displays baseline/local/current remote revision, amount/balance/date/coding/lines/project allocations and linked settlements. Fetch failures are explicit. Decisions require the same current conflict and remote/local version displayed; a changed revision invalidates approval and reloads. Keep-local and take-remote preserve historical remote ownership and existing freeze/authority checks. Posted-payment/allocation correction uses existing reviewed reversal/reallocation domain operations, never generic overwrite; irreversible consequences are previewed. Payments have an actionable resolution path beyond Retry. Duplicate/cancellation/concurrency tests prove audit evidence and one correction. Closed periods cannot be bypassed.

### Q13 — Tax/item/account setup preflight (M, medium risk; depends Q02, Q06)

Scope: QBO settings schema/provider methods, connection/settings UI and invoice-item actions; reuse existing product/service selectors.

DoD: taxable/exempt code settings accepted by strict schemas are actually configurable and validated for the selected realm. Active item/account mappings are checked before the first posting; stale/inactive refs have replacement actions. Preflight explains supported country/currency/document/tax modes and required mappings. Settings refresh means metadata refresh; token refresh means authentication. Repeated line refs resolve once per distinct reference per delivery, with connection-scoped cache and explicit invalidation; changing settings cannot reuse another company's ref. No unattended remote account/item creation to hide configuration errors. Negative preflight cases make zero financial POSTs.

### Q14 — Customer credit memo, write-off and refund parity (L, high risk; depends Q02, Q06, Q12, Q13)

Scope: provider contract/capabilities, QBO adapter/import/reconcile transaction-family modules, `receivable-adjustments.ts`, established refund/settlement services, enqueue/job types and required registry/migrations/tests.

Current state: customer credit/write-off changes flag an invoice for review and instruct users to apply matching credit externally; vendor credits already have dedicated transport. Confirm exact domain refund representation before coding.

DoD: define and implement a certified supported matrix for credit memos, application to invoices, write-offs and customer refunds. Actual QBO CreditMemo/RefundReceipt or appropriate supported operations preserve tax/item/account/customer refs and canonical adjustment identities. No refund is fabricated as an ordinary payment or silently moves bank money; external bookkeeping mirrors only authorized existing economic facts. Imports/replays/outbound uncertain response recovery preserve one adjustment/refund and correct invoice balance. Credit-before-payment, partial application, unapplied credit, reversal, cross-year date and closed-period cases pass golden fixtures. Unsupported provider/country combinations show explicit capability errors. Provider contract, queue registries and review UX include the new types. If domain cash-refund settlement is absent, implement the deliberate domain workflow first; do not mark a capability complete with a generic export or manual instruction.

### Q15 — Durable write idempotency and efficient recovery (M–L, medium risk; depends Q01, Q07, Q14)

Scope: provider-neutral operation identity/delivery contract, QBO write transport, relevant additive migration and recovery fixtures.

DoD: verify current Intuit requestid behavior/retention limits from primary docs and sandbox fixtures. Persist a distinct operation-scoped request ID and payload revision before sending; network retry uses the same ID, authorized recreation/new revision uses a new operation. Never use a transaction-wide forever key or timestamp regenerated on retry. Preserve marker-based recovery for historical writes and expired/ambiguous provider dedupe windows. In the new supported retry fixture, recovering a response-lost create requires no full-history scan and produces one remote document. Unexpected provider semantics fail closed with visible recovery, rather than claim exactly-once delivery.

### Q16 — Transaction-family modules and measured efficiency (L, medium risk; depends Q03–Q15)

Scope: QBO adapter/import/reconcile splits and shared translators; keep facade exports/provider contracts stable.

DoD: break transaction families into cohesive modules, share canonical invoice/line/money translation and remove duplicate implementations. Transport, domain mutations and UI DTOs remain separate. No new any/as escapes or speculative generic framework. Existing behavioral fixtures run unchanged against the public facade. Reference lookup request count is proportional to distinct refs, not number of lines; a 100-line invoice using one item performs one item lookup per dispatch. Import preview pages contain at most 200 rows and at most 1 MiB serialized JSON for the supported synthetic fixture. Traversing a 25k-record history is resumable rather than a single unbounded action. Peak additional heap for the 25k lightweight fixture stays below 128 MiB; measure baseline, rows and payload bytes at 1k/10k/25k. Import execution concurrency defaults to at most four items and is bounded further by per-realm transport limits. Concurrent requests are bounded per realm (default at most two in flight); the controllable-clock limiter fixture admits no more than eight starts per realm per second across cooperating workers. Raising global concurrency alone is not a fix. Record before/after calls, queries, wall time, fixture/runtime/sample sizes and peak memory where measurable. Require no regression and a demonstrable request/query reduction in the named repeated-reference and recovery cases.

### Q17 — Documentation, end-to-end fixtures and release evidence (M, low/medium risk; depends Q02–Q16)

Scope: help/docs, existing test/CI registrations, goal checklist and reviewed migration inventory.

DoD: help names real controls and accurate directionality/latency/supported entities. Duplicate guidance starts by identifying the obligation; it does not recommend renumbering to bypass warnings. Isolated UI/action/provider journeys cover reconnect, setup preflight, partial multi-project import, scoped pagination, both webhook formats, conflict comparison and credit/refund lifecycle. Run full lint/typecheck/financial/auth/Node/Bun suites and isolated migration/RLS tests. Exact additive migrations have forward replay and privilege checks; pending D2 destructive cleanup remains separate. CI application build passes. Record unapplied production migrations/rollout sequence and rollback compatibility without claiming deployment or production health.

## Dependency order

Start Q01. Then Q03 and Q07; continue Q08/Q09. Q02 requires a dedicated database rehearsal before Q10–Q14. Q04 → Q05 → Q06 establishes financial fidelity. Q10 → Q11/Q12 and Q13 prepare the missing workflows. Q14 → Q15 → Q16 → Q17 completes feature and efficiency acceptance. Coordinate source ownership; one executor at a time unless explicitly splitting disjoint files. Do not let a module refactor precede characterization tests.

## Global definition of done

- Every Q01–Q17 code DoD has passing reproducible evidence; no TODO/stub/manual instruction is counted as an implemented capability.
- No unknown fetch/read/import result is reported as successful synchronization.
- No duplicate economic fact under retry/concurrency/out-of-order/response-loss fixtures.
- No posted-money, closed-period, tenant/division, company identity or ledger-authority invariant regresses.
- Explicit synthetic request/query budgets pass; performance claims include fixture and environment.
- Full typecheck/lint/test gates and isolated database contracts pass; CI owns build acceptance.
- New user surfaces include loading/empty/error/recovery, action-level authorization and truthful receipts.
- Refactored code preserves public provider contracts and removes displaced implementations.
- Shared-source integration is reviewed against baseline hashes and preserves unrelated work.
- Production rollout requirements are documented separately; no local code-completion claim implies production deployment.

## Stop/escalation conditions

Stop the affected package and report concrete evidence if it needs production data mutation, has unresolved provider semantics that could duplicate cash, requires replacing conflicting shared changes, cannot model closed-period corrections, or discovers a new ledger authority decision. Continue independent packages. Do not treat difficulty or pending optional preferences as blockers. Never apply migrations or contact third parties just to obtain evidence.

## Considered and rejected

- Replacing QBO or the durable queue platform: unnecessary; preserve and improve existing investment.
- Implementing every QBO entity: scope is missing construction/bookkeeping workflows with domain support, not API breadth for its own sake.
- Silencing mismatch by changing project allocations or renumbering obligations: hides financial discrepancies.
- Blanket multicurrency enablement: explicit USD/currency guards first; currency conversion needs a separately complete accounting contract.
- Increasing all worker concurrency: require measured per-realm budgets and bounded work.
- Treating old production receipts as current acceptance: this goal needs fresh code/fixture/CI evidence.

## Latest verified implementation milestone

Q02 security/admin/routing artifact `b76eb3a` remains integrated and verified. During Q04 actual import tracing, parent reproduced authenticated mapping/event completion failures under the exact Q02/Q03 grants. Q02-06 existing-flow acceptance is reopened; six original clauses remain verified. The single executor is repairing owned import closure and authorized allocation preflight under the additional scope recorded in [014b](014b-qbo-authorization.md). Production SQL is unapplied.

Q03 parser `d8b97bc` and durable receipt closure `738bf7d5aab89d360c5b03a20c131cabbab516db` are integrated. Parent verified exact source/destination bytes,264/264 isolated and independently repeated shared Node tests,55/55 Bun across five QBO files, changed-file lint/fulltypecheck/diff0. Receipt SQL stores every distinct provider ID on the semantic CDC/webhook fact, preserves terminal fields, rolls back failures, and avoids metadata updates on identical replay. The original eight Q03 code clauses are verified; full acceptance still requires actual two-session PostgreSQL contention evidence in Q17. PGlite serialized replay is explicitly not that evidence. In the named80event fixture, actual old/new TS plus SDK measured80→1 database requests, the same41 newly queued facts, and40 retained delivery IDs rather than zero. Exact SQL/signed HTTP fixtures independently reproduce intake dispatches and durability. Historical pre-parser high-precision timestamp IDs can differ on replay; retain revision guards.

Q07 is DONE: scoped `a2ed029` plus nested SQL/full-cron closure `b1a7e9a84beab258b9dfaf1976d3bbcb6db06485` are integrated. Parent read all11 closure files and1305 test lines and independently verified302/302 isolated/shared Node,55/55 Bun,fulltypecheck/changed-filelint/diff0 and exact shared bytes. Actual SDK headers/bodies, tenant/caller cancellation, nested CDC/events/exhausted services, cron telemetry, expired SSR refresh, fixed identity persistence grace and100 lease cleanup cutoff are covered. No new provider/claim work after85 seconds; required owned-state SQL/telemetry shares the90-second final cutoff. SDK-local Auth retry sleeps may finish later, with late rejection observed and no later HTTP or session deletion. The prior exhausted-claim negative baseline now has zero-dispatch passing replacement tests.

The full goal remains active with22 of125 original code clauses verified. Q04 full CDC completeness and durable resumable recovery is dispatched under [014e](014e-qbo-cdc-completeness.md); Q08 reconnect handoff is prepared under [014f](014f-qbo-reconnect-recovery.md). No production migration/deployment or shared git commit occurred. Receipt rollout must install additive migration20261005040538 before RPC-based application; previous intake remains compatible.

Known combined rollout dependency (planning only, no execution): Q02 requires service-owned application paths before tightening authenticated grants; Q03 requires its RPC SQL before switching webhook intake. Q17 must prepare and verify compatible staged application artifacts: deploy Q02-compatible services while retaining the previous webhook intake, install the additive authorization and receipt migrations in normal migration order, then enable/deploy the reviewed RPC webhook intake. The unavailable Q02 count RPC fails closed until its SQL arrives. A blanket “all pending SQL first” or “all final app changes first” sequence does not satisfy both dependencies. An alternative selectively staged migration order needs its own reviewed migration-history handling; none is authorized or executed here. Reconcile this with every other pending migration before a separately authorized rollout.

Current rollout preparation must include the approved import completion/routing-preflight repair before grant tightening, plus additive owned completion RPC availability. The earlier blanket statement that Q02 service callers were complete was too broad; actual import acceptance remains open. No rollout was executed.

Q15 full execution handoff prepared: [014p](014p-qbo-operation-request-ids.md). Parent actual client2/2 negative probes establish absent durable request IDs and26 historical queries over25k records. Rendered primary Intuit pages verify identical-request replay but do not specify a retention duration; actual sandbox verification remains required. All six original Q15 clauses remain false. Current Q05 draft parent44/44 targeted passes now include atomic mutable-bill rollback/history/source guards and full expense outbound seams; actual inbound, real contention and final artifact gates remain outstanding. Current acceptance stays28/125.

Q16 full handoff [014q](014q-qbo-modules-measured-efficiency.md) and [measured baseline](014-qbo-efficiency-baseline.json) prepared. Parent27uniform measured runs execute actual client and QBO preview function at1k/10k/25k;25kpreview returns12,177,845bytes/25HTTP/sixsyntheticSQL with48.71MiB observed additional heap. Separate actual same-realm held-fetch negative1/1 demonstrates10concurrentrequests. No exhaustive peak, current financial/permission/provider-neutral action/UI or distributed rate proof; all13Q16clauses false and acceptance28/125 unchanged.

Q05 parent changing-draft verification: exact comparison SQL3/3 and actual inbound force facade/full SQL4/4 pass with scoped synthetic/minimal-financial fixtures; malformed reference Active flags reproduced1/1 negative. [014h](014h-qbo-bill-line-fidelity.md) records approved guarded import/native full baseline seams and the remaining complete gates. Acceptance remains28/125; no new source integration or production rollout.
