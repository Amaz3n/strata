# Plan 008: Publish revisions with durable follow-up work and retry-safe results
> Executor: read the entire plan, implement only its scope, run each verification gate and record evidence. Update this plan and the index status only after its done criteria hold.

- **Planned at:** `9f1549af`, 2026-10-01, including the reviewed dirty workspace.
- **Priority / effort / risk:** P1 / M-L / MED
- **Depends on:** 003, 007
- **Status:** IMPLEMENTED / RELEASE PENDING — integrated; see [verification and rollout record](drawings-implementation-2026-10-01.md).
- **Confidence:** HIGH for current-code findings; proposed performance gains require measurement.

## Why this matters

publish_drawing_revision is transactional, but the service inserts reanchor_takeoff_markups afterward. Queue failure leaves publication committed and retry rejected. Preserve the existing per-sheet decisions, collision fallback and takeoff review rules while making publication plus required work one durable state transition. Do not make rendering or measurement carry-forward synchronous.

## Current state and drift check

Run `git diff --stat 9f1549af..HEAD -- lib/services/drawings.ts lib/services/takeoff-reanchor.ts 'app/(app)/drawings/actions.ts' components/drawings/revision-review-dialog.tsx 'supabase/migrations/*_drawing_publication_receipts.sql' supabase/tests/drawing_publication.test.sql tests/drawing-publication.test.js tests/drawing-revision-publish-db.test.js 'tests/fixtures/drawing-lifecycle/**'` and compare the working-tree hashes in `advisor-plans/drawings-source-snapshot.json`. Expected prerequisite edits are not failures: inspect them, preserve their contracts, and refresh these excerpts before executing. Unrelated mismatches require review.

`lib/services/drawings.ts:2538`

```
  if (revError || !revision) throw new Error(`Revision not found: ${revError?.message}`)
  await requireProjectPermission(userId, revision.project_id, "drawing.upload")
  if (revision.status === "published") throw new Error("Revision already published")

  const { error: publishError } = await supabase.rpc("publish_drawing_revision", {
    p_org_id: resolvedOrgId,
```

`lib/services/drawings.ts:2566`

```
    org_id: resolvedOrgId,
    event_id: null,
    job_type: "reanchor_takeoff_markups",
    status: "pending",
    run_at: new Date().toISOString(),
    retry_count: 0,
    last_error: "",
    payload: { revision_id: input.revisionId },
  })
  if (reanchorEnqueueError) {
    // The revision IS published; losing the queue row means measurements
    // silently vanish from rollups, so this one is worth failing loudly.
    throw new Error(
      `Revision published, but measurement carry-forward could not be queued: ${reanchorEnqueueError.message}`,
    )
  }
```

`supabase/migrations/20260929113927_drawing_revision_sheet_number_conflicts.sql:155`

```
  WHERE org_id = p_org_id
    AND id = p_revision_id;

  PERFORM refresh_drawing_sheets_list();
END;
$function$;
```

## Repository conventions and boundaries

Work in `/Users/agustinzenuto/Desktop/Projects/arc` (or its faithfully copied review checkout). Next.js 16 / React 19 / TypeScript, pnpm, Supabase Postgres and R2. Follow `lib/action-result.ts`: `type ActionResult<T> = { success: true; data: T } | { success: false; error: string; code?: string }`; server actions return results, services own logic. Validate inputs and enforce org plus project permission at every externally callable boundary. Keep SQL org-scoped, RLS enabled, and internal worker RPC grants service-only where appropriate. Do not silently escalate to SECURITY DEFINER.

The workspace already has extensive uncommitted/untracked work. Record `git status --short` and `git diff -- <scope>` before editing; never reset or overwrite it. SHA alone is insufficient: the supplied `drawings-source-snapshot.json` hashes the reviewed working-tree files, including untracked files. Re-read changed files and update the plan after prerequisite changes; stop on unrelated drift. New migration names below are allowed suffixes, not existing files: use the repository's migration creation workflow. No historical migration edits.

Local app configuration points at production. Do not run mutation tests against it, apply production migrations, start another dev server, or run a local production build. Database contracts run against an explicitly disposable local/CI database. Author additive migrations and report their deployment status separately. Preserve unrelated financials, iOS UX, portal sharing policy, source PDF ownership and existing sheet history. No dependency/platform replacement or production rollout is authorized by this plan artifact.

Use branch `codex/drawings-<plan-slug>` if an executor needs a branch; preserve the working tree and do not push, merge or open a PR without task authorization. Existing commit style is plain imperative (for example `Fix request-bound pages blocking instant navigation`); do not commit merely to finish this plan.

## Scope

Modify only these paths (new files and narrowly named migration patterns are intentional):

- `lib/services/drawings.ts`
- `lib/services/takeoff-reanchor.ts`
- `app/(app)/drawings/actions.ts`
- `components/drawings/revision-review-dialog.tsx`
- `supabase/migrations/*_drawing_publication_receipts.sql`
- `supabase/tests/drawing_publication.test.sql`
- `tests/drawing-publication.test.js`
- `tests/drawing-revision-publish-db.test.js`
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
| SQL contract | `supabase test db supabase/tests/drawing_publication.test.sql --local` | all assertions pass on explicitly disposable local DB; otherwise require CI evidence |

The existing database-contracts CI job uses `supabase db start` then `supabase test db --local`. Do not use production environment credentials to make these tests run. Use `pnpm verify` only in the existing CI context: it includes a build.

## Steps

### 1. Add transactional publication receipt

Extend the latest publish RPC in a new migration, never editing historical migrations. Lock the revision and target sheets; verify full render readiness and existing review requirements server-side. Bind receipt to an operation key and normalized decision/edit fingerprint. Same operation retries return success; a different payload against published state returns a conflict, not a new publication. Preserve sheet-number uniqueness fallback only for automatic proposals.

**Verify:** `node --test tests/drawing-publication.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 2. Enqueue required work in that transaction

Insert exactly one carry-forward job keyed by revision, required audit/event intent, and cleanup intents for rejected draft versions before committing. Use database uniqueness, not check-then-insert dedupe. Queue optional visual diff durably too if it can share this boundary. On any required insert failure, current revisions and publication status roll back. Move the set source pointer to the committed revision when appropriate.

**Verify:** `node --test tests/drawing-publication.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 3. Preserve measurement semantics and communicate pending follow-up

Remove the post-RPC required enqueue from publishRevision. Return a receipt containing publication and follow-up state. Show Published with measurement review pending when relevant; never claim carry-forward is finished just because queued. Preserve docs/takeoff-reanchor-design.md invariants: no markup deletion, changed/uncertain scale requires review, and no automatic estimate synchronization. Verify repeated job execution cannot duplicate measurements.

**Verify:** `node --test tests/drawing-publication.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 4. Test rollback and ambiguous responses against SQL

Add SQL cases for failure on outbox insertion, simultaneous publish/discard, same-key retry after lost response, changed decisions on retry, skipped sheets requiring cleanup, sheet-number collision, and org/project denial. Keep the existing materialized-view refresh until plan 009 switches authoritative readers; do not trade correctness for a faster stale register.

**Verify:** `node --test tests/drawing-publication.test.js tests/drawing-revision-publish-db.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

## Test plan

Use existing publication collision tests as a behavior reference; mandatory SQL tests must run without skips in disposable database-contracts CI. Test takeoff job replay and no markup deletion. The optional PGlite test alone does not satisfy this plan.

## Done criteria

- [ ] Injected required-job insertion failure leaves the previous current versions intact.
- [ ] Ten retries create one receipt, one carry-forward job and one publication event.
- [ ] Lost response is reconciled without reapplying edits.
- [ ] Published receipt distinguishes queued, running, complete and failed follow-up.
- [ ] All applicable commands pass; database/browser gates have recorded evidence, not silent skips.
- [ ] Typecheck/lint introduce no regressions; failures predating the change are separately recorded.
- [ ] Review the diff against the recorded starting workspace; only scoped changes belong to this plan.
- [ ] Record schema/application rollout order, rollback behavior and remaining deployment gates in this plan; update advisor-plans/README.md.

## STOP conditions

If takeoff carry-forward currently lacks durable dedupe, implement it within the named service scope before enabling automatic retries; do not assume enqueue uniqueness makes handler effects idempotent. Also stop for unexplained source drift, two failed attempts at the same gate, required changes outside scope, or an unverified backend target. Report the specific blocker and retain safe progress.

## Maintenance and rollout

Publication remains atomic; enrichment and rendering never modify published identities. Plan 009 removes the global refresh only after read parity is demonstrated. Roll out additive schema before consumers; retain old readers/handlers during transition. Rollback must leave durable operations and immutable artifacts recoverable. Tests passing locally do not mean pending migrations were deployed.

## Implementation evidence — 2026-10-01

Publication now validates readiness and identity, checks the review snapshot, and atomically commits decisions, receipt, audit/events and follow-up jobs. Semantic receipt equality rejects changed requests while ignoring a refreshed internal timestamp on committed replay. Combined migration tests pass with queue-failure rollback and one-job replay assertions. Public/authenticated mutation privileges are revoked; authorized service calls own publication.

Schema rollout remains pending: apply additive migrations in filename order on a disposable fully migrated database, validate old/new worker compatibility, then obtain the required migration approval before release. Do not roll back by dropping operation receipts or artifact tombstones. Parent review and final integration checks remain separate gates.
