# Plan 012: Split PDFs once per attempt and stream durable page work
> Executor: read the entire plan, implement only its scope, run each verification gate and record evidence. Update this plan and the index status only after its done criteria hold.

- **Planned at:** `9f1549af`, 2026-10-01, including the reviewed dirty workspace.
- **Priority / effort / risk:** P2 / L / MED
- **Depends on:** 003, 005, 006, 007, 011
- **Status:** IMPLEMENTED / RELEASE PENDING — integrated; see [verification and rollout record](drawings-implementation-2026-10-01.md).
- **Confidence:** HIGH for current-code findings; proposed performance gains require measurement.

## Why this matters

The coordinator downloads/opens the source, then every 24-page chunk does so again: a 300-page package requires fourteen full source downloads before retries. Each chunk also performs serial database and early-thumbnail work, and queues pages only after the entire chunk completes. Reduce repeated source transfer and round trips while retaining restartability, bounded memory and immutable artifact safety.

## Current state and drift check

Run `git diff --stat 9f1549af..HEAD -- lib/services/drawings-pipeline.ts lib/services/drawing-split-session.ts lib/storage/drawing-pdf-source.ts lib/storage/drawings-pdfs-storage.ts app/api/jobs/drawings-pipeline/route.ts 'supabase/migrations/*_drawing_split_manifest.sql' supabase/tests/drawing_split_manifest.test.sql tests/drawing-split-session.test.js tests/drawing-metadata-pipeline.test.js 'tests/fixtures/drawing-lifecycle/**' scripts/benchmark-drawing-lifecycle.mjs` and compare the working-tree hashes in `advisor-plans/drawings-source-snapshot.json`. Expected prerequisite edits are not failures: inspect them, preserve their contracts, and refresh these excerpts before executing. Unrelated mismatches require review.

`lib/services/drawings-pipeline.ts:960`

```
  const pdfBytes = await downloadDrawingPdfObject({
    supabase,
    orgId,
    path: fileRecord.storage_path,
  })
  const mupdf = await loadMupdf()
  const doc = mupdf.Document.openDocument(pdfBytes, "application/pdf")
```

`lib/services/drawings-pipeline.ts:1171`

```
  }

  await Promise.all(uploads)

  const { error: fanoutError } = await supabase.from("outbox").insert(pageJobs)
  if (fanoutError) {
```

## Repository conventions and boundaries

Work in `/Users/agustinzenuto/Desktop/Projects/arc` (or its faithfully copied review checkout). Next.js 16 / React 19 / TypeScript, pnpm, Supabase Postgres and R2. Follow `lib/action-result.ts`: `type ActionResult<T> = { success: true; data: T } | { success: false; error: string; code?: string }`; server actions return results, services own logic. Validate inputs and enforce org plus project permission at every externally callable boundary. Keep SQL org-scoped, RLS enabled, and internal worker RPC grants service-only where appropriate. Do not silently escalate to SECURITY DEFINER.

The workspace already has extensive uncommitted/untracked work. Record `git status --short` and `git diff -- <scope>` before editing; never reset or overwrite it. SHA alone is insufficient: the supplied `drawings-source-snapshot.json` hashes the reviewed working-tree files, including untracked files. Re-read changed files and update the plan after prerequisite changes; stop on unrelated drift. New migration names below are allowed suffixes, not existing files: use the repository's migration creation workflow. No historical migration edits.

Local app configuration points at production. Do not run mutation tests against it, apply production migrations, start another dev server, or run a local production build. Database contracts run against an explicitly disposable local/CI database. Author additive migrations and report their deployment status separately. Preserve unrelated financials, iOS UX, portal sharing policy, source PDF ownership and existing sheet history. No dependency/platform replacement or production rollout is authorized by this plan artifact.

Use branch `codex/drawings-<plan-slug>` if an executor needs a branch; preserve the working tree and do not push, merge or open a PR without task authorization. Existing commit style is plain imperative (for example `Fix request-bound pages blocking instant navigation`); do not commit merely to finish this plan.

## Scope

Modify only these paths (new files and narrowly named migration patterns are intentional):

- `lib/services/drawings-pipeline.ts`
- `lib/services/drawing-split-session.ts`
- `lib/storage/drawing-pdf-source.ts`
- `lib/storage/drawings-pdfs-storage.ts`
- `app/api/jobs/drawings-pipeline/route.ts`
- `supabase/migrations/*_drawing_split_manifest.sql`
- `supabase/tests/drawing_split_manifest.test.sql`
- `tests/drawing-split-session.test.js`
- `tests/drawing-metadata-pipeline.test.js`
- `tests/fixtures/drawing-lifecycle/**`
- `scripts/benchmark-drawing-lifecycle.mjs`

The plan itself and its index status may be updated. Everything else is out of scope unless the reviewed scope is explicitly revised.

## Commands

Run from the repository root. Commands that refer to new tests/scripts become runnable after their creation; they were not claimed to exist during this audit.

| Gate | Command | Required result |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0, or record and isolate a pre-existing unrelated failure; new errors block completion |
| Lint | `pnpm lint` | exit 0; no new violations |
| Drawing regression | `pnpm test:drawings` | all pass |
| Focused audit baseline | `node --test tests/drawing-metadata-pipeline.test.js tests/drawing-pdf-source.test.js tests/drawing-revision-publish-db.test.js` | passing cases; optional skipped DB case is not transactional evidence |
| SQL contract | `supabase test db supabase/tests/drawing_split_manifest.test.sql --local` | all assertions pass on explicitly disposable local DB; otherwise require CI evidence |

The existing database-contracts CI job uses `supabase db start` then `supabase test db --local`. Do not use production environment credentials to make these tests run. Use `pnpm verify` only in the existing CI context: it includes a build.

## Steps

### 1. Benchmark bounded source-session strategies

Use the baseline corpus to compare one owned source session emitting pages incrementally against the current chunk fanout. Load/download once per attempt, release native page objects promptly, cap in-flight serialized bytes and uploads, and measure peak RSS and time to first page. Use existing runtime initially; no new external worker service or infrastructure purchase is assumed. If source size exceeds the proven memory budget, retain the bounded fallback and record that case.

**Verify:** `node scripts/benchmark-drawing-lifecycle.mjs --synthetic --assert --output /tmp/arc-drawing-splitting-before.json` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 2. Persist a restartable split manifest

Create a per-revision/source-generation manifest with page index, deterministic attempt/artifact path, storage-complete state, registration state and fanout receipt. Before any object PUT, durably reserve the split attempt ID, revision/source generation, exact immutable physical path, artifact lifecycle guard and active-work reference. This intent remains queryable even if the revision is deleted. Then upload the page artifact; once storage is durable, atomically mark storage complete and register the version plus deduplicated job. The cleanup worker uses the pre-upload intent to reconcile an orphan after a crash. After a crash between storage and DB, reconcile the expected immutable object before retrying. Never mark a page emitted without both durable storage or valid donor and durable job. Honor revision cancellation and lease generation at each checkpoint.

**Verify:** `node --test tests/drawing-split-session.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 3. Batch registration and pipeline work incrementally

Fetch existing sheet identities/version/calibration in bounded batches, implement bulk registration preserving sheet-number collision and targeted-sheet rules, and flush ready jobs in small bounded page batches instead of at end of source. Optional thumbnail work uses a bounded pool and cannot block rendering fanout. Choose batch size from measured first-page latency and database call counts; start at eight pages. Preserve exact current matching behavior with golden fixtures.

**Verify:** `node --test tests/drawing-split-session.test.js tests/drawing-metadata-pipeline.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 4. Cut over with recovery and resource gates

Use the source-session path only within proven runtime/memory limits, with durable checkpoint continuation across attempts. A deadline exit must not discard emitted pages or leave claimed jobs stranded. Compare 24/25-page boundary and 300-page set under cold and warm conditions; record cost as well as elapsed time. Retain legacy queued-job handlers until old jobs drain.

**Verify:** `node scripts/benchmark-drawing-lifecycle.mjs --synthetic --assert --output /tmp/arc-drawing-splitting-after.json` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

## Test plan

Test crash before upload, after pre-upload intent/before PUT, after upload/before completion checkpoint with the revision subsequently deleted, after registration/before response, duplicate continuation, deleted revision, full storage, corrupt/encrypted PDF, one-page target with multipage source, duplicate detected numbers, slow thumbnail, native object cleanup and warm artifact hits. SQL verifies bulk identity and unique page-job fanout.

## Done criteria

- [ ] A cold supported 300-page source needs one full source fetch/open per uninterrupted attempt rather than fourteen.
- [ ] First durable page batch is queued before the last source page is split.
- [ ] Retry does not recreate committed versions or duplicate their jobs.
- [ ] Peak RSS stays below the documented deployment budget with headroom; no unbounded Promise.all over pages or tiles.
- [ ] Resource counts and p95 timings are saved alongside fixture/hardware/runtime details.
- [ ] All applicable commands pass; database/browser gates have recorded evidence, not silent skips.
- [ ] Typecheck/lint introduce no regressions; failures predating the change are separately recorded.
- [ ] Review the diff against the recorded starting workspace; only scoped changes belong to this plan.
- [ ] Record schema/application rollout order, rollback behavior and remaining deployment gates in this plan; update advisor-plans/README.md.

## STOP conditions

If a single source session cannot stay inside the verified deployment budget, keep the working chunk fallback and document a separate worker-runtime decision with measurements; do not raise concurrency blindly or provision infrastructure silently. Also stop for unexplained source drift, two failed attempts at the same gate, required changes outside scope, or an unverified backend target. Report the specific blocker and retain safe progress.

## Maintenance and rollout

One fetch per attempt is not one fetch forever: retries and deadline continuations may refetch. Reuse immutable outputs and record actual retries so performance claims remain honest. Roll out additive schema before consumers; retain old readers/handlers during transition. Rollback must leave durable operations and immutable artifacts recoverable. Tests passing locally do not mean pending migrations were deployed.


## Implementation evidence — 2026-10-01

Implemented source sessions for up to 300 pages / 64 MiB compressed source, with the existing chunk handler retained for larger sources and legacy jobs. Each uninterrupted supported attempt downloads/opens the source once. Pages register in transactions of at most eight, with at most 32 MiB accumulated serialized page bytes (an individual larger page is flushed alone). Registration preserves targeted sheets, duplicate-number suffixes and calibration carry-forward. Pre-PUT intents survive deletion; each durable page emits its own idempotent job before subsequent batches. Deadline exits release the source job without consuming a retry; resumed sessions skip emitted and deleted pages. Unsupported presentation features use original-source render fallback.

Validation: real PDF handler tests cover 24/25/300 pages, first-page emission, interrupted PUTs, repeated coordinators, deleted-page tombstones and effective renderer recipe changes. PGlite tests cover atomic batch registration, identity collisions, calibration, duplicate receipts, source mismatch, manual retry and deletion-aware readiness. The synthetic 300-page benchmark records one source fetch/open and 38 batch-registration calls. See drawings-pipeline-benchmark.json for timings, hardware and memory; storage and database are in-memory and these are not production latency estimates.

Additive migration order: job leases and artifact base tables, storage deletion/publication prerequisites, then `20261001162622_drawing_artifact_guards.sql`, `20261001162632_drawing_split_manifest.sql`, and `20261001164202_drawing_split_registration.sql`. These files were authored and tested only; none was deployed. Drain legacy workers before enabling consumers. Keep durable intents/artifacts and their cleanup tombstones during rollback. Production storage behavior, true concurrent Postgres sessions, dense/scanned source memory and browser acceptance remain release gates; synthetic/PGlite evidence does not substitute for them.
