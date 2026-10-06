# Plan 003: Establish lifecycle tests and a performance baseline
> Executor: read the entire plan, implement only its scope, run each verification gate and record evidence. Update this plan and the index status only after its done criteria hold.

- **Planned at:** `9f1549af`, 2026-10-01, including the reviewed dirty workspace.
- **Priority / effort / risk:** P1 / M / LOW
- **Depends on:** none
- **Status:** IMPLEMENTED / RELEASE PENDING — integrated; see [verification and rollout record](drawings-implementation-2026-10-01.md).
- **Confidence:** HIGH for current-code findings; proposed performance gains require measurement.

## Why this matters

The drawings lifecycle crosses browser transfer, object storage, database transactions, background jobs and publication. Existing metadata tests exercise real handlers with mocked services, but do not prove recovery across those boundaries. Establish a deterministic fixture harness and separate latency measurements before changing behavior. The October 1 review ran 12 passing focused tests; the optional PGlite publication test skipped. A skipped database test is not evidence of transactional correctness.

## Current state and drift check

Run `git diff --stat 9f1549af..HEAD -- tests/drawing-lifecycle.test.js 'tests/fixtures/drawing-lifecycle/**' scripts/benchmark-drawing-lifecycle.mjs scripts/test-drawing-lifecycle-ui.mjs tests/drawing-revision-publish-db.test.js supabase/tests/drawing_lifecycle.test.sql lib/drawings/lifecycle-metrics.ts lib/services/drawings-client.ts lib/services/drawings-pipeline.ts lib/services/drawings.ts 'app/(app)/drawings/actions.ts' package.json .github/workflows/verify.yml` and compare the working-tree hashes in `advisor-plans/drawings-source-snapshot.json`. Expected prerequisite edits are not failures: inspect them, preserve their contracts, and refresh these excerpts before executing. Unrelated mismatches require review.

`tests/drawing-revision-publish-db.test.js:5`

```
let PGlite
try { ({ PGlite } = require(process.env.ARC_TEST_PGLITE_MODULE || '@electric-sql/pglite')) } catch {}
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260929113927_drawing_revision_sheet_number_conflicts.sql'), 'utf8')
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`

test('drawing publish preserves pages when detected sheet numbers collide', { skip: !PGlite }, async t => {
```

`lib/services/drawings-pipeline.ts:650`

```
    await supabase
      .from("outbox")
      .update({ status: "completed", last_error: null })
      .eq("id", job.job_id)

    console.log(
      `[drawings-pipeline] ${job.job_type} #${job.job_id} completed in ${Date.now() - startedAt}ms`,
    )
    return true
```

## Repository conventions and boundaries

Work in `/Users/agustinzenuto/Desktop/Projects/arc` (or its faithfully copied review checkout). Next.js 16 / React 19 / TypeScript, pnpm, Supabase Postgres and R2. Follow `lib/action-result.ts`: `type ActionResult<T> = { success: true; data: T } | { success: false; error: string; code?: string }`; server actions return results, services own logic. Validate inputs and enforce org plus project permission at every externally callable boundary. Keep SQL org-scoped, RLS enabled, and internal worker RPC grants service-only where appropriate. Do not silently escalate to SECURITY DEFINER.

The workspace already has extensive uncommitted/untracked work. Record `git status --short` and `git diff -- <scope>` before editing; never reset or overwrite it. SHA alone is insufficient: the supplied `drawings-source-snapshot.json` hashes the reviewed working-tree files, including untracked files. Re-read changed files and update the plan after prerequisite changes; stop on unrelated drift. New migration names below are allowed suffixes, not existing files: use the repository's migration creation workflow. No historical migration edits.

Local app configuration points at production. Do not run mutation tests against it, apply production migrations, start another dev server, or run a local production build. Database contracts run against an explicitly disposable local/CI database. Author additive migrations and report their deployment status separately. Preserve unrelated financials, iOS UX, portal sharing policy, source PDF ownership and existing sheet history. No dependency/platform replacement or production rollout is authorized by this plan artifact.

Use branch `codex/drawings-<plan-slug>` if an executor needs a branch; preserve the working tree and do not push, merge or open a PR without task authorization. Existing commit style is plain imperative (for example `Fix request-bound pages blocking instant navigation`); do not commit merely to finish this plan.

## Scope

Modify only these paths (new files and narrowly named migration patterns are intentional):

- `tests/drawing-lifecycle.test.js`
- `tests/fixtures/drawing-lifecycle/**`
- `scripts/benchmark-drawing-lifecycle.mjs`
- `scripts/test-drawing-lifecycle-ui.mjs`
- `tests/drawing-revision-publish-db.test.js`
- `supabase/tests/drawing_lifecycle.test.sql`
- `lib/drawings/lifecycle-metrics.ts`
- `lib/services/drawings-client.ts`
- `lib/services/drawings-pipeline.ts`
- `lib/services/drawings.ts`
- `app/(app)/drawings/actions.ts`
- `package.json`
- `.github/workflows/verify.yml`

The plan itself and its index status may be updated. Everything else is out of scope unless the reviewed scope is explicitly revised.

## Commands

Run from the repository root. Commands that refer to new tests/scripts become runnable after their creation; they were not claimed to exist during this audit.

| Gate | Command | Required result |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0, or record and isolate a pre-existing unrelated failure; new errors block completion |
| Lint | `pnpm lint` | exit 0; no new violations |
| Drawing regression | `pnpm test:drawings` | all pass |
| Focused audit baseline | `node --test tests/drawing-metadata-pipeline.test.js tests/drawing-pdf-source.test.js tests/drawing-revision-publish-db.test.js` | passing cases; optional skipped DB case is not transactional evidence |
| SQL contract | `supabase test db supabase/tests/drawing_lifecycle.test.sql --local` | all assertions pass on explicitly disposable local DB; otherwise require CI evidence |

The existing database-contracts CI job uses `supabase db start` then `supabase test db --local`. Do not use production environment credentials to make these tests run. Use `pnpm verify` only in the existing CI context: it includes a build.

## Steps

### 1. Build a deterministic failure harness

Create tests/fixtures/drawing-lifecycle with fake clock, abortable transfer, storage fault injection and database adapters. Exercise real lifecycle functions, following the compiled-handler pattern in tests/drawing-metadata-pipeline.test.js. Block every outbound request by default; never import application credentials. Include failed signing, lost completion response, committed-but-response-lost registration, crash after claim, discard during rendering, and publish after queue failure. Characterize current behavior explicitly; later plans replace those expectations with corrected contracts.

**Verify:** `node --test tests/drawing-lifecycle.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 2. Make database evidence mandatory

Add supabase/tests/drawing_lifecycle.test.sql to the existing disposable database-contracts CI suite. Assert current draft uniqueness, publication rollback, tenant separation and current-version selection against real migrated tables. Keep the optional PGlite developer test, but do not treat it as the required gate. Add a CI check that the drawing SQL file actually ran; no silent skip.

**Verify:** `node --test tests/drawing-lifecycle.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 3. Record operation stages and resource counts

Add typed lifecycle measurements with operation/revision/job identifiers, duration, outcome, attempts, bytes transferred, source downloads, pages rendered/reused, storage deletions, and database call counts. Record transfer, registration, queue wait, first viewable page, review readiness, verification, publish and deletion acknowledgement separately. Do not log file contents, names, signed URLs, credentials or raw metadata. Instrument at stage boundaries, not each tile; telemetry failure must never fail the operation.

**Verify:** `node --test tests/drawing-lifecycle.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 4. Create repeatable benchmark and UI fixtures

Create the two named scripts. Generate synthetic 1-, 24-, 25- and 300-page PDFs plus a one-page revision and reordered variant; do not depend on customer PDFs in tmp/. Benchmark script accepts --synthetic --assert --output and reports medians/p95 plus counts, configuration and sample size. UI harness follows scripts/test-drawing-workspace.mjs: real components with fake actions/storage and network blocked. Initial assertions verify report completeness and invariants, not an invented speedup.

**Verify:** `node scripts/benchmark-drawing-lifecycle.mjs --synthetic --assert --output /tmp/arc-drawing-baseline.json` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

## Test plan

Cover telemetry redaction, injected clocks, duplicate delivery, missing fixture dependencies, and rejection of non-fixture URLs. Test fixtures must fail closed if a production backend would be contacted. Add a browser run: bun scripts/test-drawing-lifecycle-ui.mjs; exit 0 with transfer/review/delete states exercised.

## Done criteria

- [ ] Benchmark JSON contains all stages and resource counts for all four sizes.
- [ ] Database-contracts CI executes drawing_lifecycle.test.sql with zero failures and no skipped drawing cases.
- [ ] Fixture harness makes zero real backend requests.
- [ ] All applicable commands pass; database/browser gates have recorded evidence, not silent skips.
- [ ] Typecheck/lint introduce no regressions; failures predating the change are separately recorded.
- [ ] Review the diff against the recorded starting workspace; only scoped changes belong to this plan.
- [ ] Record schema/application rollout order, rollback behavior and remaining deployment gates in this plan; update advisor-plans/README.md.

## STOP conditions

If the fixture server or database target cannot be proven disposable, do not run mutation tests. Report missing tooling rather than using .env.local. Also stop for unexplained source drift, two failed attempts at the same gate, required changes outside scope, or an unverified backend target. Report the specific blocker and retain safe progress.

## Maintenance and rollout

Keep raw latency evidence separate from proposed service-level targets. Later plans must extend this same harness, not create unrelated benchmark conventions. Roll out additive schema before consumers; retain old readers/handlers during transition. Rollback must leave durable operations and immutable artifacts recoverable. Tests passing locally do not mean pending migrations were deployed.

## Implementation evidence — 2026-10-01

Added mandatory PGlite-backed transaction fixtures, fail-closed handler doubles, lifecycle metrics, real browser fixtures, named `test:drawings-ui` and `benchmark:drawings` commands. CI verifies the drawing pgTap file is nonempty and actually runs six assertions. Full disposable Supabase verification remains pending because Docker was unavailable; fixture timings are not production measurements.

Schema rollout remains pending: apply additive migrations in filename order on a disposable fully migrated database, validate old/new worker compatibility, then obtain the required migration approval before release. Do not roll back by dropping operation receipts or artifact tombstones. Parent review and final integration checks remain separate gates.
