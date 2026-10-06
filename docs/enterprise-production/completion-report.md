# Arc Production completion baseline

Baseline: arc-production-national-builder-v1. Audit date: 2026-10-03. Generated from completion-checklist.json; update that file and regenerate this report.

Deliver and accept every mandatory item in docs/enterprise-production/completion-checklist.json baseline arc-production-national-builder-v1, preserving mixed-org behavior. The goal completes only when the checklist validator confirms 100% implemented, verified and release-ready, all five lifecycle scenarios pass, approved scale/recovery targets are demonstrated, and migration/security/operational sign-offs are recorded. Further enhancements require explicit scope change and belong in a separate backlog.

**136 mandatory items, 289 fixed complexity units.** Scope, criteria, weights and dependencies are frozen; additions require explicit user approval. Defects that prevent an existing criterion stay within that item. Optional improvements belong in the deferred backlog.

| Measure | Current result |
| --- | --- |
| Implemented | 11.4% — a documented lower bound, not an ETA |
| Fully verified | 0% |
| Release ready | 0% |
| Code implemented | 21 items |
| Partially implemented | 89 items |
| Known pending tasks | 26 items |
| Existing capability not yet qualified | 0 items |
| Isolated automated evidence | 92 items; this does not imply full workflow verification |

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
| EP01-01 | Role navigation | partial | Map permission-denied service errors to an explanatory forbidden state (reuse app/(app)/unauthorized or a typed error) instead of generic 'Try again' on each desk. |
| EP01-02 | Complete desk queues | partial | Confirm production PostgREST max_rows. Replace every .limit>1000 or unlimited desk read with readAllRows/keyset paging, or with a cap that reports when it truncates. |
| EP01-03 | Searchable operator pickers | partial | Replace lot-hold, Find-a-home, design-studio booking, warranty/purchasing vendor and tasks/schedule project Selects with the shared server-searched entity picker (scoped, paged). |
| EP01-04 | Shared scope across desks | partial | Make resolveProductionDeskScope return an explicit denied/empty scope (with message) whenever a requested community is not pinnable, regardless of division. |
| EP01-05 | Desk states and recovery | partial | Add desk-level error boundaries for communities, projects, tasks, payables, schedule and listed subroutes. |
| EP01-06 | Home and lot drill-down | partial | Fix LaunchLane/StartPackageSheet selection adoption and response fencing for permalinks. |
| EP01-07 | Bulk operator actions | partial | Make community bulk reprice atomic and idempotent: an RPC with an expected-price check and a request key. |
| EP01-08 | Page exposure inventory | partial | Assess remaining ~170 pages and write assessments back into surfaceInventory. |

### EP02: Enterprise organization and security

| ID | Outcome | Status | Next concrete step |
| --- | --- | --- | --- |
| EP02-01 | Enterprise hierarchy | partial | Decide/implement region level (or record explicit exclusion with approval). |
| EP02-02 | SSO and MFA enforcement | partial | Select IdP approach (Supabase SAML SSO) and implement domain-routed SSO sign-in. |
| EP02-03 | Provisioning and deprovisioning | partial | Implement SCIM (or IdP-driven) provisioning restricted to approved role/division mappings. |
| EP02-04 | Organization and division isolation | partial | Scope listTaskProjectsAction, financial exports and org reports by getDivisionScopedProjectIds for assigned users. |
| EP02-05 | Financial separation of duties | partial | Reject self-approval of bills/invoices when another approver exists (policy-controlled). |
| EP02-06 | Audit completeness | partial | Add correlation/request ID to audit_log and propagate from actions. |
| EP02-07 | Audit retention and export | partial | Write and implement explicit retention policy. |
| EP02-08 | Access review and emergency access | partial | Add access review report/attestation for role and division grants. |

### EP03: Product and configuration

| ID | Outcome | Status | Next concrete step |
| --- | --- | --- | --- |
| EP03-01 | Versioned product definition | partial | Give elevations a revision identity (version them under house_plan_versions or snapshot them at release) so post-release edits cannot change a priced home's elevation definition. |
| EP03-02 | Option dependency controls | implemented | Approve and apply 20261003013000_selection_configuration_rules.sql (migration approval). |
| EP03-03 | Configuration preflight | implemented | Verify all named entry points together in authorized QA with the rule flag enabled. |
| EP03-04 | Atomic configuration mutation | partial | Move home selection and package application (selectProjectPackage, updateSingleSelection, confirmSelectionGroup) into one DB transaction/RPC that re-validates the effective configuration and rules under a lock or revision fence. |
| EP03-05 | Community offering restrictions | partial | Make instantiatePlanForProject reject plans/elevations not offered in the lot community (and inactive elevations) unless an explicit, permissioned, evidenced override is recorded. |
| EP03-06 | Lot fit and orientation | partial | Model lot buildable constraints (dimensions/setbacks/orientation/allowed elevations) and plan/elevation footprint requirements; reconcile the snake_case vs camelCase lots.dimensions keys written by lib/services/imports.ts:669 vs lib/validation/lots.ts. |
| EP03-07 | Deterministic pricing resolution | implemented | Confirm (or enforce) that production homes without a pinned plan version fail pricing explicitly rather than falling back to base price. |
| EP03-08 | Immutable commercial snapshots | partial | Capture an original cost and margin baseline (plan takeoff/budget cost, option costs, incentives) at agreement and at start release, stored immutably. |
| EP03-09 | Revision impact and rollout | partial | Implement a revision proposal with affected-home preview (contracted vs released vs unsold) for plan, elevation and catalog changes, before release. |
| EP03-10 | Guided configuration correction | partial | Return structured violations (rule, source, target) from the preflight rather than a joined string. |

### EP04: Land and inventory

| ID | Outcome | Status | Next concrete step |
| --- | --- | --- | --- |
| EP04-01 | Acquisition diligence | pending | Design and build land opportunity entity with diligence items (evidence documents, owners, due dates), approval steps and versioned acquisition decisions, linked to the resulting community/takedowns. |
| EP04-02 | Entitlement milestones | pending | Model entitlements and jurisdiction conditions per community/phase with due dates, owners and status. |
| EP04-03 | Takedown obligations | partial | Link takedowns to a land contract/commitment with deposit schedule, refundability and extension/penalty terms, preserving signed evidence on change. |
| EP04-04 | Horizontal development controls | partial | Add horizontal development budgets and contracts per phase with actual-cost reconciliation to phases and lots. |
| EP04-05 | Lot lifecycle and bounded inventory | implemented | Verify permission-scoped bulk/lifecycle mutations and actual inventory paging in QA (400-lot community). |
| EP04-06 | Concurrent lot allocation | partial | Fix tests/reservation-conversion-db.test.js fixture (budget_lines missing from captured live columns) or the migration dependency, and get it green. |
| EP04-07 | Spec aging calculation | partial | Source standing-spec age from an actual completion fact (e.g., a recorded completion/CO date or the schedule's final milestone actual) rather than projects.end_date, or stamp end_date at completion. |
| EP04-08 | Spec disposition workflow | partial | Add an approved per-spec price/incentive change workflow writing asking_price_override_cents with audit. |

### EP05: Sales, agreements and closing

| ID | Outcome | Status | Next concrete step |
| --- | --- | --- | --- |
| EP05-01 | Lead ingestion and routing | partial | Decide the 'chosen CRM' and website form contract (product decision; doc 06 currently scopes lead ingestion out). |
| EP05-02 | Buyer and reservation continuity | implemented | Repair tests/reservation-conversion-db.test.js fixture (4/8 fail: relation public.budget_lines missing when loading create_invoice_atomic from 20260905004943_invoice_budget_mapping.sql) so the atomic commit/rollback/race cases actually run. |
| EP05-03 | Agreement packet versions | partial | Model versioned agreement templates and addenda (org/community/jurisdiction applicability, immutable published versions) - new entity with RLS, RBAC seed, search registration; migration needs approval. |
| EP05-04 | Contingency management | partial | Model agreement contingencies (type, owner, due date, evidence file, status, waiver) linked to the purchase agreement; seed from the agreement packet; migration needs approval. |
| EP05-05 | Lender and title milestones | pending | Product decision on lender/title scope and integration partner(s). |
| EP05-06 | Commission controls | pending | Product decision on commission plans (broker co-op %, internal sales comp) and payout source (payables artifact at settlement per doc 06). |
| EP05-07 | Agreement amendments and cancellation | partial | Decide amendment model: versioned agreement amendments (new snapshot version + signed packet) vs. signed COs; ensure authorized price/scope is readable as one current version with history. |
| EP05-08 | Purchase and settlement arithmetic | implemented | Apply 20261003050000_closing_evidence_guards after approval. |
| EP05-09 | Atomic closing and deposit reconciliation | partial | Fence concurrent settlement: claim the closing row (status transition or advisory lock) before creating the invoice, or add a unique index on invoices(org_id, metadata->>'source_closing_id') where invoice_kind='closing' (migration needs approval). |
| EP05-10 | Closing to warranty handoff | partial | Add an immutability trigger and restrict write RLS on project_warranty_coverage (migration needs approval). |

### EP06: Selections and permits

| ID | Outcome | Status | Next concrete step |
| --- | --- | --- | --- |
| EP06-01 | Selection appointments | partial | Add consultant/location capacity (studio rooms, hours) and an overlap check enforced in the DB (exclusion constraint on tstzrange per coordinator/location) - migration needs approval. |
| EP06-02 | Buyer selection approval | partial | Persist the option id + price/cost snapshot in the approval document metadata at send time and, on execution, confirm only if the selection still matches; otherwise flag for re-approval instead of re-pricing. |
| EP06-03 | Cutoff enforcement | implemented | Make the cutoff check atomic (conditional update on locked_at null and group status, or DB trigger) to close the TOCTOU between assertSelectionMutable and the update. |
| EP06-04 | Supply lead-time eligibility | pending | Compute per-option effective cutoff = needed-by date (from schedule) - lead_time_days and enforce it in assertSelectionMutable/eligibility. |
| EP06-05 | Selection change propagation | partial | Move CO approval -> selection apply -> variance orders into one DB transaction or receipt-keyed resumable job with idempotency per change order. |
| EP06-06 | Permit submission lifecycle | pending | Model permit applications per home/jurisdiction with submissions, revisions, required-document checklist and decisions (new entity: RLS, RBAC seed, search index, events). |
| EP06-07 | Permit corrections and aging | pending | After EP06-06, add correction rounds (owner, due date, history) and an overdue/unresolved queue on the Starts desk. |
| EP06-08 | Permit fees and release gate | partial | Add permit fee obligations linked to payables/expenses and reconcile to actual payments. |

### EP07: Starts and trade coordination

| ID | Outcome | Status | Next concrete step |
| --- | --- | --- | --- |
| EP07-01 | Evidence-backed release gates | partial | Require evidence for manual permit and financing gates. Either require an org/project-scoped evidence file (validate evidence_file_id against files.org_id/project_id) or link a permit/financing record, and re-check it in assertReleaseGateCompletion. |
| EP07-02 | Even-flow release planning | partial | Decide and implement cross-community (division/org) throughput targets enforced at release, not just summed for display. |
| EP07-03 | Crew and superintendent capacity | partial | Design and add crew/superintendent capacity calendars (schema, RLS, RBAC, migration pending approval). |
| EP07-04 | Resumable artifact steps | partial | Make resume fail (not warn) when a completed instantiation step came from a different plan version, and record per-step artifact receipts (ids/counts) that assertReleaseCompletion verifies. |
| EP07-05 | Trade notice recovery desk | implemented | Before applying 20261003023000, move retryStartTradeNotice's outbox update to an authorized service-side RPC. Under the staged guard it raises 42501. |
| EP07-06 | Complete trade look-ahead | partial | Exclude cancelled schedule items (and decide on completed items) in loadTradeLookahead and read_trade_lookahead_workspace, with tests. |
| EP07-07 | Delivery idempotency and reconciliation | partial | Snapshot notice content and recipient list (with a hash) at enqueue, make them immutable, and send from the snapshot. |
| EP07-08 | Trade acceptance workflow | pending | Design trade response records bound to the issued scope version (accept/decline/reschedule with proposed dates), with schema, RLS, RBAC and a pending migration. |
| EP07-09 | Dependency-aware bulk rescheduling | partial | Add a server-side, transactional dependency recompute for bulk moves, reusing calculateScheduleImpacts. |
| EP07-10 | Tokenized job claim protocol | implemented | Full-schema replay and independent-session claim/heartbeat/reaper races. |
| EP07-11 | Core release ownership | partial | Qualify linked-home acquisition, core cleanup and claim transitions against the full schema. |
| EP07-12 | Generated artifact ownership | implemented | Replay all guards and real domain RPCs together against the full schema. |
| EP07-13 | Transactional actor authority | partial | Move interactive starts mutations to RPCs that assert actor authority in-transaction (this also resolves the EP07-11 cutover defect). |
| EP07-14 | Bounded storage copy | implemented | Verify private copy, changed source and destination receipts with real storage in authorized QA. |
| EP07-15 | Durable drawing publication | implemented | Run the actual consumer, the full SQL chain and real storage together in QA. |
| EP07-16 | Child worker and orphan recovery | partial | Give start_release_trade_notice and trade_schedule_change_notice workers token-claimed ownership and retry rules. |
| EP07-17 | Atomic release finalization | partial | Implement an atomic finalize RPC: package status, lot/project state, event, audit and notification intent in one transaction under the claim. |
| EP07-18 | Starts cutover and rollback | pending | Fix the interactive-path incompatibility (EP07-11/EP07-05 defects) before any apply. |

### EP08: Purchasing and supply chain

| ID | Outcome | Status | Next concrete step |
| --- | --- | --- | --- |
| EP08-01 | Production bid workbench entry | implemented | Fix rescission of price-book awards (see defects) so the minted agreements are voided/ended and superseded predecessors restored — this is the EP08-05 gap but it is reachable from this workbench. |
| EP08-02 | Bounded bid and vendor queues | implemented | QA judgement whether picker 'accurate totals' requires a visible count; if so surface listDirectoryPage total in production-bid-vendor-picker. |
| EP08-03 | Bid subresource authorization | partial | Add division/membership visibility to listBidPackages and getProjectBuyoutSummary (or route through assertBidProjectVisibility); delete or scope the unused listCommunityBidPackages export. |
| EP08-04 | Complete bid intelligence | implemented | Surface intelligence failures in the workbench instead of .catch(() => null) at app/(app)/purchasing/bids/[packageId]/page.tsx:40 (or render an explicit error state). |
| EP08-05 | Rebid and renewal lifecycle | partial | Add a renewal view on the price book/bid workbench: expiring agreements (scope tuple, vendor, effective_to) side by side with replacement bid lines, with buyer-chosen effective_from passed into run_bid_award_price_agreements. |
| EP08-06 | PO preview and exception resolution | implemented | Make expectedFingerprint required for mode=commit in poGenerationInputSchema (server must not accept an unpreviewed commit). |
| EP08-07 | Transactional PO issuance | partial | Inside the RPC, under the project advisory lock, re-read the latest succeeded commit run and reject (or replace) when payload prior_run_id is stale, so concurrent different-fingerprint commits cannot both create full sets. |
| EP08-08 | Vendor PO acknowledgment | partial | Define an issued-version concept for POs (issue event/version number snapshot) and restrict the portal to issued, non-canceled POs. |
| EP08-09 | Variance approval controls | partial | Remove requested_by from client-writable input (always the authenticated actor) and keep reason_code_id immutable once a VPO is requested (or require vpo.request and re-run classification). |
| EP08-10 | Delivery and shortage workflow | partial | Design delivery records keyed to home + PO line (expected date/qty, received date/qty, shortage reason) — migration with RLS/indexes/RBAC/search/events. |
| EP08-11 | Completion to payment reconciliation | partial | Optionally gate completion verification/approval on the linked inspection (or record the inspection id on the completion) per org policy. |
| EP08-12 | Complete variance reporting | implemented | Compare scoped vs RPC outputs and export totals against populated QA facts. |

### EP09: Field execution and quality

| ID | Outcome | Status | Next concrete step |
| --- | --- | --- | --- |
| EP09-01 | Assigned-home mobile access | partial | Fix lib/mobile/purchasing.ts requireProject to use the same project authorization as the web (requireAuthorization with projectId) for PO list and VPO create. |
| EP09-02 | Offline conflict recovery | partial | Add expected_updated_at/revision to mobile task, punch and daily-log update endpoints and return 409 conflicts; surface conflicts in iOS FieldStore/DailyLogStore with keep-mine/keep-theirs. |
| EP09-03 | Released field documents | partial | Apply/approve the plan drawing publication migrations and enable planDrawingCopyTransactions in the QA org. |
| EP09-04 | Inspection failure lifecycle | implemented | Fix the stale test stub in tests/project-field-page-data.test.js (listInspectionObligations missing from the mock) so the field-page suite passes. |
| EP09-05 | Punch and close readiness | partial | Move punch create/update into lib/services/punch-lists.ts with requirePermission + project authorization (division scope). |
| EP09-06 | Cross-home daily records | partial | Add a cross-home review band (logs missing today, new photos) for assigned homes on the superintendent Home/My Work surface. |
| EP09-07 | Supplier and trade communication | partial | Add optional PO (commitment) linkage on field issues/punch with ancestry validation. |
| EP09-08 | Field device usability | pending | Agree the required daily field workflows and a measured latency target with the owner (scope input). |

### EP10: Finance and planning

| ID | Outcome | Status | Next concrete step |
| --- | --- | --- | --- |
| EP10-01 | Legal-entity financial reconciliation | partial | Activate entity ledgers beyond ledger_state='setup' and carry legal_entity_id through journal, AR, AP, cash and inventory subledgers. |
| EP10-02 | Inventory and land capitalization | partial | Define and implement correction flows (reverse acquisition/allocation/start transfer and re-post) that keep the original receipt chain and lot/home links. |
| EP10-03 | Construction-driven cash forecast | partial | Enforce authorized division/home scope (getProjectReadScopeForUser) and replace limit(1000)/unpaged reads with database aggregation or keyset paging that reports truncation. |
| EP10-04 | Margin arithmetic | partial | Read the approved/locked baseline budget version (or budget snapshot) explicitly and expose original vs revised separately. |
| EP10-05 | Complete portfolio reporting | partial | Move portfolio aggregation into a scoped SQL function (pattern: control_tower_rollup) so all authorized homes contribute without row caps. |
| EP10-06 | Loan draw and payoff lifecycle | partial | Model construction loans per home/community (limit, availability, lender, draw requests with lender evidence) on top of books_debt_instruments. |
| EP10-07 | Accounting adapter parity | partial | Obtain the customer-selected adapter and list the required production transaction set. |
| EP10-08 | Period close and financial recovery | partial | Add blocking tie-outs for land/WIP/finished inventory vs lot/home subledger, warranty reserve vs reserve policy/consumption, and closing settlement proceeds vs AR/deposits. |

### EP11: Warranty and customer care

| ID | Outcome | Status | Next concrete step |
| --- | --- | --- | --- |
| EP11-01 | Installed-home and coverage migration | pending | Add an installed-base importer (closed homes: lot/address, buyer, actual close date, program/terms as sold) that creates closed projects/closings and enrolls coverage with the original terms snapshot. |
| EP11-02 | Warranty coverage classification | implemented | Harden: revoke authenticated UPDATE/DELETE on project_warranty_coverage (or add an immutability trigger on terms_snapshot/effective_date) via an approved migration. |
| EP11-03 | SLA routing and escalation | partial | Implement routing rules (severity × community × responsibility → assignee/queue) or document manual triage as the accepted design. |
| EP11-04 | Dispatch capacity and rescheduling | partial | Make overbooking impossible under concurrency (exclusion constraint on assignee + tstzrange for non-canceled visits, or transactional RPC with advisory lock) and require an audited reason for allow_conflict. |
| EP11-05 | Visit completion and verification | partial | Policy decision then enforcement: required evidence per outcome and verification by a different authorized user for all completions (not only portal). |
| EP11-06 | Backcharge dispute lifecycle | partial | Make transitions atomic (status/updated_at guard or a DB RPC) so issue/resolve cannot run twice. |
| EP11-07 | Warranty accounting reconciliation | partial | Gate cost approval on verified/accepted work and add a reserve tie-out. |
| EP11-08 | Complete defect feedback | partial | Approve/apply 20261003053000_warranty_actor_analytics.sql and enable the flag; expose plan/version/trade groupings with drill-down to requests. |

### EP12: Migration and integration platform

| ID | Outcome | Status | Next concrete step |
| --- | --- | --- | --- |
| EP12-01 | Bounded validated import reads | partial | Page loadValidationLookups (lib/services/imports.ts:191-205) with readAllRows or scope lookups to the keys present in the batch (e.g. .in('lot_number', ...)), and fail visibly on truncation; scope the roles lookup explicitly (org/system). |
| EP12-02 | Open-WIP continuity | implemented | Clean up (or reuse via receipt) buyer contacts and companies created inside a failed row (imports.ts:789-791, ensureCompany) so failed writes leave no orphan parties. |
| EP12-03 | Atomic resumable cutover | partial | Move Open-WIP commit to a durable job (outbox/lease) with per-row transactional commit (RPC) that writes the import_rows receipt in the same transaction as the home. |
| EP12-04 | Financial and signed-document migration | partial | Add an agreement/executed-document importer (file + hash + signer metadata, immutable) linked to the Open-WIP home, reusing Documents/Signing storage. |
| EP12-05 | Selections and warranty continuity | pending | Add installed-home importer (home identity, close date, program/terms version, structural carrier) creating project_warranty_coverage with effective_source 'manual'/'import' and terms snapshot. |
| EP12-06 | Integration API contract | partial | Define the required builder-record integration surface (from EP14-11 inventory). |
| EP12-07 | Webhook delivery and replay | pending | Implement webhook endpoint registration (secret, scopes, version), signed payloads (HMAC + timestamp), durable per-endpoint delivery rows with retry/backoff, dead-letter view and replay in admin/ops. |
| EP12-08 | Chosen-system sandbox acceptance | pending | Obtain named CRM/accounting/lender inventory (EP14-11). |

### EP13: Performance and resilience

| ID | Outcome | Status | Next concrete step |
| --- | --- | --- | --- |
| EP13-01 | Representative load dataset | pending | Write a deterministic synthetic dataset generator (seeded) for the frozen loadTargets into an isolated database with a production-endpoint refusal preflight. |
| EP13-02 | Mixed-role performance proof | pending | Build load runner (desktop desk reads + mutations + mobile API) reporting p50/p95/p99, throughput, error rate, with traces. |
| EP13-03 | Tenant fairness and bulk controls | partial | Add per-org fair claiming (round-robin/limit per org) in claim_jobs (migration needs approval). |
| EP13-04 | Truthful starts completion telemetry | implemented | Verify deployed after() lifetime, partial failure and telemetry-error behavior in QA. |
| EP13-05 | Durable running-job monitoring | partial | Insert a 'running' job_runs row at start (with expected deadline) and finalize it; reconcile rows past deadline to 'timed_out' in the watchdog (migration for status/deadline columns needs approval). |
| EP13-06 | Cross-pipeline observability | partial | Propagate a correlation id (request/trace) into outbox payloads, job_runs, events and audit_log; surface it in admin/ops. |
| EP13-07 | Failure injection and race acceptance | partial | Generalize the embedded-postgres two-session harness to starts release, agreements/deposits, payments and imports (full schema). |
| EP13-08 | Backup restore drill | partial | Confirm Supabase PITR tier/retention and storage backup configuration (operator). |
| EP13-09 | Availability and incident readiness | partial | Define SLOs (availability 99.95%, desk/mutation latency) and error budgets in a reference doc. |
| EP13-10 | Runbooks and capacity review | partial | Write runbooks (reference docs): deploy rollback, stale/timed-out jobs, missing files/previews, accounting/integration backlog, financial reconciliation. |

### EP14: Release acceptance

| ID | Outcome | Status | Next concrete step |
| --- | --- | --- | --- |
| EP14-01 | Presold lifecycle acceptance | pending | Engineering: author A01 scenario (fixtures + authenticated API/browser steps + ledger reconciliation queries) mapped to dependency item IDs. |
| EP14-02 | Spec lifecycle acceptance | pending | Author A02 scenario with released-cost/product-version immutability assertions and final margin reconciliation. |
| EP14-03 | Cancellation lifecycle acceptance | pending | Author A04 before/after-release cancellation scenario incl. interrupted retry (independent sessions). |
| EP14-04 | Delayed-home lifecycle acceptance | pending | Author permit/supply delay scenario asserting schedule/capacity/promised-close propagation. |
| EP14-05 | Warranty lifecycle acceptance | pending | Implement EP12-05 installed-home import first. |
| EP14-06 | Complete role and money concurrency matrix | partial | Engineering: generate the surface list from scripts/enterprise-production-inventory.cjs and build a deny matrix (cross-org, cross-division, stale role) per route/action/mobile endpoint. |
| EP14-07 | Desktop and mobile visual acceptance | pending | Engineering: add axe-core Playwright checks and phone-viewport projects for critical role workflows; screenshot states (loading/empty/error/dark). |
| EP14-08 | Full schema and deployment parity | partial | Engineering: wire `pnpm db:ledger:check` into verify.yml (trusted branches) or fix its header claim. |
| EP14-09 | Migration and activation approval | pending | Engineering: prepare per-release activation manifest (ordered migrations, lock/index risk, flags, worker drain, monitoring, rollback) from EP14-08 parity report. |
| EP14-10 | Independent security review | pending | Engineering: write review scope + threat model; run internal security review of pending changes and fix findings. |
| EP14-11 | Operating requirements and integrations | pending | Prepare approval package (loadTargets, operating policies, integration inventory template). |
| EP14-12 | Operational release sign-off | pending | Complete all dependencies; designated owner records release decision and residual backlog. |

## Scope and acceptance limits

213 candidate authenticated/portal pages are inventoried. This is an exposure inventory awaiting role/posture/module qualification, not a claim that every candidate page belongs in production.

Sizing and operating assumptions are frozen engineering targets awaiting launch-owner approval under EP14-11. QA access, chosen-system sandbox credentials, migration/activation approval, independent security review and operational sign-off remain explicit external gates. No customer database, storage or email mutations were performed.

This side conversation cannot access the persistent main-thread goal, and exposed goal tools support status updates only, not editing an active objective. Do not mark the old goal complete or create a replacement to bypass this limitation; use this user-approved checklist as its governing DoD.

