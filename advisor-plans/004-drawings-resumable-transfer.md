# Plan 004: Preserve upload progress and support pause, resume and cancellation
> Executor: read the entire plan, implement only its scope, run each verification gate and record evidence. Update this plan and the index status only after its done criteria hold.

- **Planned at:** `9f1549af`, 2026-10-01, including the reviewed dirty workspace.
- **Priority / effort / risk:** P1 / L / MED
- **Depends on:** 003
- **Status:** IMPLEMENTED / RELEASE PENDING — integrated; see [verification and rollout record](drawings-implementation-2026-10-01.md).
- **Confidence:** HIGH for current-code findings; proposed performance gains require measurement.

## Why this matters

The shared multipart client aborts and clears progress for every terminal exception, including signing or completion failures. Promise.all rejects while sibling workers can continue writing resume state. Drawings use this client for PDFs at least 32 MiB; documents also use it, so preserve existing callers while adding recovery capabilities.

## Current state and drift check

Run `git diff --stat 9f1549af..HEAD -- lib/services/multipart-upload-client.ts lib/services/drawings-client.ts lib/storage/drawings-pdfs-storage.ts 'app/api/drawings/multipart/**' components/drawings/drawings-sets-view.tsx tests/multipart-upload-client.test.js tests/drawing-upload-transport.test.js 'tests/fixtures/drawing-lifecycle/**'` and compare the working-tree hashes in `advisor-plans/drawings-source-snapshot.json`. Expected prerequisite edits are not failures: inspect them, preserve their contracts, and refresh these excerpts before executing. Unrelated mismatches require review.

`lib/services/multipart-upload-client.ts:145`

```
    await Promise.all(workers)

    onStage?.("finalizing")
    const completeResponse = await fetch(endpoints.complete, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storagePath: createPayload.storagePath,
        uploadId: createPayload.uploadId,
        parts: completedParts.map(({ partNumber, etag }) => ({ partNumber, etag })),
      }),
    })

    if (!completeResponse.ok) {
      throw new Error("Failed to complete multipart upload.")
    }

    clearMultipartResumeState(resumeKey)
    return createPayload.storagePath
  } catch (error) {
    await fetch(endpoints.abort, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storagePath: createPayload.storagePath,
        uploadId: createPayload.uploadId,
      }),
    }).catch(() => undefined)
    clearMultipartResumeState(resumeKey)
    throw error
```

`lib/services/multipart-upload-client.ts:228`

```
export function uploadBlobWithProgress(
  url: string,
  blob: Blob,
  contentType: string,
  onProgress?: (loaded: number) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("PUT", url)
    xhr.setRequestHeader("Content-Type", contentType)
```

## Repository conventions and boundaries

Work in `/Users/agustinzenuto/Desktop/Projects/arc` (or its faithfully copied review checkout). Next.js 16 / React 19 / TypeScript, pnpm, Supabase Postgres and R2. Follow `lib/action-result.ts`: `type ActionResult<T> = { success: true; data: T } | { success: false; error: string; code?: string }`; server actions return results, services own logic. Validate inputs and enforce org plus project permission at every externally callable boundary. Keep SQL org-scoped, RLS enabled, and internal worker RPC grants service-only where appropriate. Do not silently escalate to SECURITY DEFINER.

The workspace already has extensive uncommitted/untracked work. Record `git status --short` and `git diff -- <scope>` before editing; never reset or overwrite it. SHA alone is insufficient: the supplied `drawings-source-snapshot.json` hashes the reviewed working-tree files, including untracked files. Re-read changed files and update the plan after prerequisite changes; stop on unrelated drift. New migration names below are allowed suffixes, not existing files: use the repository's migration creation workflow. No historical migration edits.

Local app configuration points at production. Do not run mutation tests against it, apply production migrations, start another dev server, or run a local production build. Database contracts run against an explicitly disposable local/CI database. Author additive migrations and report their deployment status separately. Preserve unrelated financials, iOS UX, portal sharing policy, source PDF ownership and existing sheet history. No dependency/platform replacement or production rollout is authorized by this plan artifact.

Use branch `codex/drawings-<plan-slug>` if an executor needs a branch; preserve the working tree and do not push, merge or open a PR without task authorization. Existing commit style is plain imperative (for example `Fix request-bound pages blocking instant navigation`); do not commit merely to finish this plan.

## Scope

Modify only these paths (new files and narrowly named migration patterns are intentional):

- `lib/services/multipart-upload-client.ts`
- `lib/services/drawings-client.ts`
- `lib/storage/drawings-pdfs-storage.ts`
- `app/api/drawings/multipart/**`
- `components/drawings/drawings-sets-view.tsx`
- `tests/multipart-upload-client.test.js`
- `tests/drawing-upload-transport.test.js`
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

The existing database-contracts CI job uses `supabase db start` then `supabase test db --local`. Do not use production environment credentials to make these tests run. Use `pnpm verify` only in the existing CI context: it includes a build.

## Steps

### 1. Define resumable transfer states

Add idle/transferring/paused/reconciling/completed/cancelled states and AbortSignal support. Persist a versioned record scoped by org, project, file identity and transfer ID. File name/size/mtime alone must not authorize reuse of different content: verify content identity before reusing parts, using bounded-memory hashing. Treat completion-unknown separately from transfer failure. Preserve the current Promise<string> result for existing clients through optional options or a compatibility wrapper.

**Verify:** `node --test tests/multipart-upload-client.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 2. Stop sibling work and retain valid parts

On pause or exhausted transient failure, stop scheduling parts, abort in-flight XHR/fetch, await all workers settling, then persist stable progress. Abort storage only for explicit cancellation or a confirmed unusable session. Add progress-based stall timeout and bounded control-request deadlines; retry signing/PUT/completion with jitter and fresh signatures when necessary. Nonempty ETags are required; progress cannot reach complete before server confirmation.

**Verify:** `node --test tests/multipart-upload-client.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 3. Reconcile with storage and batch signing

Add authenticated status and bounded part-urls endpoints alongside existing endpoints. Reuse requireDrawingUploadForPath. List all remote parts with pagination and compare size/ETag; localStorage is a hint. For a lost completion response, validate the immutable object identity and expected bytes before returning success; never accept mere path existence. Batch 16 part signatures, retain six concurrent PUTs initially, prefetch only a bounded window. Verify current R2/S3 API behavior from official docs before implementation.

**Verify:** `node --test tests/drawing-upload-transport.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 4. Wire pause, resume and cancel into both drawing upload paths

Thread control through whole-set and single-sheet uploads, including local proxy behavior. Closing the dialog keeps transfer owned by a mounted manager only while the tab remains open; full reload requires file reselection unless a persisted handle is actually available. Preserve completed transfer metadata until registration confirms it; plan 005 owns durable operation registration.

**Verify:** `node --test tests/multipart-upload-client.test.js tests/drawing-upload-transport.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

## Test plan

Fake six concurrent workers: one fails while five finish, immediate retry, cancel during URL signing, timeout with late XHR callback, storage quota failure, malformed saved JSON, switched org, mismatched reselected file, expired upload and lost completion response. Assert surviving parts are not resent, no worker writes after cancellation settles, and existing document callers still behave correctly.

## Done criteria

- [ ] A recoverable failure after 90% completion never triggers storage abort.
- [ ] Retry reconciles and sends only absent/invalid parts.
- [ ] A 64-part upload uses at most four initial 16-URL signing batches, excluding justified expiry/retry requests.
- [ ] Cancellation settles all workers before session deletion and releases the busy UI.
- [ ] All applicable commands pass; database/browser gates have recorded evidence, not silent skips.
- [ ] Typecheck/lint introduce no regressions; failures predating the change are separately recorded.
- [ ] Review the diff against the recorded starting workspace; only scoped changes belong to this plan.
- [ ] Record schema/application rollout order, rollback behavior and remaining deployment gates in this plan; update advisor-plans/README.md.

## STOP conditions

If storage cannot distinguish completed from absent upload safely, preserve the session as completion-unknown; do not invent success or delete the object. Also stop for unexplained source drift, two failed attempts at the same gate, required changes outside scope, or an unverified backend target. Report the specific blocker and retain safe progress.

## Maintenance and rollout

The client is shared by documents. Add compatibility coverage without migrating document workflows in this plan. Signing batches remain bounded and project-authorized. Roll out additive schema before consumers; retain old readers/handlers during transition. Rollback must leave durable operations and immutable artifacts recoverable. Tests passing locally do not mean pending migrations were deployed.

## Implementation evidence (2026-10-01)

Implemented the shared multipart state machine with bounded hashing, retained sessions on transient failure, authoritative paginated status reconciliation, 16-part signature batches, six PUT workers, stall/control deadlines, cancellation settlement, completion-unknown recovery, and generic document compatibility. Reserved drawings use multipart at every size; localhost uses an authenticated, bounded streaming part proxy. Durable operation generation, transfer ID and exact upload ID gate all reserved follow-ups. Creation retries recover existing bindings, including ambiguous database acknowledgements. Storage metadata records operation/generation/content identity, and native cleanup never follows a library-source fallback.

Behavioral tests: `node --test tests/multipart-upload-client.test.js tests/drawing-upload-transport.test.js` exercise retained parts, no retransmission after completion/registration loss, quota failure, malformed local hints, mismatched file content, legacy documents, signing pause/cancel, 64-part batching, exact generation/session authorization and lost create binding responses. Browser fixture additionally exercises the real shared hook for package and single-sheet flows. Scoped ESLint passes. Full TypeScript has pre-existing prospects errors; parent integration owns final typecheck after domain changes.

The R2 implementation was checked against [Cloudflare S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/) and [multipart upload documentation](https://developers.cloudflare.com/r2/objects/upload-objects/). ETags identify uploaded parts; whole-object completion requires matching immutable metadata and size, never path existence alone.

Deployment: additive upload-operation schema and cleanup jobs must precede application routes. Existing non-operation document upload callers remain supported. No migration, production mutation, app build or development server was run. New routes and browser tests use only isolated fixtures.
