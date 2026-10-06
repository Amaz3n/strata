# Arc Production: national-builder completion plan

> Status: ACTIVE IMPLEMENTATION PLAN — not a description of shipped functionality.
> Written: 2026-10-04. Baseline HEAD: `9f1549af`, plus a heavily modified shared working tree.
> Requested outcome: finish the existing national-builder goal, with explicit definitions of done.
> Canonical execution plan: this file. Canonical status/evidence record: `docs/enterprise-production/acceptance.json`.
> Completion rule: every required task below passes its DoD and every release gate passes. Code existing, staged SQL, passing mocks, or a percentage estimate alone cannot satisfy this rule.

## 1. Goal amendment and execution contract

The main thread must adopt the following as the acceptance contract for its existing goal. Keep that goal active; do not replace it with a smaller goal, reset its history, or mark it complete to create another goal. If the goal tool cannot edit objective text, retain the existing objective and bind this document in the main thread's instructions and acceptance tracker. Record which mechanism was used; do not claim the persistent objective changed unless confirmed.

**Goal text to adopt:**

> Deliver Arc Production as an operable, secure, recoverable and efficient platform for a national production homebuilder, using `plans/001-enterprise-production-finish-line.md` as the required implementation and acceptance contract. Reconcile existing work before implementing remaining tasks. Meet all task definitions of done, all 14 workstream acceptance criteria, the complete lifecycle scenario matrix, approved performance/recovery objectives, migration and integration acceptance, and release/customer sign-off. Maintain task-level evidence in `docs/enterprise-production/acceptance.json`. Do not count staged, disabled, unverified, partially connected or externally blocked work as release-complete. Do not mark the goal complete until the final acceptance gate in this document passes. Continue independent authorized implementation while external acceptance requirements are pending; report those dependencies explicitly. Preserve residential/commercial and mixed-organization behavior, and never use live customer data for testing.

### How the executor uses this document

1. Read the latest `CLAUDE.md`, `docs/README.md`, this document, and the acceptance tracker. Read source before changing it. Search existing services and UI; extend the existing mutation owner rather than adding a second writer.
2. Reconcile every task against live source, staged migrations, deployed schema and existing evidence. The tracker has historical remaining lists that later slices supersede. A new checklist must not make finished code disappear or falsely count disabled code as shipped.
3. Add this plan path/version and stable task IDs to the existing tracker. Keep execution history; attach evidence to IDs instead of creating another status tracker. Initial status is `unassessed` until reconciled, not automatically TODO or DONE.
4. For each task use `unassessed`, `planned`, `in_progress`, `implemented`, `verified_qa`, `released_accepted`, or `blocked_external`. Store implementation and release status separately if a task is partly complete. An external block is not completion.
5. Take the highest-priority ready task in the dependency order. Deliver an entire usable workflow with validation and recovery, not an endless sequence of isolated foundations. Decompose large tasks into named child IDs before editing; each child needs its own observable DoD and evidence.
6. Before moving to an unrelated slice, connect its services/actions/UI, test it, reconcile legacy writers, document rollout and update the tracker. Explicitly identify any external gate that prevents activation.
7. Keep changes local to the task and preserve concurrent work. Do not reset, clean, reformat or overwrite unrelated modifications. Check changed paths with `git diff`; do not commit, push or deploy without authorization.

### Planning scope and limits

This is a completion contract derived from the existing 14-workstream tracker, original production expansion and current implementation entry points. It is not a fresh exhaustive source audit, not private Lennar requirements, and not a compliance certification. Customer operating policies and integration choices need confirmation under F01; implementation can proceed using the stated defaults while those are gathered. Customer-specific scope changes require an explicit recorded decision; an agent cannot silently remove a difficult requirement to obtain 100%.

The earlier conversational estimates of approximately 50% features and 30% readiness were rough judgments. They are not the baseline for measured completion. F01 must produce the actual task/evidence baseline.

## 2. Fixed architectural and verification rules

### Product and ownership

- Project posture (`projects.property_type`) controls project capabilities, terminology and financial behavior. Organization tier supplies defaults and packaging. Mixed residential/commercial/production organizations remain supported.
- Organization is the tenant boundary. Region/division/entity/community/home scope layers on top; ambient community is a lens, not permission. Validate actual parent/home access, including reads, reports, documents, exports and background work.
- Desks rank/filter/deep-link across records; the owning workbench/action owns each mutation. Keep Communities → land/offering, Plans → product, Design Studio → selections, Sales/closing → agreements and settlement, Starts → release, Purchasing → commercial procurement, home → field execution, Warranty → service.
- Services hold logic, actions stay thin and return ActionResult, inputs use Zod, and money uses integer cents. Use existing events, audit, outbox, search, mobile and notification registrations.
- Match `docs/design.md`: dense token-based tables, zero-radius shape, visible state, accessible focus, dark/loading/empty/error states. Avoid raw ID entry or technical recovery mechanics in normal operator flows.

### Critical transaction contract (applies wherever a task handles state/money/resources)

Capture the original reviewed actor, organization, scope, source versions, monetary/configuration/recipient evidence and exact request identity. Reauthorize inside the committing transaction after locks. Lock in documented deterministic order. Check current source ancestry and expected revision; reject stale changes without partial writes. Commit domain changes, immutable receipt and required event/audit together. Reserve capacity and uniqueness at the database boundary. Retry the same original request; a changed body cannot reuse its key. A lost reply must be inspectable as committed/uncommitted/changed, without repeating financial or legal operations.

External actions use durable intents and attempt identities before sending/copying/uploading; record provider acceptance and reconcile ambiguous responses. Do not promise exactly-once external delivery without provider proof. A stale worker cannot publish or alter another claim's work. Cancellation fences delayed retries. Cleanup must never delete a referenced or another actor's object. Legacy/direct/browser/import/restore writers must obey equivalent invariants before activation.

### Universal DoD (required in addition to each task's specific DoD)

1. A permitted user can discover, perform, inspect and recover the workflow on its real surface. Read-only users receive appropriate controls. Stale actor/org/scope/view responses cannot change another context's UI.
2. Relevant money/source/permission/capacity checks follow the transaction contract. Negative cases include revoked permission, moved parent, stale revision, duplicate request, competing writer and partial external failure where applicable.
3. Lists/search/counts/exports are complete for authorized scope with bounded pages and memory. Explicit caps are visible, with an acceptable next step; a cap alone does not satisfy enterprise capacity. Reports disclose missing/unreconciled evidence rather than treating it as zero.
4. `pnpm typecheck` exits 0 and `pnpm lint` exits 0. Pertinent suites pass with zero unexpected failures. Test meaningful behavior, not copies of implementation. No weakened assertions or skipped critical tests to claim success.
5. Database-sensitive work is exercised against the full applicable schema/migration chain and real independent PostgreSQL sessions. Sequential PGlite or fake PostgREST tests are useful local evidence but not concurrency/RLS acceptance.
6. Real authenticated QA exercises transport, auth/RLS, storage/provider boundaries and the actual UI. Desktop keyboard/accessibility, dark mode and mobile layout are verified where relevant. Native field tasks also need physical-device evidence.
7. New entities have RLS, indexes/FK coverage, permission catalog entries, search/event/audit/notification registration, and mobile/cron contracts where needed. Reports and archive/restore include their receipts and source evidence.
8. Migration order, compatibility, data reconciliation, activation, monitoring and rollback are documented and verified. Required SQL is approved/applied through the human-controlled release process; no test writes to production.
9. Evidence includes commit/dirty-tree fingerprint, schema versions, dataset, actor matrix, command and exit code, observed results and date. Store durable evidence or artifact links, not only temporary logs.

### Exact verification commands and their limits

Existing commands verified in `package.json`: `pnpm typecheck`, `pnpm lint`, `pnpm test:financials`, `pnpm test:auth`, `pnpm test:mobile`, `pnpm test:schedule`, `pnpm test:land`, `pnpm test:starts`, `pnpm test:onboarding`. Existing navigation/document/drawing suites must be included when their paths are affected; inspect current scripts first. Expected result: exit 0 and no unexpected failures.

`pnpm db:schema:check` and `pnpm db:ledger:check` are release parity checks; inspect target/credentials first and keep them read-only. CI in `.github/workflows/verify.yml` already has disposable local database and browser jobs. Extend that existing infrastructure for enterprise tests. The executor must add and record exact new commands for multi-session races, authenticated lifecycle acceptance, load/soak, recovery and native validation; an invented command written in a plan is not evidence that it exists.

Do not run `pnpm dev` or `pnpm build` locally. Do not apply migrations, seed/test production, issue real payments, send real buyer/trade messages, change release flags or deploy without applicable authorization. Prepare reviewable changes and keep independent work moving when a release gate is pending.

## 3. Foundation tasks and dependency order

### F01 — Reconcile scope, operating policies and the actual baseline (P0)

**Steps:** Inventory all production-visible routes, tabs, home modules, portals, mobile surfaces, actions and background jobs from `components/layout/app-sidebar.tsx`, `components/layout/project-nav-items.ts`, route trees and permissions. Map every one to owner persona, workstream/task, scope, read/write access, current implementation, open defects and required scenario. Compare latest tracker entries to source; specifically preserve the interrupted category-discovery work in the main thread. Establish integration inventory, entity/division calendars, signing/retention/deposit/cancellation policies and customer sizing without claiming access to private requirements.

**DoD:** A complete route/action/job register and task-level gap matrix exist in the canonical tracker/evidence; every exposed production surface maps to a required task or an explicitly justified existing capability. No unknown critical route remains. Each existing implementation is classified as live, staged, disabled, partial or accepted with evidence. Open customer decisions have an owner and next action; estimates are clearly distinguished from measured facts.

**Evidence:** Route inventory, source/flag/migration matrix, policy decision log, baseline test results. Depends on nothing; unlocks all streams.

### F02 — Establish isolated enterprise acceptance infrastructure (P0)

**Steps:** Use isolated disposable PostgreSQL/local Supabase for mutation tests and a dedicated QA environment for actual browser/provider/device acceptance. Build deterministic datasets containing multiple orgs, divisions, entities, communities, homes, roles and mixed postures; include malformed legacy ancestry and partial-operation states. Implement independent connections and barriers for real races, controlled provider/storage failures and worker crashes. Extend existing CI; no production credentials in fixtures.

**DoD:** Reproducible commands recreate the fixture, run real RLS/JWT and concurrent sessions, produce durable results and destroy only disposable data. QA identity and provider sandbox setup are documented. A safety preflight rejects mutation tests targeting the production endpoint. Current schema and staged candidate chains can both be tested. Test output proves independent-session execution, not a mocked concurrency schedule.

**Evidence:** CI run, fixture manifest, environment separation check, sample denied cross-org operation and simultaneous-transaction test. Depends on F01 for scope, can begin immediately.

### F03 — Reconcile migrations, cutovers and legacy writers (P0)

**Steps:** Inventory staged and pending migrations, function grants, feature gates, clients and direct writers. Define ordered release groups and compatibility windows. Exercise clean installs and realistic legacy upgrades, duplicate reconciliation and receipt/archive restoration. Prepare operator migration approval packages including lock/index risk, data counts, rollback and dependent deployments.

**DoD:** Every required migration/flag has an owner, prerequisites, tested upgrade path and activation criteria. There are no unguarded old writers that bypass a newly activated invariant. Old clients either remain safe or receive a clear reload/upgrade rejection. Required migration ledger/schema parity is confirmed after authorized rollout. Default-off work remains labelled incomplete until activated and accepted.

**Evidence:** Migration dependency register, full-chain tests, grants comparison, before/after reconciliation and rollback drill. Depends on F02; revisited by every stream.

### F04 — Standardize durable completion and operator recovery (P0)

**Steps:** Inventory existing receipt/intent/history infrastructure, reuse it within each domain and document the shared semantics without inventing a universal replacement framework. Require exact-body persistence before dispatch, status inspection after uncertain replies, original-scope retry/acknowledgment/cancellation and bounded authorized pending queues. Cover browser reload/cross-tab/device/server crash and provider ambiguity.

**DoD:** Critical workflows expose truthful saved/prepared/delivered/committed/reconciliation states; lost responses never encourage new-key retries for the same operation. Permission revocation never grants recovery access. Recovery restores original reviewed evidence and never regenerates it silently. Required committed fanout is resumable and observable. Domain tasks prove these semantics individually.

**Evidence:** Domain recovery contract matrix and failure-injection cases. Depends on F01/F02 and applicable security task E02-02.

### Execution waves

1. **Wave A:** F01–F04, E02-01/02, E01-01 and E14-01. Establish the finish-line ledger and test environment, then audit current unfinished changes before adding more foundations.
2. **Wave B:** Close current catalog/configuration and agreement/recovery work (E03, E05), starts (E07), purchasing (E08), settlement (E05-04), warranty transaction recovery (E11). Produce one fully exercised presold-home lifecycle at the end of this wave.
3. **Wave C:** Fill end-to-end operating gaps in land (E04), selections/permits (E06), field (E09), finance/planning (E10), security administration and migration/integrations (E02/E12). Produce the complete scenario matrix, including spec and cancellation.
4. **Wave D:** Enterprise scaling/resilience (E13), independent security and accessibility, schema rollout, integration/customer acceptance and release (E14). Performance work starts earlier whenever measurements reveal a blocker; do not defer architectural bottlenecks until the final week.

Tasks within a wave may be independent, but no consumer is activated ahead of its schema/security/recovery dependencies. Closing, warranty, accounting and integration decisions must align across the same home lifecycle.

Dependencies that mention a reciprocal domain are interface/design dependencies first, not a requirement to finish both implementations before starting either. Define shared source/receipt/state contracts together, implement producers and consumers in order, then accept the integrated scenario. For example, define closing→enrollment together; implement closing publication and enrollment consumption; accept E05-04 and E11-01 together. F01 must turn these references into an acyclic executable child-task graph.

### Original acceptance traceability

The four entries in each row map the four original acceptance statements for that workstream, in their existing order in `acceptance.json`. This preserves the original scope; F01 also maps individual exposed surfaces and later execution-log gaps to these task IDs.

| Workstream | Original criterion 1 | Original criterion 2 | Original criterion 3 | Original criterion 4 |
|---|---|---|---|---|
| EP01 | E01-01 | E01-02 | E01-02/03 | E01-01/03, E02-02 |
| EP02 | E02-01 | E02-01 | E02-02 | E02-03 |
| EP03 | E03-01/02 | E03-02, E04-02 | E03-02, E05-02, E10-02 | E03-03 |
| EP04 | E04-01 | E04-02 | E04-03, E05-01 | E04-03, E10-02 |
| EP05 | E05-01 | E05-02 | E05-03 | E05-01/02/04, E11-01 |
| EP06 | E06-01 | E06-02 | E06-02, E08-02, E07-03 | E06-03 |
| EP07 | E07-02 | E07-01/02 | E07-03 | E07-03, E05-03 |
| EP08 | E08-01 | E08-01/02/03 | E08-02, E02-02 | E08-03, E10-01 |
| EP09 | E09-01/02 | E09-01, E03-03 | E09-03 | E09-01/02, E07-03 |
| EP10 | E10-01 | E10-02 | E10-02 | E10-03, E12-02 |
| EP11 | E11-01, E12-01 | E11-02/03 | E11-04, E10-01 | E11-04, E08-04, E03-03 |
| EP12 | E12-01 | E12-01/03 | E12-02 | E12-02, E10-03 |
| EP13 | E13-01 | E13-01/02 | E13-02 | E13-03 |
| EP14 | E14-01, A01–A06 | E14-01/02, A07–A09 | E14-02 | E14-03, F03, E13-03 |

## 4. Workstream task contracts

Each task inherits the universal DoD. Paths below are verified existing entry points or directories for investigation, not blanket permission to edit every file. Identify the precise implementation paths and tests during reconciliation. New neutral capabilities must follow existing naming and mutation ownership.

### EP01 — Production desks, navigation and operator efficiency

**Entry points:** `components/layout/app-sidebar.tsx`, `components/layout/project-nav-items.ts`, `lib/services/desk-context.ts`, `app/(app)/my-work`, `my-houses`, `sales`, `starts`, `purchasing`, `design-studio`, `warranty`, `reports`, `schedule`, `communities`, `plans`.

**E01-01 — Finish the all-page role/scope audit.** Walk every F01 route as executive, division manager, consultant, starts/purchasing/studio/closing/warranty coordinator, superintendent, finance clerk/controller, trade and buyer where exposed. Trace cross-desk links to the canonical mutation owner. Fix hidden reachable workflows, wrong terminology/landing pages and inappropriate controls. **DoD:** Every route has an accepted persona/navigation case; changing community changes the data across desks consistently without changing authority; mixed-project modules remain correct; denied routes and direct links fail safely. **Verify:** auth/land/navigation suites plus authenticated role matrix. Depends on F01 and E02-02.

**E01-02 — Finish complete bounded queues and entity selection.** Audit counts, filters, sorts, pagination and exports, including catalog registers, bid subresources/vendor rosters, reports and home histories. Use stable server queries and separate selected-reference lookup; eliminate silently capped whole-org lists, client-only search and large ID enumerations on enterprise paths. **DoD:** Late-page records are discoverable, totals reflect exactly the authorized filters, selected unavailable records can be remediated, changed scope invalidates stale cursors/replies, and page/payload/memory bounds are measured. **Verify:** generated large dataset, late-page error and concurrent-edit cases; actual query plans under E13. Depends on E02-02.

**E01-03 — Finish high-frequency operator workflows.** Provide permission-safe bulk actions, review of affected records, saved filters where useful, keyboard/focus continuity and durable per-record drafts where losing work matters. Keep failures attributable to specific records. **DoD:** Named personas complete their daily queues without raw IDs, repeated context selection or lost drafts; bulk changes show partial/uncertain outcomes with recovery; actual accessibility and mobile/dark acceptance pass. **Evidence:** timed QA tasks and browser captures, baseline-versus-final steps/time. Depends on E01-01/02 and domain bulk contracts.

### EP02 — Enterprise organization, identity and security

**Entry points:** `lib/services/divisions.ts`, `team.ts`, authorization/context/permission helpers, `app/(app)/settings`, `team`, `admin`, `platform`, `proxy.ts`, database policies/grants and mobile/portal routes.

**E02-01 — Complete enterprise hierarchy and identity lifecycle.** Define region/division/legal entity/community assignments without substituting them for tenant identity. Implement or finish customer-selected SSO, automated provisioning/deprovisioning and MFA policy using existing auth. Include invites, role/group mapping, suspended accounts, session/token revocation and auditable emergency access. **DoD:** Provision/change/deprovision cases work in the customer's identity sandbox; removed users lose web/native/API/worker/recovery access promptly under a documented policy; every home has validated hierarchy and accounting-entity mapping. **Verify:** auth/mobile, full-schema JWT tests and sandbox identity lifecycle. Depends on F01/F02.

**E02-02 — Finish transaction-bound authorization and separation of duties.** Enumerate every read/write/report/export/storage/portal/worker entry. Enforce actual-home ancestry, explicit denies, assignment/division scope and current membership. Reconcile stricter staged SQL versus legacy service policy; service-role helpers require trusted actor binding. Define distinct procurement, variance, bill, payment and close approvals. **DoD:** Cross-org/division/home and mid-operation revocation/parent-move races cannot expose data or commit unauthorized writes; no generic table/RPC grant bypasses the owning service; self-approval and prohibited duty combinations reject at commit. **Verify:** real RLS/grants and independent races plus `pnpm test:auth`. Blocks activation of every critical workflow.

**E02-03 — Complete audit/access governance.** Define customer-approved retention, legal hold, audit export, scheduled access review and break-glass procedures. Include provider delivery, imports, bulk jobs and original receipts while excluding secrets. **DoD:** Investigators reconstruct a representative sale/payment/start/closing/service action from original evidence; tampering, retention and unauthorized export tests pass; emergency access is bounded, revoked and reviewed. **Evidence:** audit reconstruction, retention/restore/access-review exercises. Depends on E02-01/02 and E12-03.

### EP03 — Plans, configuration, catalog and governed publication

**Entry points:** `lib/services/house-plans.ts`, `configuration-rules.ts`, `option-catalog.ts`, `catalog-group-categories.ts`, `catalog-group-publication.ts`, `catalog-package-publication.ts`, `catalog-price-publication.ts`, `catalog-publication-history.ts`, `selection-cutoffs.ts`, `components/design-studio`, `app/(app)/plans`, `design-studio` and community offering.

**Current evidence:** Reviewed atomic package/price/rule publication, exact-body browser recovery and cross-scope histories have been implemented behind cutover gates. The actual rule editor is connected. Category discovery was being finished in the interrupted main turn and may exceed the last logged slice. Reconcile and validate it rather than rewrite it.

**E03-01 — Finish catalog authoring and original-scope recovery.** Complete bounded package/category/option discovery, selected-reference remediation, original inherited-scope navigation and lifecycle operations. Verify exact reviewed labels/hashes/source through registration/commit/recovery. Cut over direct/legacy writers and cross-org parent constraints. **DoD:** Actual create/edit/archive/restore/rule flows survive reload, competing tabs and lost replies without changing original evidence; renamed/archived/foreign choices reject or remain removable; unauthorized cost fields never enter DTO/review/storage. Old writers cannot bypass the same invariants after activation. **Verify:** existing catalog financial/browser/SQL suites, auth, real QA and independent publication/cancellation races. Depends on F03/F04/E02-02.

**E03-02 — Complete fit, dependencies and configuration eligibility.** Define plans/elevations/swing, lot setbacks/geometry/engineering restrictions and community availability. Complete transitive requirements/exclusions and guided correction in sales/studio. Validate the same versioned configuration at quotation, selection confirmation, change approval and release. **DoD:** Invalid fit/contradictory choices cannot be signed or released; valid configurations yield deterministic prices/costs; UI explains the exact corrective choices; archived/scope-changed sources cannot slip through concurrent publication. **Verify:** graph/geometry boundary tests, cross-stage fixtures and real source-change races. Depends on E03-01 and E04-02.

**E03-03 — Complete controlled revision rollout.** Preserve original plans, prices, dependencies, selections, scope and drawings for signed/released homes. Show affected homes and budget/PO/schedule/contract impact before approved revision adoption. Separate new offering revisions from amendments on existing homes. **DoD:** Updating the library never silently changes a signed instrument or issued PO; reviewed rollout targets exact eligible homes, rejects drift, and has immutable before/after evidence plus resumable outcomes. **Verify:** two-plan-version lifecycle and simultaneous plan/catalog edits. Depends on E03-02/E05-02/E08-02.

**E03-04 — Complete cutoff fanout and atomic defaults copying.** Replace post-save community recomputation with a durable original-scope job covering existing/new affected homes; implement resumable exact-source defaults copying and group lifecycle governance. **DoD:** A committed rule has inspectable fanout progress/failures and no missed homes created during processing; crash/retry/cancel does not duplicate or overwrite intervening approved changes; defaults copying cannot leave half a configuration. **Verify:** worker crash/lease/revocation cases, simultaneous home creation, and large fanout throughput. Depends on E03-01/F04/E07-01.

### EP04 — Land, horizontal development and inventory

**Entry points:** `lib/land/*`, `app/(app)/communities`, community land/offering/inventory workbenches, land report and financial services found during F01.

**E04-01 — Complete acquisition/entitlement/takedown lifecycle.** Reconcile existing land foundation; add missing diligence checklists, entitlement conditions, obligated phases/takedowns, due dates, approvals, deposits and evidence. Support amendment/termination and link financing/cash obligations. **DoD:** A land manager can follow a parcel from evaluation/control to approved acquisition and phased delivery, see overdue/blocked obligations, and reconcile each committed takedown amount to accounting. Changes preserve signed obligation evidence. **Verify:** land/financial suites and controlled→owned→terminated cases. Depends on E02/E10-01.

**E04-02 — Complete horizontal development and lot readiness.** Model budgets/actuals, utilities/roads/inspections and dependencies on build-ready lots; validate phase/plat/lot identity and engineering fit. Provide bulk import/correction review and explicit readiness evidence. **DoD:** Unready lots cannot enter an approved start; completed infrastructure updates only eligible lots; phase delays propagate to starts/forecast; lot engineering restrictions are enforced by E03-02. **Verify:** multi-phase delayed development and contradictory geometry cases. Depends on E04-01/E03-02 contract design.

**E04-03 — Finish inventory allocation and disposition.** Tie hold/reservation/spec/start/sale/close transitions to their owning events; expose available/sold/spec aging and carrying cost with approved price changes. **DoD:** Two consultants cannot reserve/sell the same home or resurrect a cancelled ownership state; expired holds release correctly in division time; standing specs have accurate price, stage and aging; cancellation returns inventory under explicit policy with complete accounting/contract evidence. **Verify:** land/sales multi-session races and spec/cancellation scenario. Depends on E05-01/E10-01.

### EP05 — Sales, agreements, deposits and closing

**Entry points:** `lib/services/sales-inquiries.ts`, `sales-deals.ts`, `community-sales.ts`, `closings.ts`, `closing-readiness.ts`, agreement transaction/signing helpers discovered from their imports, `components/sales`, `app/(app)/sales` and `projects/[id]/closing`.

**Current evidence:** Quote hashes, atomic creation receipts, catalog revisions, incentive capacity, contract-scoped signing ownership and truthful signing recovery UI now exist in staged/gated paths. Do not call them missing code. Full lifecycle/legacy/legal/provider/concurrency acceptance and initial reservation conversion remain open.

**E05-01 — Complete inquiry→hold→reservation→home/deposit conversion.** Finish idempotent website/CRM ingestion with consent/attribution/dedup/owner routing. Make hold conversion, actual-home creation/linking and deposit instrument creation atomic or durably recoverable; preserve real buyer/co-buyer identity. **DoD:** Repeated inbound events create one routed inquiry; simultaneous/expired hold conversions have one winner; failures do not leave an orphan home, occupied lot or duplicate deposit invoice; cancellation/transfer/refund policy is explicit and recoverable. **Verify:** financial/auth/onboarding suites, independent ownership races and real consultant QA. Depends on E02/F04/E04-03.

**E05-02 — Complete reviewed agreement lifecycle and legal packets.** Finish gated transaction cutover and source/capacity/review fences; version builder templates, required addenda, signature fields and recipient identities. Implement approved amendments, corrections, void/replacement/expired legacy reconciliation and countersignature; preserve executed artifacts. **DoD:** Buyer and builder complete a legally reviewed packet matching the accepted configuration/price; retries reuse original legal ownership; stale recipient/template/source changes require explicit correction rather than a hidden replacement. Draft incentive release/expiry policy is explicit. **Verify:** full-schema creation/capacity/publication races, actual PDF/portal/provider sandbox execution and legal sign-off. Depends on E03/F03/E05-01/E12-03.

**E05-03 — Complete deal milestones and commercial coordination.** Finish financing/title/contingency dates, deposits/receipts/refunds, commissions/co-op brokers, promised-close changes, cancellation/reinstatement and owner-specific queues. Link studio/permit/build readiness read-only to Sales. **DoD:** Coordinator sees current blockers and responsible owner across the entire sold backlog; reschedules update downstream promises/audit; balances reconcile to ledger; a cancelled deal leaves coherent inventory, incentive, commission and document states. **Verify:** delayed financing, partial deposit, cancellation and reinstatement scenarios. Depends on E05-02/E06/E10.

**E05-04 — Complete settlement and post-close recovery.** Make settlement ownership, original report/monetary evidence, invoice/payment links, home delivery, audit/event and required warranty enrollment transactional or durably coordinated. Include lost response, changed checklist, late adjustment and cancelled closing policies. **DoD:** One closing yields one immutable settlement with balanced original sources; competing changes cannot settle stale money/readiness; retries recover the original result and warranty/statement fanout; authorized reversal/amendment preserves original evidence. **Verify:** independent money races, actual coordinator-to-warranty lifecycle and finance reconciliation. Depends on E05-03/E09-03/E10-01/E11-01.

### EP06 — Design studio, selections and permitting

**Entry points:** `lib/services/selections.ts`, `selection-cutoffs.ts`, `selection-change-orders.ts`, `app/(app)/design-studio`, `projects/[id]/selections`, buyer portals; locate current permit/gate implementation during F01 rather than assuming a service exists.

**E06-01 — Complete appointments and buyer approvals.** Implement studio appointment resources/capacity, buyer/co-buyer review, selection drafts, approvals and original decision evidence. **DoD:** Competing bookings cannot overbook staff/resources; buyers approve an exact version with accessible prices and deadlines; incomplete choices have actionable guidance; reschedule/no-show/decline/revocation cases preserve drafts and history. **Verify:** capacity races and actual buyer/studio QA. Depends on E03-02/E02.

**E06-02 — Complete cutoff/lead-time/change propagation.** Tie effective cutoffs and supply lead times to actual schedule and approved rules. Price/cost/scope changes produce reviewed amendments, PO changes and schedule impact as appropriate. **DoD:** After-cutoff choices require explicit approval and cannot silently modify issued/installed work; one approved change reconciles across contract, selections, budget, procurement and schedule; failure/retry cannot apply only one side. **Verify:** before/after-cutoff and simultaneous rule/selection/PO races. Depends on E03-04/E05-02/E08-02/E07-03.

**E06-03 — Complete permit lifecycle.** Provide jurisdiction/submission packet/version, fees, correction rounds, inspections, aging, owner and evidence; integrate actual gates and forecast dates. **DoD:** Submitted, corrected, approved, rejected and expired permits are traceable; pending/expired critical approval blocks release; jurisdiction/calendar changes affect forecasts without rewriting history. **Verify:** corrections/resubmission/expiry lifecycle in QA and start-gate tests. Depends on E04-02/E03-03/E07-02.

### EP07 — Starts, scheduling and trade capacity

**Entry points:** `lib/services/starts.ts`, `starts-pipeline.ts`, `starts-desk.ts`, `plan-instantiation.ts`, `plan-drawing-copy.ts`, `starts-confirmation-recovery.ts`, `schedule.ts`, `components/starts`, `schedule`, related jobs/outbox and staged claim migrations.

**E07-01 — Finish claim consumers, fenced publication and cutover.** Reconcile existing SQL claims/triggers and disabled consumers. Cover all generated schedule, budget, ledger, PO, drawing/file, checklist, event/audit and fanout mutations; finish atomic finalization/cancel/retry and safe lease cleanup. **DoD:** A reclaimed/expired worker cannot publish any domain artifact; a process crash resumes one release without duplicated costs/documents; confirmed cancellation blocks late writes; generated evidence proves original plan/source and current authorization. **Verify:** full-chain independent sessions, deadlock/reclaim/expiry tests and deployed-runtime QA. Depends on F02/F03/E02/E03/E08 transaction contracts.

**E07-02 — Complete readiness and even-flow planning.** Make gates evidence-backed across land/permits/selections/purchasing/drawings; level release across communities, crews and financing/resources. Show constraints and reviewed bulk effects. **DoD:** Missing/unreadable evidence blocks release rather than appearing ready; planner proposes a feasible schedule, identifies bottleneck/override owner and validates each home at commit; bulk runs have durable progress/cancel/recovery. **Verify:** competing releases, resource limits and a mixed-community workload. Depends on E04/E06/E08/E07-01.

**E07-03 — Complete trade coordination and dependency-aware rescheduling.** Finish trade accept/decline/propose date, crew/service-area eligibility, capacity calendars, conflict resolution and scope-specific notice evidence. Propagate dependency changes and promised-close impact with reviewed exceptions. **DoD:** Two schedulers cannot reserve the same capacity; trade responses bind the reviewed work version; rescheduling updates downstream work with conflicts visible; original notices survive provider ambiguity and changed recipients with safe retry/dead-letter controls. **Verify:** real trade portal, DST calendars, competing crew reservations and delivery failure/recovery. Depends on E07-01/E08-03/E02/F04.

### EP08 — Purchasing, supply chain and payment controls

**Entry points:** `lib/services/purchasing-workspace.ts`, `price-book.ts`, PO generation helpers, bid services, `purchasing-readiness.ts`, `components/purchasing`, `app/(app)/purchasing`, `bids`, home commitments/payables and vendor portals.

**E08-01 — Complete rebid/award/renewal workbench.** Finish package documents, effective-date/UOM/coverage review, bid invite/submission/history paging, comparison, addenda and approved award/renewal. **DoD:** Buyer can complete an actual community/plan sourcing cycle; approved agreement freezes original scope/terms/pricing; no scope/grant bypass through subresources; renewal does not retrospectively reprice issued work. **Verify:** bid financial/auth tests, vendor sandbox acceptance and late-page data. Depends on E02/E01-02/E03.

**E08-02 — Complete PO generation, changes and monetary contention.** Fence price source/version/eligibility inside generation transactions; preserve issued/accepted/paid documents during regeneration. Finish VPO causes/thresholds/separation of duties and competing resolution handling. **DoD:** Same reviewed generation yields one durable set; stale pricing/exception/source changes reject without partial replacement; issued evidence remains immutable; competing approvals/payments cannot overcommit or bypass threshold approvals. **Verify:** independent regeneration/exception/bill/payment races, full FK cascades and margin reconciliation. Depends on E03/E07-01/E10-01.

**E08-03 — Complete acknowledgment, deliveries, shortages and payment evidence.** Add or finish vendor accept/decline, promised delivery, partial receipt, shortages/substitution, completion verification, bill matching, waiver and payment reconciliation. **DoD:** Operator tracks each PO through acknowledged→delivered/completed→verified→paid with explicit exceptions; shortages affect schedule; duplicate invoice/receipt/payment retries cannot double pay; approvals retain original supporting evidence. **Verify:** partial delivery/substitution/duplicate bill scenarios and finance/vendor QA. Depends on E08-02/E07-03/E10.

**E08-04 — Finish vendor performance and commercial reporting.** Use original award/PO baselines, variance causes, timely completions, quality, warranty and recoveries with defined cohorts/exposure. **DoD:** Scoped reports reconcile to transaction evidence and distinguish missing data; costing and recovery do not masquerade as posted accounting; report/export totals match exact authorized scope at scale. **Verify:** golden dataset, report/export parity and E13 query plans. Depends on E08-03/E09/E11/E10.

### EP09 — Field execution, quality and offline work

**Entry points:** home schedule/daily-logs/inspections/punch/drawings/documents/photos/safety routes, `app/(app)/my-houses`, `my-work`, `app/api/mobile/v1/projects`, `workspace`, `ios/Arc` and `ios/README.md`.

**E09-01 — Finish assigned-home field workspace and released documents.** Expose fast daily assigned work, correct released plans/options/scopes, cross-home logs/photos and communication. Keep permission-safe document versions and actionable changes. **DoD:** Superintendent/trade can locate today's work and authoritative home documents without office navigation; released revision is explicit; stale/foreign documents or withdrawn assignment cannot be used as current authority. **Verify:** mobile/land/auth, actual field-user navigation and drawing/document acceptance. Depends on E03-03/E07/E02.

**E09-02 — Finish durable offline capture and conflict recovery.** Audit each native field workflow separately; persist actor-scoped drafts, attachment bytes/metadata, original requests and safe sync. Include cold launch, protected data, account switch, navigation, upload interruption and server conflict. **DoD:** Required logs/photos/inspection/punch drafts survive app termination and reconnect without duplication or cross-account disclosure; conflict UI preserves both evidence and a clear resolution; uploads are resumable/reconciled and orphan cleanup is safe. **Verify:** physical device/network/Keychain/background tests; fixture persistence alone is insufficient. Depends on F04/E02/E09-01.

**E09-03 — Complete inspection, punch and close-readiness loop.** Finish failed inspection assignment, corrective evidence, reinspection, verification ownership, outstanding safety/quality gates and trade accountability. **DoD:** Failed critical work cannot close through an unchecked status edit; evidence/reviewer/revision bind resolution; close readiness matches actual inspected home and latest valid permits/documents. **Verify:** failed inspection→repair→reinspection→cleared closing lifecycle and competing completion cases. Depends on E09-01/02/E06-03/E05-04 contract design.

### EP10 — Accounting, finance and planning

**Entry points:** `lib/services/books/*`, `accounting-*.ts`, financial services, `app/(app)/books`, `billing`, `payables`, `payments`, `reports`, home financials and `docs/books-revenue-recognition.md`, `docs/accounting-sync.md`.

**E10-01 — Complete production accounting/source reconciliation.** Map land/acquisition/development/WIP/sales/deposits/closing/commissions/warranty/recoveries to entity books and original operational receipts; finish reversals, period controls and inventory transfer. Reconcile with the separate Books workstream rather than reimplementing it. **DoD:** Golden lifecycle balances by entity and account; operational money ties to posted evidence; void/reversal/late correction preserves original entries; no duplicate posting on replay or period-close race. Any departure from shadow mode has required construction-CPA sign-off. **Verify:** financial/Books full-schema money races and signed reconciliation. Depends on E02/E04/E05/E08/E11 contracts.

**E10-02 — Complete budget/forecast/actual margin and cash scenarios.** Preserve approved baseline and forecast versions by home/plan/community/division/entity. Combine starts, closings, land takedowns, supplier commitments and financing into cash/runway scenarios. **DoD:** Actuals reconcile to ledger, forecast assumptions remain inspectable, delayed sales/starts alter cash with correct entity dates, and budget change does not rewrite original variance baseline. **Verify:** known-answer planning dataset, scenario sensitivity and scoped report/export parity. Depends on E10-01/E07/E04/E05.

**E10-03 — Complete construction financing and adapter parity.** Finish draw eligibility/evidence, borrowing base, disbursement/interest/covenant/payoff tracking and customer-selected accounting/lender interfaces. **DoD:** Loan/draw/payoff state reconciles to bank/provider and home inventory without double counting; each selected adapter supports the approved lifecycle and recovery, including rejected/partial/duplicate callbacks. **Verify:** sandbox integrations, golden adapter contract tests and controller acceptance. Depends on E10-01/E12-02.

### EP11 — Installed-base warranty and customer care

**Entry points:** `lib/services/warranty.ts`, `warranty-operations.ts`, `warranty-enrollment.ts`, `warranty-completion-transactions.ts`, `warranty-courtesy-reservations.ts`, `warranty-actor-analytics.ts`, `components/warranty`, `app/(app)/warranty`, home warranty, native service API and buyer/trade portals.

**E11-01 — Complete coverage/enrollment/courtesy governance.** Finish transaction-backed enrollment/program versioning, original home delivery/coverage, installed-home import, mixed-home defaults, courtesy milestone identity and historical reconciliation. **DoD:** Correct coverage and visits follow original delivery/program evidence; retries and overlapping sweeps cannot duplicate milestones; changed programs do not silently rewrite coverage; imported installed base reconciles counts/dates/exceptions. **Verify:** enrollment/closing/courtesy independent races and historical fixtures. Depends on E05-04/E12-01/E02.

**E11-02 — Complete dispatch/capacity/calendar workflows.** Implement division-local time/DST, trade/crew/service-area/assignee eligibility, atomic reservations, parts/follow-up/rescheduling and SLA escalation. **DoD:** Competing dispatch cannot overbook; no-show/parts-required cases retain work and escalate correctly; queues/counts are complete under actual-home/community/division scope; calendars behave correctly across DST. **Verify:** crew races and coordinator/technician daily QA. Depends on E02/F04/E07-03 shared calendar semantics.

**E11-03 — Complete mobile repair evidence and recovery.** Activate receipt/revision-guarded completion only after schema/policy QA. Finish camera/library capture, previews/removal, signature provenance, durable image bytes/unsubmitted drafts, pending recovery list, upload reconciliation and account/device retention policy. **DoD:** A technician completes/recoveries an original visit after crash/offline/relaunch without duplicate work, lost photos or another user's journal; staged receipts reauthorize; late source changes reject without overwriting; meaningful device/storage failure states are recoverable. **Verify:** physical-device and real PostgreSQL/provider tests in addition to native unit/simulator build. Depends on E09-02/E11-02/F03.

**E11-04 — Complete verification/backcharges/analytics feedback.** Finish homeowner/office verification ownership, disputes, approved backcharges/credits/reversals and durable notifications/search fanout. Reconcile recovery to accounting; use accurate installed-base/cohort/trade exposure denominators and scoped DB aggregation. **DoD:** Service→verification→dispute/recovery closes coherently; no concurrent money/status race duplicates recovery; selected/assigned scope filters before aggregation; defect trends drill to original evidence and feed plan/vendor improvement. **Verify:** complete service scenario, scoped analytics golden data, accounting reconciliation and E13 plans. Depends on E11-01/03/E10-01/E08-04.

### EP12 — Migration, APIs and integration platform

**Entry points:** `lib/services/imports.ts`, `import-definitions.ts`, `import-mapping.ts`, `import-parsers.ts`, accounting adapters/delivery, API/webhook routes, document/signature storage, export and restore services.

**E12-01 — Complete atomic/resumable operational cutover.** Cover contacts/companies/hierarchy/land/lots/plans/price books/open homes/agreements/deposits/selections/schedules/POs/payables/closing/warranty and attachments. Validate source identity and provenance, stage/review/reconcile before commit, and recover chunks across crashes. **DoD:** Representative builder dataset imports with exact counts/balances/statuses/document continuity; duplicate and late rows reject visibly; restart does not duplicate or erase manual work; failed chunks reconcile and source→Arc identity remains traceable. **Verify:** onboarding/financial tests, full migration rehearsal and second replay. Depends on domain transaction contracts/F02/E02.

**E12-02 — Finish scoped APIs, webhooks and selected integrations.** Define versioned auth/scopes, rate limits, idempotency, signed payloads, retries/dead letters/replay and mappings for approved CRM/accounting/lender/identity systems. **DoD:** Customer-selected integrations complete tested sandboxes end to end; duplicate/out-of-order callbacks and mapping changes preserve original evidence; revoked token has no residual access; operators inspect/recover delivery without hidden divergence. **Verify:** provider sandbox contract/failure tests, auth and operational reconciliation. Depends on F01/E02/F04.

**E12-03 — Finish archive/export/restore and document continuity.** Include immutable receipts, intents/claims/history/revisions/capacity/source ownership and original/executed files in compatible archives. Define retention/legal holds, orphan cleanup and legacy packet reconciliation. **DoD:** Restore reconstructs coherent lifecycle and money in an isolated target, verifies file checksums/relationships and does not replay completed external actions; schema manifest/RPC/table coverage matches; no original document is silently regenerated from current rows. **Verify:** snapshot/restore tests, real restore drill and historical agreement/warranty examples. Depends on F03/E02-03/domain receipts.

### EP13 — Measured scale, reliability and operational readiness

**Entry points:** production queries/indexes/RPCs, outbox/cron/job telemetry, existing CI, Vercel/runtime and database observability configuration, native/runtime profiling and operational runbooks.

**E13-01 — Establish and meet enterprise workload objectives.** Calibrate provisional targets with customer sizing. Until replaced by an approved recorded decision, test 100 divisions, 2,000 communities, 100,000 active homes, 1,000,000 installed homes and 5,000 concurrent sessions. Include skewed tenants, large catalogs/history, simultaneous reports/imports/releases/signing/service and interactive users. **DoD:** Actual end-to-end desk p95 ≤2,000 ms and synchronous mutation p95 ≤1,500 ms at approved workload; async jobs acknowledge promptly and have separately approved completion-throughput/backlog limits. Report p50/p95/p99, errors, throughput, saturation and warm/cold behavior without hiding failures as successful fast responses. **Verify:** reproducible load runner with raw artifacts and traces. Depends on F02/E01/domain completeness.

**E13-02 — Remove measured bottlenecks and protect tenant fairness.** Optimize actual query plans/indexes/aggregation, transport, browser rendering and native memory/frame time. Bound bulk jobs, worker concurrency, retries and cancellation; isolate tenant backlogs. **DoD:** Target workloads meet E13-01 with documented headroom and bounded memory/payload; a large import/report does not starve another tenant's desks; revoked scope invalidates cache authority; short search/count and large fanout are measured. **Verify:** before/after plans, browser/device traces and mixed-tenant load. Depends on E13-01.

**E13-03 — Prove crash recovery, backups and operations.** Inject process kill, lease loss, DB/provider/storage outage, ambiguous response, queue backlog and deploy overlap. Exercise backup/restore and operator runbooks with on-call alerts. Provisional objectives: 99.95% availability, RPO ≤15 minutes, RTO ≤60 minutes; confirm contractual measurement windows and exclusions rather than invent them. **DoD:** Recovery drills meet RPO/RTO, critical outcomes reconcile without duplicate money/legal actions, stuck jobs alert within approved windows, operators can restore/requeue/rollback safely, and an approved soak/observational period supports the reliability claim. A short benchmark cannot establish uptime. **Verify:** timed drill artifacts, incident simulation, soak report and named operational sign-off. Depends on F04/E12-03/E14-03.

**Proposed measurable acceptance defaults:** Freeze these under F01 before acceptance, or record an explicitly approved replacement: load test includes 60 minutes at target concurrency after warmup and 15 minutes at 1.5× concurrency; sustained soak lasts 72 hours with representative active/backlogged jobs; availability is observed over 30 consecutive days on the approved pilot/service. Unexpected request error rate is ≤0.1% at target load; expected business validation rejections are measured separately and never used to hide infrastructure failures. There are zero unauthorized accesses, lost committed records, duplicate monetary/legal outcomes or unreconciled original-evidence mismatches. A failed/stalled critical job alerts within 5 minutes. Establish explicit per-family async completion/backlog targets from the full acceptance dataset before testing; a fast enqueue response cannot pass a bulk job whose completion is unbounded. These are proposed engineering acceptance defaults, not existing measurements or a customer SLA. Pilot observation and independent load evidence can run in parallel with final noncritical fixes, but final evidence must match the release version.

### EP14 — Complete acceptance and release

**E14-01 — Build the full lifecycle acceptance pack.** Encode the scenario matrix below with actual browser/mobile/API/database/provider evidence and current schema/flags. Link every required task to test or review artifacts. **DoD:** The matrix is reproducible, no critical case is covered solely by mocked services, and per-task evidence states exactly what was and was not exercised. **Verify:** CI plus authenticated dedicated-QA run. Begins in Wave A; finishes after all domain tasks.

**E14-02 — Complete independent security, accessibility and policy acceptance.** Review tenant/permission/grants/token/storage/privacy boundaries, duties/identity, document legal policies and retention. Test keyboard/screen reader/contrast/focus, mobile text/layout and main personas' actual work. **DoD:** No unresolved critical/high security issue, money integrity defect, inaccessible essential workflow or legal packet blocker; accepted lower issues have explicit owners and remediation dates and cannot contradict a required DoD. **Evidence:** independent review and customer/legal/controller approval. Depends on E02/E05/E09/E11.

**E14-03 — Execute approved release/pilot/operational sign-off.** Assemble compatible application/native/schema/provider versions, approve/apply required migrations, verify parity, drain/cut over workers, activate gated workflows in dedicated QA then approved pilot, exercise rollback and observe agreed pilot/soak period. **DoD:** Real permitted pilot personas complete all required operating cycles; required integrations work; no disabled required path remains; no stale writer bypass remains; E13 targets/recovery pass; operator/customer/finance/security sign-off is recorded. **Evidence:** release manifest, activation/reconciliation artifacts, pilot findings resolved, approval record and final scorecard. This is the final completion gate, not an automatic action authorized by this planning request.

## 5. Required cross-workstream acceptance scenarios

Execute scenarios with real authenticated roles, actual migration chain/RLS and provider/storage sandboxes. Exercise their applicable native/portal surfaces. Each scenario produces source-to-ledger reconciliation and original evidence, not just a screenshot of a status.

| ID | Scenario | Observable required result |
|---|---|---|
| A01 | Presold home: inquiry→hold→reservation/deposit→configured agreement→buyer/builder execution→selections/permit→PO/start→field inspection→closing→warranty | One coherent home lifecycle; exact approved prices/configuration/docs; balanced money; no missing downstream state. |
| A02 | Spec home: development→spec release→construction→inventory aging/reprice→sale→closing | Pre-sale construction remains coherent when sold; approved sale/price does not regenerate issued work. |
| A03 | Financing delay and promised-close reschedule | Blockers/capacity/notifications/cash forecasts update with reviewed impact and preserved history. |
| A04 | Cancellation before release and after work has begun | Contract/deposit/incentive/inventory/PO/commission/accounting disposition follows explicit policy; no silent deletion or double allocation. |
| A05 | Selection after cutoff, shortage and approved substitution | One change reconciles amendment, selections, budget, PO and dependent schedule; unapproved late change rejects. |
| A06 | Failed inspection and permit correction | Release/close readiness cannot bypass required evidence; corrective work and reinspection are traceable. |
| A07 | Concurrent lot buyers, limited incentive, PO regeneration and settlement | One legal/resource winner; no over-capacity, double sale/payment, stale source acceptance or partial overwrite. |
| A08 | Permission revoked/parent moved/account switched during review, queued save and worker run | Reads/replies/caches/commits/recovery respect current actual scope; original requests cannot migrate to another org/actor. |
| A09 | Crash and lost response at every critical transaction/provider boundary | Retry original request returns/reconciles one result; stale workers and cancelled keys cannot publish late. |
| A10 | Warranty intake→dispatch→offline repair/photo/signature→verification→dispute/backcharge→posted recovery | Coverage, SLA, evidence, money and defect analytics reconcile; crashes preserve technician work. |
| A11 | Legacy and million-home installed-base/open-WIP migration plus second replay | Original agreements/deposits/files/coverage survive; totals/counts reconcile and repeat import does not duplicate. |
| A12 | Multi-entity/division/mixed-posture operating month and close | Correct scoped roles/navigation, entity books, forecasting, tax/calendar policies, access and period controls. |
| A13 | Backup restore, provider outage, rolling deploy and worker protocol change | Meets recovery targets, preserves receipts/files and does not re-send/re-pay completed actions. |
| A14 | Representative enterprise mixed-role workload and tenant skew | Meets approved latency/throughput/error/fairness limits with complete result sets and bounded resource consumption. |

Include empty/unpriced/missing-source, malformed historical records, midnight/DST, archived records, expired identity/provider credentials, long/localized labels and accessibility boundaries in the applicable scenarios.

## 6. Evidence, completion scoring and external requirements

### Task evidence record

For each Fxx/Exx-xx ID store: title, owner, dependencies, implementation status, acceptance status, relevant paths/symbols, source fingerprint, migration/flag/runtime versions, completed DoD items, outstanding DoD items, test commands/results, QA role/dataset, evidence artifact paths/URLs, external approvals and last verification date. Completion evidence must be durable; `/tmp` alone does not qualify for the final release record. Do not store secrets or customer PII in evidence.

Do not alter a historical execution log entry to pretend its old tests covered new code. Add a reconciliation record explaining which later evidence supersedes it. If code/schema changes invalidate a result, reopen the relevant acceptance status.

### Percentage calculation

Use two explicit scores after F01 reconciliation, rather than repeating rough estimates:

- **Implementation score:** Each task/approved child task gets a fixed scope weight before execution. Credit only completed functional DoD items; show partial credit and denominator. Code behind a flag may receive implementation credit if connected and tested locally, but not release credit.
- **Release score:** The same weights receive credit only when required real QA, migrations/activation, integration and acceptance evidence pass. External blocks remain outstanding. Critical gate failures always prevent 100%, even if rounded weighted progress would otherwise reach it.

Proposed workstream weights (sum 100): EP01 6, EP02 9, EP03 9, EP04 6, EP05 10, EP06 6, EP07 10, EP08 9, EP09 6, EP10 8, EP11 7, EP12 6, EP13 5, EP14 3. Allocate equally within a stream initially, then freeze customer-approved risk/effort-based child weights before implementation; document changes. Foundation work is prerequisite evidence, not extra numerator. Do not count execution slices, migrations or passing test counts as percent completion. Never round 99.x to 100 while a required item is open.

### External acceptance dependencies (track; do not treat as implemented features)

| Dependency | What must be prepared before approval/input | What closes it |
|---|---|---|
| Customer requirements/policies/sizing | Clear proposed workflow/policy matrix, provisional sizing and integration inventory | Named customer/operator approval or explicit revised contract; unresolved critical policies remain visible. |
| Dedicated QA credentials/data | Safe setup checklist, synthetic dataset and reproducible acceptance commands | Authorized authenticated QA sessions and permission to mutate only that environment. |
| SSO/CRM/accounting/lender/provider sandboxes | Adapter contracts, mappings, callback/auth/recovery cases | Customer-owned sandbox credentials and recorded successful contract/lifecycle tests. |
| Database/deployment/flag approval | Reviewed migrations, upgrade/rollback/reconciliation, compatibility and worker drain plan | Authorized application plus verified schema/ledger/runtime parity and activation. |
| Legal/accounting/security reviews | Actual templates/packets/receipts/reconciliation/security reports | Named qualified reviewer approval; CPA shadow-mode condition preserved. |
| Operations/customer sign-off | Completed scenario matrix, load/soak/restore/pilot artifacts and runbooks | Named accountable operational and customer acceptance with no required open DoD. |

While waiting, continue unrelated authorized implementation and isolated testing. Do not ask for approvals on incomplete proposals when a concrete reviewable result can first be prepared. Do not claim that unavailable access or pending human approvals have passed. No independent agent can self-certify customer/legal/CPA acceptance.

## 7. Final finish line: all conditions required

The goal can be marked complete only when:

- [ ] F01–F04 and every required E01-01 through E14-03 task have reconciled passing DoDs; no required task is unassessed, partial, default-off, blocked or awaiting acceptance.
- [ ] All original tracker workstream acceptance statements map to passing task/scenario evidence. Every F01 production-visible page/action/job is covered; there are no orphan surfaces.
- [ ] A01–A14 pass against the final compatible release, with actual users/providers/devices where required and real independently concurrent database evidence.
- [ ] No unresolved critical/high security, money integrity, data-loss, legal-signing, tenant isolation, inaccessible essential workflow or lifecycle completeness defect remains.
- [ ] Required migration/schema/grants/flags/client/worker versions are approved, applied and verified; legacy unsafe paths are removed or safely fenced with compatible recovery/import/restore.
- [ ] Representative performance/fairness, availability observation and restore/failure drills meet approved objectives; operational ownership, alerts/runbooks and rollback are exercised.
- [ ] Selected integrations and migrated operational/installed-base records reconcile; original executed documents and receipts restore correctly.
- [ ] Legal/controller/CPA where required, independent security, operations and customer/pilot acceptance are recorded.
- [ ] `docs/enterprise-production/acceptance.json` contains a final release scorecard with evidence and scope/version; release score is exactly 100 without rounding or exceptions that contradict this contract.

At that point update the existing goal to complete and report the release identifier, accepted scope and evidence. If any condition is outstanding, report the exact IDs and keep the completion claim false. Archive/remove this execution plan only after its durable acceptance requirements and release evidence are preserved in maintained reference documentation, following repository document lifecycle rules.
