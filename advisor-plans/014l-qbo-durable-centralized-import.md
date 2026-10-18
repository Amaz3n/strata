# Q11 handoff: durable import outcomes and organization entry

Status: TODO; no Q11 clause is accepted by this plan. Priority P1, effort L, risk MED/HIGH. Planned October 5, 2026 against shared HEAD `9f1549af84a6998eb2d851415ec6f119ab89a96f` plus reviewed dirty workspace / isolated integrated baseline `75e9810dad944ffefacbfd515edbcb182b00956a`. Preserve all seven Q11 clauses and all125 original goal clauses. The one existing isolated executor is currently implementing Q05. This plan authorizes no parallel source executor or immediate source expansion.

Follow the ordered steps and gates below. Root owns authoritative plan/checklist updates and independently reviews one immutable artifact before authorizing an exact hash-guarded shared copy. Do not edit shared source, commit/push/merge there, load `.env.local`, call live QBO, use customer data, apply remote migrations, start a development server or move money. Disposable SQL/application fixtures only. Compare these actual source hashes before execution; Q05/Q06 legitimately change the importer, so reread resulting reviewed code and report drift rather than replacing it with this older version.

## Current behavior and independently executed evidence

`lib/integrations/accounting/import.ts` defines nine import families and only aggregate `AccountingImportResult`: imported/skipped/failed/errors/affectedProjectIds. `lib/services/accounting-import.ts` validates connection/items, requires organization and bill/invoice permissions, validates submitted project membership, then delegates to the certified provider and emits aggregate audit/event metadata. Provider methods remain the public boundary.

`lib/integrations/accounting/qbo/import.ts:3762` initializes aggregate counts. `importWithClaim` returns `{skipped:true}` whenever `accounting_claim_import` returns null. That includes a currently owned processing claim and a completed claim. Financial creation/adoption uses the existing narrow owned row/children/completion RPCs; claim completion is a separate request. Document helpers run four-wide, payments sequentially after documents, with same selected identity chaining. Payment/project destinations can be derived from linked imported documents. Journal entries, deposits and expenses can fan out into multiple actual rows/projects. Returning just the first ID cannot describe those results. The final affectedProjectIds is built from submitted project/allocations only, and excludes skipped/adopted items.

Parent ran actual shared service/provider facade and exact owned import SQL through the existing `tests/fixtures/qbo-import-runtime.js` and `qbo-import-completion-database.js`. Native fetch throws. `/private/tmp/q11-parent-characterization.test.js` passed2/2, zero failures/skips; log `/private/tmp/q11-parent-characterization.log`, evidence `/private/tmp/q11-parent-characterization-evidence.json`:

- A live processing claim and an artificially completed claim produce identical skipped results with no provider read. A provider-failed-only submission returns one error but no runId/items. Claim error metadata is present; it is not a durable submitted-run receipt.
- An existing succeeded payment is actually adopted under the claim into a complete sync mapping, with its real Arc payment ID, project and100-cent amount preserved. The result still says skipped1, has affectedProjectIds=[], and omits that actual ID.

These are negative characterizations, not fixed behavior. Synthetic authorization/provider dependencies and inert balance/posting/opening collaborators remain explicit: this is not full financial/permission acceptance. Preserve actual import idempotency; do not create a second financial engine to fix receipts.

`app/(app)/integrations/qbo-import-actions.ts` currently converts a thrown batch error into a fabricated error for each submitted item and revalidates submitted destinations only if imported>0. `components/integrations/qbo-import-sheet.tsx` retains a summary only when imported>0, builds it from submitted records and links its context project. `integrations-panel.tsx:705` intentionally omits the import tab at organization level. Existing backend items already accept explicit per-item projects; the missing organization entry must use those controls without a fake project.

## Original seven definitions of done

All remain false until implementation, portable tests, UI/service/SQL authorization review and independent integration:

1. Q11-01: Each run has a durable identity and records every submitted item's imported/adopted/skipped/failed outcome, resulting Arc IDs, destination projects, amounts and error.
2. Q11-02: Retry resumes incomplete items without duplicating money or successful child rows.
3. Q11-03: Organization entry uses the existing import workflow with explicit company/project destinations and permission checks; no fake destination project is required.
4. Q11-04: Receipt links navigate to actual records/projects, including multi-project allocations.
5. Q11-05: Failed-only runs remain inspectable.
6. Q11-06: Repeated viewing reads persisted results rather than recomputing from submission.
7. Q11-07: Authorization and partial-failure SQL tests pass; no credentials/full provider payloads are retained in receipts.

## Scope, dependencies and architecture

Allowed: provider-neutral import DTO in `lib/integrations/accounting/import.ts`; current service `lib/services/accounting-import.ts`; one focused provider-neutral receipt service/helper under `lib/services/accounting-import-receipts.ts` / `lib/integrations/accounting/import-receipts.ts`; current QBO import facade and its existing completion seams; current QBO import actions/sheet; accounting sync sheet receipt entry and integration panel organization entry; one additive receipt migration and focused tests/fixtures. Narrow certified provider-contract extension in provider.ts requires a concrete proposal. No generic workflow engine, legacy provider columns, credentials in ordinary DTOs, arbitrary service writes or unrestricted admin RPC.

Q05/Q06 own financial line/discount/currency preflight. Q10 owns scoped pagination/health, Q09 owns truthful read/outcome presentation. Preserve their published contracts; backend receipt production may precede Q09 UI consumption, but original complete Q11 acceptance still requires reviewed Q06/Q10 authorization/scope and UI integration. Avoid treating that sequencing as permission to skip dependencies. Q16 owns final preview/transport efficiency; Q11 must preserve four maximum item workers, payment dependency ordering and independently bounded realm transport. No whole25k submission, unbounded receipt expansion or new full-history scan.

Existing SQL to preserve: `20260724010343_accounting_abstraction_hardening.sql` claim/finish; `20260908020000_accounting_import_recovery.sql` owned row/child/adoption; `20261005053644_qbo_import_completion_fences.sql` company/claim/target-bound complete identity and strictly older event resolution. Never reopen completed claims merely to generate receipts. Financial family implementations retain their original domain operations, immutable money and existing correction requirements. No inferred replacement cash, reversal or bank write.

## Ordered implementation

### 1. Freeze actual behavior, propose durable SQL contracts

Add executable old-behavior tests based on the two parent cases, plus partial fan-out interruption and duplicate submissions. Use actual facade/owned SQL, explicit fail-closed native fetch and a clearly named collaborator boundary. Before editing new SQL, send root exact proposed tables/signatures/grants, lock order, company/claim/source fences, retry state transitions, read authorization and rollback/replay contract. A service-owned receipt API is not inherently authorized just because it runs as service_role.

Proposed minimal shape to assess, not a preapproved signature: immutable run header (org, actor, connection, provider, original company identity/name, request UUID, normalized command hash, created/completed timestamps); one persisted ordinal/item per submission (explicit type/external ID, selected routing command, canonical identity, outcome/reason/stage and bounded error); one-to-many persisted actual result targets (typed Arc IDs, actual project, signed integer cents/currency, imported/adopted disposition), plus bounded attempt/version/lease evidence. Public DTOs contain only authorized projections, no raw command/provider envelope. Do not use a mutable sync record as the receipt itself.

Run creation follows successful request schema/organization/connection and explicit destination authorization; a rejected foreign/unauthorized submission has no run/financial mutation. A valid provider-failed-only batch gets a durable run before provider work. Freeze submission identity and reject request UUID reuse with a changed command. Canonical remote namespace/identity must be pinned to the original company, not a bare numeric ID; duplicate identical selections retain every submitted ordinal but reference one execution. Conflicting duplicate destination/type commands are rejected before effects, never whichever worker wins. Do not silently conflate Purchase versus credit aliases or Payment versus deposit: inspect the actual QBO entity map and declare supported canonicalization.

**Gate:** focused receipt contracts/tests demonstrate all old negatives and proposed role/fence/replay behavior; root approves the concrete SQL proposal before implementation.

### 2. Persist actual item completion without weakening claim fences

Extend the actual existing successful family completion paths to collect every resulting row, including already existing adopted targets. Never reconstruct identities by subtracting errors from submissions, firstEntityId, unordered query/index matching, local project context, document number or unrestricted external_id lookup. Use owned identities/claim provenance and source-defined split IDs. Derive project/amount from actual owned persisted rows and capture those values at completion; later viewing must not recompute a historic receipt from edited rows. Distinguish imported, adopted, already-complete skip, unsupported/no-applicable-lines skip and busy/deferred incomplete. A busy owner is not already imported. Optional pending/processing/deferred statuses preserve these distinctions while the required terminal categories remain explicit.

Atomic receipt projection must require original run/item/actor/org/company scope and valid owned claim/target evidence. Tie run/item attempts to current claim token/version; stale completion cannot overwrite a newer attempt or append foreign results. Finalize only after actual domain and mapping completion; a row created followed by failed child/posting/mapping/receipt completion is failed/incomplete with proven partial targets and a stage, never imported success. Do not promise rollback across independent requests. Replays must adopt validated prior rows and complete missing steps, keeping successful children/cash exactly once. If receipt write fails after financial completion, report receipt-unconfirmed/incomplete and preserve recovery eligibility; never emit healthy fabricated aggregate counts. A newly invoked run referencing a historically completed claim may project a bounded verified already-complete result after current authorization; no fabricated original run history.

**Gate:** `node --test tests/accounting-import-receipts.test.js tests/qbo-import-completion.test.js` zero failures/skips, actual nine-family paths/owned SQL, restored parent negatives, direct denied roles, absent-RPC fail-closed and stale token cases.

### 3. Make retry/resume durable and permission-checked

Resume by durable run ID with explicit incomplete item IDs/attempt version, not resubmitting every UI selection. Reauthorize current organization, provider/company and all actual/selected destinations at retry time. A disconnected/expired/rebound company cannot execute; completed receipt reading does not require the company to remain active. Refresh token reconnect preserves original scoped identities. Do not retry imported/adopted/completed siblings or reissue financial effects after a lost browser response. Lost workers retain pending/processing eligible work and bounded diagnostics; a fresh attempt uses the current existing import claim takeover rules. Interrupted documents complete before payments; same canonical identity does not run concurrently. Preserve current project routing preflight before any family effect.

Use a run request idempotency key and immutable command hash independent of Q15 remote request IDs. The receipt layer must not claim remote exactly-once delivery. Retry must never reset terminal webhook events/newer revisions or change an existing payment allocation just to succeed.

**Gate:** actual service tests cover response loss/reload, incomplete last child, domain or mapping completion failure, receipt failure, provider outage, stale lease, overlap, wrong-company reconnect, permission revoked between attempts, duplicate run request and one cash/child/fact across repeated attempts. Add deterministic true PostgreSQL contention coverage using the portable fixture approach; serialized PGlite is only transaction/replay evidence.

### 4. Expose authorized persisted results and organization import

Read runs/items through a provider-neutral validated service/action. Use current real project/division scope and resource permissions, including target records and routing destinations. Apply authorized scope before page limit/counts; exclude or explicitly redact inaccessible items/targets without leaking amounts/IDs/names/error details/counts. Label scoped counts when a user cannot see a complete run. A membership-only policy is insufficient. service_role read requires explicit same checks and bounded authorized projection; no client select on private commands/attempt secrets. Foreign org/company/run IDs fail closed. Historical connection labels come from the frozen run/company; a current active connection must not relabel old results.

Receipt item pages max100 with timestamp/immutable-ID or ordinal/ID stable keyset; bounded run listing. Return real per-target record/project references, signed cents and explicit currency. Build links through actual existing record navigation conventions; inspect detail opening/link controls before choosing URLs, and assert they open the specific row. A project landing page alone does not satisfy actual record navigation. A deleted/inaccessible historic target remains labeled unavailable; never link a replacement with the same document number.

Organization integration panel opens the existing import sheet with company selection and no selected destination default. Documents require deliberate per-item project/allocation, while payments derive from permitted linked obligations. Show actual multiple projects/results on receipts. Share Q09 loading/error/stale/outcome states; no green state on initial/refresh failure. Store and reopen the run ID; valid failed-only, partial and busy runs have inspectable persisted results and Retry where eligible. Counts come from saved outcomes, never selections. Revalidation uses proven actual touched projects, including adopted records, without revalidating foreign submitted IDs. Action-level pre-run denial is a batch error and cannot fabricate per-item persisted failures.

**Gate:** actual action/component fixtures cover organization entry, two companies, explicit multi-project destinations, adopted target, failed-only, interrupted reload, receipt fetch failure/retry, unavailable link and revoked scope. Follow `tests/browser/books-payroll-workspace.test.js` synthetic isolated UI fixture pattern; no production Next server or build.

### 5. Verify complete acceptance and hand off

Run in the isolated checkout with `COREPACK_ENABLE_AUTO_PIN=0`. Do not install packages or load production environments. Existing runtime has Node/Bun/PGlite/readonly dependencies.

- `node --test tests/accounting-*.test.js tests/qbo-*.test.js`: zero failures, skips/cancellations explicitly accounted; named actual receipt suites must have none.
- `bun test --preload ./scripts/bun-test-setup.js lib/integrations/accounting/local-change.test.ts lib/integrations/accounting/qbo/client.test.ts lib/integrations/accounting/qbo/webhook.test.ts lib/integrations/accounting/qbo/error-rules.test.ts lib/integrations/accounting/qbo/sync-safety.test.ts lib/integrations/accounting/qbo/account-utils.test.ts`: zero failures.
- `COREPACK_ENABLE_AUTO_PIN=0 pnpm typecheck`: exit0. `COREPACK_ENABLE_AUTO_PIN=0 pnpm exec eslint <every changed JS/TS/TSX path> --quiet`: exit0. `git diff --check`: exit0.
- `COREPACK_ENABLE_AUTO_PIN=0 pnpm test:auth` and `COREPACK_ENABLE_AUTO_PIN=0 pnpm test:financials`: exit0 or exact attributable pre-existing failure; no goal-caused regression.
- Execute exact additive migration, effective original owned claim/row/completion SQL and relevant current financial triggers in disposable engine, grants and forward replay. Full financial/inbound/receipt journeys must execute actual domain collaborators before program acceptance; minimal inert fixtures cannot substitute.
- Portable tests run with no isolated Git objects or inherited untracked helpers. Preserve final CI build/full application and rollout obligations; no test introduces a production DATABASE_URL fallback.

Capture provider/DB calls, wall time, runtime/fixture sizes for original versus improved partial-retry/repeated-receipt views, including zero new provider calls on receipt viewing and zero reexecution of successful items. Keep bounded read payloads (≤100 items; no unbounded children/provider blobs), existing four item workers and dependency phases. Q16's full preview200rows/1MiB,25k resumable/128MiB and realm2inflight/8starts-sec remain required, not certified by this package.

Deliver one immutable isolated code-only commit, exact file list/before/after hashes, gates/results and SQL rollout order/rollback compatibility. Root independently reads every hunk and reruns gates before authorizing shared copy; no authoritative checklist edits by executor. New SQL remains unapplied to production, and SQL-first receipt capability rollout must fail visibly while absent.

## Stop conditions and maintenance

Report a concrete proposal if a family cannot prove all actual targets, a successful receipt requires changing a posted economic fact, a required navigator has no actual detail contract, project/division authorization cannot be represented, or approved scope needs expansion. Continue independent unaffected tests while clarification is pending. Do not fill missing evidence with an inference or weaken the criterion.

Keep completion provenance, DTO projection and financial domain operations separate. Adding a family must extend the certified type/canonical namespace, actual target collection, resumable failure path, permissions and receipt link fixture together. Existing outcome aliases/aggregate compatibility may remain during rollout, but all new receipts and consumers must preserve actual adopted/busy/failed meanings. Never retain OAuth tokens, headers, full envelopes, unrestricted user/provider error messages or financial ledger payloads in receipt metadata.

## Planned source hashes

- `lib/integrations/accounting/import.ts`: `d552f37b03eaccef5b20888ac964730bb07bcc0668611c163e86daa3594965e6`
- `lib/services/accounting-import.ts`: `3b4eef547a7bb10581e0bd4bf49377c2ba1abc9cde348e13018fc25a6f820138`
- `lib/integrations/accounting/qbo/import.ts`: `8ecfa340a4c24fc44a90e259193ebd55bea7c5518512be008575aa3f1f4fc71c`
- `app/(app)/integrations/qbo-import-actions.ts`: `9e1209a390511473c8c57c7af15daac1722d3c4ca431ea20079bf4be03111912`
- `components/integrations/qbo-import-sheet.tsx`: `83dac7fffd7b5f7ddf0db5928bb0d52febd784357a4b46039aee01fc0a367589`
- `components/integrations/integrations-panel.tsx`: `dbb00b69d60b0df89acf263d29e15bebc32cd4d0c0eae7c0ede29d8da8838ff2`
- `supabase/migrations/20260724010343_accounting_abstraction_hardening.sql`: `efe55226a05ad8b0b718d637582c6f0d819020475b27d8c98ddee6db628f0170`
- `supabase/migrations/20261005053644_qbo_import_completion_fences.sql`: `e048381e350ac57e26eb5e1a18c98ec810a9556cc92ae550cf3d136988eb7367`

## Database documentation verification

Parent checked current [Supabase changelog](https://supabase.com/changelog), [database functions](https://supabase.com/docs/guides/database/functions) and [RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security). Privileged functions need explicit restricted EXECUTE grants and a safe search_path; table privileges and RLS are separate. New private receipt tables remain client-denied with RLS enabled; authorized public projections must check actual scoped permissions. The changelog now lists PostgreSQL17.11, while the prepared temporary concurrency runtime is17.6: retain its exact observed version in evidence and include a current target-version run in portable/CI acceptance. Do not imply the temporary runtime is the deployed version or upgrade any real database as part of these checks.
