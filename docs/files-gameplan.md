# Strata Files & Documents Gameplan (LLM-Optimized)

Goal: Make Strata’s documents system competitive with (and simpler/faster than) Procore/Buildertrend for local builders by turning files into a **system of record**: drawings/specs, photos, submittals, RFIs, change orders, contracts, invoices, and closeout artifacts—securely shared with clients and subs.

This doc is a detailed implementation plan, including product scope, UX placement, phased rollout, and database changes based on the current repo schema.

---

## 0) Current State (Repo Reality)

### 0.1 Database (from `supabase/schema.sql` + migrations)

**Existing tables**
- `files`
  - Columns (as of `supabase/schema.sql`): `id`, `org_id`, `project_id`, `file_name`, `storage_path`, `mime_type`, `size_bytes`, `checksum`, `visibility`, `uploaded_by`, `created_at`, `updated_at`
  - Added by migration `supabase/migrations/20251215_sub_portal_enhancements.sql`: `share_with_subs boolean not null default false`
  - Added by migration `supabase/migrations/20251215_add_files_metadata.sql`: `metadata jsonb not null default '{}'::jsonb` (+ GIN index)
- `file_links`
  - Links a file to an entity: `entity_type`, `entity_id`, optional `project_id`
- `doc_versions`
  - Tracks versions per `file_id` via `(file_id, version_number)`
  - NOTE: does **not** currently store per-version `storage_path`, which limits true versioned storage.

**RLS**
- `files`, `file_links`, `doc_versions` are RLS-enabled and use `is_org_member(org_id)` policies.

### 0.2 Storage + Code

**Supabase Storage**
- Bucket used in code: `project-files`

**UI**
- Project detail has a Files tab using `components/files/*` and `FilesManager`.
- Global `/files` page is currently a stub (“coming soon”).
- The sidebar already groups “Documents” (Files, RFIs, Submittals), but “Files” itself isn’t a real global document center yet.

**Services/actions**
- `lib/services/files.ts` supports listing + creating file records (basic).
- `app/projects/[id]/actions.ts` implements project file upload/delete and generates signed URLs; file categories are inferred from filename/mimetype (not stored).
- `file_links` and `doc_versions` exist but are not fully productized as first-class workflows in UI.

---

## 1) Product Principles (What “True Construction File Management” Means)

### 1.1 Non-negotiables
- **Files are not a standalone page**: they must be the connective tissue across the entire app (RFIs, submittals, COs, tasks, daily logs, invoices, commitments, vendor bills).
- **One canonical file record** + many links/attachments (no duplicate uploads for the same artifact).
- **Fast field UX**: upload → view → share in seconds.
- **Auditability**: disputes happen; you need “who uploaded/changed/shared/downloaded what and when”.
- **Portal-safe sharing**: client/sub access must be explicit, revocable, scoped, and logged.

### 1.2 What we are not building (yet)
- A general-purpose Drive replacement (collaborative editing, Office/Google doc co-authoring).
- Full BIM/takeoff tools.
- Perfect AI classification as a requirement; automation must be “helpful” with a fast manual override.

---

## 2) UX Architecture: Where Files Live in Strata

### 2.1 Recommended Information Architecture

**A) Global “Documents Center”**
- Replace the stub `/files` with a real global document hub:
  - Project filter (All projects / one project)
  - Category filters (Plans, Contracts, Permits, Submittals, RFIs, Photos, Safety, Financials, Other)
  - Search (name, tags, description; later OCR text)
  - Upload from anywhere (defaults to “current project” when inside project context)

**B) Project-level “Documents” inside Project Detail**
- Keep the existing Project → Files tab, but treat it as the **project-scoped view** of the same Documents Center.
- Add a sub-navigation (or tabs) inside project Documents:
  - **All**
  - **Drawings**
  - **Photos**
  - **Contracts**
  - **Permits**
  - **Submittals / RFIs (attachments view)**

**C) Drawings as a first-class module (not just “files”)**
- Drawings should be a dedicated view because Procore/BT stickiness is heavily tied to drawing workflows.
- Proposed structure:
  - Global: Documents → Drawings (optional shortcut)
  - Project: Project → Documents → Drawings

### 2.2 Why this structure (vs “only inside projects”)
- Builders often start from a project, but office/admin work often starts from “Documents”.
- A global hub prevents “where did we store that?” fragmentation and makes search and reporting possible.
- You still preserve project-centric workflow by defaulting to project context when navigated from a project.

---

## 3) Data Model: What We Need for Competitive Documents

This section proposes DB changes to support the product scope. The goal is to keep schema simple but scalable and queryable.

### 3.1 Core file record (`files`)

**Current gaps**
- Category/tags/foldering are inferred or UI-only; not persisted.
- No true versioned storage (current `doc_versions` lacks `storage_path`).
- No consistent “attachments to entities” UX despite `file_links` existing.

**Proposed additions to `files`**
- Persist the fields the UI already assumes:
  - `category text` (enum-like constraint aligned to current `FileCategory`)
  - `folder_path text` (virtual folders; avoids separate folders table initially)
  - `description text`
  - `tags text[]`
  - `archived_at timestamptz` (soft-archive)
  - Optional: `source text` (`upload`, `portal`, `email`, `generated`, `import`)

**Continue using `files.metadata jsonb`**
- Store advanced/rare attributes without schema churn:
  - drawing ingestion results (sheet_number, discipline, revision)
  - OCR extraction status, page count
  - custom labels, external IDs

**Indexes**
- `(org_id, project_id, created_at desc)`
- `(org_id, project_id, category)`
- GIN on `tags`
- GIN on `metadata` already exists

### 3.2 Attachments (`file_links`) as the universal “attach to anything”

**Current**
- `file_links` exists but needs indexing + semantics for production use.

**Proposed additions**
- Add index for lookup by attached entity:
  - `create index file_links_entity_idx on file_links (org_id, entity_type, entity_id);`
- Add optional `link_role text` (or `metadata jsonb`) so attachments can be structured:
  - Example roles: `rfi_question`, `rfi_response`, `submittal_package`, `co_supporting`, `task_evidence`, `invoice_backup`

### 3.3 True versioning (`doc_versions`)

**Current gap**
- `doc_versions` cannot point to distinct version file blobs (no per-version `storage_path`).

**Proposed change**
- Add per-version storage fields:
  - `storage_path text not null`
  - `mime_type text`
  - `size_bytes bigint`
  - `checksum text`
  - Optional: `file_name text` (preserve original name)

**Version semantics**
- `files.storage_path` points to “current” blob
- `doc_versions` stores every version blob (including the current one) so rollback and diff are possible

### 3.4 Drawings (new tables)

If we want “upload plan PDF → sheet register → revisions,” we need explicit entities.

**New tables**
- `drawing_sets`
  - `id`, `org_id`, `project_id`
  - `title`, `status` (`processing|ready|failed`)
  - `source_file_id` (the uploaded plan-set PDF)
  - `created_by`, `created_at`, `processed_at`, `error_message`
- `drawing_sheets`
  - `id`, `org_id`, `project_id`, `drawing_set_id`
  - `sheet_number`, `sheet_title`, `discipline`
  - `current_revision_id` (nullable), `sort_order`
  - `created_at`
- `drawing_revisions`
  - `id`, `org_id`, `project_id`, `drawing_set_id`
  - `revision_label` (e.g., A, B, 2025-01-12), `issued_date`, `notes`, `created_at`
- `drawing_sheet_versions`
  - `id`, `org_id`, `drawing_sheet_id`, `drawing_revision_id`
  - `file_id` (the per-sheet PDF file record)
  - `thumbnail_file_id` (optional; could also be generated on-demand)
  - `page_index` (for traceability back to source set)
  - `created_at`

**Why “files + drawing_*” instead of only `files.metadata`**
- You need fast register queries, deduping, and revision comparison. That becomes painful if everything is jammed into `files.metadata`.

### 3.5 File access logging (new table, optional but recommended)

For portals and dispute-proofing, you want download/view logs.
- `file_access_events`
  - `id`, `org_id`, `file_id`, `actor_user_id` (nullable), `portal_token_id` (nullable)
  - `action` (`view|download|share|unshare`)
  - `ip`, `user_agent`, `created_at`

---

## 4) Storage Layout (Buckets + Paths)

Keep storage deterministic and future-proof. A recommended convention:

### 4.1 Buckets
- `project-files` (keep)
- Optional later: `project-thumbnails` (only if we want to separate)

### 4.2 Paths
- General uploads:
  - `{orgId}/{projectId}/files/{fileId}/{timestamp}_{safeName}`
- Document versions:
  - `{orgId}/{projectId}/files/{fileId}/versions/{versionNumber}/{timestamp}_{safeName}`
- Drawing sets:
  - `{orgId}/{projectId}/drawings/sets/{setId}/source/{timestamp}.pdf`
- Drawing sheets:
  - `{orgId}/{projectId}/drawings/sheets/{sheetId}/rev/{revisionId}/sheet.pdf`
- Thumbnails:
  - `{orgId}/{projectId}/thumbnails/{fileId}.webp`

---

## 5) Core User Stories (What Must Work)

### 5.1 Internal team
- Upload any document/photo and immediately view/share/download it.
- Organize documents by category + folder + tags.
- Attach documents to RFIs/submittals/COs/tasks/logs/invoices.
- Replace a document as a new version without breaking existing links.
- Find documents quickly by search and filters.

### 5.2 Client portal
- See the right shared artifacts (drawings, selected docs, invoices) without seeing internal-only documents.
- Download and view safely with access logging.

### 5.3 Sub portal
- See only documents shared with subs (and optionally filtered to their company/trade later).
- Acknowledge receipt of updated drawings (future “killer feature”).

---

## 6) Phased Implementation Plan

This is ordered to maximize product utility early while building toward drawings.

### Phase 1 — Make Documents Real Everywhere (Foundation)

**Outcome**
- `/files` becomes the global Documents Center (project-filtered, category-filtered, searchable).
- Project Files tab uses the same backend model, now persisted (category/tags/folder/description).
- File linking (attachments) is available in key modules.

**Backend**
- Add persisted metadata fields to `files` (`category`, `folder_path`, `description`, `tags`, `archived_at`, optional `source`).
- Implement CRUD APIs/services:
  - list files by org/project/category/folder/tags/search
  - update file metadata
  - archive/unarchive
- Implement `file_links` helpers:
  - attach/detach file to entity
  - list attachments for entity

**UI**
- Global Documents Center:
  - Project filter + category tabs + search
  - Upload (with category + folder selection)
  - Viewer
- Entity attachments:
  - Add “Attachments” section to RFI/Submittal/CO/Task/Daily Log detail views/forms

**DB migrations (SQL outline)**
- `alter table files add column category text;`
- `alter table files add column folder_path text;`
- `alter table files add column description text;`
- `alter table files add column tags text[] not null default '{}'::text[];`
- `alter table files add column archived_at timestamptz;`
- Add indexes (`category`, `tags`, `folder_path`, and entity lookup on `file_links`)
- Add constraints for `category` allowed values (match UI categories)

**Acceptance criteria**
- Upload a file once, categorize/tag it, and it appears correctly in:
  - project documents view
  - global documents view (filtered to that project)
- Attach that same file to an RFI and see it in both places.

---

### Phase 2 — True Versioning (Replace Without Chaos)

**Outcome**
- Users can upload new versions of key docs (contracts, specs, drawings, submittal packages) while preserving history and links.

**Backend**
- Extend `doc_versions` to store per-version blob metadata (`storage_path`, `mime_type`, `size_bytes`, `checksum`, optional `file_name`).
- Implement version APIs:
  - create new version (upload blob, create doc_version row, update `files.storage_path` to current)
  - list versions
  - rollback to a version

**UI**
- Version history panel in file viewer:
  - list versions, notes, uploader, timestamp
  - “make current” action

**DB migrations (SQL outline)**
- `alter table doc_versions add column storage_path text;` (+ not null once backfilled)
- `alter table doc_versions add column mime_type text;`
- `alter table doc_versions add column size_bytes bigint;`
- `alter table doc_versions add column checksum text;`
- optional `file_name text`
- Index on `(org_id, file_id, version_number desc)`

**Acceptance criteria**
- Replacing a file does not break:
  - portal access
  - entity attachments
  - download URLs

---

### Phase 3 — Drawings v1: Plan Set Ingestion + Sheet Register

**Outcome**
- Upload a multi-page plan PDF → Strata creates a drawing set, splits sheets, builds a sheet register with discipline classification, and generates thumbnails.

**Pipeline design**
- Upload “plan set” file → create `drawing_sets` row in `processing`
- Enqueue background job (Outbox / Edge Function):
  - split PDF into pages or detect sheets
  - extract sheet number/title (heuristics first; OCR later)
  - classify discipline (E/P/A/S/M/C) + keywords
  - create `drawing_sheets` + `drawing_revisions` + `drawing_sheet_versions`
  - generate thumbnails
  - mark set `ready`

**Does Procore do this?**
- Procore’s Drawings tool ingests plan sets and manages sheets/revisions. Strata can differentiate by:
  - being faster/simpler for local builders
  - tighter integration into tasks/punch/RFIs
  - better automation with manual override

**UI**
- Drawings register:
  - discipline filters, revision filters, search by sheet #
  - open viewer
- Basic viewer:
  - fast zoom/pan, show revision/date

**DB migrations**
- Create `drawing_sets`, `drawing_sheets`, `drawing_revisions`, `drawing_sheet_versions` tables + RLS policies.

**Acceptance criteria**
- Upload a plan set and within minutes:
  - you see a sheet list with stable sheet URLs
  - thumbnails exist
  - you can share selected drawings to client/sub portals

---

### Phase 4 — Drawings v2: Markups + “Link Work to Drawings”

**Outcome**
- Users can markup drawings and create tasks/RFIs/punch items pinned to a sheet location.

**DB additions**
- `drawing_markups`
  - `sheet_version_id`, `created_by`, `data jsonb` (vector annotations), `created_at`
- `drawing_pins`
  - links `sheet_version_id` + `(entity_type, entity_id)` + coordinates

**UI**
- Markup tools (arrow, circle, text)
- “Create task/RFI/punch from here” with pin
- Pins list filtered by status

---

### Phase 5 — Automation “Killer Features” (High ROI)

Pick 2–3 to productize well:
- **Email-in to project**: forward email attachments → auto-file + suggested category
- **Auto-filing rules**: if filename matches patterns, auto-tag/category
- **Acknowledgement workflows**: “Electrical vendor must acknowledge latest E sheets”
- **Closeout binder generator**: one-click packaging of key artifacts

---

## 7) Security & Permissions Model (Files + Portals)

### 7.1 Internal access (org members)
- Default: org members can access org files subject to org/project scope (current RLS covers this via `is_org_member(org_id)`).
- Project-based scoping should be enforced at the service layer for UX (avoid listing other projects by default).

### 7.2 Portal access
- Client/sub portals must only access:
  - files explicitly shared (via `share_with_subs` and/or future fine-grained sharing rules)
  - files linked to a portal-visible entity (e.g., invoice PDF)
- Every portal download should be logged (`file_access_events`).

### 7.3 Anti-leak requirements
- Never use public bucket URLs; always signed URLs or proxy endpoints.
- Ensure `storage_path` never encodes sensitive info beyond IDs.
- Add expiration + revocation for any share links.

---

## 8) Implementation Checklist (Engineering)

### 8.1 Services layer
- `lib/services/files.ts`
  - list/search with filters
  - create file record with metadata
  - update metadata
  - archive/unarchive
  - generate signed download URL (and record access)
  - versioning helpers (Phase 2)
- `lib/services/file-links.ts` (new)
  - attach/detach/list for entities

### 8.2 Server actions / routes
- Global documents actions (list/upload/update/delete/versions)
- Entity attachment actions (attach/detach)
- Drawing ingestion job endpoints (Phase 3)

### 8.3 UI components
- Global Documents Center page
- Unified file viewer with:
  - metadata editing
  - versions panel (Phase 2)
  - share controls
- Attachments component used by:
  - RFIs, Submittals, COs, Tasks, Daily Logs, Invoices
- Drawings register + viewer (Phase 3+)

### 8.4 Testing / verification
- Permission tests (portal cannot access private docs)
- Versioning regression tests (attachments still resolve after version bump)
- Large file upload + performance smoke checks

---

## 9) Open Product Decisions (Decide Early)

1) **Foldering model**: virtual folders (`folder_path`) vs `file_folders` table
   - Recommendation: start with `folder_path` (fast), add folders table later if needed.
2) **Categories**: fixed enum vs configurable
   - Recommendation: fixed categories now; allow org-custom categories later via config.
3) **Portal sharing granularity**:
   - Current: `share_with_subs` boolean + portal permissions
   - Recommendation: add per-file audience (`share_audience`: client/sub/internal) and/or per-portal token share list for tighter control.
4) **Plan ingestion accuracy**:
   - Recommendation: ship heuristics + manual override first; add OCR later.

---

## 10) Next Step (What to Do Immediately)

Start Phase 1 with a concrete scope:
- Make `/files` a real Documents Center using existing `files` table + newly persisted metadata.
- Implement `file_links` indexes + attachments UI in 1–2 modules first (e.g., RFIs + Submittals), then expand.
- Decide the drawings data model now (Phase 3), even if you ship it later, so you don't paint yourself into a corner.

---

## 11) Implementation Progress

### Phase 1 — COMPLETED (2025-12-17)

**Database Migration** (`supabase/migrations/20251217_files_phase1.sql`)
- [x] Added `category` column with constraint for allowed values (plans, contracts, permits, submittals, photos, rfis, safety, financials, other)
- [x] Added `folder_path` column for virtual folder organization
- [x] Added `description` column for file documentation
- [x] Added `tags` array column for flexible labeling
- [x] Added `archived_at` column for soft-archive functionality
- [x] Added `source` column (upload, portal, email, generated, import)
- [x] Added indexes for common query patterns:
  - `files_org_project_created_idx`
  - `files_org_project_category_idx`
  - `files_tags_idx` (GIN)
  - `files_folder_path_idx`
  - `files_archived_idx`
- [x] Added `file_links_entity_idx` for entity lookup
- [x] Added `link_role` column to `file_links`

**Backend Services**
- [x] Updated `lib/services/files.ts` with full CRUD operations:
  - `listFiles()` with filters (project, category, folder, tags, search, archived)
  - `getFile()` - get single file by ID
  - `createFileRecord()` - create with all new metadata fields
  - `updateFile()` - update metadata
  - `archiveFile()` / `unarchiveFile()` - soft archive
  - `deleteFile()` - permanent delete
  - `getSignedUrl()` - download URL generation
  - `listFilesWithUrls()` - list with signed URLs
  - `listFolders()` - get distinct folder paths
  - `getFileCounts()` - counts by category
- [x] Created `lib/services/file-links.ts` for attachments:
  - `attachFile()` - attach file to entity
  - `detachFile()` / `detachFileById()` - remove attachment
  - `listAttachments()` - list attachments with files and URLs
  - `listFileLinks()` - list all links for a file
  - `hasAttachments()` - check if file has attachments
  - `getAttachmentCount()` - count attachments for entity
  - `bulkAttachFiles()` - attach multiple files
  - `getLinkedEntities()` - get entities file is attached to
- [x] Updated `lib/validation/files.ts` with schemas:
  - `fileInputSchema` with new fields
  - `fileUpdateSchema` for metadata updates
  - `fileListFiltersSchema` for list queries
  - `fileLinkInputSchema` for attachments

**Server Actions** (`app/files/actions.ts`)
- [x] `listFilesAction()` - list with filters
- [x] `getFileAction()` - get single file
- [x] `getFileCountsAction()` - category counts
- [x] `listFoldersAction()` - folder paths
- [x] `updateFileAction()` - update metadata
- [x] `archiveFileAction()` / `unarchiveFileAction()`
- [x] `deleteFileAction()` - permanent delete
- [x] `getFileDownloadUrlAction()` - signed URLs
- [x] `uploadFileAction()` - upload with metadata
- [x] `attachFileAction()` / `detachFileAction()` / `detachFileLinkAction()`
- [x] `listAttachmentsAction()` - list entity attachments
- [x] `listProjectsForFilterAction()` - projects dropdown

**UI Components**
- [x] Global Documents Center at `/files`:
  - Project filter dropdown
  - Category tabs with counts
  - Search input
  - Grid/List view toggle
  - Image-only filter
  - Drag-and-drop upload
  - File viewer modal
  - Delete confirmation
- [x] `DocumentsCenterClient` component (`app/files/documents-client.tsx`)
- [x] `FileMetadataSheet` component (`app/files/file-metadata-sheet.tsx`) for editing file details
- [x] `EntityAttachments` component (`components/files/entity-attachments.tsx`):
  - Reusable for RFIs, Submittals, COs, Tasks, etc.
  - Drag-and-drop upload
  - Preview, download, remove actions
  - Compact mode option
  - Role-based attachment labeling

**Acceptance Criteria Status**
- [x] Upload a file once, categorize/tag it - DONE (metadata persisted on upload)
- [x] File appears in project documents view - DONE (project filter works)
- [x] File appears in global documents view filtered to project - DONE
- [x] Attach file to entities (component ready) - DONE (EntityAttachments component created)

---

### Phase 2 — COMPLETED (2025-12-18)

**Database Migration** (`supabase/migrations/20251217_files_phase2_versioning.sql`)
- [x] Added `storage_path` column to `doc_versions`
- [x] Added `mime_type` column to `doc_versions`
- [x] Added `size_bytes` column to `doc_versions`
- [x] Added `checksum` column to `doc_versions`
- [x] Added `file_name` column to `doc_versions`
- [x] Added index `doc_versions_file_version_idx` for efficient version queries
- [x] Added `current_version_id` to `files` table (optional reference to current version)

**Backend Services**
- [x] Created `lib/services/file-versions.ts`:
  - `listVersions()` - list all versions of a file
  - `getVersion()` - get single version by ID
  - `createVersion()` - upload new version with blob storage
  - `makeVersionCurrent()` - rollback/set a version as current
  - `updateVersion()` - update version metadata (label, notes)
  - `deleteVersion()` - delete a version (with blob cleanup)
  - `getVersionSignedUrl()` - signed download URL for version
  - `hasVersions()` - check if file has versions
  - `getVersionCount()` - count versions for file

**Server Actions** (`app/files/actions.ts`)
- [x] `listFileVersionsAction()` - list versions for a file
- [x] `getFileVersionAction()` - get single version
- [x] `getVersionCountAction()` - count versions
- [x] `uploadFileVersionAction()` - upload new version via FormData
- [x] `makeVersionCurrentAction()` - set version as current
- [x] `updateFileVersionAction()` - update version label/notes
- [x] `deleteFileVersionAction()` - delete version
- [x] `getVersionDownloadUrlAction()` - signed URL for version download

**UI Components**
- [x] `VersionHistoryPanel` component (`components/files/version-history-panel.tsx`):
  - Displays version list with timestamps, labels, notes
  - Upload new version with drag-and-drop
  - Edit version metadata (label, notes)
  - Make version current action
  - Delete version with confirmation
  - Download individual versions

**Entity Attachments Integration**
- [x] `RfiDetailSheet` (`components/rfis/rfi-detail-sheet.tsx`):
  - Full detail view with RFI metadata, status, question, response, decision
  - EntityAttachments integration for file uploads
  - Made RFI cards clickable in `rfis-client.tsx`
- [x] `SubmittalDetailSheet` (`components/submittals/submittal-detail-sheet.tsx`):
  - Full detail view with submittal metadata, status, description, decision
  - EntityAttachments integration for submittal packages
  - Made submittal cards clickable in `submittals-client.tsx`
- [x] `ChangeOrderDetailSheet` (`components/change-orders/change-order-detail-sheet.tsx`):
  - Full detail view with CO metadata, line items, totals, approval info
  - EntityAttachments integration for supporting documents
  - Made change order rows clickable in `change-orders-client.tsx`

**Acceptance Criteria Status**
- [x] Upload new version without breaking portal access - DONE (version storage separate from main file)
- [x] Upload new version without breaking entity attachments - DONE (file_links reference file_id, not storage_path)
- [x] Upload new version without breaking download URLs - DONE (signed URLs generated from current storage_path)
- [x] Version history visible in file viewer - DONE (VersionHistoryPanel component)
- [x] Rollback to previous version - DONE (makeVersionCurrent action)

---

### Phase 3 — COMPLETED (2025-12-18)

**Database Migration** (`supabase/migrations/20251218_drawings_phase3.sql`)
- [x] Created `drawing_sets` table with status tracking (processing/ready/failed)
- [x] Created `drawing_revisions` table for revision/issuance management
- [x] Created `drawing_sheets` table with discipline classification
- [x] Created `drawing_sheet_versions` table linking sheets to revisions with files
- [x] Created `file_access_events` table for audit logging
- [x] Added RLS policies for all new tables
- [x] Added indexes for common query patterns
- [x] Added update triggers for timestamps

**Validation Schemas** (`lib/validation/drawings.ts`)
- [x] `drawingSetStatusSchema` - processing states
- [x] `drawingDisciplineSchema` - A/S/M/E/P/C/L/I/FP/G/T/SP/D/X disciplines
- [x] `DISCIPLINE_LABELS` - human-readable discipline names
- [x] Input/update schemas for all drawing entities
- [x] List filter schemas with pagination

**Backend Services** (`lib/services/drawings.ts`)
- [x] Drawing Sets:
  - `listDrawingSets()` - list with filters
  - `getDrawingSet()` - get by ID
  - `createDrawingSet()` - create new set
  - `updateDrawingSet()` - update metadata/status
  - `deleteDrawingSet()` - delete with cascade
- [x] Drawing Revisions:
  - `listDrawingRevisions()` - list by project/set
  - `getDrawingRevision()` - get by ID
  - `createDrawingRevision()` - create new revision
  - `updateDrawingRevision()` - update label/notes
  - `deleteDrawingRevision()` - delete
- [x] Drawing Sheets:
  - `listDrawingSheets()` - list with filters
  - `listDrawingSheetsWithUrls()` - list with signed URLs
  - `getDrawingSheet()` - get by ID
  - `createDrawingSheet()` - create new sheet
  - `updateDrawingSheet()` - update metadata
  - `bulkUpdateSheetSharing()` - batch sharing updates
  - `deleteDrawingSheet()` - delete
- [x] Sheet Versions:
  - `listSheetVersions()` - list versions for sheet
  - `createSheetVersion()` - create new version
- [x] Helpers:
  - `getDisciplineCounts()` - counts by discipline
  - `getSheetSignedUrl()` - signed URL for sheet file

**Server Actions** (`app/drawings/actions.ts`)
- [x] All CRUD actions for sets, revisions, sheets
- [x] `uploadPlanSetAction()` - upload PDF and trigger processing
- [x] `retryProcessingAction()` - retry failed processing
- [x] `getProcessingStatusAction()` - poll processing status
- [x] `bulkUpdateSheetSharingAction()` - batch sharing updates
- [x] `getSheetDownloadUrlAction()` - signed URL for viewing

**Edge Function** (`supabase/functions/process-drawing-set/index.ts`)
- [x] PDF splitting with pdf-lib
- [x] Per-page PDF extraction and storage
- [x] Automatic discipline classification from sheet numbers
- [x] Sheet record creation with revision linking
- [x] Progress tracking during processing
- [x] Error handling with status updates
- [x] Automatic default revision creation

**UI Components**
- [x] Drawings page at `/drawings` (`app/drawings/page.tsx`)
- [x] `DrawingsClient` component (`components/drawings/drawings-client.tsx`):
  - Project filter dropdown
  - Discipline filter tabs with counts
  - Grid/List view toggle
  - Search functionality
  - Plan set upload dialog
  - Sheet selection and bulk actions
  - Sheet viewer modal
  - Processing status polling
  - Delete confirmation dialogs
  - Share with clients/subs bulk actions

**Acceptance Criteria Status**
- [x] Upload a plan set PDF - DONE (uploadPlanSetAction with file upload)
- [x] Sheet list with stable URLs - DONE (listDrawingSheetsWithUrls)
- [x] Discipline classification - DONE (auto-classification in edge function)
- [x] Processing status polling - DONE (getProcessingStatusAction with interval)
- [x] Share selected drawings to portals - DONE (bulkUpdateSheetSharing with share_with_clients/share_with_subs)

---

### Phase 4 — COMPLETED (2025-12-18)

**Database Migration** (`supabase/migrations/20251218_drawings_phase4_markups.sql`)
- [x] Created `drawing_markups` table for vector annotations
  - Links to sheets and optionally specific sheet versions
  - Stores annotation data as JSON (type, points, color, strokeWidth, text)
  - Supports private markups (only visible to creator)
  - Portal sharing controls (share_with_clients, share_with_subs)
- [x] Created `drawing_pins` table for entity location links
  - Links sheets to entities (tasks, RFIs, punch lists, submittals, etc.)
  - Stores normalized coordinates (0-1) for scalable positioning
  - Supports multiple entity types via polymorphic reference
  - Status caching for performance filtering
  - Unique constraint prevents duplicate pins per entity/sheet
- [x] Added RLS policies for both tables
- [x] Added indexes for common query patterns
- [x] Added update triggers for timestamps

**Validation Schemas** (`lib/validation/drawings.ts`)
- [x] `markupTypeSchema` - arrow, circle, rectangle, text, freehand, callout, dimension, cloud, highlight
- [x] `MARKUP_TYPE_LABELS` - human-readable markup type names
- [x] `markupDataSchema` - structure for annotation JSON data
- [x] `drawingMarkupInputSchema` / `drawingMarkupUpdateSchema` - CRUD schemas
- [x] `drawingMarkupListFiltersSchema` - list query filters
- [x] `pinEntityTypeSchema` - task, rfi, punch_list, submittal, daily_log, observation, issue
- [x] `PIN_ENTITY_TYPE_LABELS` - human-readable entity type names
- [x] `pinStatusSchema` - open, in_progress, closed, pending, approved, rejected
- [x] `pinStyleSchema` - color, icon, size for pin styling
- [x] `drawingPinInputSchema` / `drawingPinUpdateSchema` - CRUD schemas
- [x] `drawingPinListFiltersSchema` - list query filters
- [x] `createEntityFromPinInputSchema` - for "create from drawing" workflow

**Backend Services** (`lib/services/drawing-markups.ts`)
- [x] Drawing Markups:
  - `listDrawingMarkups()` - list with filters
  - `getDrawingMarkup()` - get by ID
  - `createDrawingMarkup()` - create new markup
  - `updateDrawingMarkup()` - update markup
  - `deleteDrawingMarkup()` - delete markup
  - `deleteMarkupsForSheet()` - bulk delete for sheet
  - `getMarkupCountsByType()` - counts by markup type
- [x] Drawing Pins:
  - `listDrawingPins()` - list with filters
  - `listDrawingPinsWithEntities()` - list with entity details enrichment
  - `getDrawingPin()` - get by ID
  - `getPinsForEntity()` - get pins for specific entity
  - `createDrawingPin()` - create new pin
  - `updateDrawingPin()` - update pin
  - `deleteDrawingPin()` - delete pin
  - `deletePinForEntity()` - delete pin when entity deleted
  - `syncPinStatus()` - sync pin status with entity status
  - `getPinCountsByStatus()` - counts by status
  - `getPinCountsByEntityType()` - counts by entity type

**Server Actions** (`app/drawings/actions.ts`)
- [x] Markup actions: list, get, create, update, delete, getCountsByType
- [x] Pin actions: list, listWithEntities, get, getPinsForEntity, create, update, delete
- [x] Pin sync actions: deletePinForEntity, syncPinStatus
- [x] Pin count actions: getPinCountsByStatus, getPinCountsByEntityType

**UI Components**
- [x] `DrawingViewer` component (`components/drawings/drawing-viewer.tsx`):
  - Full-screen drawing viewer with zoom/pan controls
  - Markup toolbar with 9 annotation tools (arrow, circle, rectangle, text, freehand, callout, dimension, cloud, highlight)
  - Color picker with 8 preset colors
  - Stroke width control
  - Local markup state with undo/clear/save
  - Pin tool for adding entity pins
  - Pins overlay showing linked items
  - Pins sidebar with linked item list
  - Show/hide toggles for markups and pins
  - Download button
- [x] `CreateFromDrawingDialog` component (`components/drawings/create-from-drawing-dialog.tsx`):
  - Dialog for creating tasks/RFIs/punch items from drawing location
  - Entity type selector (task, RFI, punch list, issue)
  - Title/description input
  - Priority selector for applicable entity types
  - Automatic pin creation at clicked location
- [x] `PinsList` component (`components/drawings/pins-list.tsx`):
  - Filterable list of pins for a sheet
  - Filter by entity type and status
  - Grouped by entity type
  - Status indicators
  - Click to navigate to entity
  - Delete pin action
- [x] Component exports in `components/drawings/index.ts`

**Acceptance Criteria Status**
- [x] Markup drawings with various tools - DONE (9 markup types implemented)
- [x] Create tasks/RFIs/punch from drawing - DONE (CreateFromDrawingDialog)
- [x] Pin items to specific locations - DONE (pin tool + normalized coordinates)
- [x] View pins list filtered by status - DONE (PinsList with filters)
- [x] Navigate from pin to entity - DONE (onNavigateToEntity callback)

**What's Next (Phase 5)**
- Implement automation "killer features"
- Email-in to project: forward email attachments → auto-file
- Auto-filing rules: if filename matches patterns, auto-tag/category
- Acknowledgement workflows: vendor must acknowledge latest sheets
- Closeout binder generator: one-click packaging of key artifacts

---

## 12) Finish-Line Checklist (Make Files “Fully Connected”)

This is the minimum integration work needed to make the current implementation feel complete and production‑ready for PMs.

### 12.1 Canonical Documents Experience
- [x] Unify the **project Files tab** with the **Documents Center** (same UI + metadata + filters).
  - [x] Expose a project‑scoped Documents Center view and use it in navigation.

### 12.2 True Versioning End‑to‑End
- [x] Wire `VersionHistoryPanel` into the file viewer.
- [x] Ensure **initial upload creates a `doc_versions` record** so “version 1” exists.
- [x] Make version actions consistent across project document views.

### 12.3 Attachments Everywhere
- Extend `EntityAttachments` to the remaining modules:
  - [x] Tasks
  - [x] Daily Logs
  - [x] Invoices
  - [x] Commitments
  - [x] Bills
  - [x] Selections
- Ensure attachment lists show in Documents Center (linked entities visible).

### 12.4 Sharing Model Consistency
- [x] Add per‑file share controls in the Files UI (client/sub/internal).
- [x] Align Files and Drawings sharing semantics (`share_with_clients`, `share_with_subs`).
- [x] Ensure portal lists reflect the same sharing rules.

### 12.5 Access Logging
- [x] Log view/download events into `file_access_events`.
- [x] Add lightweight audit visibility in file viewer (optional but recommended).

### 12.6 Category + Taxonomy Cleanup
- [x] Make portal document categories align with file categories.
- [x] Ensure search includes tags + description + name.
- [x] Display tags/folder consistently across all file views.

### 12.7 Cross‑Module Visibility
- [x] Documents Center should show “attached to” context (RFI, Submittal, CO, Task, etc.).
- [x] From any entity detail, “View in Documents” should deep‑link into file viewer.
