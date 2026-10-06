# Plan 011: Reuse verified unchanged pages across revised PDF packages
> Executor: read the entire plan, implement only its scope, run each verification gate and record evidence. Update this plan and the index status only after its done criteria hold.

- **Planned at:** `9f1549af`, 2026-10-01, including the reviewed dirty workspace.
- **Priority / effort / risk:** P2 / L / HIGH
- **Depends on:** 003, 007, 010
- **Status:** IMPLEMENTED / RELEASE PENDING — integrated; see [verification and rollout record](drawings-implementation-2026-10-01.md).
- **Confidence:** HIGH for current-code findings; proposed performance gains require measurement.

## Why this matters

Current reuse matches source_hash of the entire PDF plus page_index. A one-page edit or reordered PDF misses every donor even when most drawings are unchanged. Separate version identity from immutable reusable rendering artifacts. Correct equivalence is more important than hit rate: page reuse must never hide a drawing change or copy version-specific calibration, markups or publication decisions.

## Current state and drift check

Run `git diff --stat 9f1549af..HEAD -- lib/drawings/page-artifact-key.ts lib/services/drawings-pipeline.ts lib/services/drawing-storage-cleanup.ts lib/storage/drawings-tiles-storage.ts 'supabase/migrations/*_drawing_page_artifacts.sql' supabase/tests/drawing_page_artifacts.test.sql tests/drawing-page-artifacts.test.js tests/drawing-metadata-pipeline.test.js 'tests/fixtures/drawing-lifecycle/**' scripts/benchmark-drawing-lifecycle.mjs` and compare the working-tree hashes in `advisor-plans/drawings-source-snapshot.json`. Expected prerequisite edits are not failures: inspect them, preserve their contracts, and refresh these excerpts before executing. Unrelated mismatches require review.

`lib/services/drawings-pipeline.ts:799`

```
  // Full sha256: the hash is the sole namespace for tile paths, and a
  // truncated hash colliding across two PDFs would silently overwrite tiles.
  // (Legacy 16-char paths keep working — paths are stored per version.)
  const sourceHash = createHash("sha256").update(pdfBytes).digest("hex")

```

`lib/services/drawings-pipeline.ts:1728`

```
  const { data } = await supabase
    .from("drawing_sheet_versions")
    .select(
      "id, tile_manifest, tile_base_url, tile_levels, thumbnail_url, image_width, image_height, tile_manifest_path, tiles_base_path, page_text, extracted_metadata",
    )
    .eq("org_id", orgId)
    .eq("source_hash", sourceHash)
    .eq("page_index", pageIndex)
    .not("tile_manifest", "is", null)
    // Never adopt a mid-upload partial pyramid: the adopter would keep the
    // truncated manifest after the donor's own row gets the full one.
    .is("tile_manifest->Partial", null)
    .neq("id", excludeVersionId)
    .order("created_at", { ascending: false })
    .limit(1)
```

## Repository conventions and boundaries

Work in `/Users/agustinzenuto/Desktop/Projects/arc` (or its faithfully copied review checkout). Next.js 16 / React 19 / TypeScript, pnpm, Supabase Postgres and R2. Follow `lib/action-result.ts`: `type ActionResult<T> = { success: true; data: T } | { success: false; error: string; code?: string }`; server actions return results, services own logic. Validate inputs and enforce org plus project permission at every externally callable boundary. Keep SQL org-scoped, RLS enabled, and internal worker RPC grants service-only where appropriate. Do not silently escalate to SECURITY DEFINER.

The workspace already has extensive uncommitted/untracked work. Record `git status --short` and `git diff -- <scope>` before editing; never reset or overwrite it. SHA alone is insufficient: the supplied `drawings-source-snapshot.json` hashes the reviewed working-tree files, including untracked files. Re-read changed files and update the plan after prerequisite changes; stop on unrelated drift. New migration names below are allowed suffixes, not existing files: use the repository's migration creation workflow. No historical migration edits.

Local app configuration points at production. Do not run mutation tests against it, apply production migrations, start another dev server, or run a local production build. Database contracts run against an explicitly disposable local/CI database. Author additive migrations and report their deployment status separately. Preserve unrelated financials, iOS UX, portal sharing policy, source PDF ownership and existing sheet history. No dependency/platform replacement or production rollout is authorized by this plan artifact.

Use branch `codex/drawings-<plan-slug>` if an executor needs a branch; preserve the working tree and do not push, merge or open a PR without task authorization. Existing commit style is plain imperative (for example `Fix request-bound pages blocking instant navigation`); do not commit merely to finish this plan.

## Scope

Modify only these paths (new files and narrowly named migration patterns are intentional):

- `lib/drawings/page-artifact-key.ts`
- `lib/services/drawings-pipeline.ts`
- `lib/services/drawing-storage-cleanup.ts`
- `lib/storage/drawings-tiles-storage.ts`
- `supabase/migrations/*_drawing_page_artifacts.sql`
- `supabase/tests/drawing_page_artifacts.test.sql`
- `tests/drawing-page-artifacts.test.js`
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
| SQL contract | `supabase test db supabase/tests/drawing_page_artifacts.test.sql --local` | all assertions pass on explicitly disposable local DB; otherwise require CI evidence |

The existing database-contracts CI job uses `supabase db start` then `supabase test db --local`. Do not use production environment credentials to make these tests run. Use `pnpm verify` only in the existing CI context: it includes a build.

## Steps

### 1. Prove a conservative equivalence key

Implement and benchmark candidate canonical single-page fingerprints on synthetic PDFs. Include page resources/fonts, images, geometry, boxes, rotation, annotations/layers and renderer generation/configuration. A serialized standalone page can be an exact-content fast path only after determinism is demonstrated. Low-resolution perceptual hashes may nominate candidates but never authorize reuse. Any unsupported document feature falls back to rendering. Keep whole-file exact reuse working.

**Verify:** `node --test tests/drawing-page-artifacts.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 2. Extend the deletion artifact guard into reusable artifacts

Reuse plan 007 org/path generation ownership; add verified fingerprint, rendering recipe, completion state and immutable manifest. Version rows reference ready artifacts; concurrent builders use a unique scoped key and owned build lease. Adoption and garbage-collection claims use the same transactional guard. Retain legacy fields/read fallback and never overwrite objects under immutable URLs. Each build attempt generation has a unique immutable physical prefix even when its logical fingerprint is identical; a deleting/deleted prefix is never reactivated. A newly built equivalent artifact gets a new generation and URL, so delayed deletes for the old generation cannot damage it. Reconcile late writes against the retired-generation cleanup ledger from 007.

**Verify:** `node --test tests/drawing-page-artifacts.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 3. Adopt rendering assets without adopting version semantics

Match pages independent of page position; use verified full manifests only. Reuse pixels, text and extraction outputs only when their own recipe versions match. Do not copy calibration confirmation, markup IDs, pending AI flags or reviewed identities from another revision. Preserve original source/version records for audit and history. Cache verified title-block extraction only with its model/prompt recipe and sufficient provenance; user-confirmed identity still belongs to the current review.

**Verify:** `node --test tests/drawing-page-artifacts.test.js tests/drawing-metadata-pipeline.test.js` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

### 4. Enable guarded reuse with corpus evidence

Run changed-one-page and reordered packages; record render count, reuse hit count, bytes and correctness. Enable only equivalence cases established by tests; keep fallback cheap and visible in telemetry. Test adoption/deletion and simultaneous producer races against SQL. Do not perform a broad historical backfill; discover/cache artifacts lazily.

**Verify:** `node scripts/benchmark-drawing-lifecycle.mjs --synthetic --assert --output /tmp/arc-drawing-reuse.json` → exit 0, with assertions for the behavior introduced by this step. Tests must execute the affected implementation, not only search source text.

## Test plan

Include same content with new PDF metadata, reordered pages, changed annotation, crop/rotation, tiny text change, font change, optional layers, embedded images, missing resource, renderer change, partial manifest, failed reference lookup and cross-org matches. Every changed visible fixture must miss reuse. Unchanged supported fixtures must hit without a full tile render.

## Done criteria

- [ ] For the supported 300-page fixture with one changed page: 299 artifact hits and one newly tiled page.
- [ ] Reordered supported pages retain hits independent of original page index.
- [ ] No changed-content fixture reuses old pixels; uncertain cases render anew.
- [ ] Shared artifact remains available until its final durable and active-work reference is released.
- [ ] All applicable commands pass; database/browser gates have recorded evidence, not silent skips.
- [ ] Typecheck/lint introduce no regressions; failures predating the change are separately recorded.
- [ ] Review the diff against the recorded starting workspace; only scoped changes belong to this plan.
- [ ] Record schema/application rollout order, rollback behavior and remaining deployment gates in this plan; update advisor-plans/README.md.

## STOP conditions

If no deterministic safe fingerprint is demonstrated, finish the experiment with reuse disabled for those PDFs; do not substitute perceptual similarity or stripped-content hashing. Record the unsupported cases and measured fallback cost. Also stop for unexplained source drift, two failed attempts at the same gate, required changes outside scope, or an unverified backend target. Report the specific blocker and retain safe progress.

## Maintenance and rollout

Fingerprint and renderer recipe versions are part of the cache key forever. This plan does not alter takeoff geometry or financial rollups; those follow publication/re-anchor rules. Roll out additive schema before consumers; retain old readers/handlers during transition. Rollback must leave durable operations and immutable artifacts recoverable. Tests passing locally do not mean pending migrations were deployed.


## Implementation evidence — 2026-10-01

Implemented conservative exact standalone-page fingerprints, versioned by actual MuPDF WASM hash, Sharp/native encoder versions and effective render settings. Unsupported annotations, optional layers, output intents and uncertain resources fall back to rendering the original source. Artifacts use immutable generation prefixes, writer renewal, full manifest validation, durable render receipts independent of their original version, organization-bound references, atomic adoption/retirement and periodically rescanned cleanup tombstones.

Validation: actual processDrawingPage handler execution on the supported 300-page one-change fixture performs 299 artifact adoptions, one page download and one native render/activation. This uses in-memory storage/RPC fixtures; PGlite separately verifies artifact lifecycle transactions. Changed text/font/image/crop/rotation/recipe fixtures miss reuse. Original-version deletion preserves reusable render receipts; partial manifests, retired references, cross-organization references and expired writers are rejected.

Additive migration order: job leases and artifact base tables, storage deletion/publication prerequisites, then `20261001162622_drawing_artifact_guards.sql`, `20261001162632_drawing_split_manifest.sql`, and `20261001164202_drawing_split_registration.sql`. These files were authored and tested only; none was deployed. Drain legacy workers before enabling consumers. Keep durable intents/artifacts and their cleanup tombstones during rollback. Production storage behavior, true concurrent Postgres sessions, dense/scanned source memory and browser acceptance remain release gates; synthetic/PGlite evidence does not substitute for them.
