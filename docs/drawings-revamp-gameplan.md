## Drawings Revamp Gameplan (v3) — Maximum Performance + Usability

### TL;DR (north-star)
- **Viewer renders images/tiles, never PDFs.** PDFs are for download/print only.
- **No per-item signed URL generation in lists.** Lists return metadata + cacheable image URLs only.
- **Instant open:** click → viewer opens in **<100ms** with a cached thumbnail, then upgrades to hi-res/tiles.
- **Deep zoom without jank:** use **tiled pyramid** (DeepZoom/IIIF-style) for large sheets.
- **Pins/markups are vector overlays** in normalized coordinates (0–1), streamed/loaded async.

---

## 1) What’s broken today (root causes)

### 1.1 Wrong “asset access model” (causing 400s + complexity)
- Images are stored in a **private** bucket (`project-files` is `public=false`).
- The DB stores **public URLs** for those images (`/storage/v1/object/public/project-files/...`) which 400 for private buckets.
- The UI sometimes assumes images are public and tries to fetch them directly.

**Fix principle:** DB stores **storage paths** (canonical), and the app decides how to serve them (public bucket, signed, or proxied).

### 1.2 “List view” does expensive work it should never do
- Generating signed URLs per sheet (N× requests) kills initial load and makes server render slow.

### 1.3 Viewer open is blocked on non-critical network work
- Download URL, pins, markups, version list, etc. should not block first paint of the drawing.

---

## 2) Target experience + performance budgets

### 2.1 List/grid (sets + sheets)
- **First meaningful paint:** < 500ms (cached), < 1.5s cold.
- **Skeleton removal:** tied to first data payload only (no waterfall of N calls).
- **Scrolling:** 60fps with virtualization when sheet counts are large.

### 2.2 Viewer
- **Time to “something visible”:** < 150ms (thumbnail).
- **Time to readable:** < 500ms (medium).
- **Time to full quality:** < 1s (full or initial tiles).
- **Pan/zoom:** 60fps; no layout thrash; no massive re-renders.

### 2.3 Network + caching
- Images/tiles served with:
  - `Cache-Control: public, max-age=31536000, immutable`
  - versioned URLs (content-hash in filename) so they can be cached forever.
- Pins/markups: cacheable with ETags; invalidate on writes.

---

## 3) Architecture decisions (choose one and commit)

### Option A (recommended): Public “drawings-images” bucket + private PDFs
**Best performance / least complexity.**
- **Bucket:** `drawings-images` (public=true) for thumbnails/medium/full/tiles.
- **Bucket:** `project-files` (public=false) for PDFs and private documents.
- **Security model:** images are not sensitive; access is enforced by obscurity + tenancy pathing + app auth for metadata.
  - Path format includes org + project + set + version ids.
  - Use content-hash filenames to prevent mutation and allow immutable caching.

**Pros**
- Fastest: direct CDN fetch, no signing, no proxy.
- Simplest UI: Next/Image (unoptimized) or plain `<img>` + prefetch.

**Cons**
- Images are technically public if someone guesses URLs (mitigate with unguessable IDs + no listing without app access).

### Option B: Private storage + app image gateway (signed/proxied)
**Most secure, more engineering.**
- Images stored private.
- Viewer loads via your app route:
  - `/api/drawings/sheets/:sheetVersionId/image/:size`
  - `/api/drawings/sheets/:sheetVersionId/tiles/:z/:x/:y.webp`
- Route performs auth, then fetches from storage with service role, returns with aggressive `s-maxage` caching.

**Pros**
- Real access control at the asset layer.

**Cons**
- More moving parts; easy to regress performance if proxy is not cached correctly.

**Decision recommendation:** Start with **Option A** now for speed + simplicity. If enterprise customers demand strict asset privacy later, migrate to Option B with the same DB model (storage paths + versioning).

---

## 4) Data model (canonical contracts)

### 4.1 Store canonical paths, not URLs
In `drawing_sheet_versions` store:
- `thumb_path`, `medium_path`, `full_path` (or `thumb_key`, etc.)
- optional: `tile_manifest_path` (JSON describing tiling)
- `image_width`, `image_height`, `images_generated_at`
- keep `file_id` for PDF download

**Do NOT store**:
- `getPublicUrl()` outputs
- signed URLs

### 4.2 Viewer contract
When opening a sheet, client should receive a **single JSON payload**:
- sheet metadata
- image sources (either direct public URLs, or gateway URLs)
- pins/markups summary (counts) + async endpoints for full data

---

## 5) Rendering strategy (how we win on usability)

### 5.1 Progressive loading (always)
- Stage 1: thumbnail (fast)
- Stage 2: medium (readable)
- Stage 3: full or tiles (zoom)

### 5.2 Deep zoom via tiles (recommended)
For large construction sheets, full images still get heavy at deep zoom.
- Generate tiles at multiple zoom levels (e.g. 256px tiles).
- Viewer requests only tiles in viewport.
- Overlay pins/markups on top using normalized coordinates.

### 5.3 Overlays: keep them cheap
- Pins layer: DOM (absolute positioned) with clustering; only render visible pins.
- Markups layer: Canvas or SVG (choose one), but avoid re-rendering on every mousemove:
  - keep drawing-in-progress in a dedicated layer.
  - saved markups should be memoized and only redraw when data changes.

---

## 6) Processing pipeline (upload → ready)

### 6.1 Background job (preferred)
On upload:
- Store original PDF (private).
- Split into per-sheet PDFs (optional).
- Generate:
  - thumb/medium/full images OR tiles
  - dimensions
- Write DB paths + metadata.

**Implementation options**
- Node worker (BullMQ / pg-boss / Supabase background job pattern)
- External service (Cloudinary/imgix) if you want speed of implementation over control

### 6.2 Client-side generation (only as temporary stopgap)
If used:
- must store paths, not “public urls”
- must upload to the correct bucket (public images bucket if Option A)
- should run in Web Workers to avoid freezing UI

---

## 7) Page redesign (information architecture)

### 7.1 “Drawings Home” (fast overview)
- Left: discipline filter + sets filter
- Main: virtualized grid/list of sheets
  - thumb + sheet number + title
  - quick status dots (pins/markups counts) — loaded lazily

### 7.2 Viewer (single responsibility)
- The viewer should not fetch list data, sets data, etc.
- It receives:
  - sheet image sources (thumb/medium/full or tiles)
  - overlays (pins/markups)
- It can optionally prefetch next/prev sheet thumbnails.

---

## 8) Phase plan (ship value fast, keep refactors safe)

### Phase 0 — Stop the bleeding (1 day)
- Decide Option A vs B.
- Change DB to store canonical **paths** (add new columns; keep old columns temporarily).
- Add logging for:
  - list load time
  - viewer open time
  - asset request errors (400/403)

### Phase 1 — Fast list + instant viewer (2–3 days)
- Lists return **metadata only** + image URLs that are actually fetchable.
- Viewer open does not block on pins/markups/PDF URL.
- Add sheet virtualization for large projects.

### Phase 2 — Tiles for deep zoom (3–7 days)
- Generate tile pyramid + manifest.
- Viewer uses tiles when zooming past threshold.
- Keep overlays consistent with normalized coords.

### Phase 3 — Prefetch + offline-ish (1–2 days)
- Prefetch adjacent sheets (thumbnail+medium).
- Cache last N viewed in browser cache (via standard caching headers; avoid complex SW).

### Phase 4 — Migration + cleanup (1–3 days)
- Backfill existing sheets to new image bucket/paths.
- Remove old “public url” columns and any signed-url-in-list logic.

---

## 9) Instrumentation (non-negotiable)
- Emit metrics for:
  - `drawings_list_loaded` (server + client)
  - `drawing_viewer_opened`
  - `drawing_first_visible` (thumbnail)
  - `drawing_readable` (medium)
  - `drawing_full_quality` (full/tiles ready)
  - asset error rate by type (thumbnail/medium/full/tiles)
- Store P50/P95 in Vercel analytics or your events table.

---

## 10) Explicit “rules of the road”
- **No signed URLs in list endpoints. Ever.**
- **No PDF rendering in the viewer. Ever.**
- **No storing URLs in DB. Store canonical paths + metadata.**
- **Immutable versioned asset URLs.** Never overwrite; always create new version.

---

## 11) Immediate next engineering decision (needed before coding)
Pick one:
- **Option A:** create `drawings-images` (public) bucket and migrate image uploads there.
- **Option B:** build `/api/drawings/assets/*` gateway and keep bucket private.

Once chosen, the rest of the implementation becomes straightforward and stable.

