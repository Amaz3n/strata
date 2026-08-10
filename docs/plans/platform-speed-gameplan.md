# Platform Speed & Feel Gameplan

> **Status: ACTIVE PLAN — intent, not a description of the system.**
> Nothing in this document is guaranteed to exist. Never infer current app
> behavior from it. Source of truth is the code, `CLAUDE.md`, and the
> reference docs at the `docs/` top level.

**Status:** Awaiting execution. Written 2026-07-31.
**Audience:** an LLM executor. Six workstreams that make Arc *feel* instant:
streaming/PPR, View Transitions, image placeholders/formats, OPFS tile cache,
incremental desk rollups, and multiplayer presence. Each is independent; recommended
order at the end.

Global doctrine: measure before/after (each WS defines its metric); no regressions to
`pnpm lint && npx tsc --noEmit`; migrations written-not-applied; delete what you
replace.

---

## WS-S1 — Streaming + Partial Prerendering (Next 16 Cache Components)

### Ground truth
- `next.config.mjs`: Next 16.2.7 / React 19.2, webpack (not Turbopack),
  `cacheComponents` NOT set, `ppr` NOT set, zero `"use cache"`, zero
  `unstable_cache` — caching is 100% greenfield.
- 77 files under `app/(app)` declare `export const dynamic = "force-dynamic"`.
- 32 `loading.tsx` files; 44 files use `Suspense` — the good pattern exists
  (e.g. `app/(app)/projects/page.tsx:47` wraps `<ProjectsData/>` in Suspense).
- The two worst offenders do NOT stream: `app/(app)/page.tsx` (Home) and
  `app/(app)/control-tower/page.tsx` both `await Promise.all([getControlTowerData(),
  getWatchlist()])` — `getControlTowerData` alone is ~16 parallel queries + a
  sequential 17th (`dashboard_budget_rollup` needs activeProjectIds). TTFB is gated
  on the slowest query.
- `app/(app)/sales/page.tsx`: sequential awaits (`getAmbientDeskContext` →
  `listSalesDeals(ROW_CAP=500)` → second Promise.all) — the first is a true
  dependency, the third is not.
- `app/(app)/layout.tsx` runs ~12 parallel loaders (auth/org/permissions) before any
  page renders.

### Metric
TTFB and LCP on Home, control-tower, and one desk (`/sales`) — capture via Vercel
Analytics before starting; target: shell paint < 300ms, first band < 800ms on prod.

### Phase 1 — Streaming without config changes (safe, do first)
Convert the await-all desk pages to shell + Suspense bands. For Home/control-tower:
1. Split `getControlTowerData` into per-band loaders (`getMoneyBand`,
   `getScheduleBand`, `getExceptionsBand`, `getActivityBand`) — the 16 queries
   already group naturally; keep each band's queries in one `Promise.all`.
2. Page becomes: static shell (headers, band chrome, `.desk-rise` once) + one
   `<Suspense fallback={<BandSkeleton/>}>` per band, each wrapping an async server
   component that calls its loader. Bands render as they land; slowest no longer
   gates the page.
3. Preserve the production-posture branch (`getOrgProductTier()` in the shell —
   it's cheap and layout-affecting; it stays un-suspended).
4. `/sales`: keep the true dependency sequential, but move the team-members +
   lost-reasons Promise.all into a suspended band; deal table streams separately
   from its filters.
5. Rule for the executor: a Suspense boundary per *band*, never per *row/cell*;
   fallbacks are the existing skeleton components (match sibling skeletons — do not
   invent new ones).

### Phase 2 — Cache Components (`use cache`) pilot
STOP before this phase: enabling `cacheComponents: true` in next.config changes
build behavior globally; get human sign-off and do it on a branch with full manual
QA of auth flows (the (app) layout's 12 loaders MUST stay dynamic).
1. Enable `cacheComponents: true`. Fix build errors it surfaces (it will demand
   explicit boundaries where dynamic data leaks into static scopes).
2. Candidates for `"use cache"` + `cacheLife`/`cacheTag` (read-heavy,
   change-slow, org-scoped keys): terminology/posture lookups, report catalog
   definitions, plan-library covers, community price sheets (5-min life), the
   sidebar's static nav structure. Tag by org (`cacheTag(\`org-\${orgId}-pricing\`)`)
   and invalidate with `updateTag` in the mutating actions (price edits call it).
3. NEVER cache: anything permission-dependent per user, financpartial rows, badge
   counts (WS-S5 handles those), portal/token pages.
4. Roll out per-surface; `force-dynamic` deletions happen surface-by-surface as each
   is verified, not as a sweep.

### Acceptance
Home shell visible before any band data on a throttled connection; no auth
regression (`pnpm test:auth`); metrics captured before/after in the PR description.

---

## WS-S2 — View Transitions

### Ground truth
Zero usage today (`startViewTransition`, `view-transition-name` absent). Motion
doctrine: one `.desk-rise` entrance per page, hover ≤200ms, no idle animation —
navigation continuity is the one sanctioned polish channel.

### Directives
1. Enable Next's built-in ViewTransition support (Next 16 ships experimental
   `viewTransition: true`; verify the flag name against the installed version's docs
   — `next.config.mjs` experimental block).
2. Apply to THREE high-traffic morphs only (v1):
   - Desk row → detail sheet: `view-transition-name` on the row's title/amount and
     the sheet's header equivalents (invoices, bills, deals).
   - Project list → project overview: project name + status chip morph.
   - Drawings: sheet thumbnail → viewer canvas frame.
3. Respect `prefers-reduced-motion` (transitions off entirely). Durations ≤ 200ms,
   default easing; no springs, no scale-bounce (ascetic zone).
4. Names must be unique per viewport instant: derive from entity id
   (`vt-invoice-${id}`), and only assign to the visible/clicked row (assign on
   interaction via style, not statically on 500 rows — 500 identical names is
   undefined behavior and a perf hazard).
5. Dark mode + Safari verification are part of done (Safari's VT support differs;
   feature works as progressive enhancement — no fallback code needed, absence is
   the fallback).

---

## WS-S3 — Image placeholders + modern formats (blurhash/thumbhash + AVIF)

### Ground truth
- `images.unoptimized: true` — next/image does NOTHING here.
- Photos: no `width/height` columns, no blurhash, one preview thumbnail per file
  (`generate_file_preview` outbox job → single jpg/webp at
  `documents/previews/{fileId}/...`), HEIC converted server-side, iOS uploads
  full-res with no client resize, `photos` table recently gained
  ai_caption/albums/visibility but nothing dimensional.
- Plan covers render as raw `<img src="/api/files/{id}/raw">`
  (`components/plans/plan-product-panel.tsx:63`).

### Directives
1. **Capture dimensions + thumbhash at preview time:** extend the
   `generate_file_preview` job: while sharp has the decoded image, also compute
   `{ width, height, thumbhash }` (thumbhash over blurhash — smaller, better
   gradients; base64 ~28 bytes). Store on `files.preview_metadata` jsonb (column
   exists via `updateFilePreviewMetadata` — extend its payload; verify the column
   name in `lib/services/files.ts` and reuse, no migration if it's jsonb).
   Backfill: enqueue `generate_file_preview` for image files missing thumbhash,
   rate-limited batch via the existing job (dedupe on file id).
2. **Responsive ladder for photos:** the preview job emits THREE sizes for image
   files (320w, 960w, 2048w) as WebP AND AVIF (sharp supports AVIF; encode AVIF at
   effort ≤ 4 to keep job time sane), stored under the same preview path family.
   `files.preview_metadata.sizes` records what exists. Photo grids request via a
   tiny helper `photoSrcSet(file)` → `<img srcset sizes loading="lazy"
   decoding="async">`; detail views take 2048w. DELETE nothing yet — old single
   thumbnails serve as fallback until backfill completes, then remove the fallback
   branch (leave-no-trash, end state one path).
3. **Render placeholders:** shared `<HashImage>` component: paints thumbhash to a
   canvas/CSS gradient instantly, fades the real image in over 150ms, reserves
   aspect ratio from stored dimensions (kills photo-grid layout shift). Use in
   photo grids, plan covers, portal photo feed. Do not apply to drawings tiles
   (viewer has its own pipeline).
4. **iOS uplink sanity (companion fix):** add client-side downscale in the iOS app
   before upload (long edge 3072px, HEIC→JPEG q0.85) for PHOTO uploads only
   (documents stay original). This is in `ios/Arc` (`MobileAPIService.swift`
   upload paths) — separate PR, `pnpm test:mobile` contract unchanged.

### Acceptance
Photo grid CLS ≈ 0; grid payload for 48 photos < 1.5MB (from full-res previously);
thumbhash visible < 50ms on throttled 4G; HEIC/AVIF verified in Safari + Chrome +
dark mode.

---

## WS-S4 — OPFS tile cache for drawings

### Ground truth
- `lib/viewer/tile-loader.ts`: in-memory only — `Map` LRU of decoded textures
  (`DEFAULT_MAX_TILES = 600`, `DEFAULT_MAX_CONCURRENT = 12`), fetch →
  `createImageBitmap` → GPU upload; 401/403 → `onAuthError` (cookie re-mint).
- Tiles are HTTP-cached (`cache-control: private, max-age=31536000, immutable` from
  the proxy route; CDN path via cdn.arcnaples.com signed cookie). Immutability is
  REAL: tile paths embed generation (`TILE_PATH_GENERATION = r{dpi}-{size}-{fmt}`)
  and content hash (`tilesBasePath(orgId, sourceHash, pageIndex)`) — a URL's bytes
  never change. This makes caching trivially safe.
- `idb-keyval` already a dependency (used by offline daily-log/safety drafts). No
  OPFS/Cache API usage anywhere.

### Design decision
Use **Cache API first, OPFS second**. Rationale for the executor: tiles are
immutable HTTP responses — `caches.open('arc-tiles-v1')` gives request-keyed
storage with zero serialization code and works in every target browser;
OPFS+SyncAccessHandle adds value only for the *manifest/vector* sidecars and
very large pinned sets. Implement Cache API now; the interface below leaves OPFS as
a drop-in later. (If the human explicitly wants OPFS-only, the interface absorbs
it.)

### Directives
1. `lib/viewer/tile-cache.ts` — interface `TileCache { match(url):
   Promise<Response|null>; put(url, response): Promise<void>; prune(budgetBytes):
   Promise<void> }` with `CacheApiTileCache` implementation. Wire into
   `TileLoader.load()`: check cache → hit: decode from cached response → miss:
   fetch, `put` a CLONE (async, non-blocking), decode. Auth note: cache AFTER
   successful fetch only; cached entries bypass the cookie (acceptable — the URL
   embeds org-scoped path and unguessable content hash; STOP only if the human
   considers cached-tile-after-revocation a threat — then key entries with a
   session epoch and clear on logout, which you should implement anyway on the
   signout path: `caches.delete('arc-tiles-v1')`).
2. Budget + pruning: `navigator.storage.estimate()`-aware; default budget 512MB;
   LRU by an `idb-keyval` touch index (url → lastAccess); prune on viewer mount
   when over budget. Never call `navigator.storage.persist()` without a user
   gesture/setting.
3. **Prefetch pinning:** "Available offline" toggle per sheet set (viewer toolbar):
   walks the manifest, fetches all tiles of levels ≤ current+1 through the cache
   (respecting `DEFAULT_MAX_CONCURRENT`), progress chip; pinned sets exempt from
   pruning (pin registry in idb-keyval). This is the field-laptop story.
4. Manifest + `vectors.bin` + thumbnails go through the same cache (they're on the
   same immutable path family — `use-sheet-vectors.ts` and the manifest fetch adopt
   `tile-cache` too).
5. Metric: reopen of yesterday's 300-sheet set — tile network requests ≈ 0,
   first-render from cache < 200ms. Instrument via the existing
   `use-drawing-performance.ts` hook.

---

## WS-S5 — Incremental desk rollups (kill the unbounded count queries)

### Ground truth
- `getNavigationBadgeCounts` runs on EVERY sidebar render: four UNBOUNDED
  `select("project_id")` row-pulls (time_entries submitted, project_expenses draft,
  vendor_bills pending, billable_costs open) counted in JS, then an N×2
  `authorize()` fan-out per project, plus task-assignment pulls filtered in JS.
- `getControlTowerData`: 16 queries incl. 7 unbounded row-pulls; precedent for
  aggregates exists — `dashboard_invoice_rollup` / `dashboard_budget_rollup` jsonb
  RPCs (migration `20260710090000_dashboard_rollups.sql`).
- Exactly ONE materialized view in the system (`drawing_sheets_list_mv`) and its
  refresh is NON-concurrent (caused an ACCESS EXCLUSIVE incident, later hardened) —
  do not copy that refresh pattern.
- No pg_ivm extension; treat availability as unknown (STOP: confirm with the human
  whether installing an extension on prod Supabase is acceptable — the design below
  does NOT require it).

### Design: counter table maintained by triggers (not pg_ivm, not MV)
Badge-class rollups are per-(org, project, kind) COUNTS over status subsets —
perfect for a trigger-maintained counter table; exact, transactional, no refresh
cadence, no extension risk.

1. Migration (write, then STOP):
   `desk_rollup_counts` — org_id, project_id, kind text
   (`review_time | review_expenses | review_bills | review_costs |
   ready_to_bill_costs | ready_to_bill_draws`), count int not null default 0,
   updated_at; PK (org_id, project_id, kind).
   Per source table, an AFTER INSERT/UPDATE/DELETE trigger function computes the
   delta of an `is_counted(row)` predicate (OLD vs NEW) and upserts
   `count = count + delta`. Predicates mirror EXACTLY the filters in
   `navigation-badges.ts` (time_entries status ∈ submitted/pm_approved; expenses ∈
   draft/submitted; vendor_bills = pending; billable_costs open+billable). Write
   the predicates ONCE as SQL functions so trigger + backfill share them.
   Backfill statement populates from current data in the same migration.
   Triggers are cheap single-row upserts; contention is per (project, kind) —
   acceptable at Arc's write rates. Include a nightly verifier query (drift check
   counts vs. live predicate; log discrepancy to ops) — trigger bugs must be
   detectable.
2. Service rewrite: `getNavigationBadgeCounts` reads `desk_rollup_counts` for the
   org in ONE query, then applies the permission filter. Replace the N×2
   `authorize()` fan-out: batch to ONE evaluation per distinct permission by
   resolving the user's project-scope once (extend the existing authorization
   caching from the July 2026 perf pass — `authorize()` already caches; add a
   `authorizeMany(permission, projectIds)` helper in `lib/services/authorization.ts`
   that evaluates scope containment in a single pass).
3. Control-tower band loaders (WS-S1) adopt rollup RPCs for their counting needs:
   extend the `dashboard_*_rollup` RPC family rather than pulling rows to count in
   JS (new RPC per band where a 7-way head-count batch exists today). Unbounded
   row-pulls that feed LISTS (not counts) get explicit caps + "showing N" per the
   lists doctrine.
4. DELETE the four unbounded queries and the per-project authorize loop in the same
   change (leave-no-trash).

### Acceptance
Sidebar badge computation ≤ 2 queries total; p95 sidebar server time drops
measurably (log before/after); nightly verifier shows zero drift for a week on QA
org; `pnpm test:financials` badge-adjacent tests green.

---

## WS-S6 — Multiplayer surfaces (Yjs + Supabase Realtime)

### Ground truth
- Exactly ONE realtime subscription in the codebase (`use-notifications.ts`,
  postgres_changes on notifications). No broadcast, no presence anywhere.
- CAUTION from grounding: the `notifications` table's publication membership is
  managed OUTSIDE version control (no migration adds tables to
  `supabase_realtime`). Any new postgres_changes dependency must fix this first —
  but this WS uses BROADCAST + PRESENCE channels, which need no publication.
- Candidate surfaces with real simultaneous work: takeoff on a sheet (Procore
  markets multi-user takeoff), bid leveling grid on bid day, punch triage.

### Scope discipline (v1 = presence + live-refresh, NOT co-editing)
Full CRDT co-editing of markups is a deep integration into the takeoff data model
(server-computed quantities, `QUANTITY_EPSILON` semantics, conditions rollups).
V1 delivers 80% of the collaboration value with 20% of the risk:

1. **Presence layer** — `lib/realtime/presence.ts`: `useRoomPresence(roomKey,
   meta)` on Supabase Realtime presence channels (`room:sheet:{sheetId}`,
   `room:bidpkg:{packageId}`). Shows avatars + colored cursors (throttled 10Hz
   broadcast of normalized coords — the drawings coordinate system is already
   normalized 0..1, reuse it). Cursor layer draws in the existing
   `svg-overlay.tsx`. Room key must embed org and be verified server-side: gate
   channel names through a short server action that returns a signed channel token
   (Supabase Realtime authorization / private channels) — presence must not leak
   across orgs. STOP if private-channel auth isn't enabled on the Supabase project;
   enabling it is a human/dashboard step.
2. **Live refresh** — same channels carry broadcast events (`markup_changed`,
   `bid_updated`) emitted from the relevant server actions post-commit
   (fire-and-forget). Clients react by re-fetching the affected slice (router
   refresh or targeted SWR) — the DB stays the single writer, no merge semantics,
   no divergence risk. Editing conflicts resolve as they do today (last write), but
   users now SEE each other, which prevents most collisions socially.
3. **Soft locks:** presence meta includes `editing: markupId|null`; the overlay
   renders "Maria is editing this" on the shape. Advisory only.
4. **Phase 2 (design gate, do not build):** true Yjs co-editing for DRAFT takeoff
   shapes only (pre-commit geometry), server as Yjs awareness relay, commit =
   existing server action. STOP for human review of the takeoff-data implications
   before any Yjs document is introduced.

### Acceptance
Two browsers on one sheet see each other's cursors < 200ms round-trip; a markup
committed in one appears in the other < 2s without reload; channel tokens scoped —
cross-org join attempts fail (test with two QA-org users + a foreign token);
presence adds zero queries to initial page load (lazy after mount).

---

## Recommended order
S1-phase-1 (streaming) → S5 (rollups; unblocks S1's band speed) → S3 (images) →
S2 (transitions) → S4 (tile cache) → S6 (presence) → S1-phase-2 (`use cache`, after
everything above has burned in).
