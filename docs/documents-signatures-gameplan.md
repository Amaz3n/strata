# Documents + Signatures Gameplan (LLM-Optimized)

Goal: Make Arc's project document system feel like a construction-grade command center: Documents is the project file room, Signatures is the execution queue, and both surfaces stay tightly linked through source files, versions, envelopes, access events, and portal sharing.

This doc is written for LLM/agent execution. It includes product decisions, current repo reality, target files, phased implementation steps, and verification criteria.

---

## 0) Product Decision

### 0.1 Keep Documents and Signatures separate

Use two first-class product surfaces:

- **Documents**: browse, upload, organize, preview, version, share, and attach project files.
- **Signatures**: prepare envelopes, track recipients, send reminders, void/resend, and download executed PDFs.

They should be separate pages because the user intent is different:

- Documents answers: "Where is the file?"
- Signatures answers: "What needs to be signed, by whom, and what is done?"

Do not make one mega-page. Instead, make them feel like two connected parts of one document system.

### 0.2 Fix naming and routes

Current user-facing IA is confusing:

- Project "Documents" nav points to `/projects/[id]/files`.
- Project "Signatures" nav points to `/projects/[id]/documents`.
- Global `/documents` renders the Signatures hub.
- Global `/files` is effectively a project-selection stub.

Target IA:

```txt
/documents
  Global documents hub, project filter required/available.

/projects/[id]/documents
  Project document library.

/signatures
  Global signatures queue.

/projects/[id]/signatures
  Project signatures queue.
```

Implementation may preserve old routes as redirects for compatibility:

```txt
/files -> /documents
/projects/[id]/files -> /projects/[id]/documents
/documents (old signatures) -> /signatures
/projects/[id]/documents (old signatures) -> /projects/[id]/signatures
```

If route migration is risky, do it in two stages: first update nav labels/copy and add redirects, then move route files.

---

## 1) Current State Audit

### 1.1 Documents library

Primary project page:

- `app/(app)/projects/[id]/files/page.tsx`
- `components/documents/unified-documents-layout.tsx`
- `components/documents/documents-context.tsx`
- `components/documents/documents-toolbar.tsx`
- `components/documents/documents-explorer.tsx`
- `components/documents/documents-content.tsx`
- `components/documents/documents-table.tsx`
- `components/documents/upload-dialog.tsx`
- `components/documents/file-timeline-sheet.tsx`
- `components/files/file-viewer.tsx`

Strengths:

- Project-scoped document layout exists.
- Explorer sidebar supports folders and drawing sets.
- Upload, drag/drop, move, delete, rename, share toggles, timeline, preview, versions, and drawing viewer integrations exist.
- Drawing set upload and processing hooks exist.
- File timeline/access event plumbing exists.

Gaps:

- The project page loads only the first 100 files.
- Search/filtering is local over the loaded slice, so large projects silently miss results.
- Category filters and grid/list view state exist but are not surfaced in the active toolbar.
- User-facing IA says "Documents" but routes and service names still say "files".
- Row accessibility needs work: clickable table rows and clickable div empty states.
- Folder actions are incomplete: no rename, delete empty folder, move folder, or visible permission defaults.
- Sharing state is hidden in the action dialog instead of visible in table/explorer.
- Document status is not first-class: no badges for private/shared/signed/waiting/expired/superseded.

### 1.2 Signatures hub

Primary pages/components:

- `app/(app)/documents/page.tsx`
- `app/(app)/projects/[id]/documents/page.tsx`
- `components/esign/signatures-hub-client.tsx`
- `components/esign/envelope-wizard.tsx`
- `components/esign/esign-document-viewer.tsx`
- `app/(app)/documents/actions.ts`
- `lib/services/documents.ts`
- `lib/services/envelopes.ts`
- `lib/services/esign-events.ts`
- `lib/services/esign-executed-links.ts`

Strengths:

- Unified e-sign work is already substantial.
- Hub rows include envelope status, document title/type, project, recipient summary, pending recipient info, actions, and version metadata.
- Envelope wizard can start standalone envelopes or continue drafts.
- Executed download URLs exist.

Gaps:

- Route/page name is wrong: `/documents` is Signatures.
- Summary data is fetched but not shown as a dashboard.
- Row actions hide too much behind the overflow menu.
- No visible due/expiry urgency beyond filter.
- No recipient-level detail panel from the hub.
- Uses `window.confirm` for destructive actions instead of app-native dialogs.
- Executed PDFs need a clearer "saved back to Documents" flow and destination.
- Draft cleanup, resend/replace signer, bulk reminders, and audit detail are missing.

### 1.3 App navigation

Primary file:

- `components/layout/app-sidebar.tsx`

Current behavior:

- `/drawings` and `/files` are classified as `documents`.
- `/documents` is classified as `signatures`.
- Project nav has both "Documents" and "Signatures", but the backing routes are counterintuitive.

Target behavior:

- `/documents` and `/projects/[id]/documents` classify as `documents`.
- `/signatures` and `/projects/[id]/signatures` classify as `signatures`.
- Keep backwards-compatible redirects for old routes.

---

## 2) North Star UX

### 2.1 Documents

Documents should feel like a fast file room with operational context.

Core jobs:

- Find the latest file quickly.
- Understand who can access it.
- Understand what workflow it belongs to.
- Preview/download/share without leaving context.
- Send a signable file into the Signatures flow.
- See if a file is superseded, executed, waiting, expired, or private.

Default project Documents layout:

```txt
Header / toolbar:
  Search, category/status filters, sort, New, upload/drawing set/folder actions.

Left explorer:
  All Documents, folders, drawing sets, saved views later.

Main table:
  Name, type/category, status, shared with, linked record, modified, uploaded by, size, actions.

Preview/details:
  Existing modal viewer is acceptable initially.
  Later: optional right-side details panel for metadata, sharing, versions, activity.
```

### 2.2 Signatures

Signatures should feel like a queue that tells the PM what to chase today.

Core jobs:

- See what is waiting.
- See who is blocking.
- Send reminders.
- Continue drafts.
- Download executed documents.
- Void/resend/replace signer when needed.
- Jump back to the source document.

Default Signatures layout:

```txt
Summary cards:
  Waiting, expiring soon, drafts, executed this week, failed/voided.

Filters:
  Queue state, project, recipient, source type, status, date range.

Queue table:
  Document, source, project, recipients, status, progress, expires/due, last activity, actions.

Detail drawer:
  Recipient-level audit, events, source document, executed output, reminder history.
```

---

## 3) Data and Service Requirements

### 3.1 Server-backed documents query

Problem: current project Documents loads `limit: 100` and filters locally.

Required:

- Add server-backed query args for:
  - `project_id`
  - `search`
  - `category`
  - `folder_path`
  - `status`
  - `share_with_clients`
  - `share_with_subs`
  - `signature_status`
  - `source_entity_type`
  - `sort`
  - `direction`
  - `limit`
  - `offset` or cursor

Target files:

- `lib/validation/files.ts`
- `lib/services/files.ts`
- `app/(app)/files/actions.ts` or renamed route equivalent
- `components/documents/documents-context.tsx`
- `components/documents/documents-toolbar.tsx`
- `components/documents/documents-content.tsx`

Acceptance:

- Searching in a project with more than 100 files can return files beyond the initial first page.
- Folder views do not require the full project file list on the client.
- Sort/filter state is represented in URL query params.

### 3.2 Document row view model

Add a single server-returned row shape for the Documents table so UI does not infer too much.

Recommended shape:

```ts
type DocumentLibraryRow = {
  id: string
  file_name: string
  mime_type?: string | null
  size_bytes?: number | null
  category?: FileCategory | null
  folder_path?: string | null
  updated_at: string
  created_at: string
  uploader_name?: string | null
  share_with_clients: boolean
  share_with_subs: boolean
  linked_records: Array<{
    entity_type: string
    entity_id: string
    label?: string | null
    href?: string | null
  }>
  signature?: {
    envelope_id: string
    document_id: string
    status: "draft" | "sent" | "partially_signed" | "executed" | "voided" | "expired"
    signed_count: number
    total_count: number
    next_pending_names: string[]
    expires_at?: string | null
    executed_file_id?: string | null
  } | null
  version?: {
    version_number?: number | null
    is_current?: boolean
    superseded_by_file_id?: string | null
  }
}
```

Acceptance:

- Table badges are driven from explicit row fields.
- The UI can show sharing and signature status without extra per-row fetches.

### 3.3 Executed PDF persistence

When an envelope is executed:

- Store or link the executed PDF as a normal file record.
- Set source metadata:
  - `source: "generated"`
  - `category: "contracts"` or derived from document type.
  - `folder_path`: near the source document, or a predictable executed folder.
  - metadata keys:
    - `source_document_id`
    - `source_envelope_id`
    - `executed_at`
    - `document_type`
    - `version_family_key`
- Link executed file to the same project/source entity.

Acceptance:

- A user can download executed PDF from Signatures.
- The executed PDF also appears in Documents.
- The Documents row links back to the envelope/signature audit.

### 3.4 Access and audit visibility

Use/extend existing:

- `lib/services/file-access-events.ts`
- `lib/services/files.ts`
- `components/documents/file-timeline-sheet.tsx`

Required events:

- upload
- rename
- move
- share/unshare
- preview/view
- download
- version upload
- make version current
- signature sent
- signature viewed/signed/executed
- portal view/download

Acceptance:

- File timeline shows both internal lifecycle and external portal access.
- Signatures detail drawer shows recipient-level signing events.

---

## 4) Implementation Stages

### Stage 1: IA and routing cleanup (COMPLETE)

Goal: Make naming clear before adding more functionality.

Tasks:

1. Add new route files for:
   - `app/(app)/documents/page.tsx` as the global documents hub.
   - `app/(app)/projects/[id]/documents/page.tsx` as project Documents.
   - `app/(app)/signatures/page.tsx` as global Signatures.
   - `app/(app)/projects/[id]/signatures/page.tsx` as project Signatures.

2. Move existing signatures page logic:
   - From old `app/(app)/documents/page.tsx` to new `app/(app)/signatures/page.tsx`.
   - From old `app/(app)/projects/[id]/documents/page.tsx` to new `app/(app)/projects/[id]/signatures/page.tsx`.

3. Move existing project documents logic:
   - From old `app/(app)/projects/[id]/files/page.tsx` to new `app/(app)/projects/[id]/documents/page.tsx`.

4. Add redirects for old routes if needed:
   - `/files` -> `/documents`
   - `/projects/[id]/files` -> `/projects/[id]/documents`
   - Old signatures `/documents` routes should only redirect after the new global docs page exists. If this conflicts, use a temporary deprecation path.

5. Update sidebar:
   - `components/layout/app-sidebar.tsx`
   - `Documents` url: `/projects/[id]/documents`
   - `Signatures` url: `/projects/[id]/signatures`
   - section detection should match the new routes.

6. Update user-facing copy:
   - Prefer "Documents" over "Files" in nav/headings/empty states.
   - Use "file" only for low-level actions like upload file, file size, file type.

Acceptance:

- Project sidebar has Documents and Signatures with intuitive URLs.
- Old bookmarked routes redirect or remain temporarily functional.
- No user-facing page called Documents renders the signatures queue.

Verification:

```bash
npm run lint
npm run build
```

Manual:

- Visit project Documents.
- Visit project Signatures.
- Confirm active sidebar state.
- Confirm old `/projects/[id]/files` behavior.

### Stage 2: Server-backed Documents search, filters, sort, pagination (COMPLETE)

Goal: Documents must work for large projects.

Tasks:

1. Expand `fileListFiltersSchema` in `lib/validation/files.ts`.
2. Update `listFiles` in `lib/services/files.ts`:
   - support folder path
   - support sort/direction
   - support shared filters
   - support search safely
   - return total count or `hasMore`
3. Update `listFilesAction`.
4. Update `DocumentsProvider`:
   - hydrate from URL query params.
   - fetch server data when filters/search/sort/page changes.
   - remove assumptions that all files are loaded.
5. Update `DocumentsContent`:
   - avoid local-only search as the source of truth.
   - keep only small client-side view composition for current response.
6. Add "Load more" or virtual/infinite pagination.

Acceptance:

- Project with 250+ files can search and find records beyond first 100.
- Sorting and filters survive refresh/back/forward.
- Loading states are visible and do not blank the entire explorer unnecessarily.

### Stage 3: Documents toolbar and table upgrade (COMPLETE)

Goal: Make Documents immediately scannable and operational.

Tasks:

1. Replace current slim toolbar with:
   - search
   - category filter
   - status filter
   - shared filter
   - sort
   - New menu
   - selected bulk action bar

2. Add table columns:
   - Name
   - Category/type
   - Status badges
   - Shared with
   - Linked record
   - Modified
   - Uploaded by
   - Size
   - Actions

3. Add badges:
   - Private
   - Client
   - Subs
   - Waiting
   - Executed
   - Expired
   - Draft
   - Superseded

4. Make row actions clearer:
   - Primary: Open/Preview.
   - Visible secondary for high-value action: Send for signature if signable.
   - Overflow: rename, move, share, timeline, delete.

5. Accessibility:
   - Use buttons/links for interactive row controls.
   - Add `aria-label` to icon buttons.
   - Make empty-state upload action a real button.
   - Ensure keyboard open/select works.

Acceptance:

- A PM can tell what is shared/signed/waiting without opening each document.
- No critical action is only discoverable through hidden row state.
- Keyboard users can open rows, use actions, and upload from empty state.

### Stage 4: Connect Documents to Signatures (COMPLETE)

Goal: Signatures should be a workflow view over Documents, not a silo.

Tasks:

1. Add "Send for signature" from Documents row/action menu.
2. Pass source file/entity/version into `EnvelopeWizard`.
3. Show signature status badges in Documents.
4. Add "Open source document" from Signatures row/detail.
5. Add "Open envelope/signature audit" from Documents row.
6. Ensure executed PDF saves back into Documents.
7. Show executed file destination after completion.

Acceptance:

- User can start at a PDF in Documents and send it for signature.
- User can start at an envelope in Signatures and navigate back to the source file.
- Executed file is discoverable from both pages.

### Stage 5: Signatures command center (COMPLETE)

Goal: Turn Signatures into "what needs chasing today".

Tasks:

1. Surface summary cards from existing `initialData.summary`.
2. Add filters:
   - all
   - waiting
   - expiring
   - drafts
   - executed
   - voided/failed
3. Add due/expires column with urgency style.
4. Add recipient detail drawer:
   - signer name/email
   - status
   - viewed/signed timestamps
   - last reminder
   - signing order
5. Replace `window.confirm` with app-native dialogs for void/delete.
6. Add void reason.
7. Add reminder history display.
8. Add bulk reminders for selected waiting envelopes.
9. Add draft cleanup affordance.

Acceptance:

- Opening Signatures immediately shows what is waiting/expiring.
- User can inspect who is blocking an envelope without opening the wizard.
- Destructive actions are deliberate, accessible, and audited.

### Stage 6: Folder permissions and sharing visibility (COMPLETE)

Goal: Make portal exposure impossible to miss.

Tasks:

1. Show folder default sharing in explorer.
2. Add folder actions:
   - rename
   - delete empty folder
   - move folder
   - set default sharing
   - apply defaults to existing files
3. Add visible row sharing states.
4. Add external access counts:
   - last viewed
   - download count
   - viewed by client/sub if known
5. Add expiring/revocable link support if not already covered by portal tokens.

Acceptance:

- User can answer "who can see this?" from the table or details panel.
- Moving files into a shared folder clearly applies or offers folder defaults.

### Stage 7: Metadata, OCR, smart search (COMPLETE)

Goal: Make Documents more useful than storage.

Tasks:

1. Add OCR/full-text indexing for PDFs and images.
2. Index:
   - file name
   - description
   - tags
   - OCR text
   - linked entity labels
   - drawing sheet number/title
   - vendor/contact/company names
3. Add extracted metadata:
   - date
   - vendor/company
   - permit number
   - invoice number
   - contract amount
   - drawing sheet number
   - document type
4. Add duplicate detection:
   - checksum
   - file name similarity
   - same source entity/version family
5. Add "latest/current" warnings.

Acceptance:

- Search can answer "latest signed contract", "permit number", "electrical drawing E201".
- Upload warns on likely duplicates.

### Stage 8: Drawing set polish (COMPLETE)

Goal: Make drawing docs feel reliable under field conditions.

Tasks:

1. Show processing status clearly in Documents.
2. Add retry failed processing.
3. Show processing error details.
4. Add sheet count mismatch warning.
5. Add drawing set revision flow:
   - permit set
   - IFC set
   - addendum
   - revision
6. Add sheet filters:
   - discipline
   - revision
   - status
   - has open pins
7. Add revision comparison entry points from Documents.

Acceptance:

- A failed drawing upload gives next steps.
- Users can find sheets by number/title/discipline.
- Revisions are visible and actionable.

### Stage 9: Packets, templates, and advanced workflows (COMPLETE)

Goal: Move from file management to construction workflow management.

Tasks:

1. Shared packets:
   - client packet
   - sub packet
   - permit packet
   - closeout packet
2. Signature templates:
   - proposal
   - change order
   - subcontract
   - lien waiver
   - closeout
3. Approval workflows:
   - submitted
   - under review
   - approved
   - rejected
   - resubmit required
4. Document health:
   - missing closeout docs
   - expired insurance/compliance
   - unsigned contract
   - outdated drawing set
5. AI assistant hooks:
   - "Find latest signed contract"
   - "Show documents shared with owner this week"
   - "What is missing for closeout?"

Acceptance:

- Users can bundle and send sets of documents.
- Common signature documents do not require manual field placement each time.
- The system can surface missing/risky documents proactively.

---

## 5) UI Details and Copy

### 5.1 Product copy

Documents page:

- Title: `Documents`
- Empty state title: `No documents yet`
- Empty state body: `Upload drawings, contracts, photos, permits, and closeout files for this project.`
- Upload button: `Upload documents`
- New menu:
  - `Upload documents`
  - `Upload drawing set`
  - `New folder`

Signatures page:

- Title: `Signatures`
- Empty state title: `No signature envelopes yet`
- Empty state body: `Send proposals, change orders, contracts, and waivers for signature.`
- Primary button: `New envelope`

Avoid:

- Calling the product surface "Files".
- Calling signatures "Documents".
- Ambiguous "New" without nearby menu labels.

### 5.2 Status badge vocabulary

Documents:

- `Private`
- `Client shared`
- `Sub shared`
- `Waiting for signature`
- `Partially signed`
- `Executed`
- `Expired`
- `Draft`
- `Superseded`

Signatures:

- `Draft`
- `Sent`
- `Partially signed`
- `Executed`
- `Expired`
- `Voided`

### 5.3 Important interaction rules

- Row click opens preview; action menu should not trigger row click.
- Checkboxes select only; they should not open files.
- Bulk action bar should appear only when selection exists.
- Search should debounce, update URL, and query server.
- Back/forward should restore folder/filter/search/signature context.
- Portal/shared state should never be hidden only in a modal.

---

## 6) Data Migration and Compatibility Notes

### 6.1 Route compatibility

If changing routes:

- Add Next redirects in `next.config.mjs` or route-level redirects.
- Search for hard-coded links:

```bash
rg -n '"/files"|`/files|/projects/\\$\\{.*\\}/files|"/documents"|`/documents|/projects/\\$\\{.*\\}/documents' app components lib
```

Update product links carefully:

- Links that mean file library should go to `/documents`.
- Links that mean signature queue should go to `/signatures`.
- Public signing routes like `/d/[token]` should not change.

### 6.2 Naming compatibility

Do not rush to rename DB tables/services from `files` to `documents`.

Recommended:

- User-facing routes/copy: Documents.
- Service/model names can remain `files` until a deliberate refactor.
- Add higher-level `documents` view models where needed.

### 6.3 Permission checks

Before exposing actions, verify existing permission helpers:

- `lib/services/permissions.ts`
- file upload/delete/share actions
- e-sign send/void/delete actions

Acceptance:

- Users without manage permission cannot delete/share/sign.
- Read-only users can preview/download only if allowed.

---

## 7) Testing and Verification

### 7.1 Automated tests to add

Service tests:

- `listFiles` search returns beyond first page.
- `listFiles` folder filter works.
- `listFiles` sort works.
- sharing filters work.
- signature row view model maps envelope statuses correctly.

Component tests if test harness exists:

- Documents toolbar updates query params.
- Empty state upload button is keyboard accessible.
- Row action menu does not trigger preview.
- Signatures summary cards match summary input.

### 7.2 Manual smoke checklist

Documents:

- Upload PDF to root.
- Upload image to `/photos`.
- Create folder.
- Move file into folder.
- Search by file name.
- Search by description/tag.
- Filter category.
- Sort modified desc/asc.
- Preview PDF.
- Upload new version.
- Make old version current.
- Share with clients/subs.
- View timeline.
- Start signature flow from a PDF.

Signatures:

- Create draft envelope.
- Continue draft.
- Send envelope.
- See waiting status.
- Send reminder.
- Void with reason.
- Download executed PDF.
- Confirm executed PDF appears in Documents.
- Open source document from envelope.

Drawings:

- Upload drawing set.
- Confirm processing status.
- Open sheet.
- Add markup.
- Add pin linked to task/RFI/punch.
- Add sheet version/revision.

### 7.3 Build/lint

Run after each stage:

```bash
npm run lint
npm run build
```

If build is too slow during incremental work, at least run targeted TypeScript/lint checks before handoff.

---

## 8) Suggested Execution Order

Best order for highest product impact with lowest confusion:

1. IA route cleanup and sidebar naming.
2. Server-backed search/filter/sort/pagination.
3. Documents table badges and sharing/signature visibility.
4. Documents to Signatures linking.
5. Signatures summary dashboard and detail drawer.
6. Executed PDF persistence and provenance.
7. Folder permission defaults and visibility.
8. OCR/full-text search and smart metadata.
9. Drawing processing/revision polish.
10. Packets/templates/advanced workflows.

Do not start with OCR or AI. The foundation must first scale past 100 files and the IA must stop confusing Documents with Signatures.

---

## 9) Open Questions

Answer before or during Stage 1:

1. Should global `/documents` show all documents across all projects, or require selecting a project first?
2. Should global `/signatures` include all projects by default, or default to "waiting on me/clients" queue?
3. Where should executed PDFs default to?
   - Same folder as source file.
   - `/contracts/executed`.
   - Folder derived from document type.
4. Are clients and subs allowed to see executed PDFs automatically, or should that be explicit?
5. Should drawing sets live only inside Documents, or also keep a dedicated Drawings nav item for speed?

Recommended defaults:

- Global Documents shows all projects with project filter.
- Global Signatures shows all active envelopes with urgent filters.
- Executed PDFs save near the source file, with an `Executed` badge and metadata link to the envelope.
- Executed PDF sharing should inherit from source only if explicitly confirmed or configured by folder defaults.
- Keep drawing sets inside Documents, but allow a project-level shortcut if builders use drawings daily.

