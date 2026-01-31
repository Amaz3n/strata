# R2 Storage Migration Plan (Arc)

## Goals
- Move all binary uploads (PDFs, images, docs, attachments) from Supabase Storage to Cloudflare R2.
- Serve read-heavy assets via CDN with secure access (signed cookies or signed URLs).
- Keep Supabase as metadata + permissions only.
- Maintain backward compatibility during rollout.

---

## Current Storage (Supabase)
- project-files: general uploads, attachments, daily log photos, message files, portal uploads.
- drawings-tiles: drawing tiles + thumbnails (now migrating to R2).
- drawings-images: optimized image variants (client-side gen).

---

## Upload Entry Points (scanned)
### Drawings
- lib/services/drawings-client.ts → uploads PDFs to project-files.
- workers/drawings-worker → generates tiles (now supports R2).
- lib/services/drawings-image-gen.ts → client-side image variants to drawings-images.
- app/(app)/drawings/actions.ts → legacy plan set upload.

### Files / Docs
- app/(app)/files/actions.ts → general file upload for Files page.
- lib/services/file-versions.ts → versioned uploads + storage cleanup.
- app/(app)/projects/[id]/actions.ts → uploadProjectFileAction.

### Daily Logs
- app/(app)/projects/[id]/daily-logs/project-daily-logs-client.tsx
  → uses uploadProjectFileAction (files bucket).

### Messages / Chat
- app/(app)/projects/[id]/messages/actions.ts → uploads to project-files.

### RFIs / Tasks / Change Orders / Closeout / Vendor Bills / Contracts
- Uses uploadFileAction and attachFileAction from Files actions.

### Portal / External
- app/p/[token]/punch-list/actions.ts → portal uploads to project-files.
- lib/services/compliance-documents.ts → compliance docs (portal + internal).

---

## Target Storage Layout (R2)
Use separate logical prefixes (or buckets) to simplify lifecycle + access:
- drawings-tiles/{org_id}/ → tiles + manifests + thumbnails
- drawings-pdfs/{org_id}/ → source PDFs (plan sets)
- project-files/{org_id}/ → general files + attachments
- daily-logs/{org_id}/ → photos (optional; could live under project-files)
- messages/{org_id}/ → message attachments (optional; could live under project-files)

Prefer one bucket + prefixes for simplicity unless compliance or lifecycle requires separate buckets.

---

## Bucket Strategy (Recommended Long-Term)
**Default:** single private R2 bucket + org-scoped prefixes.
- Bucket name: `project-files` (or existing canonical bucket).
- Prefixes inside the bucket:
  - `drawings-tiles/{org_id}/...`
  - `drawings-pdfs/{org_id}/...`
  - `project-files/{org_id}/...`
  - `daily-logs/{org_id}/...` (optional)
  - `messages/{org_id}/...` (optional)

**Why this is optimal long-term**
- Lowest operational overhead (one bucket, one set of credentials).
- Consistent URL model + CDN config.
- Separation is enforced by org-scoped keys + signed access.

**When to split into multiple buckets**
- Different retention/lifecycle policies.
- Compliance boundaries (PII vs general files).
- Very different access model (public vs private).

---

## R2 Setup (Bucket + CDN)
1) Create a single **private** R2 bucket (e.g. `project-files`).
2) Configure a custom domain for the bucket (e.g. `cdn.arcnaples.com`).
3) Ensure the CDN path model matches the prefix layout above:
   - Example: `https://cdn.arcnaples.com/project-files/{org_id}/...`
4) Create an R2 API token with **read/write** for the bucket.
5) Add envs (app + workers):
   - `FILES_STORAGE=r2`
   - `FILES_BASE_URL=https://cdn.arcnaples.com/project-files`
   - `R2_BUCKET_FILES=project-files`
   - `R2_ACCOUNT_ID=...`
   - `R2_ACCESS_KEY_ID=...`
   - `R2_SECRET_ACCESS_KEY=...`
   - `R2_REGION=auto`
   - `R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com`
6) Verify access with a simple upload + CDN read (private + signed access).

Notes:
- Keep the bucket private; rely on signed URLs/cookies for read access.
- Prefixes are the primary tenant boundary (org-scoped paths).

---

## Access Model
Recommended: private R2 + CDN + signed cookies
- CDN domain: cdn.arcnaples.com
- Cookie set by app route for tiles
- Use the same pattern for other assets once migrated
- Scope cookies to org paths (e.g. `/project-files/{org_id}/`) to prevent cross-org access

Fallback: signed URLs per request (slower, more CPU).

---

## Phased Migration Plan

### Phase 0 — Inventory & Config
- Confirm all upload surfaces above.
- Decide if one bucket or multiple buckets.
- Add envs:
  - FILES_STORAGE=r2 (new)
  - FILES_BASE_URL=https://cdn.arcnaples.com/project-files
  - R2_* credentials (already in worker)
- Document secrets & deployment steps.
- Confirm org-scoped key strategy for all objects.

### Phase 1 — Shared Storage Adapter
Add a shared adapter (lib/storage/files-storage.ts) for:
- upload
- download
- delete
- list
- generate public URL

Add helpers:
- buildFilesBaseUrl()
- buildFilesPublicUrl(path)
- buildOrgScopedPath(orgId, pathParts...)

Adapter requirements:
- Must require org_id on all write/read operations.
- Must never accept raw object keys from clients.
- Must generate keys under `{prefix}/{org_id}/...` only.

Status:
- ✅ Adapter created at `lib/storage/files-storage.ts` with org-scoped path helpers and R2/Supabase support.

### Phase 2 — Drawings PDFs
Update lib/services/drawings-client.ts:
- Upload source PDF to R2 (drawings-pdfs/...).
- Store storage path in DB as R2 path (not Supabase URL).
- Update worker to download PDFs from R2.
- Ensure tile manifest and base paths are org-scoped (drawings-tiles/{org_id}/...).

### Phase 3 — Files / Attachments
Update app/(app)/files/actions.ts:
- Use shared adapter (R2).
- Preserve DB record shape (storage_path stays path, not URL).
- Signed URL generation should use CDN base.
- Validate org ownership before issuing signed URL.

Update all uploadFileAction users:
- tasks / RFIs / change orders / closeout / vendor bills / contracts.

### Phase 4 — Daily Logs Photos
Update app/(app)/projects/[id]/actions.ts:
- uploadProjectFileAction to R2.

### Phase 5 — Messages / Portal
Update app/(app)/projects/[id]/messages/actions.ts:
- Upload to R2.

Portal uploads:
- app/p/[token]/punch-list/actions.ts
- lib/services/compliance-documents.ts
- Portal signed URL/cookie must be scoped to org + project/file.

### Phase 6 — Read Path & Preview
- Update file preview endpoints to use R2/CDN.
- Ensure the Service Worker caches CDN paths.

### Phase 7 — Backfill / Migration
- Script to copy existing Supabase objects to R2.
- Update DB storage_path if you change prefixes.
- Gradually flip base URL + storage provider.
- Backfill must preserve org prefix; reject/move any legacy paths without org_id.

### Phase 8 — Cleanup
- Audit Supabase buckets; remove old files once R2 is verified.
- Add lifecycle policies in R2 for old versions/temp files.

---

## Migration Strategy (Safe Rollout)
1) Dual-write (optional) for 1–2 weeks.
2) Read-from-R2, fallback to Supabase.
3) Backfill existing objects.
4) Disable Supabase uploads.

---

## Validation Checklist
- Upload from Files page → R2 + CDN URL
- Daily Logs photos → R2
- Message attachments → R2
- Portal punch list upload → R2
- Drawings: PDFs in R2, tiles in R2
- All previews still work in app & portals
- Signed URLs/cookies are scoped to org paths

---

## Known Risks
- Signed cookie domain/path scoping.
- Cache invalidation on updated files.
- Large file upload reliability (consider multipart if needed).

---

## Next Actions
1) Decide bucket strategy (single vs multi).
2) Add shared files-storage adapter.
3) Migrate drawings PDFs to R2 first (highest ROI).
4) Roll through Files/Daily Logs/Messages/Portals.
