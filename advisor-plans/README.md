# Arc Advisor Plans

These are implementation-oriented product and architecture plans. They are advisory artifacts, not authorization to apply database migrations or change production systems.

| Plan | Priority | Status | Summary |
|---|---:|---|---|
| [001 — Arc Books: staged QBO independence](001-arc-books-qbo-independence.md) | P0 | Proposed | Expand Books B5 into gated stages that let small builders operate without QuickBooks Online. |
| [002 — Accounting integration completion record](002-accounting-sync-and-d2-closure.md) | P1 | RELEASE PENDING | All 40 financial decisions repaired. Single retained record of verification and remaining deployment, acceptance and D2 steps. |

Record 002 is independent of the Books-independence proposal. Temporary accounting audit plans and snapshots have been removed; ongoing architecture documentation lives in [docs/accounting-sync.md](../docs/accounting-sync.md).


## Drawings lifecycle program — 2026-10-01

Full scope selected by the user after a read-only audit: upload recovery, deletion,
version replacement, publication, progressive review, artifact reuse and splitting.
Plans are based on commit `9f1549af` **plus the current uncommitted workspace**.
`drawings-source-snapshot.json` records source hashes for drift checking.
Implementation of plans 003–012 has been reviewed in an isolated checkout.
See [the implementation record](drawings-implementation-2026-10-01.md) for verified behavior, integration status and release gates. Database migrations remain unapplied.

M = roughly a day or two; L = multiple days including failure testing. Estimates
are sequencing aids, not delivery promises. The work deliberately reuses the
existing outbox, storage and UI instead of selecting a new platform.

| Plan | Outcome | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| [003](003-drawings-verification-baseline.md) | Establish lifecycle tests and a performance baseline | P1 | M | — | IMPLEMENTED / RELEASE PENDING |
| [004](004-drawings-resumable-transfer.md) | Preserve upload progress and support pause, resume and cancellation | P1 | L | 003 | IMPLEMENTED / RELEASE PENDING |
| [005](005-drawings-atomic-registration.md) | Reserve uploads and finalize drawing revisions idempotently | P1 | L | 003, 004 | IMPLEMENTED / RELEASE PENDING |
| [006](006-drawings-owned-job-leases.md) | Recover claimed jobs without duplicate ownership or cron-sized gaps | P1 | M-L | 003 | IMPLEMENTED / RELEASE PENDING |
| [007](007-drawings-durable-deletion.md) | Delete drawings transactionally and clean storage asynchronously | P1 | L | 003, 005, 006 | IMPLEMENTED / RELEASE PENDING |
| [008](008-drawings-atomic-publication.md) | Publish revisions with durable follow-up work and retry-safe results | P1 | M-L | 003, 007 | IMPLEMENTED / RELEASE PENDING |
| [009](009-drawings-current-register.md) | Read committed drawing versions without a global materialized-view refresh | P2 | L | 003, 007, 008 | IMPLEMENTED / RELEASE PENDING |
| [010](010-drawings-progressive-review.md) | Make upload and replacement review progressive and recoverable | P2 | L | 004, 005, 006, 007, 008, 009 | IMPLEMENTED / RELEASE PENDING |
| [011](011-drawings-page-artifact-reuse.md) | Reuse verified unchanged pages across revised PDF packages | P2 | L | 003, 007, 010 | IMPLEMENTED / RELEASE PENDING |
| [012](012-drawings-efficient-splitting.md) | Split PDFs once per attempt and stream durable page work | P2 | L | 003, 005, 006, 007, 011 | IMPLEMENTED / RELEASE PENDING |

### Execution order

Start with 003. Then implement 004 → 005 and 006; these are separable domains,
but do not edit shared pipeline/UI files concurrently without explicit ownership.
Continue 007 → 008 → 009 → 010 → 011 → 012. Default to this serial order.
Deletion's artifact lifecycle guard is extended by reuse; it must not be replaced
by a second reference-count mechanism. Publication keeps the old refresh until
009 proves every authoritative current reader has switched.

### Acceptance targets and evidence

- Recovery: retries preserve completed transfer; duplicate operations have one durable result.
- Deletion: acknowledgement has zero object-storage calls; eventual cleanup survives outages.
- Publication: current-version switch and required jobs commit or roll back together.
- Queue: graceful exits release owned unstarted claims; stale-only queues recover on the next sweep after expiry.
- Review: a viewable page can be reviewed while independent identity verification runs.
- Reuse: the supported one-page-change 300-page fixture renders one new page, with no false reuse.
- Splitting: one full-source download per uninterrupted supported attempt; bounded memory.
- Proposed latency budget: publish/delete acknowledgement p95 under two seconds on the agreed fixture environment. This is a target, not a measured current result.

Record fixture, runtime, sample size and p50/p95 for each performance result.
Implementation verification: the drawings suite passed 258 tests with zero skips,
the isolated browser fixtures passed, and the full TypeScript check passed.
The synthetic splitting benchmark covers 1, 24, 25 and 300 pages; production latency
is not measured. Full disposable Supabase migration verification and QA acceptance
remain release gates; see the implementation record for final evidence.
Schema-dependent work is IMPLEMENTED / RELEASE PENDING until the approved rollout
and applicable evidence are recorded; never use DONE to imply production deployment.

### Findings considered and rejected

- Removing independent identity verification entirely: rejected; wrong sheet matching can replace the wrong drawing. Enable progressive review and explicit confirmation instead.
- Increasing all worker/upload concurrency: rejected without measurement; it multiplies source memory, storage traffic and database contention.
- Async global MV refresh as the complete fix: rejected; it leaves current-register reads stale after publish/delete.
- Perceptual/thumbnail similarity as proof of unchanged content: rejected; it can hide small consequential drawing changes.
- Replacing the queue/storage platform immediately: not supported by this audit; fix ownership, retries and transaction boundaries first.
- Automatic deletion of original library PDFs, new undo policy, iOS redesign, automatic estimate resync and broad historical artifact backfill: outside the selected scope.

Status vocabulary for this program: TODO, IN PROGRESS, IMPLEMENTED / RELEASE PENDING,
DONE, BLOCKED (reason), REJECTED (reason). Existing accounting plan records above are preserved.

Handoff review completed: corrected storage-generation retirement, durable pre-upload split intent, cancellation/finalization races, and recovery/browser-test scope. Ten plans validated for sections, step gates, index links and an acyclic dependency graph; reviewed source hashes remained unchanged.


## Arc Books full-scope completion — 2026-10-04

The user requested a detailed plan and definitive completion criteria for the
existing October 2 Books goal. This plan preserves the entire objective and the
workflow-integrated product design. It is advisory authorization to continue
implementation within the existing task, not blanket authorization for customer
transactions or production changes.

| Plan | Priority | Status | Summary |
|---|---:|---|---|
| [013 — Arc Books completion to 100%](013-arc-books-completion-to-100.md) | P0 | PLAN READY / IMPLEMENTATION IN PROGRESS | 59 implementation and repair packages across all original workstreams, individual/global DoDs, 25 golden scenarios and seven mandatory program exit gates. |

Use the [requirements/evidence checklist](013-arc-books-completion-checklist.json)
for progress and the [planning source snapshot](013-arc-books-completion-baseline.json)
for drift checks. The main task must revalidate existing work, finish the interrupted
payroll attribution history slice, establish current full-schema acceptance and
follow the dependency order. No feature or release gate was marked DONE by this
planning session. External builder/CPA evidence remains part of the finish line.


## QBO integration completion goal — 2026-10-04

The user requested an active goal to improve existing QBO performance, reliability,
maintainability and efficiency and add the missing accounting workflows.

| Plan | Priority | Status | Summary |
|---|---:|---|---|
| [014 — QBO integration completion](014-qbo-integration-completion.md) | P0 | ACTIVE / IMPLEMENTATION IN PROGRESS | 17 dependency-ordered packages with code DoDs, financial/security failure fixtures, request/query budgets and missing workflow acceptance. |

Track individual outcomes in [the checklist](014-qbo-completion-checklist.json).
[Source hashes](014-qbo-source-baseline.json) capture the existing uncommitted
workspace. Work starts in an isolated copy; shared integration requires a drift
check. Code completion and production rollout are separate. No production
migration, real financial write or deployment is authorized by this goal.

QBO goal milestone: Q03 scoped webhook change approved at isolated commit `d8b97bc`,169/169 Node and13/13 Bun plus lint/typecheck; shared integration underway. Q03 durable provider ID metadata remains open. Q07 bounded transport/maintenance implementation is in progress; handoff [014a](014a-qbo-worker-reliability.md). These milestones do not imply complete goal acceptance or production rollout.

QBO goal continuation: scoped Q07 worker code approved after parent verification (214/214 Node,55/55 Bun,lint/typecheck). Nested DB request coverage remains open in [014d](014d-qbo-worker-deadline-closure.md). Next security execution handoff is [014b](014b-qbo-authorization.md), with a real isolated SQL baseline reproducing direct credential reads and connection writes. Q03 durable receipt closure is [014c](014c-qbo-webhook-receipts.md). No production SQL/deployment occurred.

QBO integration milestone: Q07 approved scoped code is now integrated in the shared workspace and independently matched against `a2ed029`; shared Node verification passed 214/214 with no skips. Q02 database authorization is in isolated implementation. Whole-worker bounds and durable webhook provider metadata remain open; the full goal stays active.

Q04 handoff [014e](014e-qbo-cdc-completeness.md) now records executable malformed/cap-sized response regressions and the distinction between safe ingestion and complete resumable recovery. Its acceptance remains open.

Q02 code acceptance is DONE: exact seven files from `b76eb3a` integrated; parent verified shared bytes and253/253 scoped Node tests, plus final lint/typecheck and real pre/post-D2 role/RPC/replay/count tests. Reassignment count uses one request instead of six in the measured private-helper SDK fixture and includes records beyond former row ceilings. The additive SQL is unapplied to production; migration/RPC availability is a documented rollout requirement. Goal remains active.

QBO receipt milestone: exact five files from738bf7d integrated; parent264/264 shared Node and55/55 isolated QBO Bun plus lint/typecheck passed. All eight original Q03 code clauses verified, but full package/program acceptance retains a genuine two-session PostgreSQL contention fixture in Q17. Named80-event intake uses1 database request instead of80 and retains40 delivery IDs on the repeated fact. Receipt migration remains unapplied and must precede RPC-based application rollout. Goal20/125 verified; Q07 nested SQL/full cron deadline closure dispatched under [014d](014d-qbo-worker-deadline-closure.md).

Q08 execution preparation: [014f](014f-qbo-reconnect-recovery.md) preserves company-bound OAuth, stable scoped identities and actual eligible-backlog revival. Parent executed current TSX handler with hook/UI stubs: enabled expired “Reauthorize” still invokes token refresh. No Q08 source implementation is claimed.

QBO worker closure milestone: Q07 DONE at exact integrated b1a7e9a; parent302/302 isolated/shared Node,55/55 Bun,fulltypecheck/lint/diff and11 source hashes verified. Main work85seconds; required SQL completion/telemetry90seconds; SDK-local retry sleeps may finish later with zero later HTTP/session deletion. Goal23/125 verified, active. Q04 full CDC completeness and resumable recovery now in progress under [014e](014e-qbo-cdc-completeness.md). Production SQL/deployment remains unexecuted.

Q05 additional executable negative evidence: actual bill fingerprint ignores a same-total line project/account/description edit and reports no local change. This is recorded without claiming full posted-ledger reproduction; financial fidelity implementation remains outstanding.

Q04 recovery design approved with narrow Books connection-collector and authorized read-only import-candidate seams. Actual listing/cron-lifecycle negative fixtures prove capped lists cannot certify completeness and uncollected gap findings are cleared nightly. No Q04 clause is marked verified until implementation and independent checks.

Q06 full handoff prepared under [014g](014g-qbo-invoice-fidelity.md), including actual discount translation/canonical-math negative evidence, metadata/read/edit/export continuity and USD/document preflight. Execution waits for Q04/Q05; no Q06 criteria verified.

Q05 full handoff prepared under [014h](014h-qbo-bill-line-fidelity.md), with canonical line/allocation identity, posted review guards, atomic mutable-domain proposal and actual dispatched revision receipts. Parent source reads confirm importer omits identities and current coding updates are separate delete/insert/header requests. Execution follows Q04; no Q05 acceptance claimed.

Q02 existing-flow acceptance reopened: actual importer helper/role probes fail final mapping and event writes after Q02/Q03 grants. Six Q02 security/admin/rehearsal clauses remain verified; Q02-06 is pending owned completion/routing-preflight repair, approved under [014b](014b-qbo-authorization.md). Current total22/125; historical23/125 milestones above predate this finding. The one Q04 executor continues the narrow compatibility repair; no production SQL was applied.

Q09 execution handoff: [truthful status, delivery clocks and import receipts](014i-qbo-truthful-status-receipts.md). All seven original criteria retained; failed-only/partial receipt acceptance depends on the actual durable Q11 producer. This is a prepared TODO handoff, not additional completed work.

QBO recovery/import closure milestone: approved revision75e9810 integrated27exact files with all shared hashes verified. Parent365/365 isolated Node,55/55 Bun,28/28 no-Git focused and types/lint/diff0; shared365/365 Node passes. Q02-06 restored, Q04sixofseven accepted; current goal29/125 verified. Q04-06 genuine concurrent PostgreSQL checks remain Q17, and SQL/production remains unapplied. Full Q05 [014h](014h-qbo-bill-line-fidelity.md) dispatched to the same isolated executor; characterize actual line/delivery/domain behavior and obtain reviewed atomic-domain signature/lock/validation/rollout proposal before SQL.

QBO goal verification progress: original29/125 accepted clauses remain unchanged. Q05 actual characterization now reproduces line/identity and in-flight delivery failures; narrow atomic/source-fence/receipt contracts approved for isolated implementation. [014j](014j-qbo-postgresql-verification.md) records four parent real PostgreSQL contention probes and the remaining portable/facade/financial/CI obligations. No source integration or production rollout is implied by this evidence.

[014k — scoped pagination/company health](014k-qbo-scoped-pagination-health.md) is ready for the existing executor after preceding integrations. Parent actual queue action reproduced600older requested records disappearing behind600newer foreign-project records. All eleven original Q10 clauses remain unverified; exact SQL visibility contracts and full authenticated query budget must be reviewed before implementation.

[014l — durable centralized import](014l-qbo-durable-centralized-import.md) preserves all seven Q11 clauses with exact receipt/resume/authorization/UI gates. Parent actual service/owned-SQL probes reproduced busy/completed result conflation and an adopted payment missing its actual ID/project. Two negative probes pass; no criteria accepted. Q05 isolated implementation continues; goal remains active29/125.

[014m — reviewed conflict resolution](014m-qbo-reviewed-conflict-resolution.md) preserves all eight Q12 clauses, including baseline/current comparison, version-bound decisions, historical ownership, actionable posted payment corrections and closed-period protection. Parent two actual action probes expose absent displayed-version fencing and duplicate dispatch at that seam; provider/domain collaborators synthetic, not duplicate financial proof. No acceptance increase; Q05 executor continues.

Goal current acceptance28/125: Q02-06 reopened after parent actual outbound invoice-adoption action/role probe found a partial invoice marker followed by denied sync mutation. [014n — setup preflight/adoption](014n-qbo-setup-preflight-adoption.md) preserves all seven Q13 criteria and the required atomic Q02 compatibility closure. Actual strict settings/full invoice adapter probes also reproduce rejected tax keys and100 lookups for one item across100 concurrent lines. Source executor remains Q05; all prepared-package criteria remain false.

[014o — customer credit/refund parity](014o-qbo-customer-credit-refund-parity.md) preserves all eight Q14 clauses, including standalone credit/application and actual externally settled refund domain. Parent exact SQL opening-trigger probes reproduce credits/write-offs being counted as synthetic cash (2/2 negative). Q05 actual draft adapter/model21/21 passes, but exact SQL equivalent retry previously remained processing; reviewed opaque-version completion refinement is in isolated implementation. Goal active28/125, no source acceptance or production rollout from this preparation.

[014p — durable operation request IDs](014p-qbo-operation-request-ids.md) preserves all six Q15 criteria with persist-before-send/exact retry/recreate/unknown-window recovery gates. Parent actual transport/marker2/2 probes record26queries for25k history and no requestid; primary rendered docs verify replay but retention/sandbox evidence remains missing. Parent Q05 draft44/44 targeted checks pass, including atomic mutable-bill/history/source guards and expense outbound seams. No new code clauses accepted; goal active28/125.

[014q — modules and measured efficiency](014q-qbo-modules-measured-efficiency.md) preserves all13Q16clauses. [Baseline JSON](014-qbo-efficiency-baseline.json) records27actual-client/preview measured samples and a1/1same-realm10inflight negative. Preview25kreturns12.2MB in one response; observed lightweight heap is below128MiB, not a measured memory failure. Bounded pages/resume/shared realm admission/type-safe module gates await implementation. Q05 sole executor is wiring inbound and actual contention; current acceptance28/125.

Q05 parent changing-draft verification: exact comparison SQL3/3 and actual inbound force facade/full SQL4/4 pass with scoped synthetic/minimal-financial fixtures; malformed reference Active flags reproduced1/1 negative. [014h](014h-qbo-bill-line-fidelity.md) records approved guarded import/native full baseline seams and the remaining complete gates. Acceptance remains28/125; no new source integration or production rollout.
