# Drawings: Stable PDF→Images Conversion via Cloud Run Worker (Gameplan)

## TL;DR
Your pain isn’t “React”. It’s **running CPU-heavy, native-dep PDF rendering inside Next/Vercel request handlers** (timeouts, memory ceilings, cold starts, dependency fragility), plus **PDF libraries that don’t fit serverless**.

**Fix**: move PDF rendering + image/tile generation to a **dedicated worker container** deployed on **GCP Cloud Run**, wired to your existing **Supabase `outbox` jobs** and **Supabase Storage**.

This doc is a complete gameplan to:
- Make uploads reliably produce sheet images (and then tiles).
- Keep Vercel/Next purely as UI + orchestration.
- Let you run the worker **now** while you develop locally, so production is trivial later.

---

## Goals (what “done” means)

### Functional
- Upload a plan-set PDF → system creates one `drawing_sheet` per page, each with a `drawing_sheet_version`.
- Each sheet version gets **a rendered image** (MVP) and then **tile pyramid** artifacts (target).
- Viewer reliably shows the sheet with sharp zoom (no placeholder images except explicit “processing” state).
- Processing is retryable, idempotent, and observable (logs + job status).

### Non-functional
- No request-timeout coupling: processing can take minutes without breaking.
- No dependency coupling with your Next/React stack: the worker is isolated.
- Stable storage URLs (cacheable, immutable), minimal signed URL usage.

---

## Current State (from repo)
- You already have:
  - Supabase DB + Storage
  - An `outbox` system with job types like `process_drawing_set` and `generate_drawing_tiles`
  - A Next route `app/api/jobs/process-outbox/route.ts` that currently executes jobs in-process (and has placeholder PDF logic in at least one path)
  - A “tiled images + OpenSeadragon” foundation doc (`docs/drawings-foundation-v2.md`)

### Root cause of “nothing but problems”
1. **Wrong runtime**: heavy conversion inside a Next route / serverless.
2. **Wrong dependency shape**: PDF renderers are either browser-first (PDF.js) or native-heavy (pdfium/poppler/ghostscript), both fragile in serverless packaging.
3. **The code path currently produces placeholders** in places, so the system can’t stabilize.

---

## Architecture (target)

### Components
- **Vercel / Next.js**
  - Upload UI + metadata orchestration
  - Creates DB records
  - Enqueues `outbox` jobs
  - No PDF rendering / tiling work

- **Supabase**
  - DB: truth for sets/sheets/versions/job state
  - Storage:
    - `project-files` (private): input PDFs
    - `drawings-tiles` (public): rendered outputs (thumb + tiles) on immutable paths

- **Cloud Run “drawings-worker”**
  - Polls `outbox` for pending jobs
  - Downloads PDFs from `project-files`
  - Renders pages to images
  - Generates tile pyramids + thumbnail
  - Uploads outputs to `drawings-tiles`
  - Updates `drawing_sheet_versions` + marks job complete/failed

### Data flow (happy path)
1. Client uploads PDF to `project-files` (private).
2. Next creates `files` record + `drawing_sets` record (status `processing`).
3. Next inserts an outbox job:
   - `job_type = process_drawing_set`
   - payload: `{ drawingSetId, projectId, sourceFileId, storagePath }`
4. Cloud Run worker claims the job and:
   - downloads PDF bytes
   - determines page count
   - creates sheets + versions (or updates existing)
   - enqueues `generate_drawing_tiles` per sheet version (optional split) OR does tiles inline (MVP)
5. Worker writes:
   - thumbnail + tiles to `drawings-tiles` on content-addressed path
   - `tile_manifest`, `tile_base_url`, `image_width/height`, `tiles_generated_at`, etc.
6. Worker updates `drawing_sets` to `completed` with page counts.

---

## Decision: “Where conversion runs”

### Recommendation
Run the conversion engine as a **container** on **GCP Cloud Run**.

### Why not Vercel / Next routes
- Request handlers are the wrong place for long-running CPU+native tasks.
- Timeouts + memory ceilings + cold starts + unpredictable concurrency.
- Native dependencies are brittle in serverless.

### Why not Supabase Edge Functions for the core engine
- Deno edge runtime is great for glue, not ideal for native PDF renderers.
- You’ll end up in “WASM PDF renderer” land (possible, but slower and more fragile).

---

## Conversion Engine Choice (what to render PDFs with)

### Recommended engine in a container
Use **native PDF rendering tools** installed in the container, not browser PDF.js:
- **MuPDF (`mutool`)** or **Poppler (`pdftocairo` / `pdftoppm`)**

Why: these are battle-tested renderers and are stable when installed as system packages in Linux.

### Suggested output formats
- **PNG** for first stable milestone (simplest, deterministic).
- **WebP** once stable (smaller, good quality).
- Tile size: **256×256**.

### Rendering resolution guidance (construction drawings)
- Base render should be high enough to read details:
  - Target long edge: **6000–9000 px** (varies by sheet).
  - Or render by DPI (e.g., **200–300 DPI**) and clamp max dimension to avoid RAM blowups.

---

## Version/Stack Pinning for Reliability

### App stack (Vercel / Next)
You can keep the app on your current stack because the worker decouples conversion from React/Next.

That said, for “maximum reliability” as a principle:
- **Node (app)**: **20 LTS** (you already use Node 20 via `.nvmrc`)
- **Next/React**: keep what you have *if stable*, but avoid frequent upgrades during this migration.
  - If you experience ecosystem churn: the conservative baseline is **Next 15.x + React 19** or **Next 14.x + React 18** (larger downgrade).
  - The key point: conversion should not depend on these versions anymore.

### Worker stack (Cloud Run)
Pin the worker independently:
- **Base image**: `node:20-bookworm-slim` (or equivalent Node 20 LTS)
- **System deps**:
  - `mupdf-tools` OR `poppler-utils`
  - `libvips` (if using `sharp`)
- **Node packages**:
  - `sharp` (pinned to a known-good minor; upgrade intentionally)

Why Node 20 for worker: best compatibility with native tooling today, widely supported by Cloud Run, and stable ABI expectations.

### Recommended “pinned” versions (practical)
These are the versions you should standardize on **today** to reduce variables while you fix the pipeline:

- **App runtime**
  - **Node**: `20.x` (stick to LTS; your repo uses `.nvmrc = 20`)
  - **Next**: `16.0.8` (current `package.json`)
  - **React / React DOM**: `19.2.0` (current `package.json`)
  - **Supabase JS**: `^2.86.0` (current `package.json`)

- **Worker runtime**
  - **Node**: `20.x` (same LTS line as the app; minimizes surprises)
  - **OS base**: Debian **bookworm-slim**
  - **Renderer**: **MuPDF** *or* **Poppler** (installed as OS packages; pick one)
  - **Image pipeline**: `sharp` (pin; don’t float until stable)

If you later decide you want the app stack more conservative, do it *after* conversion is stable—otherwise you’ll be debugging upgrades and conversion simultaneously.

---

## Job Model (how to structure work)

You already have two job types. Keep them, but make them “real”:

### Job A: `process_drawing_set`
**Responsibility**: discover pages + create DB records.
- Validate: the file exists and is a PDF.
- Determine page count (via renderer tooling, not guess-by-bytes).
- Create:
  - `drawing_sheets` rows (one per page)
  - `drawing_sheet_versions` rows (one per page version)
- Enqueue `generate_drawing_tiles` for each sheet version.
- Set `drawing_sets.status`:
  - `processing` → `completed` once all children jobs complete (or keep “completed” when records exist and tiles continue async; decide based on UX).

### Job B: `generate_drawing_tiles`
**Responsibility**: take one `drawing_sheet_version` (one PDF page) and produce view artifacts.

Minimum artifacts (MVP, correctness-first):
- `thumbnail` (for list)
- `full` render (single image) for viewer fallback

Target artifacts (what your docs already want):
- `thumbnail` (256px)
- **tile pyramid** (DZI-style or equivalent manifest)
- manifest JSON stored in DB (`tile_manifest`) and optionally mirrored to Storage (`manifest.json`)

**Inputs**:
- `sheetVersionId` (in outbox payload)

**Outputs**:
- Updates `drawing_sheet_versions`:
  - `tile_manifest` (JSON)
  - `tile_base_url` (public URL base)
  - `thumbnail_url`
  - `image_width`, `image_height`
  - `source_hash` (content address)
  - `tile_levels`
  - `tiles_generated_at`
  - (optional) keep legacy `thumb_path/medium_path/full_path` only for backward compatibility

---

## Idempotency & correctness rules (non‑negotiable)

### Rule 1 — Jobs must be safe to retry
Any `generate_drawing_tiles` retry must:
- produce the same storage outputs (content-addressed), OR
- detect outputs already exist and skip re-upload, OR
- upload with upsert semantics only if outputs are identical.

### Rule 2 — Content-addressed outputs
Use a deterministic key such as:
- `orgId/{sha256(pdfBytes + pageIndex + renderParams)}/...`

Why include render params: changing DPI/tile size should produce a new immutable artifact set.

### Rule 3 — No “guess page count”
Your current placeholder heuristic (“estimate pages by PDF size”) must be deleted from the real pipeline. Page count must come from the PDF renderer itself.

### Rule 4 — No PDF rendering in Next routes
Next routes can enqueue and show status. They should never:
- render PDFs
- generate tiles
- run multi-minute loops

---

## What to change in the app backend (wiring plan)

### 1) Make Next “process-outbox” orchestration-only
Current file: `app/api/jobs/process-outbox/route.ts`

Goal:
- Keep only “lightweight” job types that are safe in serverless (e.g. emails, refresh view).
- Remove/disable `generate_drawing_tiles` and `process_drawing_set` execution in this route once worker is live.

Why:
- This route is a major source of reliability issues (timeouts, memory pressure, native deps).

Deliverable:
- The route either:
  - stops selecting those job types, or
  - immediately marks them as “delegated” / no-op in prod.

### 2) Standardize job payload contracts
For each job type, define a strict schema in docs (and later enforce in code):
- `process_drawing_set`: `{ drawingSetId, projectId, sourceFileId, storagePath }`
- `generate_drawing_tiles`: `{ sheetVersionId }`

Rule:
- Payloads must include stable identifiers; never embed signed URLs.

### 3) Add a safe “claim job” mechanism (avoid double-processing)
Do NOT rely on “select then update” without a lock in multiple workers.

Preferred:
- A Postgres function (RPC) that:
  - selects N pending jobs
  - marks them processing
  - returns them
  - uses `FOR UPDATE SKIP LOCKED`

This can live in Supabase as a SQL migration + RPC.

### 4) Status + UX
Make the UI treat sheets as:
- `processing` (show skeleton + “processing” badge)
- `ready` (tiles exist)
- `failed` (show error + retry button that enqueues/reenqueues jobs)

You already have: `retryProcessingAction` and job retry fields in outbox—align them with worker retries.

---

## Cloud Run Worker: Implementation Gameplan (no-code but concrete)

### 0) Create a new repo folder (recommended)
Create a separate workspace folder (same monorepo or separate repo):
- `workers/drawings-worker/`

Reason:
- You want the worker dependency graph isolated from Next/React.
- This prevents “pdf-to-img conflicts with React 19” type problems entirely.

### 1) Worker responsibilities
The worker runs an infinite loop:
- claim jobs (batch size small, e.g. 1–5)
- process each job
- write logs
- update outbox status
- sleep/backoff when no jobs

### 2) Choose “renderer toolchain”
Pick one and standardize:

#### Option A (recommended): MuPDF (`mutool`) + `sharp`
- Very reliable rasterization.
- Good quality for line drawings.
- Easy to install on Debian-based images.

#### Option B: Poppler (`pdftocairo`) + `sharp`
- Also very reliable; often slightly heavier.

Avoid:
- Node PDF.js for the conversion engine (it’s a browser renderer first).
- Libraries that embed headless Chromium for PDF rasterization (heavy and expensive).

### 3) Artifact generation phases

#### Phase P0 — Correctness-first (ship ASAP)
For each page:
- Rasterize page → high-res PNG
- Create thumbnail (256px)
- Upload:
  - `tiles/0/0_0.png` (single tile “level 0”)
  - `thumbnail.png`
- Store DB manifest consistent with your viewer’s current expectations.

This immediately removes the “placeholder” situation.

#### Phase P1 — True tile pyramid
From the high-res image:
- Generate 256×256 tiles across multiple zoom levels.
- Store DZI-like manifest as JSON (your `docs/drawings-foundation-v2.md`).
- Upload tiles with immutable caching headers.

#### Phase P2 — OCR/metadata extraction (optional but high ROI)
After tiles are ready:
- Run Claude Vision OCR on a medium-res render.
- Populate `extracted_metadata`, `search_vector`, better sheet naming.

---

## Cloud Run Setup (step-by-step)

### 1) Create a GCP project
- Create or choose a GCP project: `strata-drawings-worker` (name is arbitrary).
- Enable APIs:
  - Cloud Run
  - Artifact Registry
  - Cloud Build
  - Secret Manager
  - (optional) Cloud Logging / Error Reporting

### 2) Artifact Registry (container images)
- Create an Artifact Registry repo (Docker).
- This is where worker images are pushed.

### 3) Secrets
Store secrets in **Secret Manager**:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- (optional) `SUPABASE_STORAGE_BUCKET_INPUT=project-files`
- (optional) `SUPABASE_STORAGE_BUCKET_OUTPUT=drawings-tiles`
- (optional, R2 tiles) `DRAWINGS_TILES_STORAGE=r2`
- (optional, R2 tiles) `DRAWINGS_TILES_BASE_URL=https://<cdn-domain>/drawings-tiles`
- (optional, R2 tiles) `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
- (optional, R2 tiles) `R2_BUCKET_DRAWINGS_TILES=drawings-tiles`
- (optional, R2 tiles) `R2_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com`
- (optional, R2 tiles) `R2_REGION=auto`, `R2_FORCE_PATH_STYLE=true`

Do NOT bake these into images.

### 4) Deploy the service
Deploy `drawings-worker` as a Cloud Run service (always-on-ish):
- **Min instances**: 1 (prevents cold-start delays for job pickup)
- **Max instances**: 2–5 initially (cap costs + DB contention)
- **CPU**: 2
- **Memory**: 2–4GB (PDF rasterization can spike)
- **Concurrency**: 1 (keep predictable memory; scale by instances instead)
- **Timeout**: doesn’t matter if it’s a long-running loop service; if you choose request-based execution, set higher.

### 5) How the worker runs on Cloud Run
Two viable patterns:

#### Pattern A (recommended): “Always running” worker loop
- The container starts, runs forever.
- It polls outbox every few seconds.

Pros: simplest, lowest latency, easiest mental model.
Cons: you pay for at least one instance always.

#### Pattern B: Cloud Run Jobs + Scheduler
- Cloud Scheduler triggers a Cloud Run Job every minute.
- Each job processes up to N tasks and exits.

Pros: scale-to-zero, cheaper at low volume.
Cons: more moving parts + higher latency + more job orchestration.

Given you want “use it now and never worry later”: choose **Pattern A** first.

---

## “Use it now” while you develop locally

### Recommended dev environment model
Keep your local UI pointed at a **staging Supabase project**, not prod:
- A separate Supabase project avoids polluting real customer data.
- The Cloud Run worker points to that same staging Supabase.

Workflow:
1. Run Next locally.
2. Upload PDFs to staging Supabase storage.
3. Local UI shows processing status.
4. Cloud Run worker picks jobs and writes artifacts.
5. Local UI refresh shows real images/tiles.

This matches production exactly, just with a different Supabase URL.

If you must use one Supabase project:
- Use a dedicated “dev org/project” row and isolate by org_id.

---

## Observability & operations

### Logging
Every job log line should include:
- `job_id`, `job_type`
- `org_id`, `project_id` where relevant
- `sheetVersionId` or `drawingSetId`
- elapsed time
- renderer tool + params (dpi, maxDim, tileSize)

### Metrics (minimum)
- jobs processed / failed
- average time per page
- bytes uploaded per job

### Failure handling
- Outbox retries: exponential backoff (you already do this)
- Non-retriable failures:
  - “sheet version not found” should be skipped and marked completed with “skipped”
- Poison pill:
  - if a specific PDF repeatedly fails, mark the drawing set `failed` with a helpful message

---

## Rollout Plan (safe migration)

### Phase 0 — Prep (no behavior change)
- Add claim-job RPC (or equivalent) in Supabase.
- Deploy Cloud Run worker but keep it idle (poll but only for a new job type or disabled flag).

### Phase 1 — Dual-run, worker handles new uploads
- For new drawing sets:
  - enqueue jobs as normal
  - worker processes them
- Keep Next route processing disabled for these job types in prod (or stop selecting them).

### Phase 2 — Backfill existing sheets
- Use your existing action: `queueTileGenerationForExistingSheetsAction`
- Worker processes legacy sheet versions and populates tile fields.

### Phase 3 — Remove dead paths
- Remove placeholder logic and any remaining PDF rendering attempts in Next routes.
- Remove any “local dev PDF conversion” hacks that aren’t used.

---

## Compatibility checklist (what you should standardize)

### App
- Node: **20 LTS** (keep)
- Next/React: **freeze during migration** (don’t fight two battles)

### Worker
- Node: **20 LTS**
- Debian base: **bookworm-slim**
- Renderer: **MuPDF or Poppler**, pick one
- `sharp`: pinned

### Storage & URLs
- Output bucket: **public**
- Paths: **content-addressed**
- Cache headers: `public, max-age=31536000, immutable`
- DB stores:
  - storage keys or public base paths, never expiring signed URLs

---

## Acceptance criteria (hard gates)
- Upload a 1-page PDF → sheet visible within 60s with real image (no placeholder).
- Upload a 50–200 page plan set → processing completes without route timeouts.
- Retries do not duplicate storage or create broken DB state.
- Viewer zoom remains crisp (especially at >200%).
- After cutover, no production path does PDF rendering inside Next routes.

---

## IMPLEMENTATION STATUS (Jan 14-15, 2026)

### ✅ COMPLETED

#### 1. Worker Infrastructure
- **Location**: `workers/drawings-worker/` (isolated from Next.js app)
- **Deployed to**: Google Cloud Run
  - Project: `strata-479821`
  - Service: `drawings-worker`
  - Current revision: `drawings-worker-00020-rcc`
  - Region: `us-central1`
  - **CRITICAL CONFIG**: `--no-cpu-throttling` flag (required for performance)

#### 2. Container Configuration
- **Base image**: `node:20-bookworm-slim`
- **System packages installed**:
  - `mupdf-tools` (primary renderer - `mutool`)
  - `poppler-utils` (backup/alternative - `pdftoppm`, `pdftocairo`)
  - `libvips-dev` (for Sharp image processing)
- **Node packages**:
  - `@supabase/supabase-js ^2.86.0`
  - `sharp ^0.33.0`
  - `node-cron ^3.0.3`

#### 3. Resource Allocation
- **Memory**: 8GB (increased from initial 4GB for complex PDFs)
- **CPU**: 2 vCPUs
- **Timeout**: 900s (15 minutes)
- **Min instances**: 0 (scale-to-zero for cost savings)
- **Max instances**: 3
- **Concurrency**: Default (handles multiple jobs in parallel)
- **CPU Throttling**: **DISABLED** (`--no-cpu-throttling` flag)
  - **WHY THIS MATTERS**: Without this flag, Cloud Run throttles CPU to near-zero when not handling HTTP requests, making PDF extraction 300x slower (90+ seconds per page vs <1 second)

#### 4. Database Functions
- **Created**: `claim_jobs` RPC function
  - Uses `FOR UPDATE SKIP LOCKED` for safe concurrent job claiming
  - Location: `supabase/migrations/20260112_claim_jobs_rpc.sql`
  - Prevents race conditions between worker instances

#### 5. Worker Job Processing
- **Architecture**: Optimized two-phase approach
  - **Phase 1** (`process_drawing_set`): Extract ALL pages once
    - Downloads PDF from `project-files` storage
    - Extracts all pages to PNG using MuPDF at 100 DPI
    - Uploads PNGs to temp storage (`drawings-tiles/{orgId}/{hash}/temp/page-{N}.png`)
    - Creates `drawing_sheets` and `drawing_sheet_versions` records
    - Queues individual `generate_drawing_tiles` jobs
  - **Phase 2** (`generate_drawing_tiles`): Generate tiles per page
    - Downloads pre-rendered PNG from temp storage (not full PDF)
    - Generates thumbnail (256x256)
    - Uploads tiles and manifest
    - Cleans up temp PNG

#### 6. Performance Metrics (Burke.pdf - 9 pages, 6.7MB)
- **Total processing time**: ~15 seconds
- **Per-page extraction**: ~1-1.5 seconds (including upload)
- **Tile generation**: ~2 seconds per page
- **All 9 pages processed successfully**

#### 7. Storage Structure
- **Input PDFs**: `project-files` bucket (private)
  - Path: `{orgId}/{projectId}/drawings/sets/{timestamp}_{filename}.pdf`
- **Temp PNGs**: `drawings-tiles` bucket (public)
  - Path: `{orgId}/{contentHash}/temp/page-{pageIndex}.png`
  - Auto-deleted after tile generation
- **Final tiles**: `drawings-tiles` bucket (public)
  - Path: `{orgId}/{contentHash}/page-{pageIndex}/tiles/0/0_0.png`
  - Path: `{orgId}/{contentHash}/page-{pageIndex}/thumbnail.png`
  - Path: `{orgId}/{contentHash}/page-{pageIndex}/manifest.json`
  - Cache headers: `public, max-age=31536000, immutable`

#### 8. Database Schema Updates
- ✅ Removed `page_index` from `drawing_sheets` (doesn't exist in schema)
- ✅ Added `sort_order` to `drawing_sheets` (for page ordering)
- ✅ Added `drawing_revision_id` to `drawing_sheet_versions` (required field)
- ✅ Create default "Initial" revision before sheet creation
- ✅ Store `temp_png_path` and `source_hash` in `extracted_metadata`
- ✅ Store `tiles_base_path` per sheet version

### ⚠️ CURRENT ISSUES

#### Issue #1: All Sheets Showing Same Page in UI
**Status**: INVESTIGATING
**Symptoms**:
- Worker correctly extracts all 9 pages
- Tile paths are unique per page (`page-0`, `page-1`, etc.)
- Database shows correct `page_index` values
- BUT: Frontend displays same page for all sheets

**Working Theory**:
- Storage paths are now unique and correct
- Tiles are uploading to correct paths
- Issue is likely in how the frontend reads/displays the tiles
- Need to check:
  1. Which field the viewer is reading for tile URLs
  2. If there's URL construction logic that ignores page index
  3. Browser caching of old tile URLs

**Next Steps**:
1. Verify actual tile files in Supabase Storage match page numbers
2. Check frontend viewer code for how it constructs tile URLs
3. Confirm `tile_base_url` includes page-specific path

### 🔧 FIXES APPLIED

#### Fix #1: Schema Mismatches
- **Problem**: Worker tried to insert `page_index` into `drawing_sheets` table (doesn't exist)
- **Solution**: Store `page_index` only in `drawing_sheet_versions`, use `sort_order` in sheets

#### Fix #2: Missing Revision
- **Problem**: `drawing_sheet_versions` requires `drawing_revision_id` (NOT NULL)
- **Solution**: Create default "Initial" revision before creating sheet versions

#### Fix #3: Concurrent PDF Download Conflicts
- **Problem**: 9 tile jobs all downloading same 6.7MB PDF simultaneously → fetch failures
- **Solution**: Refactored to extract all pages once in `process_drawing_set`, upload PNGs to temp storage, then tile jobs download individual PNGs

#### Fix #4: MuPDF Timeout (CRITICAL)
- **Problem**: MuPDF extraction timing out after 90+ seconds per page
- **Root Cause**: Cloud Run CPU throttling (default behavior)
- **Solution**: Deploy with `--no-cpu-throttling` flag
- **Result**: Extraction now completes in <2 seconds per page (300x faster!)
- **Cost Impact**: Minimal - still using min-instances=0 for scale-to-zero

#### Fix #5: Tile Path Collisions
- **Problem**: All pages uploading tiles to same path → pages overwriting each other
- **Original Path**: `{orgId}/{hash}/tiles/0/0_0.png` (no page identifier)
- **Fixed Path**: `{orgId}/{hash}/page-{pageIndex}/tiles/0/0_0.png`
- **Status**: DEPLOYED but need to verify frontend is reading new paths

### 📋 CONFIGURATION CHECKLIST

When deploying worker, MUST include:
```bash
gcloud run deploy drawings-worker \
  --image gcr.io/strata-479821/drawings-worker:latest \
  --region=us-central1 \
  --platform=managed \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=3 \
  --memory=8Gi \
  --cpu=2 \
  --timeout=900 \
  --no-cpu-throttling  # ⚠️ CRITICAL - without this, 300x slower!
```

### 🎯 NEXT ACTIONS

1. **DEBUG UI DISPLAY ISSUE**
   - Verify frontend is reading `tile_base_url` correctly
   - Check if frontend code constructs tile URLs properly with page index
   - Test actual tile file downloads from storage to confirm they're different

2. **OPTIONAL IMPROVEMENTS** (after display fix)
   - Increase resolution from 100 DPI to 150 or 200 DPI (now that CPU throttling is fixed)
   - Implement true tile pyramids (currently just single tile at level 0)
   - Add OCR/metadata extraction (Phase P2)

### 💰 COST ESTIMATES

**Current Configuration**:
- 8GB memory, 2 vCPUs, no CPU throttling
- Scale-to-zero (min-instances=0)
- ~15 seconds per 9-page PDF upload

**Estimated Cost**:
- Per upload: ~$0.007 (<1 cent)
- Monthly (100 uploads): ~$0.70
- Monthly (1000 uploads): ~$7.00

**Why It's Cheap**:
- Workers shut down when idle (scale-to-zero)
- Fast processing (15s avg) minimizes billable time
- No always-on minimum instances
