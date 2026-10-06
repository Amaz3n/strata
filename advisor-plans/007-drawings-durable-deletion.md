# Plan 007: Delete drawings transactionally and clean storage asynchronously
> Executor: read the entire plan, implement only its scope, run each verification gate and record evidence. Update this plan and the index status only after its done criteria hold.

- **Planned at:** `9f1549af`, 2026-10-01, including the reviewed dirty workspace.
- **Priority / effort / risk:** P1 / L / HIGH
- **Depends on:** 003, 005, 006
- **Status:** IMPLEMENTED / RELEASE PENDING — integrated; see [verification and rollout record](drawings-implementation-2026-10-01.md).
- **Confidence:** HIGH for current-code findings; proposed performance gains require measurement.

## Why this matters

Set and sheet deletion wait for derived-storage cleanup. Draft discard uses many unchecked database calls; trade deletion sends a separate action per sheet. Cleanup lists only 1,000 objects, ignores per-object deletion results, and treats failed reference lookups like no references. A fast acknowledgement must mean the database change and durable cleanup intent committed, while cleanup can safely resume independently.

## Current state and drift check

Run `git diff --stat 9f1549af..HEAD -- lib/services/drawings.ts lib/services/drawing-storage-cleanup.ts lib/services/drawing-upload-operations.ts lib/storage/drawings-pdfs-storage.ts lib/services/drawings-pipeline.ts lib/storage/drawings-tiles-storage.ts 'app/(app)/drawings/actions.ts' components/drawings/drawings-sets-view.tsx components/drawings/revision-review-dialog.tsx 'supabase/migrations/*_drawing_deletion_operations.sql' supabase/tests/drawing_deletion.test.sql tests/drawing-deletion.test.js scripts/test-drawing-lifecycle-ui.mjs 'tests/fixtures/drawing-lifecycle/**'` and compare the working-tree hashes in `advisor-plans/drawings-source-snapshot.json`. Expected prerequisite edits are not failures: inspect them, preserve their contracts, and refresh these excerpts before executing. Unrelated mismatches require review.

`lib/services/drawings.ts:104`

```
      await deleteTilesObjects({ supabase, paths: directPaths })
    }

    for (const prefix of candidatePrefixes) {
      const { data: stillReferenced } = await supabase
        .from("drawing_sheet_versions")
        .select("id")
        .eq("tiles_base_path", prefix)
        .limit(10)
      const survivors = (stillReferenced ?? []).filter((row) => !deletedIds.has(row.id as string))
      if (survivors.length > 0) continue

      const objects = await listTilesObjects({ supabase, prefix: `${prefix}/`, limit: 1000 })
      if (objects.length > 0) {
        await deleteTilesObjects({ supabase, paths: objects.map((object) => object.name) })
      }
    }
  } catch (error) {
    console.error("[drawings] Failed to clean up version storage:", error)
  }
}
```

`components/drawings/drawings-sets-view.tsx:1121`

```

  const handleDeleteDisciplineGroup = async () => {
    if (!disciplineGroupToDelete) return
    setIsDeleting(true)
    try {
      await Promise.all(
        disciplineGroupToDelete.sheets.map((sheet) =>
          deleteDrawingSheetAction(sheet.id).then(unwrapAction),
        ),
      )
      setSheetsBySet((curr) => {
```

## Repository conventions and boundaries

Work in `/Users/agustinzenuto/Desktop/Projects/arc` (or its faithfully copied review checkout). Next.js 16 / React 19 / TypeScript, pnpm, Supabase Postgres and R2. Follow `lib/action-result.ts`: `type ActionResult<T> = { success: true; data: T } | { success: false; error: string; code?: string }`; server actions return results, services own logic. Validate inputs and enforce org plus project permission at every externally callable boundary. Keep SQL org-scoped, RLS enabled, and internal worker RPC grants service-only where appropriate. Do not silently escalate to SECURITY DEFINER.

The workspace already has extensive uncommitted/untracked work. Record `git status --short` and `git diff -- <scope>` before editing; never reset or overwrite it. SHA alone is insufficient: the supplied `drawings-source-snapshot.json` hashes the reviewed working-tree files, including untracked files. Re-read changed files and update the plan after prerequisite changes; stop on unrelated drift. New migration names below are allowed suffixes, not existing files: use the repository's migration creation workflow. No historical migration edits.

Local app configuration points at production. Do not run mutation tests against it, apply production migrations, start another dev server, or run a local production build. Database contracts run against an explicitly disposable local/CI database. Author additive migrations and report their deployment status separately. Preserve unrelated financials, iOS UX, portal sharing policy, source PDF ownership and existing sheet history. No dependency/platform replacement or production rollout is authorized by this plan artifact.

Use branch `codex/drawings-<plan-slug>` if an executor needs a branch; preserve the working tree and do not push, merge or open a PR without task authorization. Existing commit style is plain imperative (for example `Fix request-bound pages blocking instant navigation`); do not commit merely to finish this plan.

## Scope

Modify only these paths (new files and narrowly named migration patterns are intentional):

- `lib/services/drawings.ts`
- `lib/services/drawing-storage-cleanup.ts`
- `lib/services/drawing-upload-operations.ts`
- `lib/storage/drawings-pdfs-storage.ts`
- `lib/services/drawings-pipeline.ts`
- `lib/storage/drawings-tiles-storage.ts`
- `app/(app)/drawings/actions.ts`
- `components/drawings/drawings-sets-view.tsx`
- `components/drawings/revision-review-dialog.tsx`
- `supabase/migrations/*_drawing_deletion_operations.sql`
- `supabase/tests/drawing_deletion.test.sql`
- `tests/drawing-deletion.test.js`
- `scripts/test-drawing-lifecycle-ui.mjs`
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
| SQL contract | `supabase test db supabase/tests/drawing_deletion.test.sql --local` | all assertions pass on explicitly disposable local DB; otherwise require CI evidence |

The existing database-contracts CI job uses `supabase db start` then `supabase test db --local`. Do not use production environment credentials to make these tests run. Use `pnpm verify` only in the existing CI context: it includes a build.

## Steps

### 1. Add one transactional deletion service

Support set, one/many sheets and draft discard via a validated operation ID and project-scoped target IDs. Lock relevant revision/sheet rows in stable order; capture minimal cleanup inventory, cancel relevant work, perform row changes and insert audit/event/cleanup intent atomically. Reject published-revision discard; explicitly define generic deleteDrawingRevision behavior so it cannot silently remove the current revision. A duplicate request returns the committed receipt. Never cascade library source PDFs as derived data.

**Verify:** `node --test tests/drawing-deletion.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 2. Fence shared artifacts before garbage collection

Introduce an org/path artifact lifecycle guard (active/deleting/deleted with generation and references), compatible with the artifact records planned in 011. All artifact adopters and writers register/check that guard before committing a new reference. Deletion claims an unreferenced generation transactionally; new adopters cannot reference it after the claim. Legacy paths lacking complete reference evidence remain retained. This closes check-then-delete races; a second best-effort SELECT alone is insufficient. Tombstone/cancel revision work before physical deletion; reconcile objects written by a late worker. Each build generation has a fresh immutable physical prefix; once deleting/deleted, that prefix is permanently retired and must never become the target of a replacement build. Cleanup receipts name the exact org, generation and prefix. Database fencing cannot cancel storage requests already in flight: keep retired generations in a durable reconciliation set, and rescan after known writer leases and request deadlines expire. A late PUT schedules further cleanup; a delayed DELETE can affect only the retired prefix, never a newer generation. Do not report physical cleanup complete while known writers remain active or unknown.

**Verify:** `node --test tests/drawing-deletion.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 3. Implement resumable, paginated cleanup

Process cleanup as leased drawing jobs. Iterate listing continuation tokens; delete batches of at most 1,000 keys; inspect per-key failures, checkpoint progress and retry. Check both durable version references and active processing/temp-page references. A database/listing error must retain data. Handle already-missing keys as success, record terminal errors for ops, and leave receipt visible after source rows disappear. Keep durable cleanup inventories rather than relying on cascaded version rows. Include expired native upload operations from plan 005: remove only objects/multipart sessions owned by the abandoned operation after verifying no committed file, revision or active operation references them. Do not delete legitimate source files retained in the document library. An ambiguous finalization remains retained for reconciliation.

**Verify:** `node --test tests/drawing-deletion.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 4. Replace per-sheet UI requests with one bulk action

handleDeleteDisciplineGroup submits all IDs once. Confirm deletion scope, then update the UI after the committed receipt; clear selected viewer/sheet state and invalidate counts. Show cleanup status separately only when actionable. If response is lost, reconcile by operation ID instead of showing a generic failure or creating a second delete. Use the same service for all deletion/discard entry points. Add executable browser assertions in scripts/test-drawing-lifecycle-ui.mjs for the bulk action, acknowledgement, lost-response reconciliation and selected-viewer removal.

**Verify:** `bun scripts/test-drawing-lifecycle-ui.mjs` → exit 0 with the new deletion cases executed; also run `node --test tests/drawing-deletion.test.js` with all cases passing.

## Test plan

Test 2,501 objects, partial DeleteObjects errors, reference-query outage, active shared temp files, two concurrent deletes, a delayed DELETE arriving after a newer generation builds, a late PUT after the first cleanup sweep, adoption versus cleanup, delete versus publication/render completion, rollback before receipt, deleted revision retry, and preservation of another revision sharing tiles. SQL tests assert transaction rollback and project isolation. Browser fixtures verify one bulk call and immediate row removal after receipt.

## Done criteria

- [ ] The request path performs zero object-storage deletes/lists.
- [ ] Deleting 100 sheets uses one bulk mutation request.
- [ ] An injected 30-second storage delay does not delay deletion acknowledgement.
- [ ] All 2,501 unreferenced fixture objects are eventually removed; every referenced fixture object survives.
- [ ] All applicable commands pass; database/browser gates have recorded evidence, not silent skips.
- [ ] Typecheck/lint introduce no regressions; failures predating the change are separately recorded.
- [ ] Review the diff against the recorded starting workspace; only scoped changes belong to this plan.
- [ ] Record schema/application rollout order, rollback behavior and remaining deployment gates in this plan; update advisor-plans/README.md.

## STOP conditions

If all artifact writers/adopters cannot be fenced, retain shared objects and report cleanup pending rather than shipping unsafe garbage collection. Preserve published history unless the explicit deletion scope includes it. Also stop for unexplained source drift, two failed attempts at the same gate, required changes outside scope, or an unverified backend target. Report the specific blocker and retain safe progress.

## Maintenance and rollout

Plan 011 extends the same artifact guard; do not create a second competing ownership mechanism. Undo/retention policy is not included: preserve current explicit permanent-deletion semantics. Roll out additive schema before consumers; retain old readers/handlers during transition. Rollback must leave durable operations and immutable artifacts recoverable. Tests passing locally do not mean pending migrations were deployed.

## Implementation evidence — 2026-10-01

Implemented transactional deletion receipts, upload cancellation and deleted-page tombstones, durable cleanup jobs, bounded first-page storage deletion, per-prefix backoff/fairness, late-write rescans, and source reference protection. Three cleanup handler tests pass with zero skips, including 2,501 objects, partial-key failure, later healthy prefix progress, and abandoned-upload isolation. Combined migration tests cover deletion winning against reservation. Legacy unowned artifacts and library sources are retained.

Schema rollout remains pending: apply additive migrations in filename order on a disposable fully migrated database, validate old/new worker compatibility, then obtain the required migration approval before release. Do not roll back by dropping operation receipts or artifact tombstones. Parent review and final integration checks remain separate gates.
