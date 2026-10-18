# Plan 005: Reserve uploads and finalize drawing revisions idempotently
> Executor: read the entire plan, implement only its scope, run each verification gate and record evidence. Update this plan and the index status only after its done criteria hold.

- **Planned at:** `9f1549af`, 2026-10-01, including the reviewed dirty workspace.
- **Priority / effort / risk:** P1 / L / MED
- **Depends on:** 003, 004
- **Status:** IMPLEMENTED / RELEASE PENDING — integrated; see [verification and rollout record](drawings-implementation-2026-10-01.md).
- **Confidence:** HIGH for current-code findings; proposed performance gains require measurement.

## Why this matters

Drawing uploads currently transfer bytes before creating files, checking pending drafts, creating revisions and inserting jobs in separate requests. A retry can transfer the same bytes again, and the draft can exist without a processing job. Introduce a durable upload operation so an ambiguous response is resolved by lookup rather than repetition. Preserve one in-flight draft per project and the existing document-library sourceFileId path.

## Current state and drift check

Run `git diff --stat 9f1549af..HEAD -- lib/services/drawing-upload-operations.ts lib/services/drawings-pipeline.ts app/api/jobs/drawings-pipeline/route.ts lib/validation/drawings.ts lib/services/drawings-client.ts 'app/(app)/drawings/actions.ts' 'app/api/drawings/multipart/**' app/api/drawings/upload-url/route.ts app/api/drawings/upload-file/route.ts components/drawings/drawings-sets-view.tsx 'supabase/migrations/*_drawing_upload_operations.sql' supabase/tests/drawing_upload_operations.test.sql tests/drawing-upload-operations.test.js 'tests/fixtures/drawing-lifecycle/**'` and compare the working-tree hashes in `advisor-plans/drawings-source-snapshot.json`. Expected prerequisite edits are not failures: inspect them, preserve their contracts, and refresh these excerpts before executing. Unrelated mismatches require review.

`app/(app)/drawings/actions.ts:425`

```
      const fileRecord = existingFile?.data ?? await createFileRecord({
        project_id: input.projectId,
        file_name: input.fileName,
        storage_path: normalizedStoragePath,
        mime_type: input.mimeType,
        size_bytes: input.fileSize,
        visibility: "private",
        category: "plans",
        source: "upload",
      })

```

`app/(app)/drawings/actions.ts:453`

```
      const { data: pendingDrafts, error: pendingError } = await supabase
        .from("drawing_revisions")
        .select("id")
        .eq("org_id", orgId)
        .eq("project_id", input.projectId)
        .in("status", ["processing", "draft"])
        .limit(1)

      if (pendingError) {
        throw new Error(`Failed to check pending revisions: ${pendingError.message}`)
      }
      if (pendingDrafts && pendingDrafts.length > 0) {
        throw new Error("A revision is already pending review. Publish or discard it before uploading another.")
      }

      let drawingSet: DrawingSet
```

`lib/services/project-file-upload.ts:40`

```
  try {
    return { record: await options.insertRecord(), created: true }
  } catch (error) {
    if (options.retrySafe) {
      // If reconciliation itself fails, preserve the object: the insert may
      // have committed and its response may have been lost.
      const existing = await options.findExisting()
      if (existing) {
        if (existing.storage_path !== options.storagePath) await options.cleanupObject()
        options.validateExisting(existing)
        // Our own insert committed: this attempt has not run post-insert work
        // yet, so it still owns version/event initialization.
        return { record: existing, created: existing.storage_path === options.storagePath }
      }
    }
    if (error instanceof UploadRecordInsertError && error.definitive) await options.cleanupObject()
```

## Repository conventions and boundaries

Work in `/Users/agustinzenuto/Desktop/Projects/arc` (or its faithfully copied review checkout). Next.js 16 / React 19 / TypeScript, pnpm, Supabase Postgres and R2. Follow `lib/action-result.ts`: `type ActionResult<T> = { success: true; data: T } | { success: false; error: string; code?: string }`; server actions return results, services own logic. Validate inputs and enforce org plus project permission at every externally callable boundary. Keep SQL org-scoped, RLS enabled, and internal worker RPC grants service-only where appropriate. Do not silently escalate to SECURITY DEFINER.

The workspace already has extensive uncommitted/untracked work. Record `git status --short` and `git diff -- <scope>` before editing; never reset or overwrite it. SHA alone is insufficient: the supplied `drawings-source-snapshot.json` hashes the reviewed working-tree files, including untracked files. Re-read changed files and update the plan after prerequisite changes; stop on unrelated drift. New migration names below are allowed suffixes, not existing files: use the repository's migration creation workflow. No historical migration edits.

Local app configuration points at production. Do not run mutation tests against it, apply production migrations, start another dev server, or run a local production build. Database contracts run against an explicitly disposable local/CI database. Author additive migrations and report their deployment status separately. Preserve unrelated financials, iOS UX, portal sharing policy, source PDF ownership and existing sheet history. No dependency/platform replacement or production rollout is authorized by this plan artifact.

Use branch `codex/drawings-<plan-slug>` if an executor needs a branch; preserve the working tree and do not push, merge or open a PR without task authorization. Existing commit style is plain imperative (for example `Fix request-bound pages blocking instant navigation`); do not commit merely to finish this plan.

## Scope

Modify only these paths (new files and narrowly named migration patterns are intentional):

- `lib/services/drawing-upload-operations.ts`
- `lib/services/drawings-pipeline.ts`
- `app/api/jobs/drawings-pipeline/route.ts`
- `lib/validation/drawings.ts`
- `lib/services/drawings-client.ts`
- `app/(app)/drawings/actions.ts`
- `app/api/drawings/multipart/**`
- `app/api/drawings/upload-url/route.ts`
- `app/api/drawings/upload-file/route.ts`
- `components/drawings/drawings-sets-view.tsx`
- `supabase/migrations/*_drawing_upload_operations.sql`
- `supabase/tests/drawing_upload_operations.test.sql`
- `tests/drawing-upload-operations.test.js`
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
| SQL contract | `supabase test db supabase/tests/drawing_upload_operations.test.sql --local` | all assertions pass on explicitly disposable local DB; otherwise require CI evidence |

The existing database-contracts CI job uses `supabase db start` then `supabase test db --local`. Do not use production environment credentials to make these tests run. Use `pnpm verify` only in the existing CI context: it includes a build.

## Steps

### 1. Add operation reservation and admission

Define drawing_upload_operations keyed by org/project/client idempotency key, storing immutable intent fingerprint, actor, server-generated object path, expected size/type, state, expiry, resulting file/revision IDs. Reserve before transfer using a project lock shared with finalization and a database constraint; account for existing processing/draft revisions. One active reservation plus existing draft must not admit two uploads. Repeated same key/intent returns the operation; changed intent rejects. Expired reservations may be reclaimed without deleting an uncertain completed object. Use states reserved → transferring → transferred → finalized, with cancelled/expired terminal admission states, an owner generation and bounded renewable expiry. Pause retains bytes but does not reserve admission indefinitely. Resume after expiry must re-admit under the same project lock; if another operation now holds admission, return its conflict and retain the old bytes for later reconciliation. The prior generation may never finalize after re-admission allocates a new owner generation.

**Verify:** `node --test tests/drawing-upload-operations.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 2. Finalize metadata and queue atomically

Verify the expected stored object through server-side storage metadata and identity checks. In one authorized transaction create/link file, canonical set, draft revision, audit/event intent and exactly one outbox processing job; write operation result last in the same transaction. Reconcile a lost result by operation ID. Keep external storage outside the transaction and retain evidence for abandoned-upload cleanup. Cancellation and finalization serialize on the same operation/project lock: if cancel wins, mark cancelled and reject all later finalization for that generation; if finalize wins, cancel returns the committed receipt and does not remove its source. A subsequent user request to remove the resulting draft uses the normal discard operation. Client abort only stops waiting; it never establishes which transaction won. Recheck admission state/generation at commit, and expose renewal and cancellation as authenticated service operations. Do not change the live set source pointer to an unpublished draft; the revision holds its source until publication.

**Verify:** `node --test tests/drawing-upload-operations.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 3. Integrate whole-set, single-sheet and library uploads

Move business logic from createDrawingSetFromUpload into the new service; preserve ActionResult shape and project authorization. The UI reserves first, transfers once, then retries only finalization. Store the returned operation ID and storage result across dialog changes/reloads. Library imports use the same transactional finalization with a validated existing source; they never delete the library file on cancellation. Prevent hidden retries from allocating a new key.

**Verify:** `node --test tests/drawing-upload-operations.test.js tests/drawing-pdf-source.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 4. Exercise concurrency and deploy additively

Add SQL contract tests for concurrent reservations, same-key finalize, different intent, tenant denial and rollback on job insertion failure. Use synthetic storage adapters to prove failed triggers cannot erase a durable queued job. Wire expired/failed operation reconciliation into the existing drawing pipeline entry path in lib/services/drawings-pipeline.ts, before the no-runnable-work decision, using a bounded indexed scan and ownership checks. Include app/api/jobs/drawings-pipeline/route.ts in that wiring so expired operations are recoverable even when no drawing jobs are pending; do not add an unregistered cron. Plan 006 subsequently preserves this preflight while adding lease recovery. Physical deletion of abandoned upload objects is deferred to plan 007; until its collector is deployed, retain them and report cleanup pending. Stage additive schema before routing new uploads to it.

**Verify:** `node --test tests/drawing-upload-operations.test.js tests/project-file-upload.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

## Test plan

Use tests/project-file-upload.test.js as the ambiguous-commit pattern and the new SQL file for actual transaction behavior. Include missing/short object, spoofed path, duplicate tab submit, one existing pending draft, sourceFileId reuse, disconnect after commit, pause beyond expiry, another operation winning re-admission, renewal racing expiry, cancel winning finalize, and finalize winning cancel.

## Done criteria

- [ ] Exactly one file/revision/initial job is visible after ten retries of the same operation.
- [ ] Failed job insertion rolls back finalization.
- [ ] Finalization retry performs zero PDF PUTs.
- [ ] Unauthorized operation lookup, signing and finalization reveal no foreign project metadata.
- [ ] All applicable commands pass; database/browser gates have recorded evidence, not silent skips.
- [ ] Typecheck/lint introduce no regressions; failures predating the change are separately recorded.
- [ ] Review the diff against the recorded starting workspace; only scoped changes belong to this plan.
- [ ] Record schema/application rollout order, rollback behavior and remaining deployment gates in this plan; update advisor-plans/README.md.

## STOP conditions

If operation/file ownership cannot be established, retain storage for reconciliation instead of removing it. If canonical-set uniqueness differs from the current project model, resolve that schema contract before adding a competing constraint. Also stop for unexplained source drift, two failed attempts at the same gate, required changes outside scope, or an unverified backend target. Report the specific blocker and retain safe progress.

## Maintenance and rollout

Idempotency must bind the complete upload intent, including target sheet and source file. Do not use a filename as the key. Keep completed operation receipts long enough to cover client retry retention. Roll out additive schema before consumers; retain old readers/handlers during transition. Rollback must leave durable operations and immutable artifacts recoverable. Tests passing locally do not mean pending migrations were deployed.

## Implementation evidence — 2026-10-01

Implemented stable intent-bound reservation, fresh immutable generation paths on expiry, durable multipart binding, verified HEAD identity/size, atomic registration and queue insertion, cancel/finalize project locking, and library-source normalization. Three handler/SQL tests pass with zero skips, including ten retries, rollback, changed intent, retired generation inventory, and zero-HEAD registered replay.

Schema rollout remains pending: apply additive migrations in filename order on a disposable fully migrated database, validate old/new worker compatibility, then obtain the required migration approval before release. Do not roll back by dropping operation receipts or artifact tombstones. Parent review and final integration checks remain separate gates.
