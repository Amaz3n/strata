# Plan 006: Recover claimed jobs without duplicate ownership or cron-sized gaps
> Executor: read the entire plan, implement only its scope, run each verification gate and record evidence. Update this plan and the index status only after its done criteria hold.

- **Planned at:** `9f1549af`, 2026-10-01, including the reviewed dirty workspace.
- **Priority / effort / risk:** P1 / M-L / MED
- **Depends on:** 003
- **Status:** IMPLEMENTED / RELEASE PENDING — integrated; see [verification and rollout record](drawings-implementation-2026-10-01.md).
- **Confidence:** HIGH for current-code findings; proposed performance gains require measurement.

## Why this matters

runDrawingsPipeline claims twice its page concurrency and may reach its deadline with waitingIds unstarted. finally only clears the heartbeat. The route exits when no pending rows exist, before stale recovery runs. General outbox and dedicated drawing workers share job infrastructure, so recovery must fence old owners rather than merely change statuses.

## Current state and drift check

Run `git diff --stat 9f1549af..HEAD -- lib/services/drawings-pipeline.ts lib/services/drawings-pipeline-trigger.ts app/api/jobs/drawings-pipeline/route.ts app/api/jobs/process-outbox/route.ts lib/services/job-runs.ts vercel.json 'supabase/migrations/*_drawing_job_leases.sql' supabase/tests/drawing_job_leases.test.sql tests/drawing-job-leases.test.js 'tests/fixtures/drawing-lifecycle/**'` and compare the working-tree hashes in `advisor-plans/drawings-source-snapshot.json`. Expected prerequisite edits are not failures: inspect them, preserve their contracts, and refresh these excerpts before executing. Unrelated mismatches require review.

`lib/services/drawings-pipeline.ts:543`

```
      for (const job of heavy) {
        const ok = await runJob(job)
        if (ok) summary.processed += 1
        else summary.failed += 1
        if (Date.now() >= deadline) break
      }

      for (let i = 0; i < light.length && Date.now() < deadline; i += PAGE_JOB_CONCURRENCY) {
        const results = await Promise.all(
          light.slice(i, i + PAGE_JOB_CONCURRENCY).map((job) => runJob(job)),
        )
        for (const ok of results) {
          if (ok) summary.processed += 1
          else summary.failed += 1
        }
      }
    } finally {
      clearInterval(batchHeartbeat)
    }
```

`app/api/jobs/drawings-pipeline/route.ts:20`

```
  const pending = await hasPendingDrawingJobs()
  if (!pending) {
    return NextResponse.json({ ok: true, message: "No pending drawing jobs" })
  }

  // Respond immediately; drain the queue after the response so callers
  // (upload actions, sibling invocations) never block on processing.
  after(async () => {
    try {
      const summary = await runDrawingsPipeline({ deadlineMs: Date.now() + 770_000 })
```

## Repository conventions and boundaries

Work in `/Users/agustinzenuto/Desktop/Projects/arc` (or its faithfully copied review checkout). Next.js 16 / React 19 / TypeScript, pnpm, Supabase Postgres and R2. Follow `lib/action-result.ts`: `type ActionResult<T> = { success: true; data: T } | { success: false; error: string; code?: string }`; server actions return results, services own logic. Validate inputs and enforce org plus project permission at every externally callable boundary. Keep SQL org-scoped, RLS enabled, and internal worker RPC grants service-only where appropriate. Do not silently escalate to SECURITY DEFINER.

The workspace already has extensive uncommitted/untracked work. Record `git status --short` and `git diff -- <scope>` before editing; never reset or overwrite it. SHA alone is insufficient: the supplied `drawings-source-snapshot.json` hashes the reviewed working-tree files, including untracked files. Re-read changed files and update the plan after prerequisite changes; stop on unrelated drift. New migration names below are allowed suffixes, not existing files: use the repository's migration creation workflow. No historical migration edits.

Local app configuration points at production. Do not run mutation tests against it, apply production migrations, start another dev server, or run a local production build. Database contracts run against an explicitly disposable local/CI database. Author additive migrations and report their deployment status separately. Preserve unrelated financials, iOS UX, portal sharing policy, source PDF ownership and existing sheet history. No dependency/platform replacement or production rollout is authorized by this plan artifact.

Use branch `codex/drawings-<plan-slug>` if an executor needs a branch; preserve the working tree and do not push, merge or open a PR without task authorization. Existing commit style is plain imperative (for example `Fix request-bound pages blocking instant navigation`); do not commit merely to finish this plan.

## Scope

Modify only these paths (new files and narrowly named migration patterns are intentional):

- `lib/services/drawings-pipeline.ts`
- `lib/services/drawings-pipeline-trigger.ts`
- `app/api/jobs/drawings-pipeline/route.ts`
- `app/api/jobs/process-outbox/route.ts`
- `lib/services/job-runs.ts`
- `vercel.json`
- `supabase/migrations/*_drawing_job_leases.sql`
- `supabase/tests/drawing_job_leases.test.sql`
- `tests/drawing-job-leases.test.js`
- `tests/fixtures/drawing-lifecycle/**`

The plan itself and its index status may be updated. Everything else is out of scope unless the reviewed scope is explicitly revised.

## Commands

Run from the repository root. Commands that refer to new tests/scripts become runnable after their creation; they were not claimed to exist during this audit.

| Gate | Command | Required result |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0, or record and isolate a pre-existing unrelated failure; new errors block completion |
| Lint | `pnpm lint` | exit 0; no new violations |
| Drawing regression | `pnpm test:drawings` | all pass |
| Focused audit baseline | `node --test tests/drawing-metadata-pipeline.test.js tests/drawing-pdf-source.test.js tests/drawing-revision-publish-db.test.js` | passing cases; optional skipped DB case is not transactional evidence |
| SQL contract | `supabase test db supabase/tests/drawing_job_leases.test.sql --local` | all assertions pass on explicitly disposable local DB; otherwise require CI evidence |

The existing database-contracts CI job uses `supabase db start` then `supabase test db --local`. Do not use production environment credentials to make these tests run. Use `pnpm verify` only in the existing CI context: it includes a build.

## Steps

### 1. Establish lease ownership across drawing consumers

Inspect claim_jobs and reap_stale_outbox_jobs migrations and every drawing dispatch path in the general outbox. Introduce additive claim token/generation and expiry for drawing jobs; either a drawing-specific claim RPC or a compatible extension must preserve non-drawing consumers. Every drawing heartbeat, finish, retry and release requires the owned token. Check affected rows/errors. Treat an expired owner as unable to commit final metadata; storage writes use immutable attempt paths.

**Verify:** `node --test tests/drawing-job-leases.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 2. Release unstarted work on every exit

Track started versus waiting jobs. In finally, release only unstarted jobs still owned by this invocation to pending, then clear heartbeats. Claim no more than the capacity/time budget supports. Reserve a shutdown margin; ensure heavy jobs do not start if the invocation cannot supervise them. A hard crash relies on lease expiry, not finally.

**Verify:** `node --test tests/drawing-job-leases.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 3. Recover before checking runnable work

Run lease recovery before the dedicated route pending check. Preserve the upload-operation reconciliation preflight from plan 005 if present; when 005 lands later, it must run alongside lease recovery rather than behind the early return. Include future retry time in runner output and arrange a bounded wakeup through supported deployment scheduling. Default to a one-minute dedicated recovery cron if the existing platform supports it; maintain job registry and authorization. No sleeping serverless invocation until run_at, no recursive unbounded fanout. Target recoverability on the first sweep after expiry, not the next unrelated upload.

**Verify:** `node --test tests/drawing-job-leases.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 4. Verify competing workers and terminal revisions

Add real SQL ownership tests and deterministic concurrent-runner tests. Deleted/cancelled revisions are terminal: late workers cannot recreate sheets or publish metadata. Test the general outbox path as well as the dedicated runner; preserve retries and dead-letter visibility.

**Verify:** `node --test tests/drawing-job-leases.test.js tests/drawing-metadata-pipeline.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

## Test plan

Cover deadline with six claimed and three unstarted jobs, only-processing queue, crash without finally, lease stolen after expiry, late heartbeat/completion, failed heartbeat, general/dedicated races, and future run_at. Use fake clocks to avoid multi-minute tests.

## Done criteria

- [ ] Zero owned-unstarted rows remain processing after graceful exit.
- [ ] Processing-only stale queues recover without a new upload.
- [ ] An old claim cannot complete, retry or heartbeat a newly claimed job.
- [ ] No more than configured page concurrency runs in one invocation.
- [ ] All applicable commands pass; database/browser gates have recorded evidence, not silent skips.
- [ ] Typecheck/lint introduce no regressions; failures predating the change are separately recorded.
- [ ] Review the diff against the recorded starting workspace; only scoped changes belong to this plan.
- [ ] Record schema/application rollout order, rollback behavior and remaining deployment gates in this plan; update advisor-plans/README.md.

## STOP conditions

If updating shared claim semantics would alter accounting/email job behavior, use an additive drawing-specific path; stop before changing unrelated worker contracts. Also stop for unexplained source drift, two failed attempts at the same gate, required changes outside scope, or an unverified backend target. Report the specific blocker and retain safe progress.

## Maintenance and rollout

A lease is a fencing mechanism, not an exactly-once guarantee. Handlers still need idempotent writes. Verify scheduling limits from current official platform docs before changing cron cadence. Roll out additive schema before consumers; retain old readers/handlers during transition. Rollback must leave durable operations and immutable artifacts recoverable. Tests passing locally do not mean pending migrations were deployed.

## Execution evidence (isolated worktree, 2026-10-01)

- Scope extension approved by orchestrator: `lib/supabase/server.ts` adds a separate job-scoped client so headers cannot leak into the service singleton.
- Additive drawing-specific claim/transition/recovery RPCs and transaction-level worker write fences authored in `20261001121920_drawing_job_leases.sql`. General outbox dispatch already calls the same pipeline and does not independently claim drawing types.
- Three implementation tests pass, including actual migration execution in disposable in-memory PGlite, stale heartbeat/complete/retry/release, metadata fencing, deleted revisions, and deadline release. Run with `ARC_TEST_PGLITE_MODULE=/tmp/arc-drawings-test-tools/node_modules/@electric-sql/pglite node --test tests/drawing-job-leases.test.js`.
- Existing focused drawing regression: 18 passing, zero skips. Supabase full-schema CI remains a distinct pending gate (no Docker daemon).
- Full typecheck attempted with the default heap exhausted Node's 4GB heap; centralized orchestrator verification should use the repository's configured typecheck memory limit.
- One-minute cron matches current Pro/Enterprise support: https://vercel.com/docs/cron-jobs/usage-and-pricing (checked 2026-10-01). Existing five-minute cron already requires that deployment tier; confirm deployment account before rollout.
- Rollout: apply additive migration, drain all older drawing consumers, then deploy fenced consumers together. Retain columns/functions on rollback; reverting consumers reintroduces legacy unfenced writes and is not a safe concurrent rollback. No schema was applied to production.
- Pending integration: immutable physical storage attempt paths/cleanup ledger belong to 007/011/012; current metadata fencing does not stop an already-issued external object PUT. Terminal cancellation state must be connected to the lifecycle schema once present.


## Implementation evidence — 2026-10-01

Implemented token-owned claim, heartbeat, release, completion and retry transitions; stale recovery runs before the no-work exit. Exhausted explicit retries and expired leases atomically mark critical revision failure or resolve pending verification. Worker metadata/fanout writes are fenced, late AI cannot override reviewed/published identity, query errors propagate, and explicit manual retries preserve targeted-sheet intent and emitted page receipts while invalidating old claims. Queue waiting, split, render, verification, first-viewable and review-ready measurements now report separate boundaries.

Validation: mandatory PGlite SQL tests exercise stale ownership, deleted revision writes, explicit/expired terminal failures, target preservation, incomplete-page retry and complete-page retention. Handler tests exercise unstarted claim release, failed queue reads, and telemetry. No production database was contacted.

Additive migration order: job leases and artifact base tables, storage deletion/publication prerequisites, then `20261001162622_drawing_artifact_guards.sql`, `20261001162632_drawing_split_manifest.sql`, and `20261001164202_drawing_split_registration.sql`. These files were authored and tested only; none was deployed. Drain legacy workers before enabling consumers. Keep durable intents/artifacts and their cleanup tombstones during rollback. Production storage behavior, true concurrent Postgres sessions, dense/scanned source memory and browser acceptance remain release gates; synthetic/PGlite evidence does not substitute for them.
