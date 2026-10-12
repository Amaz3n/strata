# Arc Production completion baseline

Baseline: arc-production-national-builder-v1. Audit date: 2026-10-03. Generated from completion-checklist.json; update that file and regenerate this report.

Deliver and accept every mandatory item in docs/enterprise-production/completion-checklist.json baseline arc-production-national-builder-v1, preserving mixed-org behavior. The goal completes only when the checklist validator confirms 100% implemented, verified and release-ready, all five lifecycle scenarios pass, approved scale/recovery targets are demonstrated, and migration/security/operational sign-offs are recorded. Further enhancements require explicit scope change and belong in a separate backlog.

**136 mandatory items, 289 fixed complexity units.** Scope, criteria, weights and dependencies are frozen; additions require explicit user approval. Defects that prevent an existing criterion stay within that item. Optional improvements belong in the deferred backlog.

| Measure | Current result |
| --- | --- |
| Implemented | 40.1% — a documented lower bound, not an ETA |
| Fully verified | 38.8% |
| Release ready | 0% |
| Code implemented | 2 items |
| Partially implemented | 57 items |
| Known pending tasks | 20 items |
| Existing capability not yet qualified | 0 items |
| Isolated automated evidence | 71 items; this does not imply full workflow verification |

Latest result per test file: 554 passed, 0 failed across 56 files. Real network requests were blocked. One drawing test failed during concurrent source edits in the first run; stable reassessment passed, and the original failure remains in the audit history.

The earlier rough 30% estimate is superseded by this evidence-based reporting. The lower-bound implementation percentage excludes partially implemented and unqualified features. It will increase when existing functionality is demonstrated complete, even without new code. No complete customer workflow, national-scale benchmark, independent-session race or approved rollout is inferred from isolated tests.

## Execution rules

1. Finish M1: qualify existing capabilities and classify candidate pages before implementing an unaudited feature. Reuse shared Books, Documents, Signing and mobile work.
2. Name checklist IDs and the next evidence requirement at the start of each turn. Close exact gaps; stop improving a satisfied criterion.
3. Update item status, evidence, remaining steps and blockers at the end of each turn. Run `node scripts/qa/production-readiness.mjs --check` and regenerate this report with `--markdown`.
4. Do not count source review, mocks or representative single-session SQL as full integration, browser, provider, concurrency or performance acceptance.
5. If only external gates remain, report implementation complete awaiting acceptance. Do not invent more engineering work. Complete the goal only when `node scripts/qa/production-readiness.mjs --release` passes.

## Milestones

- **M2: Close transactional and ownership blockers.** Named items have complete implementations and required independent-session/full-schema proof.
- **M3: Complete remaining builder workflows.** Every mandatory functional item is implemented; chosen integration sandbox scenarios are reconciled.
- **M4: Prove complete lifecycles and enterprise operation.** Named lifecycle, scale and recovery evidence passes.
- **M5: Approved rollout and completion.** All mandatory items accepted and release owner signs off; complete the goal.
- **M1: Complete baseline qualification.** Every not_audited row has a source assessment and is classified pending, partial or implemented; EP01-08 maps all exposed pages.

## Concrete audit findings

- Production portfolio report has fixed 250-community and 2000-home/fact caps (EP10-05).
- Cash forecast has a 1000-project cap and lacks accepted starts/closing/takedown/financing scenarios (EP10-03).
- Warranty division project helper uses limit(1000), risking incomplete defect scope (EP11-08).
- Agreement creation and closing use multiple independent side effects; transaction/crash/concurrency acceptance is incomplete (EP05-02, EP05-09).
- Starts claim-token consumers remain inactive; staged migrations and drawing/configuration flags are not activated (EP07-18, EP14-09).
- Default inspections module is commercial-only in lib/project-modules.ts; production exposure through overrides and navigation must be resolved (EP09-04, EP01-08).

## Finite checklist

Every row has full observable criteria, dependencies, source/test links, evidence and remaining work in completion-checklist.json. Implemented means the functional code exists; verified requires every declared proof tier; accepted additionally requires release-state and owner evidence. Pending release tasks do not mean their underlying feature is missing.

### EP01: Production desk usability and scale

| ID | Outcome | Status | Next concrete step |
| --- | --- | --- | --- |
| EP01-01 | Role navigation | verified | Apply migration 20261010200000_purchasing_manager_baseline_reads (pending approval) so the purchasing manager role holds its read keys in production. |
| EP01-02 | Complete desk queues | verified | Apply migration 20261011110000_bill_search_text (pending approval) together with the code, or payables text search errors. |
| EP01-03 | Searchable operator pickers | verified | Apply migrations 20261011120000_sellable_lot_inventory_view and 20261011130000_directory_buyer_roles_on_org_create (pending approval) with the code; Find-a-home reads the view. |
| EP01-04 | Shared scope across desks | verified | Accepted; no required work remains. |
| EP01-05 | Desk states and recovery | verified | Accepted; no required work remains. |
| EP01-06 | Home and lot drill-down | verified | Accepted; no required work remains. |
| EP01-07 | Bulk operator actions | verified | Accepted; no required work remains. |
| EP01-08 | Page exposure inventory | verified | Accepted; no required work remains. |

### EP02: Enterprise organization and security

| ID | Outcome | Status | Next concrete step |
| --- | --- | --- | --- |
| EP02-01 | Enterprise hierarchy | verified | Apply the EP02 migrations (20261010130000, 20261010230000, 20261011010000, 20261011140000, 20261011150000, 20261011160000, 20261011170000, 20261011180000, 20261011190000, 20261011200000, 20261011210000, 20261011220000) with the code (pending approval); the B14 legal-entity migrations (20261007235500, 20261007235800) remain pending too. |
| EP02-02 | SSO and MFA enforcement | verified | Apply 20261010230000 (org policy), 20261011240000 (two-factor in row security) with the code (pending approval). |
| EP02-03 | Provisioning and deprovisioning | verified | Apply the EP02 migrations (20261010130000, 20261010230000, 20261011010000, 20261011140000, 20261011150000, 20261011160000, 20261011170000, 20261011180000, 20261011190000, 20261011200000, 20261011210000, 20261011220000) with the code (pending approval). |
| EP02-04 | Organization and division isolation | verified | Apply the EP02 migrations (20261010130000, 20261010230000, 20261011010000, 20261011140000, 20261011150000, 20261011160000, 20261011170000, 20261011180000, 20261011190000, 20261011200000, 20261011210000, 20261011220000) with the code (pending approval). |
| EP02-05 | Financial separation of duties | verified | Accepted; no required work remains. |
| EP02-06 | Audit completeness | verified | Apply the EP02 migrations (20261010130000, 20261010230000, 20261011010000, 20261011140000, 20261011150000, 20261011160000, 20261011170000, 20261011180000, 20261011190000, 20261011200000, 20261011210000, 20261011220000) with the code (pending approval). |
| EP02-07 | Audit retention and export | verified | Apply 20261011230000 (append-only evidence, delete_organization) with the code (pending approval). |
| EP02-08 | Access review and emergency access | verified | Apply the EP02 migrations (20261010130000, 20261010230000, 20261011010000, 20261011140000, 20261011150000, 20261011160000, 20261011170000, 20261011180000, 20261011190000, 20261011200000, 20261011210000, 20261011220000) with the code (pending approval). |

### EP03: Product and configuration

| ID | Outcome | Status | Next concrete step |
| --- | --- | --- | --- |
| EP03-01 | Versioned product definition | verified | Apply the EP03 migrations (20261012010000, 20261012015000, 20261012020000, 20261012030000, 20261012040000, 20261012050000, 20261012060000) with the code (pending approval). |
| EP03-02 | Option dependency controls | verified | Approve and apply 20261003013000_selection_configuration_rules.sql (migration approval). |
| EP03-03 | Configuration preflight | verified | Approve EP03-02 migration and enable the rules flag in the QA org. |
| EP03-04 | Atomic configuration mutation | verified | Apply the EP03 migrations (20261012010000, 20261012015000, 20261012020000, 20261012030000, 20261012040000, 20261012050000, 20261012060000) with the code (pending approval). |
| EP03-05 | Community offering restrictions | verified | Apply the EP03 migrations (20261012010000, 20261012015000, 20261012020000, 20261012030000, 20261012040000, 20261012050000, 20261012060000) with the code (pending approval). |
| EP03-06 | Lot fit and orientation | verified | Apply the EP03 migrations (20261012010000, 20261012015000, 20261012020000, 20261012030000, 20261012040000, 20261012050000, 20261012060000) with the code (pending approval). |
| EP03-07 | Deterministic pricing resolution | verified | Apply the EP03 migrations (20261012010000, 20261012015000, 20261012020000, 20261012030000, 20261012040000, 20261012050000, 20261012060000) with the code (pending approval). |
| EP03-08 | Immutable commercial snapshots | verified | Apply the EP03 migrations (20261012010000, 20261012015000, 20261012020000, 20261012030000, 20261012040000, 20261012050000, 20261012060000) with the code (pending approval). |
| EP03-09 | Revision impact and rollout | verified | Apply the EP03 migrations (20261012010000, 20261012015000, 20261012020000, 20261012030000, 20261012040000, 20261012050000, 20261012060000) with the code (pending approval). |
| EP03-10 | Guided configuration correction | verified | Apply the EP03 migrations (20261012010000, 20261012015000, 20261012020000, 20261012030000, 20261012040000, 20261012050000, 20261012060000) with the code (pending approval). |

### EP04: Land and inventory

| ID | Outcome | Status | Next concrete step |
| --- | --- | --- | --- |
| EP04-01 | Acquisition diligence | verified | Apply the EP04 migrations (20261012070000, 20261012080000, 20261012090000, 20261012100000, 20261012110000, 20261012120000, 20261012130000, 20261012150000, 20261012170000 (with the staged 20261003221905 and 20261005121409, which EP04 makes the only conversion path); 20261012140000 in pending-migrations drops lot_takedowns.deposit_cents later) with the code (pending approval). |
| EP04-02 | Entitlement milestones | verified | Apply the EP04 migrations (20261012070000, 20261012080000, 20261012090000, 20261012100000, 20261012110000, 20261012120000, 20261012130000, 20261012150000, 20261012170000 (with the staged 20261003221905 and 20261005121409, which EP04 makes the only conversion path); 20261012140000 in pending-migrations drops lot_takedowns.deposit_cents later) with the code (pending approval). |
| EP04-03 | Takedown obligations | verified | Apply the EP04 migrations (20261012070000, 20261012080000, 20261012090000, 20261012100000, 20261012110000, 20261012120000, 20261012130000, 20261012150000, 20261012170000 (with the staged 20261003221905 and 20261005121409, which EP04 makes the only conversion path); 20261012140000 in pending-migrations drops lot_takedowns.deposit_cents later) with the code (pending approval). |
| EP04-04 | Horizontal development controls | verified | Apply the EP04 migrations (20261012070000, 20261012080000, 20261012090000, 20261012100000, 20261012110000, 20261012120000, 20261012130000, 20261012150000, 20261012170000 (with the staged 20261003221905 and 20261005121409, which EP04 makes the only conversion path); 20261012140000 in pending-migrations drops lot_takedowns.deposit_cents later) with the code (pending approval). |
| EP04-05 | Lot lifecycle and bounded inventory | verified | Apply the EP04 migrations (20261012070000, 20261012080000, 20261012090000, 20261012100000, 20261012110000, 20261012120000, 20261012130000, 20261012150000, 20261012170000 (with the staged 20261003221905 and 20261005121409, which EP04 makes the only conversion path); 20261012140000 in pending-migrations drops lot_takedowns.deposit_cents later) with the code (pending approval). |
| EP04-06 | Concurrent lot allocation | verified | Apply the EP04 migrations (20261012070000, 20261012080000, 20261012090000, 20261012100000, 20261012110000, 20261012120000, 20261012130000, 20261012150000, 20261012170000 (with the staged 20261003221905 and 20261005121409, which EP04 makes the only conversion path); 20261012140000 in pending-migrations drops lot_takedowns.deposit_cents later) with the code (pending approval). |
| EP04-07 | Spec aging calculation | verified | Apply the EP04 migrations (20261012070000, 20261012080000, 20261012090000, 20261012100000, 20261012110000, 20261012120000, 20261012130000, 20261012150000, 20261012170000 (with the staged 20261003221905 and 20261005121409, which EP04 makes the only conversion path); 20261012140000 in pending-migrations drops lot_takedowns.deposit_cents later) with the code (pending approval). |
| EP04-08 | Spec disposition workflow | verified | Apply the EP04 migrations (20261012070000, 20261012080000, 20261012090000, 20261012100000, 20261012110000, 20261012120000, 20261012130000, 20261012150000, 20261012170000 (with the staged 20261003221905 and 20261005121409, which EP04 makes the only conversion path); 20261012140000 in pending-migrations drops lot_takedowns.deposit_cents later) with the code (pending approval). |

### EP05: Sales, agreements and closing

| ID | Outcome | Status | Next concrete step |
| --- | --- | --- | --- |
| EP05-01 | Lead ingestion and routing | partial | Product decision: which CRM / website form contract is in scope (doc 06 currently scopes lead ingestion out). |
| EP05-02 | Buyer and reservation continuity | verified | Obtain approval and apply 20261003221905, 20261004000100, 20261003232615, 20261005121409; enable ARC_RESERVATION_CONVERSION_ENABLED, ARC_AGREEMENT_ATOMIC_CREATION_ENABLED, ARC_AGREEMENT_DURABLE_SIGNING_ENABLED. |
| EP05-03 | Agreement packet versions | partial | Model versioned agreement templates and addenda with org/community/jurisdiction applicability and immutable published versions (new entity: RLS, RBAC seed, search registration; migration needs approval). |
| EP05-04 | Contingency management | partial | Model agreement contingencies (type, owner, due date, evidence file, status, waiver) linked to the purchase agreement (migration needs approval). |
| EP05-05 | Lender and title milestones | pending | Product decision on lender/title scope and partner(s). |
| EP05-06 | Commission controls | pending | Product decision on commission plans (co-op %, internal sales comp) and payout source. |
| EP05-07 | Agreement amendments and cancellation | partial | Cancel/hold start packages, POs/variance orders and open signing envelopes on void; release incentive capacity. |
| EP05-08 | Purchase and settlement arithmetic | verified | Apply 20261003050000_closing_evidence_guards after approval. |
| EP05-09 | Atomic closing and deposit reconciliation | verified | Apply migration 20261010120000_closing_invoice_unique (pending approval). |
| EP05-10 | Closing to warranty handoff | partial | Apply migration 20261010120100_warranty_coverage_write_scope (pending approval). |

### EP06: Selections and permits

| ID | Outcome | Status | Next concrete step |
| --- | --- | --- | --- |
| EP06-01 | Selection appointments | partial | Consultant/location capacity and a DB-enforced overlap check (exclusion constraint on time range per coordinator/location) - migration needs approval. |
| EP06-02 | Buyer selection approval | partial | Persist option id + price/cost snapshot in the approval document at send; on execution confirm only if the selection still matches, otherwise flag for re-approval. |
| EP06-03 | Cutoff enforcement | verified | Authorize overrides against the project/division. |
| EP06-04 | Supply lead-time eligibility | pending | Per-option effective cutoff = schedule needed-by date minus lead_time_days, enforced in assertSelectionMutable. |
| EP06-05 | Selection change propagation | partial | Apply migration 20261010120200_apply_project_selection_writes (pending approval). |
| EP06-06 | Permit submission lifecycle | pending | Model permit applications per home/jurisdiction with submissions, revisions, required-document checklist and decisions (new entity: RLS, RBAC seed, search index, events). |
| EP06-07 | Permit corrections and aging | pending | After EP06-06, add correction rounds (owner, due date, history) and an overdue/unresolved queue on the Starts desk. |
| EP06-08 | Permit fees and release gate | partial | Require evidence when attesting the permit gate; derive it from an approved permit with issued plans once EP06-06 lands. |

### EP07: Starts and trade coordination

| ID | Outcome | Status | Next concrete step |
| --- | --- | --- | --- |
| EP07-01 | Evidence-backed release gates | partial | Require evidence for manual permit/financing gates: validate evidence_file_id against files.org_id/project_id (or link a permit/financing record) in attestGate and re-check it in assertReleaseGateCompletion. |
| EP07-02 | Even-flow release planning | partial | Decide and implement division/org throughput targets enforced at release. |
| EP07-03 | Crew and superintendent capacity | partial | Design crew/superintendent capacity calendars (schema, RLS, RBAC; migration pending approval). |
| EP07-04 | Resumable artifact steps | partial | Make each instantiation handler and its ledger mark atomic (RPC or idempotency keys). |
| EP07-05 | Trade notice recovery desk | verified | Apply migrations 20261003048000 (edited) and 20261010100000 together with this code (pending approval). |
| EP07-06 | Complete trade look-ahead | partial | Exclude cancelled schedule items (decide on completed) in loadTradeLookahead and read_trade_lookahead_workspace, with tests. |
| EP07-07 | Delivery idempotency and reconciliation | partial | Snapshot notice content and recipients (with a hash) at enqueue and send from the snapshot. |
| EP07-08 | Trade acceptance workflow | pending | Design trade response records bound to the issued scope version (accept/decline/reschedule with proposed dates): schema, RLS, RBAC, pending migration. |
| EP07-09 | Dependency-aware bulk rescheduling | partial | Fix bulkUpdateScheduleItems silently ignoring failed item updates (schedule.ts:930). |
| EP07-10 | Tokenized job claim protocol | verified | Full-schema, independent-session claim/heartbeat/reaper race proof. |
| EP07-11 | Core release ownership | verified | Apply migrations 20261003048000 (edited), 20261010100000 (edited), 20261010140000_starts_home_creation and 20261010141000_abandoned_plan_drawing_copy_cleanup together with the code (pending approval). |
| EP07-12 | Generated artifact ownership | verified | Replay schedule/budget/inspection/PO/land guards against the full schema (move their tests onto tests/support/pglite.js). |
| EP07-13 | Transactional actor authority | partial | Apply migrations 20261003048000 (edited) and 20261010100000 (pending approval). |
| EP07-14 | Bounded storage copy | implemented | Run plan-copy private copy, changed-source and destination receipt scenarios against the acceptance bucket (extend the STORE-01 kit). |
| EP07-15 | Durable drawing publication | verified | Run the consumer, SQL chain and real storage together in QA. |
| EP07-16 | Child worker and orphan recovery | verified | Apply migrations 20261003048000 (edited), 20261010100000 (edited) and 20261010141000_abandoned_plan_drawing_copy_cleanup (pending approval). |
| EP07-17 | Atomic release finalization | verified | Apply migrations 20261003048000 (edited), 20261010100000 (edited) and 20261010140000_starts_home_creation (pending approval). |
| EP07-18 | Starts cutover and rollback | pending | Keep the staged starts migrations from being swept in by db push until the approved cutover. |

### EP08: Purchasing and supply chain

| ID | Outcome | Status | Next concrete step |
| --- | --- | --- | --- |
| EP08-01 | Production bid workbench entry | verified | Fix rescind of price-book awards (EP08-05) since it is reachable from this workbench. |
| EP08-02 | Bounded bid and vendor queues | verified | QA judgement whether the vendor picker must show a visible total; if so surface the directory page total. |
| EP08-03 | Bid subresource authorization | partial | Route listBidPackages/getProjectBuyoutSummary through assertBidProjectVisibility; scope or delete listCommunityBidPackages. |
| EP08-04 | Complete bid intelligence | verified | Render an explicit error state instead of .catch(() => null) at app/(app)/purchasing/bids/[packageId]/page.tsx:40. |
| EP08-05 | Rebid and renewal lifecycle | partial | Make rescind_bid_award void/end the minted agreements and restore superseded predecessors transactionally (migration, needs approval). |
| EP08-06 | PO preview and exception resolution | verified | Decide policy for zero-price manual resolutions. |
| EP08-07 | Transactional PO issuance | partial | Apply migration 20261010111000_po_generation_commit_rejects_stale_prior_run after 20261003048000 (pending approval). |
| EP08-08 | Vendor PO acknowledgment | partial | Add an issued-version concept and vendor accept/dispute (quantities, dates, scope) with reason, portal permission, events, audit and email allowlist (migration). |
| EP08-09 | Variance approval controls | partial | Require cost evidence per org policy and validate file ancestry. |
| EP08-10 | Delivery and shortage workflow | partial | Design delivery records keyed to home + PO line (expected/received date and qty, shortage reason) — migration with RLS, indexes, RBAC, search, events. |
| EP08-11 | Completion to payment reconciliation | partial | Apply migration 20261010110000_po_completion_rollback_keeps_bill (pending approval). |
| EP08-12 | Complete variance reporting | verified | Compare scoped vs RPC outputs and export totals on populated QA facts. |

### EP09: Field execution and quality

| ID | Outcome | Status | Next concrete step |
| --- | --- | --- | --- |
| EP09-01 | Assigned-home mobile access | partial | Replace per-request listProjects scans with a single-project check (lib/mobile/field.ts and sibling requireProject helpers). |
| EP09-02 | Offline conflict recovery | partial | Apply migration 20261010170000_mobile_idempotency_receipts (pending approval). |
| EP09-03 | Released field documents | partial | Approve/apply the plan drawing publication migrations and enable planDrawingCopyTransactions in the QA org. |
| EP09-04 | Inspection failure lifecycle | implemented | Link corrective punch work to the failed item inside the lifecycle transaction (creation now uses the punch service; the link is still a separate write). |
| EP09-05 | Punch and close readiness | verified | Apply migration 20261010114000_punch_permissions_for_field_leads (pending approval) before relying on punch.write in production. |
| EP09-06 | Cross-home daily records | partial | Add a cross-home review band (logs missing today, new photos) for assigned homes on the super's Home/My Work. |
| EP09-07 | Supplier and trade communication | partial | Add optional PO linkage on field issues/punch with ancestry validation. |
| EP09-08 | Field device usability | pending | Agree the required daily field workflows and a latency target with the owner. |

### EP10: Finance and planning

| ID | Outcome | Status | Next concrete step |
| --- | --- | --- | --- |
| EP10-01 | Legal-entity financial reconciliation | verified | Decide whether a first production builder needs independent per-company close/reopen; if yes, build it (today companies close together). |
| EP10-02 | Inventory and land capitalization | partial | Add a governed correction for a land acquisition (reverse, clear the lot's acquisition pointer, re-acquire) and for a start transfer (reverse and re-transfer when the start is undone or redated), preserving receipts. |
| EP10-03 | Construction-driven cash forecast | partial | Feed starts (budgets by schedule), closings (settlement proceeds), takedowns, loan draws and payoffs, with editable scenario assumptions. |
| EP10-04 | Margin arithmetic | partial | Expose original vs revised budget separately from the approved/locked baseline. |
| EP10-05 | Complete portfolio reporting | partial | Define and persist immutable baselines (budget snapshot at start/sale) and cohorts (start/sale/close period). |
| EP10-06 | Loan draw and payoff lifecycle | partial | Model construction loans per home/community (limit, availability, lender, draw requests with evidence) on top of the debt register. |
| EP10-07 | Accounting adapter parity | partial | Get the first customer's adapter choice and list the required production transactions. |
| EP10-08 | Period close and financial recovery | verified | Approve and deploy 20261003002108_books_close_control_integrity.sql, 20261006155617_books_period_close_recovery.sql and 20261007200000_books_home_inventory_controls.sql (pending list 2026-10-08). |

### EP11: Warranty and customer care

| ID | Outcome | Status | Next concrete step |
| --- | --- | --- | --- |
| EP11-01 | Installed-home and coverage migration | pending | Add an installed-base importer (closed homes: lot/address, buyer, actual close date, program and terms as sold) that creates closed homes and enrolls coverage with the original terms snapshot. |
| EP11-02 | Warranty coverage classification | verified | Apply migration 20261010120100_warranty_coverage_write_scope (pending approval). |
| EP11-03 | SLA routing and escalation | partial | Report historical breaches on the desk/analytics from the persisted facts. |
| EP11-04 | Dispatch capacity and rescheduling | partial | Apply migration 20261010120300_warranty_visit_double_book_guard (pending approval). |
| EP11-05 | Visit completion and verification | partial | Policy then enforcement: verification by a different authorized user for every completion. |
| EP11-06 | Backcharge dispute lifecycle | partial | Settled-for-less outcome with partial reversal and explicit authority; test re-issue after dispute when the credit was already reversed. |
| EP11-07 | Warranty accounting reconciliation | partial | Apply (edited) migration 20261007235500_books_homes_inventory_and_allocations (pending approval). |
| EP11-08 | Complete defect feedback | partial | Deploy 20261003053000_warranty_actor_analytics.sql, enable the flag, expose plan/version/trade groupings with drill-down. |

### EP12: Migration and integration platform

| ID | Outcome | Status | Next concrete step |
| --- | --- | --- | --- |
| EP12-01 | Bounded validated import reads | verified | Add a case to tests/imports.test.js with >1,000 communities / >10,000 lots proving no false unresolved rejections. |
| EP12-02 | Open-WIP continuity | verified | Clean up or receipt-reuse buyer contacts (imports.ts:793) and vendor companies created by ensureCompany (:770, :489) inside a failed row. |
| EP12-03 | Atomic resumable cutover | partial | Move Open-WIP commit to a durable outbox job with a lease and per-row transactional RPC that writes the import_rows receipt with the home (migration needs approval). |
| EP12-04 | Financial and signed-document migration | partial | Agreement + executed-document importer (file, hash, signers, immutable) linked to the Open-WIP home, reusing Documents/Signing storage (STORE-01 proved the storage layer). |
| EP12-05 | Selections and warranty continuity | pending | Installed-home importer (home identity, close date, program/terms version, structural carrier) creating coverage with an import source and terms snapshot. |
| EP12-06 | Integration API contract | partial | Define required surface from the EP14-11 integration inventory. |
| EP12-07 | Webhook delivery and replay | pending | Endpoint registration with secret/scopes/version, HMAC-signed payloads, durable per-endpoint delivery with retry/backoff, dead-letter and replay in ops. |
| EP12-08 | Chosen-system sandbox acceptance | pending | Obtain the first builder's named systems (EP14-11). |

### EP13: Performance and resilience

| ID | Outcome | Status | Next concrete step |
| --- | --- | --- | --- |
| EP13-01 | Representative load dataset | partial | Parameterize the production seed up to a first-builder size per notes and then toward loadTargets (divisions, communities, lots, installed homes, warranty history). |
| EP13-02 | Mixed-role performance proof | pending | Load runner (desk reads, mutations, mobile) on the acceptance stack reporting p50/p95/p99, throughput, error rate. |
| EP13-03 | Tenant fairness and bulk controls | partial | Per-org fair claiming in claim_jobs (migration needs approval). |
| EP13-04 | Truthful starts completion telemetry | verified | Verify deployed after() lifetime, partial failure and telemetry-error behavior in the QA org. |
| EP13-05 | Durable running-job monitoring | partial | Write a 'running' job_runs row with a deadline at start and reconcile overdue rows to timed_out (migration needs approval). |
| EP13-06 | Cross-pipeline observability | partial | Per-pipeline failed-unit views with documented safe recovery for starts, imports, signing, notifications (mirror Books posting status). |
| EP13-07 | Failure injection and race acceptance | partial | Add RACE-02 on the acceptance stack: double release of the same lot, concurrent agreement signing on one lot, concurrent VPO/PO approvals, cancellation racing a release. |
| EP13-08 | Backup restore drill | partial | Confirm Supabase PITR tier/retention and R2 bucket backup/versioning (operator). |
| EP13-09 | Availability and incident readiness | partial | SLO reference doc (first-builder targets, see notes). |
| EP13-10 | Runbooks and capacity review | partial | Extend the runbook to Arc as a whole: deploy rollback, stale/timed-out jobs, missing files/previews, integration backlog, starts pipeline, imports, warranty. |

### EP14: Release acceptance

| ID | Outcome | Status | Next concrete step |
| --- | --- | --- | --- |
| EP14-01 | Presold lifecycle acceptance | partial | Re-run LOT-01 on the acceptance stack (including --include-pending subcases) now that D1-D7 and D9-D15 are fixed, and record the result. |
| EP14-02 | Spec lifecycle acceptance | pending | Author SPEC-01 on the acceptance runner with released-cost/plan-version immutability and margin reconciliation; reuse HOME-01/LOSS-01 checks. |
| EP14-03 | Cancellation lifecycle acceptance | pending | Author CANCEL-01: before and after release, deposit refund/forfeit, reservation release, trade/PO cancellation, lot back to inventory; interrupted retry yields one outcome (RACE-01 pattern). |
| EP14-04 | Delayed-home lifecycle acceptance | pending | Author DELAY-01: permit or supply delay propagates to dependent schedules, start capacity and promised-close risk; approved changes update obligations consistently. |
| EP14-05 | Warranty lifecycle acceptance | pending | Implement EP12-05 installed-home import. |
| EP14-06 | Complete role and money concurrency matrix | partial | ROLE-01: AUTH-01-style scenario for production roles (sales consultant, purchasing, starts manager, superintendent, warranty tech, division-scoped manager, other org) across routes/actions/mobile. |
| EP14-07 | Desktop and mobile visual acceptance | partial | Re-run the production sweep for every role now that D2, D12, D14 and D15 are fixed; triage the remaining error pages per role (owner 12, purchasing 9) to a cause. |
| EP14-08 | Full schema and deployment parity | partial | Wire pnpm db:ledger:check into verify.yml on trusted branches (or fix the script header). |
| EP14-09 | Migration and activation approval | partial | Per-release activation manifest for the production workstreams (ordered migrations from db:pending, lock/index risk, ARC_* flags, worker drain, monitoring, rollback). |
| EP14-10 | Independent security review | pending | Write review scope and threat model (tenant isolation, portals/tokens, storage, payments, imports). |
| EP14-11 | Operating requirements and integrations | pending | Prepare approval package with first-builder sizing (notes), operating assumptions and integration inventory form. |
| EP14-12 | Operational release sign-off | pending | Complete dependencies; owner records release decision and residual backlog. |

## Scope and acceptance limits

250 pages are inventoried, each assessed for production exposure and mapped to checklist IDs; excluded pages carry file:line evidence. Mobile is one deferred entry.

Sizing and operating assumptions are frozen engineering targets awaiting launch-owner approval under EP14-11. QA access, chosen-system sandbox credentials, migration/activation approval, independent security review and operational sign-off remain explicit external gates. No customer database, storage or email mutations were performed.

This side conversation cannot access the persistent main-thread goal, and exposed goal tools support status updates only, not editing an active objective. Do not mark the old goal complete or create a replacement to bypass this limitation; use this user-approved checklist as its governing DoD.

## Tracking issues

- AUDIT-20261009-EP01-EP02: source changed since proof: components/layout/app-sidebar.tsx
- AUDIT-20261009-EP01-EP02: source changed since proof: components/home/production-home.tsx
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/services/production-home.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: app/(app)/error.tsx
- AUDIT-20261009-EP01-EP02: source changed since proof: app/(app)/pipeline/layout.tsx
- AUDIT-20261009-EP01-EP02: source changed since proof: scripts/books-acceptance/journeys/app-sweep.spec.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: tests/production-home.test.js
- AUDIT-20261009-EP01-EP02: source changed since proof: tests/authorization-policy.test.js
- AUDIT-20261009-EP01-EP02: source changed since proof: tests/instant-navigation-contract.test.js
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/services/starts-desk.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/services/sales-deals.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: app/(app)/sales/page.tsx
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/services/warranty-operations.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/services/community-portfolio.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/services/design-studio.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/services/production-bid-queue.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/services/community-inventory.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/land/paging.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/services/purchasing-workspace.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/services/org-payables.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: tests/production-bid-queue.test.js
- AUDIT-20261009-EP01-EP02: source changed since proof: tests/land-scope.test.js
- AUDIT-20261009-EP01-EP02: source changed since proof: tests/purchasing-queue-scope.test.js
- AUDIT-20261009-EP01-EP02: source changed since proof: tests/warranty-desk-scope.test.js
- AUDIT-20261009-EP01-EP02: source changed since proof: tests/warranty-desk-query.test.js
- AUDIT-20261009-EP01-EP02: source changed since proof: tests/org-payables.test.js
- AUDIT-20261009-EP01-EP02: source changed since proof: tests/payables-book.test.js
- AUDIT-20261009-EP01-EP02: source changed since proof: components/purchasing/entity-picker.tsx
- AUDIT-20261009-EP01-EP02: source changed since proof: components/sales/find-a-home-dialog.tsx
- AUDIT-20261009-EP01-EP02: source changed since proof: components/sales/lot-hold-form.tsx
- AUDIT-20261009-EP01-EP02: source changed since proof: app/(app)/sales/actions.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/services/community-sales.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/services/production-desk-scope.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: tests/communities.test.js
- AUDIT-20261009-EP01-EP02: source changed since proof: components/schedule/gantt-chart.tsx
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/product-tier.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/services/production-house-overview.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: components/starts/launch-lane.tsx
- AUDIT-20261009-EP01-EP02: source changed since proof: app/(app)/contacts/actions.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: tests/product-posture-terminology.test.js
- AUDIT-20261009-EP01-EP02: source changed since proof: components/invoices/billing-book.tsx
- AUDIT-20261009-EP01-EP02: source changed since proof: components/payables/pay-batch-dialog.tsx
- AUDIT-20261009-EP01-EP02: source changed since proof: components/payables/payables-desk.tsx
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/services/lots.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/services/vendor-bills.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/services/starts.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: tests/starts-release.test.js
- AUDIT-20261009-EP01-EP02: source changed since proof: scripts/qa/production-readiness.mjs
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/services/communities.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/services/books/legal-entities.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: supabase/migrations/20261007235800_books_legal_entities.sql
- AUDIT-20261009-EP01-EP02: source changed since proof: supabase/migrations/20261007235500_books_retire_native_entity_ledger.sql
- AUDIT-20261009-EP01-EP02: source changed since proof: proxy.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/auth/mfa-gate-cookie.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/services/team.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: app/(auth)/auth/actions.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/auth/context.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/mobile/auth.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/services/invoices.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/services/authorization.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/services/bids.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: app/(app)/tasks/actions.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/services/financial-exports.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/services/reports/cash-flow-forecast.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: tests/support/pglite.js
- AUDIT-20261009-EP01-EP02: source changed since proof: tests/authorization-project-scope.test.js
- AUDIT-20261009-EP01-EP02: source changed since proof: tests/search-visibility.test.js
- AUDIT-20261009-EP01-EP02: source changed since proof: tests/imports.test.js
- AUDIT-20261009-EP01-EP02: source changed since proof: tests/bids.test.js
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/services/payment-runs.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/services/audit.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: lib/services/platform-session.ts
- AUDIT-20261009-EP01-EP02: source changed since proof: tests/platform-actions.test.js
- AUDIT-20261009-EP03-EP04: source changed since proof: lib/services/house-plans.ts
- AUDIT-20261009-EP03-EP04: source changed since proof: lib/services/plan-instantiation.ts
- AUDIT-20261009-EP03-EP04: source changed since proof: lib/services/community-sales.ts
- AUDIT-20261009-EP03-EP04: source changed since proof: supabase/migrations/20261004000030_agreement_catalog_revisions.sql
- AUDIT-20261009-EP03-EP04: source changed since proof: tests/plan-instantiation-ledger.test.js
- AUDIT-20261009-EP03-EP04: source changed since proof: tests/catalog-publication-history-db.test.js
- AUDIT-20261009-EP03-EP04: source changed since proof: lib/services/configuration-rules.ts
- AUDIT-20261009-EP03-EP04: source changed since proof: lib/selections/configuration-rules.ts
- AUDIT-20261009-EP03-EP04: source changed since proof: tests/configuration-rules.test.js
- AUDIT-20261009-EP03-EP04: source changed since proof: lib/services/selections.ts
- AUDIT-20261009-EP03-EP04: source changed since proof: lib/services/starts.ts
- AUDIT-20261009-EP03-EP04: source changed since proof: lib/services/po-generation.ts
- AUDIT-20261009-EP03-EP04: source changed since proof: lib/services/starts-pipeline.ts
- AUDIT-20261009-EP03-EP04: source changed since proof: tests/catalog-eligibility.test.js
- AUDIT-20261009-EP03-EP04: source changed since proof: tests/po-generation-preview.test.js
- AUDIT-20261009-EP03-EP04: source changed since proof: tests/agreement-configuration-eligibility.test.js
- AUDIT-20261009-EP03-EP04: source changed since proof: lib/services/catalog-group-publication.ts
- AUDIT-20261009-EP03-EP04: source changed since proof: lib/services/option-catalog.ts
- AUDIT-20261009-EP03-EP04: source changed since proof: supabase/migrations/20261004065019_catalog_group_publication.sql
- AUDIT-20261009-EP03-EP04: source changed since proof: tests/catalog-package-publication-service.test.js
- AUDIT-20261009-EP03-EP04: source changed since proof: tests/catalog-group-publication-db.test.js
- AUDIT-20261009-EP03-EP04: source changed since proof: tests/catalog-group-publication-service.test.js
- AUDIT-20261009-EP03-EP04: source changed since proof: tests/catalog-price-publication-service.test.js
- AUDIT-20261009-EP03-EP04: source changed since proof: tests/catalog-publication-intents-db.test.js
- AUDIT-20261009-EP03-EP04: source changed since proof: lib/services/imports.ts
- AUDIT-20261009-EP03-EP04: source changed since proof: supabase/migrations/20261003033500_starts_release_lot_plan_scope.sql
- AUDIT-20261009-EP03-EP04: source changed since proof: lib/validation/lots.ts
- AUDIT-20261009-EP03-EP04: source changed since proof: lib/selections/catalog-math.ts
- AUDIT-20261009-EP03-EP04: source changed since proof: lib/land/paging.ts
- AUDIT-20261009-EP03-EP04: source changed since proof: tests/catalog-price-validation.test.js
- AUDIT-20261009-EP03-EP04: source changed since proof: lib/services/production-reporting.ts
- AUDIT-20261009-EP03-EP04: source changed since proof: lib/services/budgets.ts
- AUDIT-20261009-EP03-EP04: source changed since proof: supabase/migrations/20261007180000_books_home_sale_relief.sql
- AUDIT-20261009-EP03-EP04: source changed since proof: tests/purchase-agreement-pricing.test.js
- AUDIT-20261009-EP03-EP04: source changed since proof: app/(app)/plans/[id]/page.tsx
- AUDIT-20261009-EP03-EP04: source changed since proof: components/sales/purchase-agreement-sheet.tsx
- AUDIT-20261009-EP03-EP04: source changed since proof: lib/services/books/inventory.ts
- AUDIT-20261009-EP03-EP04: source changed since proof: supabase/migrations/20261008040000_books_opening_inventory.sql
- AUDIT-20261009-EP03-EP04: source changed since proof: lib/services/communities.ts
- AUDIT-20261009-EP03-EP04: source changed since proof: lib/starts/gate-logic.ts
- AUDIT-20261009-EP03-EP04: source changed since proof: tests/starts-gates.test.js
- AUDIT-20261009-EP03-EP04: source changed since proof: lib/services/community-portfolio.ts
- AUDIT-20261009-EP03-EP04: source changed since proof: lib/land/lot-lifecycle.ts
- AUDIT-20261009-EP03-EP04: source changed since proof: lib/services/lots.ts
- AUDIT-20261009-EP03-EP04: source changed since proof: supabase/migrations/20261007210000_books_development_allocation_review.sql
- AUDIT-20261009-EP03-EP04: source changed since proof: supabase/migrations/20261007200000_books_home_inventory_controls.sql
- AUDIT-20261009-EP03-EP04: source changed since proof: supabase/migrations/20261005121409_reservation_conversion_ownership.sql
- AUDIT-20261009-EP03-EP04: source changed since proof: tests/land-foundation.test.js
- AUDIT-20261009-EP03-EP04: source changed since proof: lib/services/community-inventory.ts
- AUDIT-20261009-EP03-EP04: source changed since proof: tests/land-scope.test.js
- AUDIT-20261009-EP03-EP04: source changed since proof: lib/services/reservation-conversion.ts
- AUDIT-20261009-EP03-EP04: source changed since proof: tests/reservation-conversion.test.js
- AUDIT-20261009-EP03-EP04: source changed since proof: tests/reservation-conversion-db.test.js
- AUDIT-20261009-EP03-EP04: source changed since proof: tests/reservation-creation-preparation.test.js
- AUDIT-20261009-EP03-EP04: source changed since proof: lib/sales/spec-inventory.ts
- AUDIT-20261009-EP03-EP04: source changed since proof: lib/services/projects.ts
- AUDIT-20261009-EP03-EP04: source changed since proof: tests/spec-inventory-aging.test.js
- AUDIT-20261009-EP03-EP04: source changed since proof: supabase/migrations/20261007235000_books_inventory_impairment.sql
- AUDIT-20261009-EP05-EP06: source changed since proof: lib/services/sales-inquiries.ts
- AUDIT-20261009-EP05-EP06: source changed since proof: lib/services/sales-deals.ts
- AUDIT-20261009-EP05-EP06: source changed since proof: lib/services/prospects.ts
- AUDIT-20261009-EP05-EP06: source changed since proof: app/(app)/sales/actions.ts
- AUDIT-20261009-EP05-EP06: source changed since proof: tests/prospects.test.js
- AUDIT-20261009-EP05-EP06: source changed since proof: tests/sales-deal-file.test.js
- AUDIT-20261009-EP05-EP06: source changed since proof: lib/services/community-sales.ts
- AUDIT-20261009-EP05-EP06: source changed since proof: lib/services/reservation-conversion.ts
- AUDIT-20261009-EP05-EP06: source changed since proof: components/sales/reservation-review-dialog.tsx
- AUDIT-20261009-EP05-EP06: source changed since proof: supabase/migrations/20261005121409_reservation_conversion_ownership.sql
- AUDIT-20261009-EP05-EP06: source changed since proof: tests/reservation-conversion.test.js
- AUDIT-20261009-EP05-EP06: source changed since proof: tests/reservation-conversion-db.test.js
- AUDIT-20261009-EP05-EP06: source changed since proof: tests/reservation-creation-preparation.test.js
- AUDIT-20261009-EP05-EP06: source changed since proof: tests/agreement-creation-db.test.js
- AUDIT-20261009-EP05-EP06: source changed since proof: supabase/migrations/20261003232615_purchase_agreement_signing_ownership.sql
- AUDIT-20261009-EP05-EP06: source changed since proof: tests/agreement-signing-identity.test.js
- AUDIT-20261009-EP05-EP06: source changed since proof: tests/agreement-quote-fingerprint.test.js
- AUDIT-20261009-EP05-EP06: source changed since proof: lib/services/closings.ts
- AUDIT-20261009-EP05-EP06: source changed since proof: lib/services/closing-readiness.ts
- AUDIT-20261009-EP05-EP06: source changed since proof: lib/services/starts.ts
- AUDIT-20261009-EP05-EP06: source changed since proof: tests/closing-readiness.test.js
- AUDIT-20261009-EP05-EP06: source changed since proof: lib/financials/purchase-agreement-pricing.ts
- AUDIT-20261009-EP05-EP06: source changed since proof: lib/services/change-orders.ts
- AUDIT-20261009-EP05-EP06: source changed since proof: lib/services/selections.ts
- AUDIT-20261009-EP05-EP06: source changed since proof: supabase/migrations/20261007220000_books_home_closing_reversal.sql
- AUDIT-20261009-EP05-EP06: source changed since proof: supabase/migrations/20261003050000_closing_evidence_guards.sql
- AUDIT-20261009-EP05-EP06: source changed since proof: tests/purchase-agreement-pricing.test.js
- AUDIT-20261009-EP05-EP06: source changed since proof: tests/closing-evidence-guards-db.test.js
- AUDIT-20261009-EP05-EP06: source changed since proof: lib/financials/closing-settlement-evidence.ts
- AUDIT-20261009-EP05-EP06: source changed since proof: lib/services/books/inventory.ts
- AUDIT-20261009-EP05-EP06: source changed since proof: supabase/migrations/20261007180000_books_home_sale_relief.sql
- AUDIT-20261009-EP05-EP06: source changed since proof: lib/services/warranty-operations.ts
- AUDIT-20261009-EP05-EP06: source changed since proof: app/api/jobs/process-outbox/route.ts
- AUDIT-20261009-EP05-EP06: source changed since proof: lib/services/option-catalog.ts
- AUDIT-20261009-EP05-EP06: source changed since proof: lib/services/design-studio.ts
- AUDIT-20261009-EP05-EP06: source changed since proof: lib/validation/selections.ts
- AUDIT-20261009-EP05-EP06: source changed since proof: lib/services/selection-cutoffs.ts
- AUDIT-20261009-EP05-EP06: source changed since proof: tests/option-catalog-design-studio.test.js
- AUDIT-20261009-EP05-EP06: source changed since proof: lib/services/selection-change-orders.ts
- AUDIT-20261009-EP05-EP06: source changed since proof: tests/change-orders.test.js
- AUDIT-20261009-EP05-EP06: source changed since proof: lib/starts/gate-logic.ts
- AUDIT-20261009-EP05-EP06: source changed since proof: tests/starts-gates.test.js
- AUDIT-20261009-EP05-EP06: source changed since proof: tests/starts.test.js
- AUDIT-20261009-EP05-EP06: source changed since proof: tests/starts-release.test.js
- AUDIT-20261009-EP07: source changed since proof: lib/services/starts.ts
- AUDIT-20261009-EP07: source changed since proof: lib/starts/gate-logic.ts
- AUDIT-20261009-EP07: source changed since proof: lib/validation/starts.ts
- AUDIT-20261009-EP07: source changed since proof: components/starts/start-package-sheet.tsx
- AUDIT-20261009-EP07: source changed since proof: tests/starts-gates.test.js
- AUDIT-20261009-EP07: source changed since proof: tests/starts.test.js
- AUDIT-20261009-EP07: source changed since proof: lib/services/starts-desk.ts
- AUDIT-20261009-EP07: source changed since proof: lib/services/even-flow.ts
- AUDIT-20261009-EP07: source changed since proof: components/starts/launch-lane.tsx
- AUDIT-20261009-EP07: source changed since proof: lib/services/starts-pipeline.ts
- AUDIT-20261009-EP07: source changed since proof: lib/services/plan-instantiation.ts
- AUDIT-20261009-EP07: source changed since proof: tests/starts-release.test.js
- AUDIT-20261009-EP07: source changed since proof: tests/plan-instantiation-ledger.test.js
- AUDIT-20261009-EP07: source changed since proof: supabase/migrations/20261003023000_starts_job_claim_leases.sql
- AUDIT-20261009-EP07: source changed since proof: tests/start-trade-notices.test.js
- AUDIT-20261009-EP07: source changed since proof: lib/land/paging.ts
- AUDIT-20261009-EP07: source changed since proof: tests/trade-lookahead-workspace-db.test.js
- AUDIT-20261009-EP07: source changed since proof: lib/services/schedule.ts
- AUDIT-20261009-EP07: source changed since proof: components/schedule/gantt-chart.tsx
- AUDIT-20261009-EP07: source changed since proof: supabase/migrations/20261003041000_starts_claim_actor_transitions.sql
- AUDIT-20261009-EP07: source changed since proof: lib/supabase/server.ts
- AUDIT-20261009-EP07: source changed since proof: tests/starts-job-leases-db.test.js
- AUDIT-20261009-EP07: source changed since proof: supabase/migrations/20261003024000_starts_core_write_fences.sql
- AUDIT-20261009-EP07: source changed since proof: supabase/migrations/20261003030000_starts_package_lease_rpc.sql
- AUDIT-20261009-EP07: source changed since proof: supabase/migrations/20261003040000_starts_core_actor_scope.sql
- AUDIT-20261009-EP07: source changed since proof: tests/starts-core-write-fences-db.test.js
- AUDIT-20261009-EP07: source changed since proof: tests/starts-package-lease-rpc-db.test.js
- AUDIT-20261009-EP07: source changed since proof: supabase/migrations/20261003025000_starts_generated_artifact_fences.sql
- AUDIT-20261009-EP07: source changed since proof: supabase/migrations/20261003031000_starts_purchasing_write_fences.sql
- AUDIT-20261009-EP07: source changed since proof: supabase/migrations/20261003033000_starts_land_posting_fences.sql
- AUDIT-20261009-EP07: source changed since proof: supabase/migrations/20261003034000_starts_drawing_record_fences.sql
- AUDIT-20261009-EP07: source changed since proof: tests/starts-generated-fences-db.test.js
- AUDIT-20261009-EP07: source changed since proof: tests/starts-purchasing-fences-db.test.js
- AUDIT-20261009-EP07: source changed since proof: tests/starts-land-posting-fences-db.test.js
- AUDIT-20261009-EP07: source changed since proof: tests/starts-drawing-fences-db.test.js
- AUDIT-20261009-EP07: source changed since proof: supabase/migrations/20261003038000_starts_release_actor_scope.sql
- AUDIT-20261009-EP07: source changed since proof: supabase/migrations/20261003046000_starts_notification_delivery_recovery.sql
- AUDIT-20261009-EP07: source changed since proof: tests/starts-release-actor-db.test.js
- AUDIT-20261009-EP07: source changed since proof: supabase/migrations/20261003035000_plan_drawing_publication_transaction.sql
- AUDIT-20261009-EP07: source changed since proof: supabase/migrations/20261003036000_plan_drawing_copy_attempt.sql
- AUDIT-20261009-EP07: source changed since proof: supabase/migrations/20261003033500_starts_release_lot_plan_scope.sql
- AUDIT-20261009-EP07: source changed since proof: supabase/migrations/20261003037000_starts_worker_outbox_fanout_fences.sql
- AUDIT-20261009-EP07: source changed since proof: tests/support/pglite.js
- AUDIT-20261009-EP08-EP09: source changed since proof: lib/services/bids.ts
- AUDIT-20261009-EP08-EP09: source changed since proof: tests/bids.test.js
- AUDIT-20261009-EP08-EP09: source changed since proof: lib/services/production-bid-queue.ts
- AUDIT-20261009-EP08-EP09: source changed since proof: components/purchasing/entity-picker.tsx
- AUDIT-20261009-EP08-EP09: source changed since proof: lib/services/purchasing-workspace.ts
- AUDIT-20261009-EP08-EP09: source changed since proof: app/(app)/purchasing/page.tsx
- AUDIT-20261009-EP08-EP09: source changed since proof: tests/production-bid-queue.test.js
- AUDIT-20261009-EP08-EP09: source changed since proof: tests/purchasing-page.test.js
- AUDIT-20261009-EP08-EP09: source changed since proof: lib/services/bid-intelligence-visibility.ts
- AUDIT-20261009-EP08-EP09: source changed since proof: lib/services/bid-intelligence.ts
- AUDIT-20261009-EP08-EP09: source changed since proof: components/purchasing/purchasing-client.tsx
- AUDIT-20261009-EP08-EP09: source changed since proof: lib/services/po-generation.ts
- AUDIT-20261009-EP08-EP09: source changed since proof: lib/validation/po-generation.ts
- AUDIT-20261009-EP08-EP09: source changed since proof: tests/po-generation-preview.test.js
- AUDIT-20261009-EP08-EP09: source changed since proof: supabase/migrations/20261003032000_po_regeneration_fenced_children.sql
- AUDIT-20261009-EP08-EP09: source changed since proof: tests/starts-purchasing-fences-db.test.js
- AUDIT-20261009-EP08-EP09: source changed since proof: lib/services/po-completions.ts
- AUDIT-20261009-EP08-EP09: source changed since proof: lib/services/commitment-change-orders.ts
- AUDIT-20261009-EP08-EP09: source changed since proof: lib/validation/commitment-change-orders.ts
- AUDIT-20261009-EP08-EP09: source changed since proof: lib/mobile/purchasing.ts
- AUDIT-20261009-EP08-EP09: source changed since proof: tests/mobile-purchasing.test.js
- AUDIT-20261009-EP08-EP09: source changed since proof: tests/purchasing-queue-scope.test.js
- AUDIT-20261009-EP08-EP09: source changed since proof: lib/services/reports/variance-analysis.ts
- AUDIT-20261009-EP08-EP09: source changed since proof: tests/variance-analysis.test.js
- AUDIT-20261009-EP08-EP09: source changed since proof: lib/services/production-house-overview.ts
- AUDIT-20261009-EP08-EP09: source changed since proof: lib/services/my-houses.ts
- AUDIT-20261009-EP08-EP09: source changed since proof: lib/mobile/field.ts
- AUDIT-20261009-EP08-EP09: source changed since proof: lib/services/projects.ts
- AUDIT-20261009-EP08-EP09: source changed since proof: lib/mobile/daily-logs.ts
- AUDIT-20261009-EP08-EP09: source changed since proof: lib/services/plan-instantiation.ts
- AUDIT-20261009-EP08-EP09: source changed since proof: supabase/migrations/20261003035000_plan_drawing_publication_transaction.sql
- AUDIT-20261009-EP08-EP09: source changed since proof: supabase/migrations/20261003036000_plan_drawing_copy_attempt.sql
- AUDIT-20261009-EP08-EP09: source changed since proof: tests/plan-instantiation-ledger.test.js
- AUDIT-20261009-EP08-EP09: source changed since proof: lib/services/inspections.ts
- AUDIT-20261009-EP08-EP09: source changed since proof: lib/services/closing-readiness.ts
- AUDIT-20261009-EP08-EP09: source changed since proof: tests/inspection-completion-handoff.test.js
- AUDIT-20261009-EP08-EP09: source changed since proof: tests/inspections.test.js
- AUDIT-20261009-EP08-EP09: source changed since proof: lib/services/punch-lists.ts
- AUDIT-20261009-EP08-EP09: source changed since proof: lib/services/project-close-readiness.ts
- AUDIT-20261009-EP08-EP09: source changed since proof: app/(app)/projects/[id]/actions.ts
- AUDIT-20261009-EP08-EP09: source changed since proof: tests/closing-readiness.test.js
- AUDIT-20261009-EP08-EP09: source changed since proof: tests/closeout-preparation.test.js
- AUDIT-20261009-EP08-EP09: source changed since proof: tests/photo-record-contract.test.js
- AUDIT-20261009-EP10-EP11: source changed since proof: lib/services/books/legal-entities.ts
- AUDIT-20261009-EP10-EP11: source changed since proof: lib/services/books/verifier.ts
- AUDIT-20261009-EP10-EP11: source changed since proof: lib/services/books/period-close.ts
- AUDIT-20261009-EP10-EP11: source changed since proof: supabase/migrations/20261007235500_books_retire_native_entity_ledger.sql
- AUDIT-20261009-EP10-EP11: source changed since proof: supabase/migrations/20261007235800_books_legal_entities.sql
- AUDIT-20261009-EP10-EP11: source changed since proof: supabase/migrations/20261007235900_books_intercompany_lot_sales.sql
- AUDIT-20261009-EP10-EP11: source changed since proof: supabase/migrations/20261008001000_books_company_opening_balances.sql
- AUDIT-20261009-EP10-EP11: source changed since proof: docs/books-entities.md
- AUDIT-20261009-EP10-EP11: source changed since proof: tests/books-acceptance-scenarios.test.js
- AUDIT-20261009-EP10-EP11: source changed since proof: lib/services/books/inventory.ts
- AUDIT-20261009-EP10-EP11: source changed since proof: lib/services/starts-pipeline.ts
- AUDIT-20261009-EP10-EP11: source changed since proof: lib/services/closings.ts
- AUDIT-20261009-EP10-EP11: source changed since proof: components/books/inventory-allocation.tsx
- AUDIT-20261009-EP10-EP11: source changed since proof: supabase/migrations/20261003033000_starts_land_posting_fences.sql
- AUDIT-20261009-EP10-EP11: source changed since proof: supabase/migrations/20261007180000_books_home_sale_relief.sql
- AUDIT-20261009-EP10-EP11: source changed since proof: supabase/migrations/20261007210000_books_development_allocation_review.sql
- AUDIT-20261009-EP10-EP11: source changed since proof: supabase/migrations/20261007220000_books_home_closing_reversal.sql
- AUDIT-20261009-EP10-EP11: source changed since proof: supabase/migrations/20261008040000_books_opening_inventory.sql
- AUDIT-20261009-EP10-EP11: source changed since proof: scripts/books-acceptance/scenarios/home-01.cjs
- AUDIT-20261009-EP10-EP11: source changed since proof: tests/starts-land-posting-fences-db.test.js
- AUDIT-20261009-EP10-EP11: source changed since proof: tests/books-statement-correctness.test.js
- AUDIT-20261009-EP10-EP11: source changed since proof: lib/services/reports/cash-flow-forecast.ts
- AUDIT-20261009-EP10-EP11: source changed since proof: lib/services/community-portfolio.ts
- AUDIT-20261009-EP10-EP11: source changed since proof: lib/services/production-house-overview.ts
- AUDIT-20261009-EP10-EP11: source changed since proof: lib/services/production-reporting.ts
- AUDIT-20261009-EP10-EP11: source changed since proof: lib/services/books/close-control-rules.ts
- AUDIT-20261009-EP10-EP11: source changed since proof: lib/services/books/reconciliation-rules.ts
- AUDIT-20261009-EP10-EP11: source changed since proof: supabase/migrations/20261007200000_books_home_inventory_controls.sql
- AUDIT-20261009-EP10-EP11: source changed since proof: tests/books-close-control-integrity.test.js
- AUDIT-20261009-EP10-EP11: source changed since proof: tests/books-close-review.test.js
- AUDIT-20261009-EP10-EP11: source changed since proof: tests/arc-books.test.js
- AUDIT-20261009-EP10-EP11: source changed since proof: lib/services/warranty-operations.ts
- AUDIT-20261009-EP10-EP11: source changed since proof: lib/services/warranty/domain.ts
- AUDIT-20261009-EP10-EP11: source changed since proof: tests/warranty-program-usage.test.js
- AUDIT-20261009-EP10-EP11: source changed since proof: app/(app)/warranty/warranty-desk-client.tsx
- AUDIT-20261009-EP10-EP11: source changed since proof: app/(app)/warranty/page.tsx
- AUDIT-20261009-EP10-EP11: source changed since proof: tests/warranty-operations.test.js
- AUDIT-20261009-EP10-EP11: source changed since proof: tests/warranty-desk-query.test.js
- AUDIT-20261009-EP10-EP11: source changed since proof: tests/warranty-desk-scope.test.js
- AUDIT-20261009-EP10-EP11: source changed since proof: tests/warranty-page.test.js
- AUDIT-20261009-EP10-EP11: source changed since proof: lib/services/warranty/validation.ts
- AUDIT-20261009-EP10-EP11: source changed since proof: app/s/[token]/warranty/warranty-visits-client.tsx
- AUDIT-20261009-EP10-EP11: source changed since proof: supabase/migrations/20261003051000_warranty_visit_completion_receipts.sql
- AUDIT-20261009-EP10-EP11: source changed since proof: app/p/[token]/warranty/actions.ts
- AUDIT-20261009-EP10-EP11: source changed since proof: lib/services/vendor-bills.ts
- AUDIT-20261009-EP10-EP11: source changed since proof: supabase/migrations/20261007190000_books_warranty_consumption_accounts.sql
- AUDIT-20261009-EP10-EP11: source changed since proof: tests/closing-readiness.test.js
- AUDIT-20261009-EP10-EP11: source changed since proof: tests/closing-evidence-guards-db.test.js
- AUDIT-20261009-EP12-EP14: source changed since proof: lib/services/imports.ts
- AUDIT-20261009-EP12-EP14: source changed since proof: tests/imports.test.js
- AUDIT-20261009-EP12-EP14: source changed since proof: tests/imports-open-wip.test.js
- AUDIT-20261009-EP12-EP14: source changed since proof: supabase/migrations/20261008040000_books_opening_inventory.sql
- AUDIT-20261009-EP12-EP14: source changed since proof: lib/services/warranty-operations.ts
- AUDIT-20261009-EP12-EP14: source changed since proof: proxy.ts
- AUDIT-20261009-EP12-EP14: source changed since proof: docs/mobile-api-v1.openapi.yaml
- AUDIT-20261009-EP12-EP14: source changed since proof: scripts/books-acceptance/runtime.cjs
- AUDIT-20261009-EP12-EP14: source changed since proof: app/api/jobs/process-outbox/route.ts
- AUDIT-20261009-EP12-EP14: source changed since proof: tests/starts-job-leases-db.test.js
- AUDIT-20261009-EP12-EP14: source changed since proof: docs/books-operations.md
- AUDIT-20261009-EP12-EP14: source changed since proof: tests/starts-release.test.js
- AUDIT-20261009-EP12-EP14: source changed since proof: tests/starts-release-actor-db.test.js
- AUDIT-20261009-EP12-EP14: source changed since proof: tests/starts-drawing-fences-db.test.js
- AUDIT-20261009-EP12-EP14: source changed since proof: tests/starts-core-write-fences-db.test.js
- AUDIT-20261009-EP12-EP14: source changed since proof: scripts/books-acceptance/scenario-runner.cjs
- AUDIT-20261009-EP12-EP14: source changed since proof: scripts/books-acceptance/scenarios/home-01.cjs
- AUDIT-20261009-EP12-EP14: source changed since proof: scripts/books-acceptance/catalog.cjs
- AUDIT-20261009-EP12-EP14: source changed since proof: tests/spec-inventory-aging.test.js
- AUDIT-20261009-EP12-EP14: source changed since proof: scripts/books-acceptance/journeys/app-sweep.spec.ts
- AUDIT-20261009-EP12-EP14: source changed since proof: tests/authorization-project-scope.test.js
- AUDIT-20261009-EP12-EP14: source changed since proof: tests/authorization-policy.test.js
- AUDIT-20261009-EP12-EP14: source changed since proof: scripts/books-acceptance/browser-seed.cjs
- AUDIT-20261009-EP12-EP14: source changed since proof: lib/services/community-sales.ts
- AUDIT-20261009-EP12-EP14: source changed since proof: lib/services/reservation-conversion.ts
- AUDIT-20261009-EP12-EP14: source changed since proof: lib/services/catalog-group-publication.ts
- VERIFY-20261010: source changed since proof: tests/selections.test.js
- VERIFY-20261010: source changed since proof: tests/agreement-configuration-eligibility.test.js
- VERIFY-20261010: source changed since proof: tests/catalog-eligibility.test.js
- VERIFY-20261010: source changed since proof: tests/option-catalog-design-studio.test.js
- VERIFY-20261010: source changed since proof: tests/catalog-price-validation.test.js
- VERIFY-20261010: source changed since proof: tests/land-foundation.test.js
- VERIFY-20261010: source changed since proof: tests/land-scope.test.js
- VERIFY-20261010: source changed since proof: tests/lots.test.js
- VERIFY-20261010: source changed since proof: tests/community-sales.test.js
- VERIFY-20261010: source changed since proof: tests/spec-inventory-aging.test.js
- VERIFY-20261010: source changed since proof: tests/agreement-creation-db.test.js
- VERIFY-20261010: source changed since proof: tests/reservation-creation-preparation.test.js
- VERIFY-20261010: source changed since proof: tests/purchase-agreement-pricing.test.js
- VERIFY-20261010: source changed since proof: tests/closings-db.test.js
- VERIFY-20261010: source changed since proof: tests/selection-cutoffs.test.js
- VERIFY-20261010: source changed since proof: tests/imports-open-wip.test.js
- VERIFY-20261010: source changed since proof: tests/start-trade-notices.test.js
- VERIFY-20261010: source changed since proof: tests/starts-release-actor-db.test.js
- VERIFY-20261010: source changed since proof: tests/starts-core-write-fences-db.test.js
- VERIFY-20261010: source changed since proof: tests/starts-generated-fences-db.test.js
- VERIFY-20261010: source changed since proof: tests/starts-drawing-fences-db.test.js
- VERIFY-20261010: source changed since proof: tests/drawings-pipeline-db.test.js
- VERIFY-20261010: source changed since proof: tests/starts-release.test.js
- VERIFY-20261010: source changed since proof: tests/plan-instantiation-ledger.test.js
- VERIFY-20261010: source changed since proof: tests/bids.test.js
- VERIFY-20261010: source changed since proof: tests/production-bid-queue.test.js
- VERIFY-20261010: source changed since proof: tests/search-picker.test.js
- VERIFY-20261010: source changed since proof: tests/purchasing-page.test.js
- VERIFY-20261010: source changed since proof: tests/variance-analysis.test.js
- VERIFY-20261010: source changed since proof: tests/inspection-completion-handoff.test.js
- VERIFY-20261010: source changed since proof: tests/inspections.test.js
- VERIFY-20261010: source changed since proof: tests/closeout-preparation.test.js
- VERIFY-20261010: source changed since proof: tests/books-legal-entities-db.test.js
- VERIFY-20261010: source changed since proof: tests/books-historical-aging.test.js
- VERIFY-20261010: source changed since proof: tests/books-close-control-integrity.test.js
- VERIFY-20261010: source changed since proof: tests/books-close-review.test.js
- VERIFY-20261010: source changed since proof: tests/warranty-program-usage.test.js

