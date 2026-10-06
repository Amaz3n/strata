# Arc Books: completion plan and definitive finish line

**Plan 013 · user-requested full-scope completion plan · 2026-10-04**  
**Baseline:** commit `9f1549af` plus the uncommitted shared workspace.  
**Owner:** main task, “Assess Arc Books readiness,” thread `01a0ff13-c07c-7fd2-8488-200bfc787322`.  
**Status:** PLAN READY; implementation and release acceptance remain IN PROGRESS. This document does not claim that its acceptance criteria have passed.

## 1. Mandate and meaning of 100%

Complete the entire October 2 Arc Books assessment implementation objective. Preserve workflow-integrated accounting: billing lives in billing, payables in payables, expenses in expenses, labor/payroll in Project Time, production accounting in land/lot/home/closing workflows. Books supplies shared policy, ledger, reconciliation, reporting, close and accountant controls. Do not make operators re-enter a workflow transaction in a separate accounting screen.

The finish line is **all work packages below verified, the current application schema accepted, recovery demonstrated, and external builder/CPA acceptance recorded**. A narrow single-entity release may be a useful intermediate milestone; it cannot complete this goal, which explicitly includes legal entities, intercompany and consolidation.

“Implemented,” “tested in a small SQL fixture,” “migration written,” “safe blocker added,” and “released” are different states. A normal in-scope builder transaction rejected as unsupported is unfinished capability, even if rejection prevents incorrect accounting. A genuine invalid or unprovable transaction must remain blocked with a practical evidence/remediation workflow.

Specialized banks, payment networks, payroll calculation/remittance providers and tax-filing partners may remain external rails. Arc must own the accounting records, reconciliations, review and correction history. Native payroll tax calculation, foreign currencies, manufacturing inventory, and another live GL adapter are not added to the October objective by this plan. Older plans remain background; relevant accounting requirements are carried forward below. Their unrelated future product aspirations do not silently expand or shrink this goal.

### Mandatory program exit gates

- [ ] **G1 — Scope:** every package `B00`–`B16` and each numbered subpackage is DONE with evidence. No waived core requirement, normal transaction hidden behind “unsupported,” or critical unresolved defect.
- [ ] **G2 — Accounting:** the golden scenario suite ties trial balance, financial statements, AR/AP/retainage, banks/cards, job costs, WIP/inventory, payroll, taxes, assets/debt and entity/consolidation controls to exact cents.
- [ ] **G3 — Database:** a fresh isolated application-schema replay and an upgrade from the retained baseline both pass the complete current migration train, ACL/RLS tests, pgTAP and concurrent transaction tests.
- [ ] **G4 — Product:** actual authenticated application journeys pass through browser → action/API → database → reports → audit, including refresh, retries, permissions and mobile. Adapted SDK/context fixtures alone do not satisfy this gate.
- [ ] **G5 — Recovery and capacity:** restore the populated acceptance company and original supporting bytes into isolation; reproduce reports and continue normal operations. The declared large-builder workload meets the budgets in B09/B06.
- [ ] **G6 — External accounting acceptance:** documented independent licensed-CPA review and real-builder parallel-close evidence satisfy B16. These are external evidence requirements, never synthetic achievements.
- [ ] **G7 — Release:** reviewed application/migration rollout, monitoring, rollback/recovery and organization activation gates are complete. No blanket permission to alter customer data is granted by this document.

Technical completion may reach “G1–G5 ready; external acceptance pending.” **The full goal remains active until G6–G7 also pass.** If outside participation prevents further meaningful work, accurately record the dependency rather than mark the goal complete.

## 2. Current-state evidence and immediate resumption

Read these files before implementing; revalidate live code because the workspace is shared:

- `docs/books-implementation-progress.json`: chronological implementation checkpoints. Its top-level remaining list contains superseded entries; reconcile against later checkpoints instead of interpreting every historical bullet as current.
- `docs/books-full-schema-acceptance.json`: exact executed schema hashes and acceptance scope. The earlier 467-migration / 490-assertion checkpoint is not acceptance of the latest migration train.
- `docs/books-restore-runbook.json`: recovery evidence and limitations.
- `docs/plans/arc-books-sole-ledger-release.md`: operational release boundary and remaining gates.
- `docs/books-cash-report-policy.json`, `docs/books-revenue-recognition.md`: cash/tax and accrual policy evidence; update outdated statements as the relevant package finishes.
- `docs/plans/arc-books-gameplan.md`, `docs/plans/arc-books-ten-gameplan.md`, `advisor-plans/001-arc-books-qbo-independence.md`: background requirements, not proof of current behavior.

Latest completed checkpoint records **505 Books Node tests**, an initial attribution browser fixture and correction-posting browser fixture passing. Those tests use scoped PGlite and explicit authorization/transport/storage fixtures; they are not complete application-schema or live-R2 proof.

The main task stopped while adding saved payment-attribution history. Inspect and finish, rather than duplicate:

- `supabase/migrations/20261004082928_books_payroll_payment_workspace.sql` — new paginated private read RPC, not accepted against the full application schema.
- `lib/services/books/payroll-payment-workspace.ts` — history/detail/review/withdraw service scaffold, not yet a verified complete feature.
- `app/(app)/projects/[id]/time/payroll/actions.ts` — added history/review/withdraw actions.
- `components/time/payroll-payment-attribution.tsx` — currently creates attribution but does not yet complete saved-history review and refresh recovery.

On the planning read, `lib/services/catalog-group-categories.ts` now exports the symbol previously reported missing by TypeScript. Therefore **rerun the baseline**; do not repeat the old Design Studio failure as a current fact or modify unrelated work from a stale log. Docker availability is also unknown: earlier bounded engine reads timed out despite the user reporting it running. Diagnose current authoritative state without restarting a daemon just because a read timed out.

### Verified code anchors for architectural continuity

- `lib/services/books/dimensions.ts:6`: `loadBooksProjectDimensions` derives only unambiguous relationships. Keep ambiguity explicit; extend it with durable posted dimensions rather than guessing a lot/contract.
- `lib/services/books/revenue-basis.ts:39`: `loadProjectRevenueBases` takes an accounting cutoff. Current cutoff handling still needs durable superseded-policy/status evidence.
- `lib/services/books/revenue-recognition.ts`: recognition requires exact period-end snapshots and cumulative deltas. Preserve those invariants when expanding contracts and policies.
- `lib/services/books/period-close.ts:831`: `closeAccountingPeriod`; `:1030`: `closeFiscalYearToRetainedEarnings`; `:1092`: `reopenAccountingPeriod`. Audit their whole lifecycle, not just an individual posting helper.
- `lib/services/books/exports.ts`: uses `gzipSync`; scaling must replace in-memory document/archive assembly without weakening snapshot or byte integrity.
- `lib/services/books/payroll-payment-workspace.ts:24`: `readProjectPayrollPaymentWorkspace` validates stored evidence. New history reads must retain this integrity check while avoiding fresh blobs merely to view history.
- `lib/services/books/payroll-payment-reviews.ts`: new review verifies original bytes and current source evidence; confirmed retries must preserve the recorded historical intent.

Line numbers are planning anchors, not instructions to patch by line number. Check symbols and source hashes after drift.

## 3. Execution rules, evidence and completion tracking

### Global definition of done — applies to every subpackage

Every feature or fix must satisfy these checks in addition to its specific DoD:

1. **Behavior:** normal, correction, reversal, retry and historical-cutoff behavior are specified and implemented. Exact integer cents throughout; BigInt/decimal calculations where sums or products exceed safe floating-point operations. No silent fallback to mutable current data for missing historical proof.
2. **Ownership and access:** organization and legal-entity scope are enforced server-side; project/division permissions remain respected. Accountant-wide access does not leak through operational project pages. Salary, full TINs, credentials and supporting private files remain protected.
3. **Transactions:** immutable posted history; atomic related money writes; fresh dependency checks under locks in the same transaction. Idempotent committed-response recovery returns the original result, while changed intent conflicts. Race behavior is proven with independent database sessions.
4. **Construction integration:** the operator can reach and fix the issue from the source workflow. Shared status/reports refer to the same fact, journal and subledger grain. Accounting corrections do not unexpectedly change customer billing.
5. **Verification:** pure rules, actual SQL/ACL/RLS and actual service transport are tested at their relevant boundary. User-facing changes additionally pass real authenticated browser journeys, including denial, stale evidence, refresh and relevant failures.
6. **Presentation:** Arc components/tokens; accessible labels and keyboard use; empty/loading/error states; light/dark and 390px mobile layouts; exact amount/sign display; no browser exceptions or hidden truncation.
7. **Continuity:** affected export, restoration, close, reporting, correction and entity contracts are updated and verified. Earlier valid archives and exact historical receipts retain their meaning.
8. **Evidence:** retained log/artifact paths, SHA-256 hashes, scenario IDs, commands, runtime versions, migration identities, observed balances and residual limitations recorded. A checkbox without evidence is incomplete.
9. **Documentation:** accounting entry set, policy choices, operating/remediation instructions and release limitations match the implemented behavior.

### Status model

Use `NOT_STARTED`, `PARTIAL`, `IMPLEMENTED_UNVERIFIED`, `LOCALLY_VERIFIED`, `APP_ACCEPTED`, `EXTERNALLY_ACCEPTED`, `DONE`, or `BLOCKED_EXTERNAL`. Existing code is reused; these statuses do not mean it should be rewritten. `DONE` means all applicable DoDs passed, not that a PR was opened.

The companion `013-arc-books-completion-checklist.json` is the machine-readable requirement/evidence register. Update each item with evidence and outstanding criteria as implementation proceeds. Do not mark an entire workstream done because one subpackage is green. The historical ~60% estimate is provisional; derive future progress from the reconciled register. “100%” requires every applicable item DONE and all G gates passed, irrespective of any weighted estimate.

### Evidence record required per item

`id`, `status`, `implemented_paths`, `test_scenario_ids`, `commands`, `observed_results`, `artifact_paths_and_hashes`, `schema_or_runtime_identity`, `verified_at`, `remaining_criteria`, `external_dependency`, and `reviewer` where review is required. Keep progress/acceptance/restore records consistent; do not overwrite old evidence to make a later checkpoint look historically complete.

### Existing verification commands

Run the focused tests after each meaningful accounting change. Run the broad checks at package/phase boundaries and after new shared failures; do not rerun them pointlessly.

| Command                                                                                                                                    | Required result / actual scope                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `node --test tests/books-*.test.js`                                                                                                        | All current Books Node tests pass; scoped fixture evidence only.                                                                 |
| `pnpm test:financials`                                                                                                                     | All financial regression tests pass. New critical tests must join the relevant CI/test catalog.                                  |
| `pnpm test:books:payroll-ui`                                                                                                               | Existing payroll correction browser regression passes.                                                                           |
| `BOOKS_PAYROLL_ATTRIBUTION_BROWSER=1 node --test --test-name-pattern='intake browser' tests/books-private-payroll-storage-service.test.js` | Existing initial attribution browser fixture passes; does not replace authenticated full-app acceptance.                         |
| `pnpm typecheck`                                                                                                                           | Exit 0 on the final integrated workspace; characterize unrelated failures at interim checkpoints.                                |
| `pnpm lint`                                                                                                                                | Exit 0 for release; scoped lint is useful during execution but not a final substitute.                                           |
| `pnpm test` and `pnpm build`                                                                                                               | Exit 0 in release verification; build is implementation work, not something this advisory session executes.                      |
| `pnpm verify`                                                                                                                              | Complete repository verification pipeline passes before release, including accounting D2, repository health and security checks. |

Existing database/restore runners: `scripts/test-books-bank-integrity.mjs`, `scripts/test-books-opening-continuity.mjs`, `scripts/test-books-cash-income-full-schema.cjs`, `scripts/verify-books-export.cjs`, `scripts/preflight-books-restore.cjs`, `scripts/prepare-books-restore.cjs`. Read their current argument contracts before invoking; use an isolated database/container identified by B00.

**New runner to implement:** `scripts/test-books-release-acceptance.cjs`. Proposed interface: `node scripts/test-books-release-acceptance.cjs --database-url-env BOOKS_ACCEPTANCE_DATABASE_URL --scenario <ID|all> --evidence-dir <directory>`. It must refuse a nonisolated/customer target, never print credentials, seed deterministic fixtures, assert actual results, preserve evidence and clean up safely. These flags are a target interface, not a claim that the runner exists today.

### Boundaries

Preserve unrelated shared-workspace changes. No destructive schema reset against an existing app/customer database, mass reprojection, provider charge/refund/remittance, connection disconnect, external message to a builder/CPA, or production rollout is implied by this plan alone. Implement and prepare reviewable results first; use existing explicit authorization where it applies and obtain required authorization for remaining external effects. Isolated local acceptance is part of this implementation scope.

Do not stop the whole program because one package needs external evidence. Finish the remaining independent work and label the dependency accurately. Do not invent historical financial evidence to get a gate green.

## 4. Workstream map and ordering

| Workstream | Original requirement                                     | Priority | Effort     | Primary dependency                        |
| ---------- | -------------------------------------------------------- | -------- | ---------- | ----------------------------------------- |
| B00        | Establish current truth and acceptance infrastructure    | P0       | M          | None                                      |
| B01        | Year-end, period close, reopen and failure recovery      | P0       | L          | B00; final integration B03/B04/B12/B13    |
| B02        | General invoices, income allocations and adjustments     | P0       | M–L        | B00/B03/B11                               |
| B03        | Historical AR/AP/retainage and opening ownership         | P0       | L          | B00                                       |
| B04        | Complete reviewed WIP/POC                                | P0       | L          | B03/B07/B11                               |
| B05        | Filing-grade 1099 evidence and pagination                | P1       | M          | B03/B08                                   |
| B06        | Scalable complete export and proven restoration          | P0       | L          | B00; final integration all money modules  |
| B07        | Durable accounting dimensions and statement drilldown    | P0       | L          | B00; entity integration B14               |
| B08        | Bank/card continuity and real settlement ownership       | P0       | L          | B03/B07                                   |
| B09        | Scalable projection and integrated actionable status     | P0       | L          | B00/B03/B07                               |
| B10        | Complete cash-method reporting and tax adjustments       | P0       | L          | B02/B03/B08/B12/B13                       |
| B11        | Explicit revenue policies and closing accounting         | P0       | L          | B03/B07                                   |
| B12        | Loss contracts and capitalized-cost impairment           | P0       | L          | B04/B11                                   |
| B13        | Full reconciled payroll lifecycle                        | P0       | L          | B00/B07/B08/B11                           |
| B14        | Legal-entity ledgers, intercompany and consolidation     | P0       | XL         | B00/B07; decision must occur early        |
| B15        | Migration → first transaction → twelve-period acceptance | P0       | L          | All relevant implementation packages      |
| B16        | Policy, operating docs, external acceptance and rollout  | P0       | L/external | All packages; prepare CPA materials early |

Dependencies apply to final integration; they need not force every prototype into a serial waterfall. Do not launch subagents solely because this plan mentions independent work.

### Recommended phases

1. **Establish truth:** B00.1–3; decide B14.1 early so remaining money features share the correct entity boundary. Finish the interrupted B13.1 history work with tests.
2. **Historical foundation:** B03, B07, B14.1–2, B11.1. These underpin trustworthy cutoff reporting, policies and ownership.
3. **Complete daily workflows:** B02, B08, B09, B13.2–5 and operational cash policies in B10. Keep the already proven correction paths green.
4. **Complete construction accounting:** B04, B11.2–3, B12; integrate payroll corrections and inventory with budget/GMP/billing/WIP.
5. **Complete accounting administration:** B01, B05, B10 tax/report delivery, B14 intercompany/consolidation and B06 capacity/recovery.
6. **Acceptance and release:** B15, final B00 replay, B06 restored operation, B16. Begin CPA review and prepare builder participation while engineering proceeds; do not claim external results in advance.

## 5. Detailed implementation packages and definitions of done

Every subpackage inherits the global DoD. Paths below are starting points; inspect direct callers and shared policies before editing. Create new narrow modules only where the existing service cannot safely own the behavior. Tests must assert independently specified accounting outcomes, not duplicate the implementation formula.

### B00 — Restore an authoritative verification baseline

**Current:** substantial code and scoped tests; older full-schema evidence; interrupted new payroll scaffolding; current Docker and TypeScript state need revalidation. **Impact/risk:** P0, high confidence in the evidence gap; M effort, low risk for inspection, high risk if a wrong database is targeted.

**B00.1 — Reconcile requirements and workspace drift**

- Read this plan, the three JSON ledgers and latest code. Map every current remaining bullet to one item here; retain a disposition for duplicates/superseded statements. Inventory pending migrations, direct callers and affected test catalogs. Verify the interrupted payment-workspace scaffolding before advertising it.
- Run current typecheck and focused Books verification. Record current failures separately from old logs and unrelated changes. Save source/migration hashes and runtime versions; never reset the shared tree to manufacture a clean baseline.
- **DoD:** each original scope item maps to a package; every later checkpoint has an evidence scope; all observed failures have an owner/package; no undocumented partial work; baseline artifact can be reproduced from the live source hashes.

**B00.2 — Accept fresh and upgrade schema paths**

- Discover current Supabase CLI commands through help. Inspect Docker/container/DB identity with bounded observations. If available, use a disposable isolated target; replay the complete current train and independently upgrade a baseline dataset.
- Verify schema, indexes, constraints, trigger order, generated columns, function search paths, RLS and service-only privileges. Include ordinary document writes, legacy imports and all new payroll/tax guards. Characterize/fix actual migration failures rather than bypassing them.
- **DoD:** clean replay and baseline upgrade both exit 0; all current pgTAP tests run, not merely prepared; zero unresolved relevant security/advisor findings; no customer/app DB altered; exact input hashes and assertion counts saved. Retry observations of confirmed live operations; do not restart solely on timeout.

**B00.3 — Build the golden acceptance runner and durable evidence catalog**

- Implement the new runner interface above, scenario fixtures and protected-target checks. Preserve expected journals/control balances as reviewed fixtures. Add CI jobs for rules, actual Postgres/pgTAP, real browser and restore; use genuine independent Postgres sessions for races.
- **DoD:** intentionally incorrect accounting causes a nonzero run; missing scenarios/evidence fail verification; every B15 scenario is registered; logs retain identities and exact cents but no secrets. A failed run is diagnosable and a rerun does not duplicate money.

**Verification:** current existing commands in §3 plus the new B00 runner. A unavailable engine is a recorded external-state dependency, not successful database acceptance.

### B01 — Finish period close, reopen and year-end as a complete state machine

**Start:** `period-close.ts`, `close-review.ts`, `close-control-rules.ts`, `revenue-recognition.ts`, `reconciliation-digest.ts`, `components/books/close-workspace.tsx`, actual close/posting RPC migrations. Close-owned year-end postings and period fences exist; whole-close failure recovery remains unproven.

**B01.1 — Atomic or durably recoverable close orchestration**

- Inventory all steps: checks, WIP revenue, loss provisions, presentation reclasses, depreciation/register requirements, statements, period marker and audit. Use one transaction where practical; otherwise persist an explicit close attempt with deterministic steps/receipts and safe resumability. Define visibility of partial attempts; never display a fully closed period before its required artifacts exist.
- Inject failure after each money and snapshot step, including a lost successful response. Revalidate checks under the authoritative period fence; source mutations cannot race between preflight and close.
- **DoD:** no failed attempt is shown closed; every injected failure rolls back or resumes deterministically to the identical final ledger; retries post no duplicate revenue/loss/reclass/year-end entries; snapshots and period digest reference the successful attempt; pending recovery is visible and actionable.

**B01.2 — Correct year-end closing and ordered reopen/reclose**

- Close all supported income/expense accounts into correct entity retained earnings; exclude balance-sheet controls. Support custom accounts and fiscal-year boundaries. Govern reopen by permissions, reason and dependent subsequent closes; preserve prior snapshots and approvals rather than rewriting them.
- **DoD:** beginning RE + annual net income ± separately recorded equity movements ties ending RE; P&L resets correctly in the next year; custom-account and zero-income years work; same-intent retry creates one entry; reopening/reclosing with a late adjustment produces only the necessary deltas and preserves original history.

**B01.3 — Complete close gates and cures**

- Align AR/AP/retainage, banks/cards, payroll, deposits, debt/assets, WIP/inventory/loss, entity and projection checks. Report scan incompleteness as incompleteness. Every blocker identifies original source, amount/date/entity and remediation route in the correct workflow.
- **DoD:** all valid golden scenarios close; each invalid fixture blocks for its precise cause; a normal supported construction case is not blocked merely because its workflow is missing; corrections resolve the correct finding without hiding other open issues; read-only reviewers cannot mutate gates.

**Verify:** Books + financial regressions; B15 `CLOSE-01`, `YEAR-01`, `RACE-01`; browser close/reopen and independent-session late source changes.

### B02 — Complete invoice revenue, allocation and adjustment workflows

**Start:** `invoice-revenue.ts`, `invoice-revenue-rules.ts`, `settlement-evidence.ts`, `posting-rules.ts`, `projector.ts`, project billing pages, general invoice actions, credit/void/revision routes. Native invoice income/cost-code allocation exists.

**B02.1 — One complete native invoice accounting contract**

- Enumerate general and project invoices, progress pay apps, taxes, discounts, retainage, deposits and rounding. Resolve recognition policy explicitly. Freeze document line ownership/account/dimensions and economic version at posting; operational revisions cannot relabel old journals.
- **DoD:** general/service invoices recognize under approved policy; construction POC invoices defer without duplicate income; closing invoices do not also recognize already-posted closing revenue; pretax income + tax + held/collectible portions reconcile to document totals to the cent; custom-income allocations survive credits and later chart changes.

**B02.2 — Credits, writeoffs, voids, returns and collections**

- Build missing operational paths for partial/full credits, void/replacement, writeoffs and actual refunds with exact original document/payment ownership. Define credit application and deposit application independently from cash receipt.
- **DoD:** cross-month partial credit/refund and retainage release reproduce historical AR and revenue; no double fee/tax/income effect; discounts cannot exceed the applicable balance; arbitrary foreign allocations rejected; refresh/retry retains one intent and source workflow shows the correct financial effect.

**Verify:** `tests/arc-books.test.js`, relevant invoice/credit financial tests; B15 `BILL-01`; authenticated project and general billing journeys with actual PostgREST.

### B03 — Make historical AR/AP/retainage and opening balances provable

**Start:** `lib/services/reports/ar-aging.ts`, `lib/services/reports/ap-aging.ts`, `lib/services/reports/aging.ts`, `subledger-settlements.ts`, `retainage-history.ts`, `opening-balances.ts`, `opening-sources.ts`, shared financial ledger-status helpers and AR/AP reports. Revalidate exact loader names with `rg` before editing.

**B03.1 — Durable effective-dated source history**

- Add versioned financial header/status/line/settlement history for changed, approved, rejected, voided, superseded and reopened documents. Record both effective accounting date and recorded time, original author/reason and correction relationships. Preserve first known state explicitly; do not manufacture pre-migration history.
- Define original-as-closed versus subsequently-restated reporting. Opening imports need an attested cutoff and referenced source evidence, not just current document state.
- **DoD:** a later approval/void/rejection/allocation/policy change cannot silently alter an older frozen report; a valid backdated correction creates an auditable restatement/reclose; unknown legacy evidence is explicit and remediable through reviewed attribution; same dated source population drives aging, statements and close.

**B03.2 — Shared historical subledger engine**

- Centralize dated applications, principal, credits, refunds, reversals, discounts, deposits, AP holds and retainage releases. Include supplier/customer credit balances without hiding them in net totals. Use deterministic complete pages and independent journal reconciliation.
- **DoD:** detail aging sums to control GL at every tested cutoff; due-date bands and negatives are correct; future documents/payments excluded; rejected/voided statuses reconstructed at cutoff; over 1,000 records and ties at page boundaries return exactly once; complete source detail survives chart/status changes.

**B03.3 — Opening outstanding-item migration and reviewed legacy attribution**

- Import invoice/bill/retainage/payment/bank/payroll/control opening detail with mappings, supporting originals and maker/checker review. Prevent duplicate GL opening and operational projection. Supply a workbench for unmatched legacy evidence with exact scope and audit.
- **DoD:** approved opening detail totals match the opening batch and bank statements; first post-cutover collection/payment/release clears only the correct item; subsequent close ties; missing or contradictory evidence prevents cutover with a concrete remediation list; no fabricated date or owner.

**Verify:** `tests/books-historical-aging.test.js`; actual opening continuity runner; B15 `MIG-01`, `HIST-01`, `RESTORE-01`.

### B04 — Complete contract-level WIP/POC, including late changes

**Start:** `wip-project-scope.ts`, `wip-period-rules.ts`, `wip-review.ts`, `wip-source-evidence.ts`, `poc-revenue-allocations.ts`, `lib/services/poc.ts`, `components/books/wip-revenue-allocation.tsx`, close review UI. Exact period-end preparation/review, late-change invalidation, carryforward and native income allocation exist.

**B04.1 — Contract and performance-obligation ownership**

- Replace project-wide ambiguous-primary-contract blockers with explicit contract/obligation scope where multiple eligible contracts require separate accounting. Allocate contract price, approved change orders, transaction-price adjustments, cost ownership and EAC under reviewed policy. Do not aggregate unrelated contracts to conceal losses or overbilling.
- **DoD:** two contracts on one project with different bases produce correct independent revenue/WIP/loss and sum to project/GL; shared costs require reviewed allocation; missing ownership blocks only affected scopes with a cure; no contract is selected by row order; policy and accounting-cutoff evidence remain immutable.

**B04.2 — Period evidence, estimates and late adjustments**

- Preserve dated original costs, billings, tax exclusions, credits, estimated completion costs and prior approval. Support revised/reverted estimates, completed-job closeout/carryforward, late costs/billings, negative cumulative deltas and reopened periods. Maintain exact allocation cumulative rounding.
- **DoD:** repeated preparation/approval/recognition is idempotent; a changed source invalidates the exact review; late changes cannot reuse stale approval; estimate recovery/reduction and zero-net account reclassification conserve cents; a historical snapshot does not copy today's state into the past; completed jobs reconcile final revenue/cost/retainage without disappearing from close population.

**B04.3 — Presentation, bonded WIP and operational review**

- Provide contract asset and contract liability presentation under reviewed netting policy, retainage distinguished from those controls, and accountant-ready WIP schedule. Include contract/EAC/change-order/profit/billed/earned/unbilled/loss/provenance columns and source drilldowns. Shared project population must agree between WIP, recognition, reporting and close.
- **DoD:** underbilled and overbilled contracts display separately as required by policy; no inappropriate cross-contract/entity netting; schedule totals reconcile to statements and recognition/loss journals; printable/exported immutable period evidence matches UI; approved-by/date/reason and changed evidence are visible.

**Verify:** `tests/books-wip-*.test.js`, `supabase/tests/books_wip_review.test.sql`, `supabase/tests/books_wip_revenue_allocations.test.sql`; B15 `WIP-01`/`LOSS-01`; real browser preparation/allocation/review/close/reopen.

### B05 — Finish 1099 evidence, review and delivery

**Start:** `tests/vendor-1099-report.test.js`, tax vendor/report loaders, `tax-register.ts`, tax summary rules, payables/payment methods, Vault/TIN service and tax page. Pagination, duplicate removal, dated reversals and card exclusions exist.

**B05.1 — Complete annual payment classification**

- Trace every eligible paid amount to vendor/payee, tax year, service/category, actual payment rail, posted settlement and reversal. Reconcile joint checks, refunds, partial payments, imported amounts, fees and entity ownership. Keep payment-network exclusions grounded in actual rail evidence rather than labels.
- **DoD:** independent reference totals match across annual/period boundaries and over 1,000 payments; duplicate links count once; only qualifying network payments are excluded; void/replacement/refund history correct; unresolved legacy or TIN/category facts block affected filing and identify the cure; separate legal entities do not merge payer totals.

**B05.2 — Filing-ready review and partner handoff**

- Review W-9/TIN exceptions privately, generate immutable year/payer-specific package with preparer/reviewer, map to a documented filing-partner/import contract, retain submission/acceptance/correction evidence. Specialized transmission may remain external; the accounting package must be usable and traceable.
- **DoD:** package totals reconcile to reviewed report and payment evidence; ordinary users cannot retrieve full TINs; provider sandbox/import validates the exact format; corrected package retains original evidence; status distinguishes prepared/submitted/accepted/rejected; a partner outage leaves a downloadable reviewed package without pretending filing succeeded.

**Verify:** vendor 1099 regression + full SQL/entity fixtures; B15 `TAX-01`; actual tax browser and partner sandbox or verified file import. Use applicable-year official instructions, not a permanently hardcoded threshold.

### B06 — Complete scalable exports, restoration and ongoing operation

**Start:** `exports.ts`, `export-contract.ts`, `restore-preflight.ts`, `restore-plan.ts`, `tax-attachment-archive.ts`, existing export/restore scripts and three evidence ledgers. Single MVCC capture, versioned embedded documents and populated partial-module restores exist; synchronous memory use and broad recovery remain.

**B06.1 — Consistent streamed capture and archive jobs**

- Keep one coherent database visibility point across all paginated tables; do not replace a stable snapshot with unrelated page reads. Use a durable background capture/export lifecycle, staged snapshot or repeatable-read worker, streaming compression/document transfer, bounded buffers and resumable attempt identity. Publish only a complete verified manifest.
- Include every original historical version referenced by accounting evidence, not merely a file's current version. Account/entity/actor/scope/secret dependency rules must be explicit.
- **DoD:** source edits during capture cannot mix revisions; crash/resume produces one complete archive or explicit failed attempt, never a partial “complete” file; omitted table/version, changed bytes or unsafe cents fail verification; older supported archive schemas still verify; no full TIN/provider secret enters ordinary export.

**B06.2 — Self-contained recoverable dependency package**

- Supply the permitted organization/user/role/audit/entity dependencies or explicit reviewed dependency mappings alongside the immutable archive. Generated columns recompute; foreign keys, RLS/trigger dependencies and private-file metadata survive. Separate privileged Vault/key recovery from ordinary export; restore provider connections disabled/disconnected.
- **DoD:** preflight names every external/secret requirement before writes; exact source archive remains unchanged; restored actor/audit relationships remain meaningful; file paths cannot escape target or overwrite originals; source bytes hash-identical; no accidental payment/provider activity after restore.

**B06.3 — Full populated recovery and post-restore continuity**

- Restore the B15 company including opening detail, AR/AP/retainage, WIP/close/reopen/year-end, bank/card evidence, assets/debt/inventory, payroll sources/corrections/ownership/settlements, taxes, entities/intercompany/consolidation and private documents. Re-enable normal guards; compare archived and regenerated values deliberately.
- **DoD:** every control and immutable report reproduces to the cent; each sampled document reproduces original bytes; ordinary permissions still work; new invoice/collection/payable/expense/payroll correction/bank close/period close succeed after restore; historical exact retries recover without rewriting money; restore timing and failure restart measured.

**B06.4 — Live storage retention and recovery**

- Verify private R2 original-object retention/overwrite controls, bucket separation, CORS, byte reads and restoration. Audit old public/CDN/cached/issued URL exposure for migrated private payroll evidence; relocating metadata alone is insufficient. Use authorized test objects and document external revocation dependencies.
- **DoD:** unauthorized reads denied at application and storage boundaries; private originals never served from a public cache; immutable keys reject overwrite; download size/hash checks work with actual R2; supported version retention survives application pointer changes; restored objects retain privacy and checksum.

**Capacity target:** B09 large profile; 100 GiB document corpus, at least 10,000 retained originals and a 1 GiB maximum accepted document streamed without whole-object memory load (or an explicit validated source-product maximum if lower). Export worker peak RSS ≤1 GiB, memory not proportional to corpus size, resumable failures, no request-time archive assembly. Recovery target ≤8 hours for this declared fixture including validation; measure rather than assert a production SLA. Adjust only with recorded workload/runtime evidence and human approval if it reduces supported capacity.

**Verify:** actual export/restore scripts; `tests/books-export-*.test.js`, `tests/books-restore-*.test.js`, `tests/books-historical-document-export.test.js`; B15 `RESTORE-01`, `CAP-01`, `STORE-01`.

### B07 — Capture durable dimensions and expose complete drilldown

**Start:** `dimensions.ts`, `types.ts`, fact capture/posting/reversal helpers, `statements.ts`, `statement-detail.ts`, report definitions, financial statement snapshots. Current derivation intentionally avoids ambiguous lot/contract selection.

**B07.1 — Authoritative posted dimension contract**

- Define typed dimension ownership for organization, legal entity, division, community/phase, lot/home, project, contract/obligation, cost code/type, vendor/customer and source/worker where allowed. Resolve from authoritative source at posting; freeze original IDs and sufficient labels/classification. Decide explicit overhead/unassigned values; never assign a random relationship.
- **DoD:** each source family has a documented applicable/required/optional dimension matrix; foreign/cross-entity and ambiguous required dimensions reject posting with a source cure; later project/community/account changes do not relabel historical journals; reversals inherit original dimensions; reviewed legacy mappings remain auditable.

**B07.2 — Statements, comparative periods and source detail**

- Add consistent supported filters/grouping to P&L, balance sheet, TB, GL, WIP, job-cost and cash reports; classify cost of revenue by actual posted cost type. Define measures that can be sliced versus controls that must stay entity-wide. Comparative periods and immutable snapshots use consistent cutoff/policy/version.
- **DoD:** grouped results recombine to the unsliced total exactly; comparative dates work across fiscal years; cost-code/contract/lot drilldowns reach original permitted workflow records; filter permissions cannot expose another entity/division or salary evidence; CSV/PDF and frozen UI run agree; unknown/unassigned dimensions are visible rather than omitted.

**Verify:** dimension/posting/reversal/report regressions; B15 `DIM-01`, `ENTITY-01`; real browser filtered report and source drillthrough.

### B08 — Complete bank/card continuity and settlement workflows

**Start:** `bank-reconciliation.ts`, banking workspace/model/rules, `bank-feeds.ts`, manual import/matching loaders, settlement/payroll services, bank rollforward SQL tests. Normal check/deposit/card multi-cycle SQL tests already pass.

**B08.1 — Imported outstanding items and real clearing**

- Represent cutover checks/deposits/card balances with original amount/date/account/entity/source and review, without creating a second opening posting. Process later clearing/void/reissue and prior-period source corrections; keep grouped deposit/fee splits linked to original cash receipts.
- **DoD:** first statement opening + actual statement activity = closing; ledger balance adjusted by evidenced outstanding items = statement balance; clearing removes the exact item; refunds, fees and card payments neither double-count expense nor cash; missing ownership remains actionable.

**B08.2 — Concurrent statement lifecycle and feed/import resilience**

- Exercise actual independent sessions for match/unmatch/close/reopen/source edits and statement creation. Enforce contiguous periods, one open statement, ordered reopen/reclose and frozen evidence. Test duplicate feed/statement imports, feed interruption and manual fallback.
- **DoD:** racing closes/matches produce one valid state or explicit retry; closed evidence cannot mutate; later-first reopen order enforced; statement reimport does not duplicate transactions; feed failure is visible without preventing valid manual reconciliation; actual provider read-only/sandbox evidence retained.

**B08.3 — Funding account, card and reimbursement truth**

- Ensure each disbursement/provider fee/payroll settlement credits the actual mapped bank or liability. Card purchases create card liability, card repayments clear it once; reimbursable employee costs retain employee payable until actual settlement. Joint-check ownership and vendor remittance detail remain correct.
- **DoD:** two bank accounts and a card produce separate exact control balances; one payable paid across accounts retains ownership; no generic default cash account hides an unmapped source; card repayment does not duplicate expense; independent full workflow tests tie actual payment/statement/GL.

**Verify:** `tests/books-bank-*.test.js`, `supabase/tests/books_bank_rollforward.test.sql`, actual bank runner; B15 `BANK-01`, `RACE-01`.

### B09 — Make projection scalable and workflow status genuinely actionable

**Start:** `projector.ts`, `rebuild.ts`, `paging.ts`, `posting-status.ts`, `posting-state.ts`, reconciliation findings/receipts, background job registry, source invoice/payable/expense/warranty/time/closing screens.

**B09.1 — Complete economic dependency invalidation**

- Inventory economic dependencies per source family: header, line, application, funding mapping, native account/dimensions, contract/policy, cost source, tax, closing and ownership. Maintain monotonic version/receipt semantics and durable events/cursors so each economic change is reevaluated. Harmless notes must not create duplicate money.
- **DoD:** table-driven mutation tests change each listed dependency and get stale/blocked/reprojected status correctly; retired/superseded facts are not reported missing; a failed replacement preserves previous valid monetary history; resolution clears only evaluated source findings; no skipped/capped run reports the company clean.

**B09.2 — Bounded workers, captures and review reads**

- Replace whole-org/per-worker repeated scans with indexed scoped evidence closure, deterministic pages and resumable workers. Selected payroll/WIP proof must remain complete, including relevant ancestry/orphans, even when narrowed. Use leases/checkpoints/backpressure, not unbounded request work.
- **DoD:** >1,000 records and repeated cursor ties return exactly once; interruption/resume and concurrent workers do not skip/duplicate entries; page/query counts scale with selected sources/rows rather than workers × entire ledger; narrowed proof catches orphan/missing facts/journals and yields the same result as full reference fixtures.

**B09.3 — Complete shared operational status and health**

- One reusable status model on billing, payables, expenses, time/payroll, deposits/settlements, warranty and closing/accountant review; show current/posted/stale/blocked/pending with source-specific cure, original journal/receipt and refreshed evidence. Organize company-wide findings in one health surface without moving ordinary work out of its workflow.
- **DoD:** each supported source has an authorized status/cure path; stale receipt never says current posted; resolving one source cannot hide another; error/loading/empty and scoped-denied states verified; status agrees with actual SQL after refresh, retry, correction and close; nonproject sources have explicit permission rules.

**Declared capacity:** large fixture = 1,000 projects, 2 million journal lines, 200,000 operational financial documents, 10,000 workers, 10,000 payroll employees per run, 24 months of history and 10,000 retained liability movements. Commit deterministic fixture generator, hardware/runtime details and query plans. Interactive list/status p95 ≤2 seconds; selected detail p95 ≤3 seconds; expensive full proof/report ≤60 seconds in a background job with visible progress; incremental projection p95 ≤60 seconds after source eligibility and full replay ≤4 hours on declared reference hardware. No cap may silently publish incomplete totals. The current 16 MiB provider-source bound must either support the declared payroll workload by validated streaming or have an explicit batching/format workflow—do not call a small-file-only UI large-builder complete.

These are proposed acceptance budgets for the executor to establish and measure. They are not performance claims about today's app. If evidence shows a budget unrealistic, present a concrete workload/runtime tradeoff before reducing it.

**Verify:** projection/status tests, query-plan/worker fixture, B15 `STATUS-01`, `CAP-01`, `RACE-01`; browser all source families.

### B10 — Complete cash-method statements and reviewed tax workpapers

**Start:** `cash-profit-loss.ts`, `cash-activity.ts`, cash income/cost/expense/settlement helpers, `tax-adjustments.ts`, `tax-attachments.ts`, tax UI/report definitions, immutable report runs/export. Native reconciled cash P&L and independently reviewed workpapers exist; policy coverage and delivery remain.

**B10.1 — Complete source/policy coverage**

- Enumerate every posted cash or P&L source through cutoff. Add explicit treatments for customer/vendor advances, earnest deposits/applications/refunds, credits/writeoffs, retainage, cards, personal reimbursement, manual/other income, fee refunds, payroll funding/fees, assets, debt/equity and bank transfers. Separate ledger cash presentation from tax elections.
- Preserve full dated payment/document allocations, original account classification and historical revisions. Report reviewed unknown legacy treatments rather than omit them.
- **DoD:** independent scenario totals match by month/year; installments/refunds telescope to exact cents; transfers/loan principal/equity are not income; sales tax excluded from revenue; liability settlements do not duplicate expense; every in-scope source has supported provenance and treatment; any unhandled source prevents complete publication with a cure.

**B10.2 — Inventory, prepaids, capitalization and depreciation bridge**

- Implement reviewed book/cash/tax policy records and related schedules for capitalized home/land/development costs, prepaid/insurance recognition, fixed-asset depreciation/disposal and applicable adjustments. Do not automatically equate “paid” with “deductible.” Maintain method/effective-date/reviewer evidence.
- **DoD:** cash paid, book expense, asset balances and reviewed tax adjustment reconcile separately; policy changes preserve prior frozen runs and create explicit restatement/replacement where required; no invented deduction, election or current tax threshold; unresolved policy has a practical accountant review path.

**B10.3 — Full tax workpaper and report delivery journey**

- Finish actual authenticated preparation/review/replacement/withdrawal/no-adjustments confirmation; frozen original attachment picker/download; immutable report-run storage and CSV/PDF delivery. Recheck original supporting bytes at required review/publication boundaries and reject stale basis.
- **DoD:** preparer cannot self-review; source/attachment change invalidates the affected draft; original approval stays meaningful after replacement/withdrawal; report-run UI/CSV/PDF reproduce the reviewed exact period and provenance; actual logged-in HTTP/browser transport works; download is permission-scoped/no-store; recovery reproduces all revisions.

**B10.4 — Independently specified cash reconciliation**

- Expand the reconciliation identity to account for supported non-P&L cash flows and timing bridges; do not retain a simplistic current identity that only works for today's narrow source set. Publish income/cost/control and excluded-flow schedules with source links.
- **DoD:** cash P&L plus the complete classified bridge equals actual frozen cash movement; monthly sums equal annual totals; net-zero correction/reversal chains do not inflate activity; reports after restore and source/GL recoding preserve original meaning; all changes independently reviewed against the policy matrix.

**Verify:** `tests/books-cash-*.test.js`, tax tests and pgTAP; actual cash full-schema runner; B15 `CASH-01`, `TAX-01`, `RESTORE-01`. Tax transmission may remain a partner rail; the reviewed package and traceable acceptance/import are mandatory.

### B11 — Make revenue policies explicit and finish closing/production accounting

**Start:** `revenue-basis.ts`, `lib/financials/project-revenue-basis.ts`, `lib/financials/billing-model.ts`, `revenue-recognition.ts`, invoice/contract/project financial settings, `closings` accounting rules, production inventory/land/warranty services. Current conflict checks and cutoff filtering are useful but cannot substitute for durable policy history.

**B11.1 — Effective-dated policy and contract history**

- Store approved recognition policy by entity/project/contract/obligation with effective date, prior version, preparer/reviewer and rationale. Distinguish billing method from revenue recognition method. Display policy and source effects in project billing/settings and close; provide governed change rather than a mutable switch.
- **DoD:** standalone services, fixed-price construction, T&M, cost-plus, GMP and home closings have explicit applicable policy; later model/status changes cannot rewrite old results; superseded contracts remain reconstructible; conflicting policies are resolved through reviewed scope/ownership; unknown legacy policy has an attribution path.

**B11.2 — T&M, cost-plus and GMP recognition and protected billing**

- Specify entry sets for earned service revenue, reimbursable costs, markup, deposits, caps, approved change orders and cost-plus billable source adjustments. Review whether an existing customer invoice can be changed, credited or requires a future billing delta; never silently rewrite invoiced labor after payroll corrections.
- **DoD:** supported jobs recognize exactly once under the approved policy; invoice and POC/closing paths cannot double-count; caps/GMP/change-order adjustments reconcile; payroll/vendor cost corrections have explicit billing decisions; posted customer billing stays immutable and required credits/new billables are auditable.

**B11.3 — Home closing, land/lot/development/inventory and closeout**

- Confirm closing-basis cost capitalization, common development allocation to lots, approved allocation revisions, applicable capitalized interest and finished-spec inventory. Post closing proceeds/receivable/deposit applications, revenue, inventory relief/COGS, escrow/fees and warranty reserve under a reviewed entry set. Handle canceled/reversed closings and legitimate post-close costs/settlements.
- **DoD:** land/lot/home inventory balances reconcile to original cost ownership; allocation totals conserve cents with reviewed basis; a closing relieves only the sold home's attributable cost and applies only its deposit; reversal reconstructs original balances; late cost uses explicit closed-home policy rather than disappearing or changing historical COGS silently; reserve consumption and inventory/spec aging tie to GL.

**B11.4 — Complete construction cost allocation policies**

- Specify supported shared equipment/overhead/insurance/development cost allocations and cost-type classification where they affect job profitability, capitalization and cash reporting. Allocation journals and subledger adjustments use one source grain and preserve original cost ownership.
- **DoD:** independently reviewed allocation basis/explanation; exact cents conserved across destination jobs/lots and overhead; reallocation corrections keep both legs; no duplicate native time or depreciation cost; statements and budget/job cost/WIP/cash treatment agree.

**Verify:** golden entry fixtures for every policy, actual closing/inventory/posting SQL and source services; B15 `REV-01`, `HOME-01`, `PAY-01`, `DIM-01`; authenticated billing/closing/lot workflow tests.

### B12 — Finish loss provisions and capitalized-cost impairment

**Start:** expected-loss logic in close/revenue/WIP services, chart account subtypes, inventory/asset cost sources and reserve reporting. One-contract cost-to-cost provision/release exists; multiple contracts and capitalized-cost impairment are currently blocked.

**B12.1 — Contract-specific forecast loss and provision lifecycle**

- Calculate loss at the correct accounting unit with reviewed scope and estimates. Separate incurred cost/loss from remaining loss reserve; handle loss emergence, forecast worsening, estimate recovery, completion, termination and reopened periods. Preserve the approved snapshot/policy/lineage.
- **DoD:** multiple contracts do not net one contract's profit against another's required loss; reserve + losses already recognized matches the reviewed obligation under policy; prior postings and reversals counted exactly once; forecast recovery releases only the permitted reserve; close/retry cannot double-post.

**B12.2 — Impairment review before remaining loss provision**

- Add reviewed impairment workflow for affected capitalized contract/home/inventory costs, including asset-level evidence, valuation assumptions and independent approval. Apply impairment/provision sequence and account presentation from the CPA-reviewed entry set. Explicitly distinguish recoverable cost, write-down and remaining loss obligation.
- **DoD:** an ordinary supported capitalized-loss case can complete review and close; no double recognition across impairment and provision; original valuation and review history retained; unsupported reversal of a prior impairment remains governed by the approved policy; loss/impairment schedule and statements tie exactly.

**Verify:** existing expected-loss/WIP SQL tests plus independent contract/asset fixtures; B15 `LOSS-01`, `HOME-01`, `CLOSE-01`; real accountant review and close journey.

### B13 — Finish the full payroll lifecycle in construction workflows

**Start:** `payroll-register-*`, `payroll-worker-labor.ts`, `payroll-allocation-preview.ts`, `payroll-draft-workspace.ts`, `payroll-payment-*`, `payroll-posting-*`, `payroll-correction-*`, `payroll-settlement.ts`, private storage/download services and `components/time/payroll-*`. The reconciliation, atomic initial posting backend, native ownership and correction posting are substantial; the complete initial workflow, provider/funding variants and acceptance are unfinished.

**B13.1 — Finish saved attribution history, detail, separate review and withdrawal**

- Verify the interrupted migration/service/actions listed in §2. Add bounded history/detail UI, selected review identity/permanent link, original decision/document/claim/totals/reviewer evidence, and independent review/withdrawal controls. Refresh must rediscover prepared history without recreating attribution; an existing active decision prevents conflicting preparation. Viewing withdrawn historical evidence must not need fresh blobs or imply current postability.
- Make confirmed review/withdraw/prepare retries recover the exact committed original intent when later source/status changes occur, without bypassing checks for a new transition. Return current/historical status accurately.
- **DoD:** >50 histories page deterministically; foreign project/import/review denied before private evidence; preparer and parent preparer cannot self-review; fresh review checks source and original supporting bytes; stale/tampered proof rejected; prepare/review lost-response retry yields one record; withdrawal retains reviews/documents; browser reload and source withdrawal show correct saved history.

**B13.2 — Supporting evidence intake and valid signed claim journeys**

- Add private supporting PDF/CSV/document upload separate from intended provider register, immutable original version selection, original-byte verification and accountant-only download. Complete positive payment/recognition/reclassification and paired refund/reversal claim input with worker/allocation/two-line ownership. Large old histories need explicit evidenced grouping/search—not auto-exclusion by guessed period.
- **DoD:** real valid positive and paired-refund claims prepare/review through UI and actual SQL; wrong cash/cost/account/direction/worker/project/run claims fail; total source-line capacity cannot be claimed twice; provider-register-alone restriction preserved; claim changes invalidate preview; private upload retry cannot overwrite bytes; original documents survive later versions and restore.

**B13.3 — Initial construction decisions and independently reviewed monetary proposal**

- Provide the missing initial placement/budget/unbudgeted/GMP/billing decisions; support direct-cost, capitalized inventory, overhead and cross-project allocations with exact provider controls. Prepare immutable complete monetary context from proven source/labor/attribution, then require an independent monetary reviewer. Do not confuse source review or attribution review with approval to post money.
- **DoD:** each allocation reaches correct project/cost code/account/budget/inventory/billable grain; user explicitly resolves every required decision; unbudgeted work is reviewed; T&M/cost-plus/GMP decisions follow B11; stale chart/calendar/construction/billing/payment evidence invalidates the proposal; maker cannot approve; proposal reflects complete register controls.

**B13.4 — Actual initial posting and complete lifetime status**

- Connect reviewed proposals to atomic posting/fact/job-cost/billable/ownership/receipt services. Add project/operator and accountant views for draft → reviews → proposal → posted → correction/reversal/history, including actual journal/control movements. A posted register remains discoverable after it leaves the unposted draft list.
- **DoD:** one approved run posts exactly once; mid-transaction failures or late dependency changes roll all related money writes back; simultaneous posts cannot consume native wages twice; committed lost-response retry returns actual receipt; original estimated burden is adjusted to actual without duplicate wages; job cost/GL/WIP/inventory/billing agree; ordinary operators see permitted status without salary details.

**B13.5 — Funding, liability settlement, provider fees and remittance**

- Model individual/multiple funding debits and settlement of net wages, taxes, deductions, employer taxes/benefits, separately accrued obligations, reimbursements and provider fees. Distinguish register recognition, provider payment confirmation, bank clearing and tax remittance. Retain the external payroll provider as calculation/remittance rail.
- **DoD:** gross wages = net pay + employee tax/deductions; each liability rollforward explains accrual, reclassification, payment/refund and unresolved balance; split-date/split-bank debits reconcile to actual bank/card evidence; withholding not reclassified twice; separately accrued benefits not expensed twice; payroll clearing reaches explained zero when obligations are settled; report does not call a ledger movement proof of unpaid status.

**B13.6 — Provider formats and run types**

- Declare a supported intake matrix: canonical mapped CSV plus target real-provider formats, separate control reports, multiple earning rows per employee, salaried overhead, overtime/double-time, bonuses, off-cycle/supplemental/voided/corrected runs, deductions/reimbursements/fees and supported funding variants. Normalize to one exact canonical schema; retain original file, mapping and provider/run identity.
- **DoD:** sanitized original provider fixtures reconcile employee and independent run controls; duplicate/reuploaded runs recover or reject predictably; supported negative/correction cases have explicit documentary lineage; mixed/ambiguous/unbalanced files fail before posting; provider defaults never guess a worker/project; user can finish supported formats through the workflow; declared capacity met. No universal ADP/Gusto/etc. claim without that provider's verified fixture/format evidence.

**B13.7 — Complete coordinated payroll corrections and recovery**

- Extend the proven correction path for cost-plus/protected billing, closed projects/homes, additional liability attribution, tax/provider changes, employee/provider overpayment recovery, supplemental/voided runs and coordinated corrections of consumed native time wages. Respect original reviewed ownership; no independent edit/reversal of consumed economics.
- **DoD:** supported original native-time error has an explicit coordinated correction rather than a permanent blocker; employee/project reallocations preserve both signed legs; refunds/recoveries and amended liabilities reconcile; customer credits/new billables require review; later correction inherits proven latest placement; every original source/review/proposal/receipt survives restore and exact retries.

**B13.8 — Integrate close, cash, entity and reporting**

- Propagate payroll policy/ownership into close gates, cash-method treatment, entity ledgers, reports, exports and recovery. Bound provider/native/liability capture while preserving full proof closure.
- **DoD:** unsettled/stale/corrupt payroll prevents relevant close with a source cure; valid settled run closes; cash payroll expense follows actual reviewed funding/tax policy without deducting one run twice; employee/entity access correct; archived/restored payroll and correction chains prove GL/job-cost/bank/control equality; full app/provider/storage acceptance passes.

**Verify:** all payroll Books tests; existing correction/intake browser commands in §3; full-schema pgTAP; B15 `PAY-01`, `PAY-02`, `RACE-01`, `STORE-01`, `RESTORE-01`, `CAP-01`. Current fixture-only successes are retained as useful evidence, never substituted for these full journeys.

### B14 — Build real legal-entity accounting, intercompany and consolidation

**Start:** current organization/company fields, accounting connection/entity routing (`docs/production-expansion/08-accounting-abstraction-multi-entity.md`), `dimensions.ts`, ledger/posting/schema/report/close/restore services. **Important:** external provider connections or `company_id` customer/vendor fields do not prove a separate native legal-entity ledger. Absence of a file named `entities.ts` is not by itself proof that no entity work exists; inspect the actual model.

**B14.1 — Decide and enforce the native legal-entity boundary**

October 4 prerequisite checkpoint: complete journal proposal intent is immutable; independent approval/rejection receipts support exact committed retries, scope money IDs to the organization, and prevent adoption of previously posted content. Original and optional reversal stay atomic. Native replay, authenticated review inspection, durable event recovery, client intent/preparation retry, and all entity criteria below remain pending. This does not complete B14.1.

- Write an ADR after inventorying current org/company/connection semantics. Define legal entities, ledger ownership, functional currency (USD scope), fiscal calendar, entity chart/control mappings, bank accounts, tax registrations and accountant access. Decide early whether entity is below org or isolated org with controlled consolidation; use an explicit model, not overloaded counterparty IDs.
- **DoD:** one authoritative entity ID can be followed from source → fact → journal → subledger → bank → close → statement → export; every monetary source has exactly one owning entity unless a reviewed split creates explicit legs; cross-entity data access rejected; legacy default entity mapping reviewed and cannot rewrite posted history silently; entity architecture documented and upgrade fixtures pass.

October 4 project ownership archive checkpoint: schema23 captures immutable actual-project ownership proposals/reviews and verifies project/profile/access/document provenance, independent review and legacy posting exclusion. Populated scoped restoration preserves exact receipts, restores guards and permits a subsequent assignment. Legacy population contract2 includes ownership; contract1 retains original bytes and permits fresh review/status comparison only while ownership is absent. Historical completeness is checked at capture/review times. This remains PARTIAL: typed project workflow services/UI, actual native posting, complete source ownership and native/company/golden acceptance remain unfinished. No package or golden is accepted.

October 5 project ownership workflow service checkpoint: typed Books/entity/project-authorized actions now prepare, review and recover actual project assignments. Selected originals require caller-visible files, their actual project/document permissions and exact streamed size/SHA before new writes. Committed retries retain original scoped receipts after later document changes. The private SQL reader checks current entity operation access. Scoped service fixtures pass; authenticated rendering, durable browser intents, actual native monetary posting and native/company/golden acceptance remain unfinished. B14.1/2 remain PARTIAL.

October 5 project ownership workspace checkpoint: private snapshot reader and typed action page readable entity choices and actual project proposals, preserve the approved owner across pages, redact retained owner evidence after entity revocation and combine Books/project/entity write capabilities. Populated pagination and scope fixtures verify this foundation. Project-facing controls/durable browser recovery, actual native monetary routing and full authenticated/native/company/golden acceptance remain unfinished. B14.1/2 remain PARTIAL.

October 5 embedded ownership UI checkpoint: Billing, Payables and Expenses share project-scoped preparation and independent review controls. Original choices respect document visibility/permissions; downloads verify prepared frozen bytes. Expected organization/actor is bound server-side. Complete requests persist before sending, tabs serialize through Web Locks and only matching committed receipts clear recovery. Focused SQL/service/recovery/static render verification passes. Permanently invalid saved intents still need governed server cancellation; authenticated browser/native entity posting and full acceptance remain unfinished. B14.1/2 remain PARTIAL.

October 5 governed recovery and native routing checkpoint: saved project intents now have immutable server-side cancellation or exact committed receipt recovery, with schema24 export/restore. Source-aware plans for actual invoice/bill/expense roots now pin reviewed project owner, identity/chart/calendar approval receipts, native accounts and fiscal period. Explicit semantic roles support different entity control codes; a two-entity fixture verifies January versus April fiscal starts. These are plans only, not persisted facts or journal legs, and the production projector is not wired to them. Atomic native source posting, close/funding/dimension/reversal controls and full authenticated/native/company/golden acceptance remain unfinished. B14.1/2 stay PARTIAL.

October 5 native adjustment checkpoint: independently reviewed project adjustments now atomically retain native facts, canonical entity journal headers and balanced legs, with exact committed retries and deferred completeness enforcement. Typed services require Books adjustment and actual project read permission; private SQL enforces current entity authority and independent review. Append-only posting holds require independent release. Schema25 validates and restores complete original monetary receipts, definition/access provenance and historical holds. Actual two-entity money uses distinct account mappings and January/April calendars. This is a backend adjustment foundation: automatic source economics/projector integration, accountant UI with durable recovery, shared workflow status, full dimensions/funding, reversal/replacement, official close/activation, reports and all native/company/golden acceptance remain unfinished. A fresh native acceptance attempt failed at Docker engine readiness before database creation. B14.1/2 remain PARTIAL; no package or golden is accepted.

October 5 native invoice economics checkpoint: the private reader now captures invoice pricing, authoritative original/released retainage, billing contracts/settings, active approved policy, closed settlement and period hold in the same statement as native ownership/chart/calendar routing. The authorized preview derives progress billings, completed closing revenue and retainage release from those source rows, with no AR for deposit requests. Native income selection must belong to the owner's reviewed chart; exact decimal pricing and source totals tie. Monetary fingerprints remain stable across repeated reads/harmless operational notes. Scoped SQL/services/economics regressions pass. Atomic operational persistence, reviewed native policy exceptions, native account selector/project workflow UI and full acceptance still remain; this does not complete B14.1/2 or any release gate.

**B14.2 — Entity-specific workflows, ledgers, periods and cutover**

- Make billing/payables/expenses/labor/payroll/land/closing sources resolve and display owning entity. Support entity-specific opening balances, charts, books settings/periods, approvals, tax reports, bank mappings and official-ledger activation. Multi-entity user organization remains practical to operate without duplicate entry.
- **DoD:** two entities with different account mappings and calendars produce independent exact TB/AR/AP/payroll/banks/statements; close/reopen one does not incorrectly freeze/unfreeze the other; duplicate source identity scoped correctly; first transaction and cutover work for each; operational project/entity assignment changes after posting require governed correction.

October 5 native invoice browser recovery checkpoint (B14.2 remains PARTIAL): exact
requests and cancellation decisions persist before transport, Web Locks serialize
tabs, and independently verified original receipts are required before clearing
pending data. Actual isolated browser journeys dropped committed SQL responses,
refreshed, and recovered the original posting/cancellation without duplicate money.
Nine focused SQL/recovery tests, repository TypeScript, scoped lint and formatting
passed. This is fixture evidence, not authenticated application acceptance. Integrated
billing/native coding/status, administrative recovery, governed corrections and all
remaining entity/company/release requirements remain outstanding. Evidence is retained
under `native_project_invoice_browser_recovery_checkpoint` in the three JSON ledgers.

October 5 native invoice workbench checkpoint (B14.2 remains PARTIAL): the invoice
Accounting tab now exposes source-derived journal review, posting, original native
receipt status and exact saved-request recovery/resolution. Workspace reads enforce
actual source/project and reviewed entity access; native account codes/names appear
in the preview. The actual React component and recovery adapter passed a disposable
SQL browser journey through review, lost commit response, reload and recovery with
one original journal. Sixteen focused tests and repository TypeScript passed;
authenticated Next.js/native RLS/company acceptance, income-account selection,
administrative recovery, governed corrections and all remaining criteria remain
unfinished. See `native_project_invoice_workbench_checkpoint` in the three ledgers.

October 5 income-selection backend checkpoint (B02.1/B14.2 remain PARTIAL): private
atomic native-chart selections retain the complete original request, metadata-only
result and current preparation authority. Exact old retries survive posting;
new posted-source recoding is rejected. New explicit-account native posting requires
the authorized selection receipt. Eighteen focused SQL/service regressions pass,
including lost responses, rollback, permissions and eight catalog assertions.
Export/restore registration, durable selection/recovery and the native income-picker
UI remain required before shipping. Current native replay/pgTAP and company/golden
acceptance are still unverified; no package or release gate is accepted.

**B14.3 — Intercompany transactions and reconciliations**

- Model reciprocal due-to/due-from, one entity paying another's bill/payroll, shared expense allocations, advances/repayments and relevant transfers. A single commercial intent has mirrored entries and one ownership link; review accounts, counterparties, dates, settlement and differences. Use atomic cross-ledger writes or an auditable durable protocol that cannot present a one-sided intent as complete.
- **DoD:** every pair balances independently; reciprocal balances agree by counterparty/cutoff/currency; one-sided failures recover without duplicate legs; closed entity periods enforced; allocations conserve cents; clearing and bank ownership accurate; mismatches are actionable and block relevant consolidation/close.

**B14.4 — Consolidated reporting and eliminations**

- Define group/entity membership and ownership effective dates, chart mapping, aligned period/cutoff, consolidation adjustments and independently reviewed elimination journals. Handle intercompany receivables/payables/income/expense and applicable unrealized internal inventory profit; explicitly define supported ownership/noncontrolling-interest cases rather than confusing aggregation with consolidation.
- **DoD:** entity TBs + approved adjustments − eliminations = consolidated TB; consolidated statements balance and drill to entities/original intent; no unexplained intercompany residue; entity standalone ledgers unchanged by reporting-only elimination; historical group membership and frozen consolidated runs reproducible; supported minority/ownership treatment reviewed or explicitly bounded by the approved original-scope interpretation.

**B14.5 — Multi-entity migration, export, recovery and permission proof**

- Upgrade a populated single-entity company, add a second entity, migrate/import history with evidence and run intercompany/consolidation. Include membership, mappings, eliminations and entity source ownership in archive/restore.
- **DoD:** no source ownership loss or duplicate money during upgrade; original single-entity behavior remains correct; ordinary users cannot cross entities by tampering IDs; restored group reports/controls match; new reciprocal transaction and entity closes work after restore.

**Verify:** implement entity/intercompany/consolidation rules, SQL, service and authenticated browser suites; B15 `ENTITY-01`, `INTERCO-01`, `CONSOL-01`, `RESTORE-01`. This workstream cannot be deferred while calling the full goal 100%.

### B15 — Prove migration, first transactions and the complete accounting lifetime

**Start:** three acceptance ledgers, full-schema scripts/pgTAP, cutover/opening/greenfield/register services, B00 runner. Existing tests are a foundation; the final requirement is the integrated current product.

**B15.1 — Two entry routes and first normal transaction**

- Exercise new zero-history company and migration of an existing builder. Import governed chart/opening outstanding items, verify provider disconnect/mirror posture, roles/settings/banks/entities, dual approvals and cutover authority. Run first invoice/payment/bill/expense/payroll/source projection.
- **DoD:** greenfield activation proves zero or reviewed opening position; migrated company TB/subledgers/banks/retainage/payroll/inventory agree to external reference; activation fails on known mismatches or unauthorized review; first transactions post correct ownership once; no manual DB patch is needed to finish onboarding.

**B15.2 — Golden twelve-period scenario matrix**

- Implement and run every scenario in §6 using the complete current app/schema. Twelve fiscal periods must include quarter-end, year-end, close/reopen/reclose, late corrections and next-year continuation. Run residential/custom, commercial and production-posture fixtures with applicable revenue and inventory policies, plus a multi-entity group.
- **DoD:** independently specified expected journals, subledgers and immutable reports agree at each checkpoint; full scenario passes through actual source workflows; direct SQL shortcuts are confined to deliberate failure injection/inspection, not a substitute for ordinary actions; all G2 controls reproduce after restore; no fixture mysteriously deleted to erase a failed gate.

**B15.3 — Failure, concurrency, permission and transport acceptance**

- Run actual PostgREST/Supabase auth and application routes. Test multiple simultaneous sessions, wrong scopes, maker/checker, lost responses, timeouts, source changes after review, chart/policy/entity changes, process interruptions and provider/storage unavailability.
- **DoD:** no unauthorized data/money transition; no duplicate/partial monetary receipt; current readiness distinguished from retained historical approval; UI errors actionable; failure repair/retry succeeds with original intent; full app has no relevant browser errors or hydration issues; acceptance tests run in CI/repeatable isolated environment.

**B15.4 — Recovery, rebuild and nightly continuity**

- After all scenario operations, run complete projection/verifier/rebuild, export, restore and new operations; compare archived original and restored results. Simulate missed incremental events and worker restart; complete scan must recover truth without removing valid money.
- **DoD:** expected superseded/reversed histories are accepted; actual missing/divergent records found; all required close controls green after repair; restored next period closes; evidence references the final source/schema train, not the older 467-migration checkpoint.

**Verify:** new acceptance runner `--scenario all`, current complete pgTAP, financial/Books suites, real browser journeys, build and final `pnpm verify`. Save exact commands and runtime/schema/source hashes.

### B16 — Reconcile doctrine, obtain external evidence and release responsibly

**Start:** `docs/books-revenue-recognition.md`, `docs/books-cash-report-policy.json`, `docs/plans/arc-books-sole-ledger-release.md`, restore/acceptance/progress records, user onboarding and accountant package. Existing documentation includes historical assertions and a narrow single-entity boundary that must be reconciled with this larger goal.

**B16.1 — One current accounting policy and capability matrix**

- Document source-to-entry sets and correction policies for every supported posture, billing model, cash/tax bridge, payroll/provider variant, inventory/impairment, reserve, entity/intercompany/consolidation, deposits, assets/debt and period lifecycle. Separate book rules from tax elections/filing rails. Map each product claim to verified scenario evidence and known limitations.
- **DoD:** no contradictory “finished”/“unsupported” statements across current docs; historical checkpoints clearly historical; every matrix row has an owner, entry set, workflow, tests and acceptance state; activation/support/sales wording matches actual capability; no claim of native tax filing/calculation if a partner supplies it.

**B16.2 — Operator and recovery runbooks**

- Write onboarding, daily workflow, blocked-source repair, payroll correction, close/reopen/year-end, entity/intercompany, report package, backup/restore and disaster drills with permissions and exact user-visible steps. Include observability, failed job retries and support escalation without privileged ad hoc money edits.
- **DoD:** an operator unfamiliar with implementation completes B15 journeys from these docs; every blocker links to a real cure; incident drill restores then operates normally; secrets/Vault recovery roles and external dependencies documented without exposing keys; maintenance ownership assigned.

**B16.3 — Independent CPA and real-builder parallel close**

- Prepare a reviewable accountant package and arrange participation with explicit human authorization for any outside communications. Independent licensed construction CPA reviews the supported entry/policy matrix, golden outputs, payroll/cash/production/entity/loss and cutover controls. Record actual review scope, issues, disposition and dated approval.
- Run at least three consecutive real-builder monthly closes spanning a quarter using Arc and independently sourced reference books/statements; include year-end evidence when applicable and real bank/payroll/supporting documents. Cover each posture claimed as ready: custom/residential, commercial and production; multi-entity claims additionally require actual group/intercompany/consolidation review. Use sanitized evidence in the repo and protect customer originals.
- **DoD:** exact TB/AR/AP/retainage/job-cost/WIP/inventory/payroll/bank/tax/entity differences explained and corrected; no material unexplained variance or manual alternate-ledger dependency for ordinary supported work; CPA approves the actual supported scope; builder completes tasks without database intervention; reviewer names/roles/date and authorized evidence references retained. A fictional actor, synthetic fixture or unsigned draft letter never satisfies this item.
- **Boundary:** B15's twelve-period replay is technical proof. It cannot substitute for this real quarter. The older September “twelve consecutive live closes” aspiration is retained as a post-release operating-health objective, not falsely represented as achieved by synthetic replay; the October objective's parallel-close requirement is completed only by the actual evidence above.

**B16.4 — Controlled rollout and organization activation**

- Prepare reviewed migration/app rollout order, upgrade/backup verification, compatibility checks, flags if needed, monitoring and recovery strategy. Finish authorized deployment and per-organization greenfield/cutover approvals. Observe first production accounting cycles and reconcile actual receipts/controls.
- **DoD:** current production schema/runtime identified; required migrations applied in reviewed order with verified grants/invariants; rollback/recovery does not delete posted history; activation cannot bypass accounting checks; monitored first invoice/payable/payroll/bank/close succeeds; no unresolved critical/high accounting/access/data-loss issue; release record cites G1–G7. Real production actions require existing or obtained explicit authorization.

**Verify:** full acceptance/evidence review, CPA and real-builder artifacts, reviewed deployment and activation record. If external participation is unavailable, leave this package BLOCKED_EXTERNAL and do not claim the complete goal achieved.

## 6. Golden scenario catalog — required evidence, not optional examples

Register these IDs in the new release runner and reference them from package evidence. Each scenario needs independent expected balances/journals, source/workflow identities, permission cases, immutable report artifacts and observed results. Dollar amounts below are fixture inputs; expected entry sets must be specified from the approved policy before executing the implementation under test.

| Scenario     | Required input/journey                                                                                                                                                                                                                                                              | Pass condition                                                                                                                                                                                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MIG-01`     | Import a builder TB with outstanding invoices/bills, separate retainage, undeposited receipts, checks in transit, inventory, payroll/tax/debt/assets and two banks. Dual review, mapping, first collection/payment and cutover.                                                     | Opening detail equals reference TB and controls; no doubled opening/projection; first clearing affects exact source; known mismatch prevents activation.                                                                                                                 |
| `GREEN-01`   | Zero-history company, no active external ledger, roles/settings/chart/banks/policy, first invoice/bill/expense and approved opening/zero attestation.                                                                                                                               | Entire journey uses normal UI/actions; correct one-time journals, accessible reports and auditable activation.                                                                                                                                                           |
| `BILL-01`    | General service invoice $1,000 pretax, $80 tax, two income accounts $600/$400; installments, $100 pretax credit with corresponding reviewed tax reduction, refund, chart recode. Separate progress invoice with $100 held retainage.                                                | Independent income/tax/AR/retainage allocation and dated history agree; credit/refund count once; later recode cannot relabel original posting; totals conserve cents.                                                                                                   |
| `HIST-01`    | Invoice/bill approved, partially settled, then voided/rejected/replaced across periods; credit application, retainage release and backdated correction. >1,000 sources with tied dates.                                                                                             | Each cutoff reconciles to original/as-restated reference population, every row exactly once; later mutable status cannot rewrite frozen original report.                                                                                                                 |
| `WIP-01`     | $100,000 contract, $80,000 reviewed EAC, $40,000 costs: cost-to-cost fixture earns $50,000. Add second contract, shared cost allocation, late bill/cost, revised and reverted EAC, completed-job carryforward.                                                                      | Approved policy yields exact cumulative targets/deltas; second contract separately owned; stale review blocked; all WIP/recognition/close populations agree.                                                                                                             |
| `LOSS-01`    | Contract $100,000, EAC worsens to $120,000, cost-to-date changes; another profitable contract, capitalized cost impairment, then recovery/completion/reopen.                                                                                                                        | Full forecast loss handled per reviewed entry set without cross-contract profit offset or double impairment/provision; reserve rollforward and statement presentation reconcile.                                                                                         |
| `REV-01`     | Standalone service, fixed-price, T&M, cost-plus and GMP jobs; deposits, approved change orders/caps, earned unbilled amounts and protected invoiced labor correction.                                                                                                               | Every declared policy has exact single recognition path and practical correction; billing model does not silently dictate recognition; historical versions reproduce.                                                                                                    |
| `HOME-01`    | Land/development allocated to three lots, two homes built, one sold with deposit, escrow/fees and reserve; spec remains unsold; late cost, canceled closing, common cost revision.                                                                                                  | Inventory/land/lot balances and cent allocations tie; only sold unit relieved; deposit/reversal/late cost governed; no duplicated closing revenue.                                                                                                                       |
| `DIM-01`     | Transactions across two entities, divisions, communities/phases, lots, contracts and cost codes; overhead/unassigned row and ambiguous lot. Later relationship/label change.                                                                                                        | Frozen dimensions preserved; supported grouped totals recombine exactly; scoped drillthrough denied where unauthorized; ambiguity does not produce guessed ownership.                                                                                                    |
| `BANK-01`    | Two banks, a credit card, grouped net deposit/fees, checks/deposits in transit, imported outstanding items, supplier refund and payroll split debits across two cycles. Reopen in wrong then correct order.                                                                         | Actual statement and GL/control equations hold at each cycle; no duplicated card expense/deposit cash; correct outstanding rollforward and immutable closed descriptions.                                                                                                |
| `PAY-01`     | One worker: gross $1,200, employee tax $150, employee deductions $50, net $1,000, employer tax $90 and benefits $60. Native wages $1,200 + estimated burden $180; actual employer burden $150. Allocate across two jobs and overhead; separate recognition, funding and remittance. | Wage controls reconcile; actual job-cost burden adjustment is −$30 total; supported funding control $1,350 when provider pays all modeled obligations; bank/liability movements reconcile without double wages/withholding; clearing explained to zero after settlement. |
| `PAY-02`     | Posted run; independent corrected source; wage decrease, project move, withholding change, closed-home adjustment, cost-plus billed labor, provider/employee refund, coordinated native-time correction and supplemental/voided run.                                                | Every correction has approved signed legs/ownership; customer billing change explicit; complete provider/liability/cash/job-cost/WIP lineage; exact retry one receipt; no alternate manual ledger required.                                                              |
| `CASH-01`    | Use billing/AP/expense/payroll/home/assets/debt fixtures; partial collections/payment/refunds, sales tax, card/reimbursement, deposit, credit/writeoff, fees, prepaids, inventory, depreciation and interbank transfer.                                                             | Independent monthly and annual cash P&L + complete classified bridge ties actual cash; no capital/loan/equity or transfer misclassified as income; tax adjustments separate and reviewed.                                                                                |
| `TAX-01`     | >1,000 eligible and excluded payments across year-end; individual/company payees, missing W-9/TIN, joint checks, reversals, legal-entity payers. Cash tax workpaper, no-adjustments replacement, stale basis and altered attachment.                                                | Independently reviewed 1099 totals and applicable-year classifications correct; filing handoff traceable; no private data exposure; workpaper report/UI/CSV/PDF/restore exact and stale proof rejected.                                                                  |
| `ENTITY-01`  | Upgrade default single entity; create second with own banks/chart/calendar; projects and documents under each; prohibited cross-entity requests; entity close/reopen.                                                                                                               | Separate ledger/control balances, ownership and permissions; no cross-entity period leak; legacy migration conserved; source workflow displays actual entity.                                                                                                            |
| `INTERCO-01` | Entity A pays B's bill and payroll; shared expense allocation; advance and partial repayment; one entity closed; fail one reciprocal leg and retry.                                                                                                                                 | Both ledger pairs reconcile by date/counterparty; closed-period guard enforced; no apparently completed one-sided intent; failure recovery preserves one mirrored pair.                                                                                                  |
| `CONSOL-01`  | Combine entity TBs with effective group membership, mapped accounts, reciprocal balances, intercompany income/cost and internal inventory profit where applicable. Approved eliminations and later membership change.                                                               | Exact consolidated TB/statements and elimination bridge; standalone books unchanged; no unreviewed residue; frozen group report and restored results reproduce.                                                                                                          |
| `CLOSE-01`   | Twelve periods with all supported modules, quarter-end, late source after review, closed-period correction, reopen/reclose, outstanding genuine blocker, failure after each close step.                                                                                             | Valid company closes; injected issues block accurately; failures rollback/resume correctly; snapshots/close state never lie; prior period and later corrections traceable.                                                                                               |
| `YEAR-01`    | Custom income/expense accounts, noncalendar fiscal year, zero-income year, opening retained earnings/equity, late prior-year adjustment, next-year transactions.                                                                                                                    | Exact retained-earnings equation; no balance-sheet account closed to RE; one year-end receipt per intent; reopen/reclose creates only required deltas.                                                                                                                   |
| `STATUS-01`  | Economic header/line/funding/policy/dimension/contract/job-source mutations for each projected source family; harmless note edit, skip/cap, supersession, failed replacement and repair.                                                                                            | No false current-posted/clean status; complete scoped finding resolution; cure leads to source; monetary history not retired because replacement is blocked.                                                                                                             |
| `RACE-01`    | Independent Postgres sessions contend on prepare/review/post/source mutation/period close/bank match/entity pair; inject late mutation after money writes but before receipt.                                                                                                       | Allowed serial outcome or explicit safe retry only; no partial/duplicate money; all invariants proven at commit and after repair. PGlite alone is insufficient.                                                                                                          |
| `STORE-01`   | Real authorized test R2 private uploads, supporting CSV/PDF versions, legacy protected objects, changed bytes, create-only overwrite attempt, unauthorized download and revoked legacy exposure.                                                                                    | Actual privacy/no-store/retention/hash guarantees observed; valid accountant reads work; originals restored with equal bytes; unresolved external revocation remains a failed gate.                                                                                      |
| `RESTORE-01` | Archive entire populated twelve-period company and multi-entity group, restore isolated schema/dependencies/objects, verify all balances and frozen reports, perform new transactions and close.                                                                                    | Exact history/proofs/bytes reproduced; normal guards on; no live provider credentials; post-restore ordinary operations and historical retry work.                                                                                                                       |
| `CAP-01`     | Declared B09 financial/payroll workload and B06 document corpus; cold/warm queries, concurrent users, export interruption/resume, missed worker event and restore.                                                                                                                  | Measured p95/time/memory budgets pass on recorded hardware; no hidden cap/incomplete publication; query plans and progress/recovery evidence retained.                                                                                                                   |
| `AUTH-01`    | Org accountant, independent reviewer, assigned-division operator, ordinary project user and foreign-org/entity user exercise all added paths.                                                                                                                                       | Required role permissions work; maker/checker/tenant/entity protections enforced server-side; no salary/TIN/private documents leak via generic files/reports/status/export.                                                                                              |

### What must be in each golden evidence artifact

- Fixture provenance and reviewed expected entry/control matrix, with cents rather than rounded displays.
- Source IDs, parent/replacement/reversal identities, entity/project/dimension ownership and accounting dates.
- Actual action/API/SQL invoked, user/reviewer role, database/runtime/migration hashes and completion timestamp.
- Resulting fact/journal/receipt/subledger balances, status transitions and exact independent expected-versus-observed differences.
- Report-run/checksum references and screenshot/CSV/PDF/archive/restored-document hashes where applicable.
- Failure/race injection location, observed invariant, cleanup proof and successful recovery/retry evidence.
- Remaining unsupported behavior or outside dependency. Never omit a failing subcase from the scenario name to make it green.

## 7. Complete requirement crosswalk

| Original October requirement                                  | Required packages       | Mandatory scenario coverage                            |
| ------------------------------------------------------------- | ----------------------- | ------------------------------------------------------ |
| Year-end repair                                               | B01.1–3, B15.2          | CLOSE-01, YEAR-01, RACE-01                             |
| General-invoice revenue and income allocations                | B02.1–2, B07.1, B11.1–2 | BILL-01, REV-01, HIST-01                               |
| Shared historical AR/AP/retainage, aging and close gates      | B03.1–3, B01.3          | HIST-01, MIG-01, CLOSE-01                              |
| Reviewed period WIP/POC, late adjustments, shared populations | B04.1–3, B11.1, B12     | WIP-01, LOSS-01, CLOSE-01                              |
| Accurate paginated 1099                                       | B05.1–2                 | TAX-01, ENTITY-01, AUTH-01                             |
| Consistent versioned export and supporting-document recovery  | B06.1–4, B15.4          | STORE-01, RESTORE-01, CAP-01                           |
| Complete dimensions                                           | B07.1–2, B14.1–2        | DIM-01, BILL-01, PAY-01, ENTITY-01                     |
| Statement-cycle rollforward                                   | B08.1–3                 | BANK-01, MIG-01, RACE-01                               |
| Scalable projection and actionable shared workflow status     | B09.1–3                 | STATUS-01, CAP-01, AUTH-01                             |
| True cash-basis financials and tax adjustments                | B10.1–4, B13.5/8        | CASH-01, TAX-01, RESTORE-01                            |
| Explicit service/T&M/cost-plus/closing policies               | B11.1–4                 | REV-01, HOME-01, PAY-02                                |
| Loss-contract provisions and WIP review controls              | B12.1–2, B04            | LOSS-01, WIP-01, CLOSE-01                              |
| Reconciled payroll imports                                    | B13.1–8                 | PAY-01, PAY-02, BANK-01, STORE-01, RACE-01             |
| Legal entities, intercompany, consolidation                   | B14.1–5                 | ENTITY-01, INTERCO-01, CONSOL-01                       |
| Migration/first transaction/close/reopen/year-end acceptance  | B00.1–3, B15.1–4        | MIG-01, GREEN-01, CLOSE-01, YEAR-01, RESTORE-01        |
| Updated policy/release docs and builder/CPA evidence          | B16.1–4                 | Actual external artifacts plus complete G1–G7 evidence |

### Reconcile older plans rather than blindly execute them again

- September D: rebuild/versioning/real close/CPA/release/UI → B00/B01/B09/B15/B16.
- E: actual cash/card/payroll/feed/deposit truth → B08/B10/B13.
- F: revenue/loss/contract presentation/retainage/policy → B02/B03/B04/B11/B12.
- G: production inventory/closings/development/interest/warranty/dimensions → B07/B10/B11/B12.
- H: commercial WIP/equipment/retainage/joint checks/divisions → B04/B07/B08/B11.
- I: cost-type/compares/grouping/drilldowns/snapshots/health → B07/B09/B10/B15.
- J: tax/1099/cash/depreciation/year-end package → B01/B05/B10/B16.
- K: product organization/close gates/posture/stale surface cleanup → global workflow DoD/B01/B09/B16. A numerical “six sections” limit is an older UI aspiration, not grounds to dismantle the user's deliberate integrated workflows.
- L: mapping/import tier/payroll/provider/cutover → B03/B13/B14/B15/B16. A second external live GL adapter is not a prerequisite for Arc to own its ledger; retain it as separate provider-roadmap work unless directly required by a declared migration route.

A legacy directive already implemented still needs the appropriate current verification. A currently unsupported core accounting case is not “rejected as unnecessary” because a safe blocker exists.

## 8. First three implementation slices for the main thread

1. **Revalidate and complete B00.1 plus B13.1.** Inspect the interrupted history service/RPC/actions. Add actual service/SQL/permission/pagination tests; finish saved history UI and browser refresh/review/withdraw/lost-response paths. Preserve the existing 505-test baseline and correction-posting evidence. Do not advertise completion before the full slice passes.
2. **Establish B00.2/3 and decide B14.1.** Create the current isolated full-schema target and golden runner, resolve actual replay defects, record the native legal-entity boundary. This prevents many more features being built against an unaccepted partial schema or the wrong accounting ownership.
3. **Finish B03.1–3 and B13.2–5 with B11 policy contracts.** Historical evidence and opening ownership underpin payroll claims, cash, close and cutover. Complete valid initial payroll posting/funding and source-specific construction/billing decisions rather than concentrating indefinitely on only correction subcases.

After these slices, follow §4's phases and dependencies. At each checkpoint state what became true, what was actually verified, and the next highest-leverage unmet requirement. Do not spend entire turns restating the same blocker when independent implementation remains.

## 9. Exact instruction to attach to the existing goal

**Preserve the original objective in full and append this addendum:**

> Execute and maintain `advisor-plans/013-arc-books-completion-to-100.md` and its companion `advisor-plans/013-arc-books-completion-checklist.json` as the authoritative implementation and completion checklist for the full October 2 Arc Books objective. Follow dependency order and the package-specific/global definitions of done; reconcile current code before trusting historical checkpoints. Preserve workflow-integrated accounting and unrelated changes. Record authoritative evidence per requirement and update statuses as work progresses. Do not redefine success as a narrow single-entity, fixture-only, safe-blocker-only or locally implemented subset. Do not mark the full goal complete until every applicable package is DONE and G1–G7 pass, including actual external builder parallel-close and independent licensed-CPA evidence. Continue independent authorized work while outside dependencies remain. If the goal-management API cannot edit an active objective, retain this instruction in the main task and completion register without falsely marking the old goal complete or recreating it.

No new separate implementation goal is necessary. No token budget is added. Goal status remains active; this planning request is not a request to pause, complete or archive it.

## 10. Drift, uncertainty and escalation rules

- Revalidate commit **and uncommitted files**. `git diff --stat 9f1549af..HEAD -- lib/services/books components/books components/time supabase` sees committed drift only; use the baseline source hashes and actual workspace reads as well.
- If an entry policy or historical ownership cannot be proven, record the exact missing evidence and implement a reviewed remediation path. Never fill gaps from mutable profiles/settings/current statuses.
- If architecture requires a change beyond package boundaries, update the plan/dependency mapping explicitly rather than quietly shrinking scope. Routine implementation choices within authorized scope do not require repeated permission.
- Do not weaken maker/checker, private file, entity, transaction or historical integrity controls simply to pass a scenario. A fix to overly broad blocker logic must prove legitimate transactions and invalid ones separately.
- A failure after reasonable attempts calls for a different diagnostic strategy, not an endless retry loop or a false completion claim. An external engine/provider/CPA dependency does not prevent meaningful independent work elsewhere.
- Each release-level claim must name its evidence. Synthetic role adapters prove logic; actual authentication proves product access. Scoped SQL proves contracts; current full schema proves integration. Stored hashes prove integrity only with independently observed original bytes.

## 11. Accounting reference policy

Accounting policies need an independent licensed-CPA review for the builder's actual scope. This plan specifies engineering deliverables; it does not itself approve a tax election or certify financial statements.

- [IRS Publication 538 — Accounting Periods and Methods](https://www.irs.gov/publications/p538): basis for separating cash/accrual methods, inventory and method-policy decisions. Capture applicable-year guidance when implementing; do not assume payment alone establishes deductibility.
- [IRS instructions for Forms 1099-MISC and 1099-NEC](https://www.irs.gov/instructions/i1099mec): use current applicable-year payer/category/payment-rail instructions and partner contracts; preserve the reviewed rule version.
- [FASB revenue recognition implementation resources](https://fasb.org/page/pccAccordion?bcpath=tff&pageId=%2Fstandards%2Fimplementing%2Frevrec.html) and [FASB Revenue Recognition Implementation Q&As](https://storage.fasb.org/Rev_Rec_Implementation_QAs.pdf): starting references for the reviewed contract/cost/recognition policy matrix. Validate loss/impairment and production entry sets against applicable authoritative guidance; do not treat a generic implementation FAQ as CPA sign-off.

## 12. What this planning session did and did not verify

Read the current progress/acceptance/policy records, prior plans, relevant source anchors, current interrupted payroll scaffolding, package verification commands and main-task state. Created this plan, a requirements/evidence checklist and a planning baseline snapshot. This is a scoped completion-plan reconciliation, **not a new exhaustive line-by-line audit of the entire application**. No implementation, tests, migrations, build, deployment, container restart, customer transaction or external CPA/builder communication was performed by this planning session.

The advisor deliberately rejected these substitutions: scattered workflow entry points as a defect; passing test count as percent completion; provider/entity routing as native entity-ledger proof; safe unsupported-case blockers as finished features; scoped/old-schema success as current full release acceptance; metadata privacy as proof old public object URLs were revoked.

Native operational invoice persistence checkpoint: pending SQL now independently
revalidates and derives invoice money into the shared native journal, preserves
exact receipt retries, protects original economic fields and supports subsequent
retainage releases. Typed receipt verification reconstructs original source money
and rejects rehashed wrong-account drafts. This is partial B14.2 progress, with
zero accepted packages or release gates. Schema26 source receipt/shared-origin
archive closure and restore are essential next work before activation, followed
by the authorized service and integrated billing recovery/status. The current
544-migration/58-pgTAP Docker attempt failed before database creation; scoped
PGlite evidence does not replace current-schema/authentication/race acceptance.

Schema26 native invoice recovery checkpoint: invoice receipts and exclusive
shared journal origins now participate in strict original economic/definition/
authority/hold closure, exact leg coverage and downgrade rejection. Offline
supporting bytes and populated scoped restoration pass; restored exact retries,
retained holds, independent release and fresh retainage money are covered. Actual
scoped target catalog preparation preserves older schema25 manual null origins
without fabricating receipt history. This advances B06/B14.2; no full package,
company golden or release gate is accepted. Authorized operational services and
integrated billing/account-selection/recovery/status are next, with the full
original objective unchanged.

Authorized native invoice service checkpoint: Books/project management plus
caller-visible actual invoice precede the scoped writer; read has equivalent
Books/project read and entity authority. Original saved nonce/header/economic
requests recover exactly after a lost committed response without fresh snapshot
capture. Typed receipt/source/leg checks reject forged returns and live revoked
entity/organization authority blocks recovery. Thin actions exist; no UI submits
or activates the native ledger. Next implement atomic resolution of uncertain
invoice request nonces and durable browser ownership before integrated billing
submission/account selection/status. Missing detail is not cancellation. This
remains partial B14.2 and does not change any original acceptance requirement.

Schema28 native income archive checkpoint: complete immutable selection history,
source selection identities and scoped journal provenance now survive export and
populated scoped restore. Independent original/result/definition/access/hold/revision
closure rejects altered or missing evidence even with recomputed manifests. Older
schema27 money adapts an empty family and null origin only. Original retries survive
restore, fresh unposted coding continues revision order, and posted recoding rejects.
Browser acknowledgement retains pending intent when journal provenance is missing.
The 3,538-test financial/Books regression suite passed, with final focused delta checks,
TypeScript, lint and formatting. Full current native replay and company/golden/release
acceptance remain unproven. Next complete durable coding intent resolution and the
integrated invoice picker, then governed corrections and the remaining entire scope.

Schema27 invoice resolution checkpoint: atomic committed-original or immutable
cancellation outcomes, entity/source/nonce tuple fences and direct insert guards
now protect uncertain requests. Scoped service authorization/lost-response recovery
and original receipt verification are connected. Cancellation archive closure,
downgrade rejection, exact populated restoration and fresh normal posting under a
new identity pass. Multi-session native proof remains pending at Docker readiness;
a broader regression failure concerns concurrent inspections notification event
coverage. Durable browser ownership, integrated billing/coding/status and moved-
source/departed-maker administrative recovery remain required, along with every
original package/golden/release requirement. No acceptance gate is marked complete.

Schema29 native coding resolution checkpoint: private exact committed-original
recovery or immutable absent-request cancellation now fences selector RPCs and direct
receipt insertion before source edits. Coding cancellations survive complete export
and populated scoped restoration with fresh coding and normal posting afterwards.
Durable browser contracts preserve original intent/decision, independently verify the
exact metadata transition, retain pending state on loss/corruption/storage failure,
and share invoice posting locks. Maximum request envelopes retain room for resolution.
The final 3,564-test financial/Books regression run, TypeScript, scoped lint and format
checks pass. Actual browser/workflow income picker, native database replay/RLS/pgTAP/
multi-session proof and complete company/golden/external/release acceptance remain
required. The outside-sandbox read-only Docker CLI probe remained unresponsive and
was interrupted; no database was created or production migration applied. The original
entire goal stays active and no package or final acceptance gate advances.

Integrated invoice income picker checkpoint: reviewed account choices/default and
line quantities/rates now appear directly in invoice Accounting. Unsaved coding blocks
posting; saved choices require a fresh preview. The actual browser adapter preserves
original coding and cancellation decisions and recovers them within the workflow.
Two disposable actual React/adapter/SQL browser scenarios prove lost replies, reload,
original one-receipt/one-journal recovery, cancellation and subsequent fresh coding.
Twenty-four focused tests, TypeScript, lint and format pass. This is not full Next.js
authentication/RLS/mobile/styles or native concurrent/company acceptance. Governed
corrections, all remaining original packages and all seven acceptance gates remain
required; the full original goal remains active.

Native invoice correction preparation checkpoint: a verified original SQL journal
now produces an exact full-leg reversal plan retaining original account identities,
job/company dimensions and immutable journal provenance. Altered/partial history,
foreign scope, stale capture/backdate, reused identity and account reclassification
reject. Fourteen focused tests and TypeScript pass. This is preparation only: no
correction is persisted, reviewed or activated. Atomic reversal/replacement, source
revision/dependency history, separate review, recovery, archive and integrated UI
remain required. No package or final gate advances; the full goal stays active.

Native invoice SQL reversal derivation checkpoint: private INVOKER preparation
now independently loads original native money, verifies retained hashes/economics/
draft/header/all ordered legs and revalidates current source/owner/chart/period/
authority before exact canonical account reversals. Typed response verification
rejects rehashed forged journal history or redirected draft legs. Twenty focused
tests, TypeScript, lint and format pass; five security catalog assertions run in
scoped PGlite. The current 556-migration/62-pgTAP native replay is STAGED only. No
correction money/source changes/review/activation occur. Immutable proposals,
atomic reviewed reversal/replacement, source/dependency/payment history, recovery,
archive and integrated workflow remain next, with all original goal gates intact.

Native invoice correction proposal checkpoint (schema30): immutable requests and
server-derived original journal/reversal evidence now persist with private current
authority and source/period checks. Exact old retries preserve later labels; full
original money, frozen definitions and historical authority/hold closure survives
export and populated scoped restoration. Schema29 adapts an empty family only.
The offline file verifier/extractor now follows the current supported version.
The current financial command passes 3,417 tests, new proposal checks 5, compatibility
delta 18 and offline recovery delta 51, with TypeScript/lint/format passing. The
557-migration/63-pgTAP native train is STAGED only. Separate review, atomic correction
posting, source/dependency/payment history, resolution, service/UI and every original
company/golden/external/release requirement remain. No package or gate advances.

Native invoice correction pair calculation checkpoint: independent TypeScript/SQL
now derive full original reversals and prospective price/income-account replacements.
Accounting corrections may use an available effective period while preserving actual
invoice/signed-closing dates and evaluating contract eligibility as of the invoice.
Initial posting remains date-strict. Existing source dependencies and dimensions
remain unchanged. Twenty-four focused tests, configured 8-GiB TypeScript, scoped
lint and format pass; the default 4-GiB typecheck exhausted memory before retry.
Four security catalog assertions run in scoped PGlite; 558 migrations/64 pgTAP are
STAGED only. Persisted explicit pair intent, separate approval, atomic money/source
revision, dependency/credit/payment/line-change coverage, recovery, archive and
service/UI remain required, with every original goal and acceptance gate intact.
