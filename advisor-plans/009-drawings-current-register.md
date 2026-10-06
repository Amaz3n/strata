# Plan 009: Read committed drawing versions without a global materialized-view refresh
> Executor: read the entire plan, implement only its scope, run each verification gate and record evidence. Update this plan and the index status only after its done criteria hold.

- **Planned at:** `9f1549af`, 2026-10-01, including the reviewed dirty workspace.
- **Priority / effort / risk:** P2 / L / MED
- **Depends on:** 003, 007, 008
- **Status:** IMPLEMENTED / RELEASE PENDING — integrated; see [verification and rollout record](drawings-implementation-2026-10-01.md).
- **Confidence:** HIGH for current-code findings; proposed performance gains require measurement.

## Why this matters

The publication SQL calls refresh_drawing_sheets_list, which rebuilds a global materialized view. Several readers use that view for current versions, so merely making refresh asynchronous would create stale rows after publish/delete. Introduce a bounded live current-register query, prove parity, then remove refresh from the transaction while preserving historical snapshots.

## Current state and drift check

Run `git diff --stat 9f1549af..HEAD -- lib/services/drawings.ts lib/services/drawings-pipeline.ts lib/mobile/drawings.ts lib/services/drawings-export.ts lib/services/drawings-distribution.ts components/drawings/project-drawings-page.tsx 'app/api/portal/drawings/**' 'app/api/mobile/v1/projects/[projectId]/drawings/**' 'supabase/migrations/*_drawing_current_register.sql' supabase/tests/drawing_current_register.test.sql tests/drawing-current-register.test.js 'tests/fixtures/drawing-lifecycle/**' scripts/benchmark-drawing-lifecycle.mjs` and compare the working-tree hashes in `advisor-plans/drawings-source-snapshot.json`. Expected prerequisite edits are not failures: inspect them, preserve their contracts, and refresh these excerpts before executing. Unrelated mismatches require review.

`lib/services/drawings.ts:407`

```
  let query = supabase
    .from("drawing_sheets_list_mv")
    .select("*")
    .eq("org_id", resolvedOrgId)

  if (parsed.project_id) {
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
- `lib/services/drawings-pipeline.ts`
- `lib/mobile/drawings.ts`
- `lib/services/drawings-export.ts`
- `lib/services/drawings-distribution.ts`
- `components/drawings/project-drawings-page.tsx`
- `app/api/portal/drawings/**`
- `app/api/mobile/v1/projects/[projectId]/drawings/**`
- `supabase/migrations/*_drawing_current_register.sql`
- `supabase/tests/drawing_current_register.test.sql`
- `tests/drawing-current-register.test.js`
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
| SQL contract | `supabase test db supabase/tests/drawing_current_register.test.sql --local` | all assertions pass on explicitly disposable local DB; otherwise require CI evidence |

The existing database-contracts CI job uses `supabase db start` then `supabase test db --local`. Do not use production environment credentials to make these tests run. Use `pnpm verify` only in the existing CI context: it includes a build.

## Steps

### 1. Inventory readers and define parity contract

Run rg -n drawing_sheets_list_mv app lib supabase/migrations. Record every current reader and its permission/filter/DTO needs in the test fixture. Preserve current version IDs, labels, pin/markup counts, sharing, ordering, search and pagination. Historical drawing_register_snapshot keeps its own as-of semantics. If another active reader falls outside scope, expand the reviewed scope before switching publication.

**Verify:** `node --test tests/drawing-current-register.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 2. Implement a live project-scoped query

Add a SECURITY INVOKER RPC/query over drawing_sheets and the version matching current_revision_id. Filter org/project and page sheet IDs first; compute counts only for returned IDs. Add only indexes justified by EXPLAIN on synthetic fixtures. Return existing DTO fields with stable sort plus ID tie-breaker. Do not expose new grants or bypass project authorization to obtain speed. Prefer this simpler live query over another maintained table unless measured plans fail the stated budget.

**Verify:** `node --test tests/drawing-current-register.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 3. Switch readers before removing refresh

Route current project lists, revision diffs and relevant mobile/portal/export paths through the new query or equivalent authorized live joins. Prove post-commit read-your-writes for publish/delete. In a later additive migration remove PERFORM refresh_drawing_sheets_list from publication. Keep legacy MV and its refresh job until every remaining consumer is accounted for; do not drop it in this plan.

**Verify:** `node --test tests/drawing-current-register.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 4. Benchmark and retain rollback evidence

Compare 300-sheet project reads with 1 and 100 other synthetic projects; record EXPLAIN ANALYZE BUFFERS in disposable DB. Assert no global refresh call and no unrelated-project aggregation in the new query. Suggested measured goal: publish/delete p95 below two seconds on the agreed fixture environment, with less than 20% degradation as unrelated data grows; report actuals instead of weakening correctness when target is missed.

**Verify:** `node scripts/benchmark-drawing-lifecycle.mjs --synthetic --assert --output /tmp/arc-drawing-register.json` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

## Test plan

Test empty project, stale old MV, rejected draft sheets, multiple published versions, exact version selection, cross-project denial, sharing restrictions, stable pagination, counts and historical snapshots. Include concurrent reader/publication behavior on real Postgres.

## Done criteria

- [ ] Current readers return committed changes without running or waiting for refresh.
- [ ] Publication RPC does not call the global refresh after reader cutover.
- [ ] All inventoried current consumers pass parity tests; historical snapshots remain unchanged.
- [ ] All applicable commands pass; database/browser gates have recorded evidence, not silent skips.
- [ ] Typecheck/lint introduce no regressions; failures predating the change are separately recorded.
- [ ] Review the diff against the recorded starting workspace; only scoped changes belong to this plan.
- [ ] Record schema/application rollout order, rollback behavior and remaining deployment gates in this plan; update advisor-plans/README.md.

## STOP conditions

If a consumer requires the global MV and cannot be migrated within scope, retain the synchronous refresh and report cutover incomplete. Do not label an asynchronous stale register as done. Also stop for unexplained source drift, two failed attempts at the same gate, required changes outside scope, or an unverified backend target. Report the specific blocker and retain safe progress.

## Maintenance and rollout

PostgreSQL REFRESH replaces the whole MV; CONCURRENTLY avoids some reader blocking but still rebuilds it. Official reference: https://www.postgresql.org/docs/current/sql-refreshmaterializedview.html . Keep a tested schema-first/application-second rollout and reverse rollback order. Roll out additive schema before consumers; retain old readers/handlers during transition. Rollback must leave durable operations and immutable artifacts recoverable. Tests passing locally do not mean pending migrations were deployed.

## Implementation evidence — 2026-10-01

Readers use the live scoped register; obsolete refresh enqueue calls were removed, with a legacy no-op consumer retained. The compatibility view preserves its previous column order. Combined migration tests pass and a 2,000-unrelated-row fixture demonstrates scoped index usage; EXPLAIN evidence is `/tmp/arc-drawing-register-explain.json`. This is fixture evidence, not production p95.

Schema rollout remains pending: apply additive migrations in filename order on a disposable fully migrated database, validate old/new worker compatibility, then obtain the required migration approval before release. Do not roll back by dropping operation receipts or artifact tombstones. Parent review and final integration checks remain separate gates.
