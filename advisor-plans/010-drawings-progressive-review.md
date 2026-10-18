# Plan 010: Make upload and replacement review progressive and recoverable
> Executor: read the entire plan, implement only its scope, run each verification gate and record evidence. Update this plan and the index status only after its done criteria hold.

- **Planned at:** `9f1549af`, 2026-10-01, including the reviewed dirty workspace.
- **Priority / effort / risk:** P2 / L / MED
- **Depends on:** 004, 005, 006, 007, 008, 009
- **Status:** IMPLEMENTED / RELEASE PENDING — integrated; see [verification and rollout record](drawings-implementation-2026-10-01.md).
- **Confidence:** HIGH for current-code findings; proposed performance gains require measurement.

## Why this matters

The revision dialog polls processing state and loads the review diff only after all title-block verification completes. One slow verification holds the package back. Users should inspect rendered pages immediately while uncertain identity matches remain explicit and publication stays safe. This plan unifies whole-set and single-sheet operation presentation without changing the one-active-draft project policy.

## Current state and drift check

Run `git diff --stat 9f1549af..HEAD -- components/drawings/drawings-sets-view.tsx components/drawings/revision-review-dialog.tsx components/drawings/upload-operation-panel.tsx lib/hooks/use-drawing-upload-operation.ts lib/services/drawings.ts lib/services/drawings-client.ts lib/services/drawings-pipeline.ts lib/validation/drawings.ts 'app/(app)/drawings/actions.ts' 'supabase/migrations/*_drawing_review_readiness.sql' supabase/tests/drawing_review_readiness.test.sql tests/drawing-review-readiness.test.js 'tests/fixtures/drawing-lifecycle/**' scripts/test-drawing-lifecycle-ui.mjs` and compare the working-tree hashes in `advisor-plans/drawings-source-snapshot.json`. Expected prerequisite edits are not failures: inspect them, preserve their contracts, and refresh these excerpts before executing. Unrelated mismatches require review.

`lib/services/drawings-pipeline.ts:1828`

```
async function finishMetadataProgress(supabase: SupabaseClient, revisionId: string) {
  const { data: revision, error: revisionError } = await supabase.from("drawing_revisions")
    .select("status, processed_pages, total_pages").eq("id", revisionId).maybeSingle()
  if (revisionError) throw new Error(`Unable to read drawing progress: ${revisionError.message}`)
  if (!revision || revision.status !== "processing" || !revision.total_pages ||
      revision.processed_pages < revision.total_pages) return
  const { count, error } = await supabase.from("drawing_sheet_versions")
    .select("id", { count: "exact", head: true }).eq("drawing_revision_id", revisionId)
    .eq("extracted_metadata->sheet_detection->>vision_pending", "true")
  if (error) throw new Error(`Unable to read drawing verification progress: ${error.message}`)
  if (count !== 0) return
  const { error: updateError } = await supabase.from("drawing_revisions")
    .update({ status: "draft", processing_stage: "ready" })
    .eq("id", revisionId).eq("status", "processing")
```

`components/drawings/revision-review-dialog.tsx:213`

```
        if (status.status === "processing") {
          setProcessing(true)
          setDiff({
            revision: status,
            updated: [],
            added: [],
            unchanged: [],
          })
          // Sheet + version rows are written at split time, so pages show up
          // here long before their tiles finish. Degrade silently: a failed
          // page fetch just leaves the grid where it was.
          const pages = await listDraftRevisionSheetsAction(revisionId)
          if (cancelled) return
          if (pages.success) setDraftSheets(pages.data)
          timer = setTimeout(tick, 2000)
          return
        }
        // draft ready
        setProcessing(false)
        await loadDiff()
      } catch (err) {
```

## Repository conventions and boundaries

Work in `/Users/agustinzenuto/Desktop/Projects/arc` (or its faithfully copied review checkout). Next.js 16 / React 19 / TypeScript, pnpm, Supabase Postgres and R2. Follow `lib/action-result.ts`: `type ActionResult<T> = { success: true; data: T } | { success: false; error: string; code?: string }`; server actions return results, services own logic. Validate inputs and enforce org plus project permission at every externally callable boundary. Keep SQL org-scoped, RLS enabled, and internal worker RPC grants service-only where appropriate. Do not silently escalate to SECURITY DEFINER.

The workspace already has extensive uncommitted/untracked work. Record `git status --short` and `git diff -- <scope>` before editing; never reset or overwrite it. SHA alone is insufficient: the supplied `drawings-source-snapshot.json` hashes the reviewed working-tree files, including untracked files. Re-read changed files and update the plan after prerequisite changes; stop on unrelated drift. New migration names below are allowed suffixes, not existing files: use the repository's migration creation workflow. No historical migration edits.

Local app configuration points at production. Do not run mutation tests against it, apply production migrations, start another dev server, or run a local production build. Database contracts run against an explicitly disposable local/CI database. Author additive migrations and report their deployment status separately. Preserve unrelated financials, iOS UX, portal sharing policy, source PDF ownership and existing sheet history. No dependency/platform replacement or production rollout is authorized by this plan artifact.

Use branch `codex/drawings-<plan-slug>` if an executor needs a branch; preserve the working tree and do not push, merge or open a PR without task authorization. Existing commit style is plain imperative (for example `Fix request-bound pages blocking instant navigation`); do not commit merely to finish this plan.

## Scope

Modify only these paths (new files and narrowly named migration patterns are intentional):

- `components/drawings/drawings-sets-view.tsx`
- `components/drawings/revision-review-dialog.tsx`
- `components/drawings/upload-operation-panel.tsx`
- `lib/hooks/use-drawing-upload-operation.ts`
- `lib/services/drawings.ts`
- `lib/services/drawings-client.ts`
- `lib/services/drawings-pipeline.ts`
- `lib/validation/drawings.ts`
- `app/(app)/drawings/actions.ts`
- `supabase/migrations/*_drawing_review_readiness.sql`
- `supabase/tests/drawing_review_readiness.test.sql`
- `tests/drawing-review-readiness.test.js`
- `tests/fixtures/drawing-lifecycle/**`
- `scripts/test-drawing-lifecycle-ui.mjs`

The plan itself and its index status may be updated. Everything else is out of scope unless the reviewed scope is explicitly revised.

## Commands

Run from the repository root. Commands that refer to new tests/scripts become runnable after their creation; they were not claimed to exist during this audit.

| Gate | Command | Required result |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0, or record and isolate a pre-existing unrelated failure; new errors block completion |
| Lint | `pnpm lint` | exit 0; no new violations |
| Drawing regression | `pnpm test:drawings` | all pass |
| Focused audit baseline | `node --test tests/drawing-metadata-pipeline.test.js tests/drawing-pdf-source.test.js tests/drawing-revision-publish-db.test.js` | passing cases; optional skipped DB case is not transactional evidence |
| SQL contract | `supabase test db supabase/tests/drawing_review_readiness.test.sql --local` | all assertions pass on explicitly disposable local DB; otherwise require CI evidence |

The existing database-contracts CI job uses `supabase db start` then `supabase test db --local`. Do not use production environment credentials to make these tests run. Use `pnpm verify` only in the existing CI context: it includes a build.

## Steps

### 1. Separate rendering and identity review state

Store/render independent per-page render state, identity verification state and explicit user-confirmed identity/version. Compute review availability from viewable pages; compute publication eligibility from completed manifest and resolved accepted identities. Do not simply set status=draft early while workers still depend on status=processing. Add state transitions with revision generation/optimistic concurrency so late enrichment cannot overwrite user decisions or published metadata.

**Verify:** `node --test tests/drawing-review-readiness.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 2. Build a persistent operation controller

Use a single owner for transfer, registration and processing state shared by whole-set/single-sheet dialogs. Persist server operation identity, not File bytes or signed URLs. Closing the dialog retains in-tab transfer; navigation/unmount pauses unless the owner is genuinely above that boundary. Reload recovers server processing and asks for matching file reselection only when transfer remains incomplete. Provide pause/resume/cancel/retry at the correct stage.

**Verify:** `node --test tests/drawing-review-readiness.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 3. Make review incremental and sparse

Show changed/added/uncertain counts and current versus proposed identity. Render pages as ready, virtualize long lists, preserve user edits while new status arrives, and keep unchanged rows collapsed when equivalence is proven. Use one non-overlapping adaptive poll per revision, pause hidden-tab polling, back off on errors, stop terminal polling, and return bounded changed-page status where possible. Avoid refetching full register/manifest data every two seconds. Do not require Realtime to ship this improvement.

**Verify:** `node --test tests/drawing-review-readiness.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 4. Enforce review gates on the server and verify UI

Users may explicitly confirm uncertain identities from the page image; record that confirmation. Accepted pages must be fully rendered before publish, all expected pages must be accounted for, and rejected pages follow durable cleanup. An AI outage cannot prevent publication once these conditions and human confirmation hold. Apply Arc tokens, square surfaces and clear state text from docs/design.md. Preserve current drawings throughout processing.

**Verify:** `bun scripts/test-drawing-lifecycle-ui.mjs` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

## Test plan

Test manual edit racing AI completion, partial rendering, one failed page, metadata outage, stale tab publication, refresh/reopen, file reselection mismatch, cancel during finalization, both upload entry points, keyboard navigation and reduced motion. Use fixture UI actions; no production uploads. Extend real SQL publish checks for readiness, not just disabled buttons.

## Done criteria

- [ ] First viewable page can be reviewed before the last metadata job completes.
- [ ] A pending AI request cannot overwrite a confirmed identity.
- [ ] Server rejects publication with incomplete accepted artifacts or unresolved accepted identities.
- [ ] Only one status request is in flight per revision; polling stops after terminal state.
- [ ] All applicable commands pass; database/browser gates have recorded evidence, not silent skips.
- [ ] Typecheck/lint introduce no regressions; failures predating the change are separately recorded.
- [ ] Review the diff against the recorded starting workspace; only scoped changes belong to this plan.
- [ ] Record schema/application rollout order, rollback behavior and remaining deployment gates in this plan; update advisor-plans/README.md.

## STOP conditions

If early status changes make workers skip unfinished rendering or enrichment, keep separate flags and revise transitions before rollout. Never weaken identity checks merely to enable the Publish button. Also stop for unexplained source drift, two failed attempts at the same gate, required changes outside scope, or an unverified backend target. Report the specific blocker and retain safe progress.

## Maintenance and rollout

Design excerpt: "Color reports state" and "Radius is 0" from CLAUDE.md, with token details in docs/design.md. Background transfer only survives while browser execution remains alive; do not promise tab-close uploads. Roll out additive schema before consumers; retain old readers/handlers during transition. Rollback must leave durable operations and immutable artifacts recoverable. Tests passing locally do not mean pending migrations were deployed.

## Implementation evidence (2026-10-01)

Implemented one shared persistent upload controller for package and single-sheet entry points. The controller retains operation identity, keeps a single in-tab owner, uses Web Locks across tabs, tolerates storage failure, renews live reservations, preserves expired receipts for server re-admission, isolates generation resume keys and pauses on unmount. Cancellation waits for active work and reports an already registered PDF accurately. The operation panel supplies pause/resume/cancel and truthful tab-lifetime messaging. Trade deletion now uses one idempotent bulk action with a retained operation UUID on failed acknowledgement.

Review loads partial diffs while processing, keeps human edits when metadata refreshes, uses one adaptive non-overlapping poll with hidden-tab suspension, and stops terminal polling. Rows are revealed in bounded 50-row increments; unchanged rows stay collapsed. Pending identities require explicit confirmation tied to the exact draft version; incomplete manifests or accepted unrendered/unconfirmed pages disable publication. Server publication independently enforces those gates.

Browser verification passed using the actual React review dialog, upload hook, multipart client and operation panel: deletion acknowledgement, progressive review before verification, keyboard identity confirmation, manifest gating, human edits surviving a late AI refresh, package pause/resume, lost registration acknowledgement with zero repeat PUTs, and single-sheet replacement. Run `ARC_TEST_BROWSER_PATH=<isolated Chromium binary> bun scripts/test-drawing-lifecycle-ui.mjs`. All requests are fixture-only and unexpected origins fail the test. Scoped ESLint passes. SQL publication/race contracts and final integrated typecheck are recorded by the domain executor.

Deployment: apply additive operation/readiness/publication migrations before consumers; keep current drawings live until the publish transaction commits. No migration was applied. Rollback must preserve receipts, immutable source generations, cleanup inventory and already committed publications. Real production throughput and mobile-app interaction remain deployment verification, not claims made by these browser fixtures.
