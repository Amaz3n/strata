# Q12 handoff: compare accounting conflicts and fence reviewed corrections

Status: TODO; all eight original Q12 criteria remain false. Priority P1, effort L, risk HIGH. Planned October5,2026 against shared HEAD `9f1549af84a6998eb2d851415ec6f119ab89a96f` plus reviewed dirty source / isolated baseline `75e9810dad944ffefacbfd515edbcb182b00956a`. The single source executor is currently implementing Q05; this is preparation, not a new dispatch. Preserve all125 original clauses. Root alone owns authoritative acceptance and hash-guarded integration.

Do not edit shared code or commit/merge/push there; do not read production `.env.local`, call live QBO, move bank money, deploy, apply remote SQL, run D2 cleanup or start a development server. Use explicit disposable synthetic fixtures. Reread actual Q05/Q06/Q10 contracts after review before implementation; hash drift is expected and must be reconciled, never blindly overwritten.

## Actual behavior and independently executed negative evidence

`app/(app)/integrations/accounting-sync-actions.ts:451` accepts only entityType/id/resolution. It calls Zod.parse without retaining the parsed object, scopes a single header project, reads only connection_id/external_id/provider/status, and calls provider.resolveConflictTakeRemote without local/remote displayed revisions or a comparison identity. Keep-Arc delegates enqueueAccountingPush with org/type/id; historical remote company identity is not an explicit enqueue argument at this action seam. Inspect actual enqueue target/ownership guards before claiming they do or do not protect a particular case.

`lib/integrations/accounting/provider.ts:179` exposes the force-resolution hook without expected versions. QBO `forceReconcileFromQbo` checks that all mapped siblings still need review, then fetches a current remote record and invokes force=true. The existing comment claiming stored SyncToken makes this safe does not prove the displayed revision was approved. Q05 must preserve posted bill/allocation protection even when force=true; Q12 cannot release that guard.

`components/integrations/accounting-sync-sheet.tsx:533` displays a generic overwrite confirmation, while rows show one amount/error and Keep Arc/Take Provider. It lacks baseline/local/remote details. Payments/webhooks only Retry. Project allocations, original/current provider revision, settlements and period/authority constraints must be visible before deciding.

Parent executed the actual shared server action using the existing TypeScript loader with synthetic scoped DB, authorization, provider and audit doubles; native fetch throws. `/private/tmp/q12-parent-conflict-characterization.test.js` passes2/2, zero failures/skips. Log `/private/tmp/q12-parent-conflict-characterization.log`; evidence `/private/tmp/q12-parent-conflict-characterization-evidence.json`. Stale displayed local/remote version and comparison ID are ignored; action dispatch contains only org/company/type/externalId and reports resolved. Two identical concurrent action calls each reach the synthetic provider callback and each audit. This proves the missing action decision fence; it does NOT prove duplicate actual financial effects or a bypass of all provider/domain safeguards. Add portable tests with actual SQL/domain behavior before acceptance.

## Eight original definitions of done

1. Q12-01: Comparison displays baseline/local/current remote revision, amount/balance/date/coding/lines/project allocations and linked settlements.
2. Q12-02: Fetch failures are explicit.
3. Q12-03: Decisions require the same current conflict and remote/local version displayed; a changed revision invalidates approval and reloads.
4. Q12-04: Keep-local and take-remote preserve historical remote ownership and existing freeze/authority checks.
5. Q12-05: Posted payment/allocation correction uses existing reviewed reversal/reallocation domain operations, never generic overwrite; irreversible consequences are previewed.
6. Q12-06: Payments have an actionable resolution path beyond Retry.
7. Q12-07: Duplicate/cancellation/concurrency tests prove audit evidence and one correction.
8. Q12-08: Closed periods cannot be bypassed.

## Scope and dependencies

Requires reviewed Q02 authorization, Q05 complete cost lines/source revision/posted fences, Q06 invoice translation/currency, Q10 scoped queue/company read contracts. Allowed files: shared provider contract/capabilities only as needed; one provider-neutral comparison/decision service and typed DTO under `lib/services/accounting-conflicts.ts` / `lib/integrations/accounting/conflicts.ts`; current accounting sync action/sheet; QBO bounded read translation/force-resolution seam; existing delivery/enqueue seams strictly for pinned approved operations; one additive comparison/decision migration and focused tests. A new normalized immutable baseline/accepted-completion extension is allowed only after an exact proposal; a hash-only dispatched receipt cannot reconstruct baseline content. Reuse existing cost/invoice translators, not a separate materially-differs engine.

Narrow existing financial correction adapters must be proposed with exact signatures, source/period/identity guards, lock order and role grants before source expansion. Do not rewrite payment rails, approval/GMP/native ledger engines or use arbitrary service overwrite. No remote refund/ACH/charge creation. Financial correction records mirror reviewed economic evidence, and money-moving user/provider actions remain separately authorized.

Relevant actual domain contracts: `recordPaymentReversal` uses `record_payment_reversal_atomic`; `recordMultiInvoicePayment` uses `apply_multi_invoice_payment_atomic` and current permission/project/customer checks. Passing explicit orgId to some background helpers bypasses their interactive authorization branch: the conflict service must explicitly authorize, not assume calling a service helper is sufficient. `reverseManualBillPayment` authorizes payment.release, validates external payment controls and invokes service-only `reverse_manual_ap_payment_atomic`; its SQL rejects nonmanual/rail payments and live payment-run membership. `record_manual_customer_refund_atomic` only accepts received manual invoice payments and records money already returned, with remaining deposit/reversal limits. Neither is a generic correction for QBO-owned payment rows. Do not relabel a QBO/rail payment as manual to call them. Q14 customer-credit/refund parity is a later deliberate domain extension, not preexisting provider support.

Before any approved correction, inspect effective current Books native/legacy project ownership, close-period/calendar, posted opening, cash/balance and reversal triggers. Original SQL/helper names alone do not prove current period protection. Existing native ledger history must remain immutable and facts/reversals auditable.

## Ordered implementation and verification

### 1. Define comparison evidence and capture real baseline

Create a bounded provider-neutral comparison DTO keyed by org/actor/company/provider/canonical remote identity and every mapped Arc sibling. Read requires real entity/project/division permissions for all visible fields/linked settlements; mutation additionally needs accounting management and underlying bill/invoice/payment permissions for every affected destination. Unknown errors/metadata are sanitized. No credential/header/raw remote envelope in DTO or stored comparison.

Display three explicit columns: last accepted baseline, present Arc and current provider. Each includes supported normalized money/currency/date/status/balance/counterparty/account/item/class/customer/tax, stable line identities/source order and project allocations, plus linked invoice/bill/payment/reversal/retainage/opening history relevant to permitted actions. Capture local revision as raw microseconds and complete cost-v1/invoice content, mapping identity/version/review-reason revision, remote SyncToken and validated LastUpdatedTime. Remote IDs are company/parent scoped, never bare numeric keys. Resolve remote-to-project routing through current authorized mappings and explicit ambiguity, never first line/header guessing.

Baseline must be a bounded immutable accepted source/remote projection saved at a real successful completion. Current reread, current sync metadata mutation or a fingerprint alone cannot recreate it. New completed flows capture the exact accepted snapshot; an old record without baseline displays unavailable/unknown and stricter review, never labels current provider data as the old baseline. Q05 snapshot is provenance; inspect whether it contains material content before consuming it. Define typed schema/version and limits (max1000 financial lines; persisted canonical DTO bounded and no provider blob); oversize/unrecognized meaning is explicit review.

All provider/local/linked-document fetch failures persist a retryable comparison error and disable decisions. Missing/changed/deleted record, inactive company, unsupported currency/tax/shape and unauthorized target are explicit. Reuse existing worker deadlines and pinned QBO client; no unconditional request after budget expiry. Read-only comparison creates no financial rows/provider writes.

**Gate:** `node --test tests/accounting-conflict-comparison.test.js` executes actual service/provider read facade with complete baseline/local/remote, same-total later-line change, signed credit, discounts, multiple targets, absent baseline, deleted/stale mappings, provider/DB failure and tenant/division denial. Assert zero financial/POST effects.

### 2. Propose and implement an atomic reviewed decision fence

Before SQL, send root exact service-only comparison/decision tables/RPCs and grants, bounded JSON schema, lock order, actor/company/project/version checks, consumption/replay behavior and SQL-first rollout. Store immutable comparison evidence/digest plus a short-lived decision identity tied to the authorized user/org/company and all displayed revisions. Frontend sends only validated expected comparison/choice/version IDs, not arbitrary replacement payload. Action boundaries use strict parsed input. No unsigned caller data authorizes a correction.

At submit, reauthorize every relevant resource, active company and current authority. Lock/claim the complete mapped delivery/correction group deterministically. Recheck mapping review status/identity/reason/version and local source/children/settlement revisions, current posted/period status and exact normalized provider revision from a fresh pinned bounded read. If anything differs, do not enqueue/overwrite/mark resolved; return comparison-stale and reload. A changed remote version must not substitute the newly fetched version for the version displayed. Use approved source snapshots only; default force=true is never the decision contract. Intuit cannot be locked by the local database: document last-observed remote check, retain newer provider events and require provider optimistic SyncToken when performing a supported write. Do not claim a global atomic lock across both systems.

Persist one operation/decision identity with requested normalized effects and audit provenance before dispatch. Idempotent duplicate submissions reuse the same result or pending operation; key reuse for different choice/identity/revisions fails. Cancellation consumes no financial operation and writes only bounded cancellation evidence if applicable. Stale/lost ownership cannot mark completion or overwrite newer mapping status. Local validated decision claim and its correction effects must be atomic where required; no independent arbitrary select-then-update race. Lost provider response follows existing uncertain-delivery recovery/Q15 operation semantics, never a blind POST retry. A queued keep-local operation is awaiting delivery, not successfully resolved merely because an outbox row exists.

**Gate:** `node --test tests/accounting-conflict-decision.test.js tests/accounting-conflict-decision-db.test.js` covers both parent negatives with actual SQL, stale before/during mutation, wrong realm/org/user, expired comparison, revoked permission, same decision/different choice, takeover, cancellation and unapplied RPC. Two true PostgreSQL participants/barriers must prove one decision/effect; PGlite Promise.all is serialized evidence only.

### 3. Pin keep-local and take-remote to reviewed ownership and allowed effects

Keep-local uses the historical mapping connection/realm/remote identity, the approved local revision and existing provider-neutral durable enqueue/delivery. A routing change to another company cannot silently send a conflicting obligation there; return explicit rebind review. Provider optimistic version/coding preflight, native authority and closed-period/source freeze checks still apply. Delivery records the reviewed dispatched revision and any newer local revision remains pending.

Take-remote calls the reviewed canonical translator/apply path with exact expected source/remote/sibling revisions and approved command. Mutable draft/pending document may apply only under Q05's atomic zero-posted-history contract; force cannot bypass approvals/payments/retainage/native facts/opening or posted cost protection. Invoice take-remote must preserve actual discounts/tax/client visibility/settlements and native period ownership, not update amount/header then delete and recreate lines on a posted record. Unsupported/ambiguous legacy baseline stays review. Do not mark sibling/event work resolved except where its actual accepted version is covered; strictly newer/ambiguous events remain eligible.

**Gate:** actual nine-family relevant golden/closure/posted snapshots verify unchanged posted economic rows/children/facts under denied decisions, mutable atomic rollback, same-total redistribution review, changed routed company, native ownership, closed period and source edit during provider response. Record before/after typed rows and balances, not source-text assertions.

### 4. Implement the missing reviewed payment resolution path

A payment comparison identifies source cash and every allocation, actual provider applications, original/remaining amount, reversals and permitted target obligations/projects. Offer explicit supported decisions: keep verified Arc bookkeeping through the pinned existing mirror; adopt/complete an already matching owned provider import; or prepare a reviewed corrective reversal/reallocation plan for actual mismatch. Retry alone or a link telling someone to fix it externally does not complete Q12-06. No ordinary-document take-remote overwrite of payments.

For correction, select the existing applicable domain operation by proven source/provider/status; preview all reversal/replacement amounts, new balances, dates, projects, facts and active-run/retainage/client-visible/period constraints. A simple accounting reversal may record correction of an already-established economic fact; no action initiates a new bank transfer/refund. Source statuses/types excluded by current manual wrappers require a deliberate narrow QBO-owned correction extension proposed to root, not helper bypasses. Reallocation must preserve total net cash, use existing one-invoice-per-payment / provider identity contracts and create auditable compensating lineage, never edit or double-count settled cash. Validate all targets/customer/project permissions and available unreversed/unapplied amount before any effect; final invalid allocation rolls back the whole correction. Correction-date/closed-period choice is explicit and legally/domain-authorized; do not move dates to today automatically to escape a close.

Bind idempotency to exact original payment/applications/amount/decision, including any existing reversal helper that returns by a key before validating source arguments. Domain reversal + replacement/application + original identity lineage + accepted decision/audit must either commit once together or stay explicitly incomplete through a reviewed resumable domain contract. Never claim atomicity over separate RPCs. Preserve rail/provider exclusions and economic provenance. Old webhook/import jobs must observe correction lineage and not recreate retired applications. Q14 reuses this reviewed seam for its future scoped credit/refund support.

**Gate:** `node --test tests/accounting-payment-conflict-correction.test.js tests/accounting-payment-conflict-correction-db.test.js` executes actual applicable domain SQL/projectors and current role/period guards for unchanged cash, partial/split/multiproject correction, final-target failure, duplicate and cancellation, current provider ownership, active run, available reversal/deposit caps, cross-year/closed period and lost response. Assert exactly one corrective fact/lineage and actual balances, zero external money movement. Minimal inert posting fixtures are insufficient for this acceptance.

### 5. Add comparison UI and complete portable gates

Use existing accounting sync sheet and current design tokens/table/dialog primitives (`docs/design.md`: quiet dense console, token-only semantic colors, explicit loading/error/stale states). A row opens actual three-way detail with supported choices and reasons disabled. Both choices consume the same comparison, require updated preview after staleness and present payment effects explicitly. Cancel restores the queue without writes. Request-generation/scope guards prevent another company's late response replacing the view. Complete Q09/Q10 DTOs are dependencies, not competing health/read systems. Actual applied result and queued/incomplete operation states are distinct; history/audit shows source revisions, choice/actor/company and correction links without raw payloads.

Run actual component/action fixtures with synthetic local browser bridge following `tests/browser/books-payroll-workspace.test.js`; no production Next server/build. Test fetch error, stale refresh, changed company/project, native blocked document, permitted mutable decision, posted payment preview/cancel/submit, duplicate click and partial recovery. Links open the actual source/correction records.

Full isolated gates, with `COREPACK_ENABLE_AUTO_PIN=0`:

- `node --test tests/accounting-*.test.js tests/qbo-*.test.js`: zero failures, skips/cancellations explicitly reported; new comparison/correction/SQL suites have none.
- `bun test --preload ./scripts/bun-test-setup.js lib/integrations/accounting/local-change.test.ts lib/integrations/accounting/qbo/client.test.ts lib/integrations/accounting/qbo/webhook.test.ts lib/integrations/accounting/qbo/error-rules.test.ts lib/integrations/accounting/qbo/sync-safety.test.ts lib/integrations/accounting/qbo/account-utils.test.ts`: zero failures.
- `COREPACK_ENABLE_AUTO_PIN=0 pnpm typecheck`, changed-file `pnpm exec eslint <every changed JS/TS/TSX> --quiet`, `git diff --check`: exit0.
- `COREPACK_ENABLE_AUTO_PIN=0 pnpm test:financials` and `pnpm test:auth`: exit0 or precisely attributable preexisting failure; no goal-caused regression.
- Exact additive migration with actual effective financial/source/lease/ownership/period triggers, service/anon/authenticated privilege tests, forward replay and missing-RPC behavior. New functions revoke PUBLIC/client execute explicitly and use safe search_path. No credential/client table grants.
- Portable no-Git checkout runs actual tests without isolated objects/untracked helpers. True PostgreSQL contention/current target-version CI follows the explicit disposable fixture approach. Full goal UI/build/rollout obligations remain open until Q17.

Report request/DB counts and bounded data sizes for a100-line comparison and duplicate decision/recovery; use shared distinct-reference lookups, no per-line transport. Hand off one immutable isolated code-only commit, all before/after hashes, actual commands/results, SQL-first rollout/rollback compatibility and operational limitations. Parent reviews every hunk and reruns gates before source integration; production stays unapplied.

## Stop conditions and maintenance

Report exact proposed scope if an actual domain lacks a safe posted/payment correction contract, native period protection, accepted baseline material or authorized linked-project query. Do not satisfy missing payment resolution with Retry/unsupported/manual instructions alone, change posted cash by generic overwrite, or weaken original criteria to fit mocked tests. Continue unaffected read/test work while a concrete contract needs review.

Comparison, canonical translation, decision ownership and financial correction have distinct responsibilities. New provider/family/owned fields must extend all three-way snapshots, revision hashes, action schema, actual source/period fences and correction/receipt fixtures. Keep historical company identity stable across reconnect/routing changes and preserve ambiguous newer inbound work.

## Planned source hashes

- `app/(app)/integrations/accounting-sync-actions.ts`: `5efe0253f3353105bf528b8d1dfb365a7a165886e342f18b4d5ce6fb5b15ce35`
- `components/integrations/accounting-sync-sheet.tsx`: `adff610b47b3611f504861c66b6f558d7679aec4f8de12d6fa75983b5ed22b84`
- `lib/integrations/accounting/provider.ts`: `4d5cf7e6b1c0f305652093f3eda8a3bb58f704466395a95d2ea4c385f0b021f7`
- `lib/integrations/accounting/qbo/reconcile.ts`: `1adcfcff30a85302530095478832a8f927d2afec610c12dee394c3081857430b`
- `lib/services/payments.ts`: `3eab6fe7834411f658d655683c05a8f45047dd7c577d4f6c3b0c91aa6dfa4486`
- `lib/services/vendor-bills.ts`: `7c717ddeadcd1e60ce2d88d491cd422d7654157fad80d1e5e6b51ef0be90df5f`
- `supabase/migrations/20260813000500_manual_ap_payment_reversal.sql`: `3712aa059dfdc271e18b943fc361da0ee4146911b8829491f26c6f4d9a8ce634`
- `supabase/migrations/20260921123155_customer_billing_refunds.sql`: `b1863b0b55b6266f90239101666c99877ac9eb4b2d52510f900b5f8a28c4532c`
