# Arc BYO Docs + Field-Placement E‑Signature Gameplan (LLM‑Optimized)

Goal: Let builders **bring their own PDF documents** (proposal/contract/change order/etc), place signature + other fields, and send via Arc for client signing — with **no DocuSign subscription required**.

This doc is a “do exactly these things” implementation plan aligned to the current repo architecture (Next.js + Supabase + Storage + tokenized public portals) and Supabase/Postgres best practices (RLS + indexes).

---

## 0) Current State (Repo Reality)

### 0.1 Proposals: tokenized public acceptance + signature capture
- Public route: `app/proposal/[token]/page.tsx`
  - Looks up proposal by `proposals.token_hash` (HMAC of the token using `PROPOSAL_SECRET`).
- “Signature” UI: `app/proposal/[token]/proposal-view-client.tsx`
  - Captures a canvas image via `components/portal/signature-pad.tsx` + typed signer name.
- Accept action: `app/proposal/[token]/actions.ts`
  - Calls `lib/services/proposals.ts::acceptProposal()` which stores `proposals.signature_data` and creates a `contracts` row with the same `signature_data`.

### 0.2 Change Orders: client portal approval + signature capture
- Client portal route: `app/p/[token]/change-orders/[id]/page.tsx` + `approval-client.tsx`
- Approval stored in `approvals` via `lib/services/change-orders.ts::approveChangeOrderFromPortal()`.

### 0.3 Files and versioning foundations exist (important for BYO docs)
- DB has `files`, `file_links`, `doc_versions`.
- Service exists for versions: `lib/services/file-versions.ts` (creates versions, sets `files.current_version_id`).
- You already have PDF rendering infrastructure in the drawings system, including normalized coordinates (0–1) conversion for pointer placement: `components/drawings/drawing-viewer.tsx`.

### 0.4 Known signature gaps (must address early)
1) `SignaturePad` calls `onChange(canvas.toDataURL(...))` on mount (`components/portal/signature-pad.tsx`), so “signature required” can be satisfied without drawing.
2) The app uses inconsistent naming/format:
   - UI emits PNG data URLs, but types + DB payload call it `signature_svg`.
   - Contract UI renders `signature_svg` as HTML (`dangerouslySetInnerHTML`), which will not render a PNG data URL.
3) IP capture is inconsistent (proposal attempts to capture `x-forwarded-for`; CO approval passes `signatureIp: null`).

---

## 1) Product Scope (what we’re building)

### 1.1 MVP: BYO PDF + field placement + executed PDF
Builders can:
- Upload their own PDF (or choose an org template)
- Place fields (at least `Signature`, `Initials`, `Date`, `Name`, `Checkbox`, `Text`)
- Choose who signs (v1: single signer; v2: multi-signer routing)
- Send a signing link (email + copy link)
- Receive an **executed (flattened) signed PDF** stored in Arc as a new version, with an audit trail

Clients can:
- Open tokenized signing link without Arc login
- Fill required fields and submit
- Download/view the executed PDF (optional on v1; recommended for trust)

### 1.2 Non-goals (explicitly not DocuSign)
- No complex routing rules, conditional fields, ID verification, notarization
- No redlining/negotiation UI in v1
- No generic template “document builder” (we take PDFs as the source of truth)

---

## 2) UX Flow (end-to-end)

### 2.1 Builder flow (internal app)
1) **Create “Document”** for a project (type: Proposal / Contract / Change Order / Other)
2) Choose source:
   - Upload PDF (BYO)
   - Choose org template (optional)
3) Generate page previews (thumbnails) and open “Prepare for signature”
4) Place fields on pages (drag/drop)
5) Configure signers (v1: one signer = client contact; v2: multiple signers)
6) Send signing request:
   - Create tokenized link + outbox email job
7) Track status: Draft → Sent → Viewed → Signed → Voided/Expired
8) When signed:
   - Arc stores executed PDF as a new file version
   - Arc locks the field layout for that revision

### 2.2 Client flow (public)
1) Open `https://app.arc.com/d/[token]` (exact route TBD)
2) View PDF with overlayed required fields
3) Fill fields:
   - Signature: draw (and optionally “adopt signature” per session)
   - Text/date/checkbox as needed
4) Submit:
   - Arc stamps the filled values into the PDF
   - Arc produces executed PDF + certificate/audit page (recommended)
5) Show confirmation + optionally provide download

---

## 3) Data Model (Supabase/Postgres)

Design constraints:
- Multi-tenant: everything org-scoped via `org_id`
- Project-scoped documents for client signing
- Public signing links use **hashed tokens** (never store raw tokens)
- Performance: indexes for RLS filters + FK columns + common list queries

### 3.1 New tables (recommended)

#### A) `documents`
Represents an instance to sign (proposal/contract/CO package).

Suggested columns:
- `id uuid pk`
- `org_id uuid not null references orgs(id) on delete cascade`
- `project_id uuid not null references projects(id) on delete cascade`
- `document_type text not null` (e.g. `proposal`, `contract`, `change_order`, `other`)
- `title text not null`
- `status text not null` (`draft`, `sent`, `signed`, `voided`, `expired`)
- `source_file_id uuid not null references files(id) on delete restrict` (the PDF being signed; “unsigned” version)
- `executed_file_id uuid references files(id) on delete set null` (optional: separate file record for executed PDF; see 3.3)
- `current_revision integer not null default 1`
- `metadata jsonb not null default '{}'::jsonb`
- `created_by uuid references app_users(id)`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Indexes:
- `create index documents_org_project_created_idx on documents (org_id, project_id, created_at desc);`
- `create index documents_org_status_created_idx on documents (org_id, status, created_at desc);` (composite index pattern)
- FK indexes (per best practice): `documents.project_id`, `documents.source_file_id`, `documents.executed_file_id`

#### B) `document_fields`
Field placement for a specific document revision.

Suggested columns:
- `id uuid pk`
- `org_id uuid not null references orgs(id) on delete cascade`
- `document_id uuid not null references documents(id) on delete cascade`
- `revision integer not null default 1`
- `page_index integer not null` (0-based to match existing PDF tooling)
- `field_type text not null` (`signature`, `initials`, `text`, `date`, `checkbox`, `name`)
- `label text` (e.g. “Owner Signature”)
- `required boolean not null default true`
- `signer_role text not null default 'client'` (v1: only `client`; v2: `owner_1`, `owner_2`, `builder`, etc.)
- `x numeric not null` (normalized 0..1)
- `y numeric not null` (normalized 0..1)
- `w numeric not null` (normalized 0..1)
- `h numeric not null` (normalized 0..1)
- `sort_order integer not null default 0`
- `metadata jsonb not null default '{}'::jsonb` (font size, checkbox style, etc.)
- `created_at timestamptz not null default now()`

Constraints:
- Check normalized bounds (`x/y/w/h` within 0..1; `w/h > 0`)
- Unique optional: `(document_id, revision, page_index, sort_order)` if you want deterministic ordering

Indexes:
- `create index document_fields_doc_rev_idx on document_fields (org_id, document_id, revision);`

#### C) `document_signing_requests`
A sendable link (token) that authorizes signing a specific doc revision.

Suggested columns:
- `id uuid pk`
- `org_id uuid not null references orgs(id) on delete cascade`
- `document_id uuid not null references documents(id) on delete cascade`
- `revision integer not null`
- `token_hash text not null` (HMAC of token with secret like proposals)
- `status text not null` (`draft`, `sent`, `viewed`, `signed`, `voided`, `expired`)
- `recipient_contact_id uuid references contacts(id)` (recommended)
- `sent_to_email citext`
- `sent_at timestamptz`
- `viewed_at timestamptz`
- `signed_at timestamptz`
- `expires_at timestamptz`
- `max_uses integer not null default 1`
- `used_count integer not null default 0`
- `created_by uuid references app_users(id)`
- `created_at timestamptz not null default now()`

Indexes:
- `create unique index document_signing_requests_token_hash_idx on document_signing_requests (token_hash) where token_hash is not null;`
- `create index document_signing_requests_org_doc_idx on document_signing_requests (org_id, document_id, created_at desc);`

#### D) `document_signatures` (or `document_signing_events`)
Stores the filled values + signer metadata.

Suggested columns:
- `id uuid pk`
- `org_id uuid not null references orgs(id) on delete cascade`
- `signing_request_id uuid not null references document_signing_requests(id) on delete cascade`
- `document_id uuid not null references documents(id) on delete cascade`
- `revision integer not null`
- `signer_name text`
- `signer_email citext`
- `signer_ip inet`
- `user_agent text`
- `consent_text text not null` (what they agreed to at signing time)
- `values jsonb not null default '{}'::jsonb`
  - Map field_id → value payload (signature image bytes ref / typed name / date / checkbox boolean)
- `created_at timestamptz not null default now()`

Indexes:
- `create index document_signatures_org_doc_idx on document_signatures (org_id, document_id, created_at desc);`
- FK indexes: `signing_request_id`, `document_id`

### 3.2 RLS policies (must be fast)

Apply Supabase RLS basics + performance guidance:
- Enable RLS on all new tables
- Prefer `is_org_member(org_id)` (matches current repo) and ensure it’s efficient
- Wrap `auth.uid()` in a `select` in policies to avoid per-row function calls

Policies (pattern):
- For internal app use:
  - `to authenticated` allow `select/insert/update` where org member
- For public signing links:
  - Do NOT grant `anon` broad access to tables.
  - Use a **service role** server action / route handler to resolve the token to a signing request and then perform the writes.

### 3.3 Files + versions strategy (pick one)

Option 1 (recommended): keep **one file record** for the PDF and store unsigned/signed as versions.
- `documents.source_file_id` points to the file.
- Unsigned is version 1; executed is version 2.
- Pros: great with `doc_versions`, supports re-signing revisions.
- Cons: you must ensure `doc_versions` includes per-version `storage_path` (it does in later migrations) and your download/view code can target a specific version.

Option 2: separate file record for executed PDF.
- `documents.source_file_id` (unsigned) + `documents.executed_file_id` (signed)
- Pros: simplest retrieval (“download executed file”)
- Cons: duplicates file records and complicates “history”

Pick one and standardize.

---

## 4) Storage + PDF Rendering/Stamps (how to make field placement real)

### 4.1 Preview images for field placement
You need page images to place fields accurately.

Recommended approach:
- On PDF upload, generate and store per-page images (thumb + medium).
- Store image paths in `documents.metadata` (or a child table `document_pages`).

Implementation options:
1) Client-side PDF.js render → upload to Storage (similar to drawings):
   - Pros: no server CPU
   - Cons: worker hosting must be reliable (avoid relying on unpkg in production)
2) Server/worker render:
   - Pros: consistent output
   - Cons: infra cost/ops

Given your drawings work already uses client-side PDF.js, reuse that approach but plan to host the PDF.js worker yourself (static asset) for reliability.

### 4.2 Executed PDF generation (stamp values into the original PDF)
Requirement: create an immutable, flattened PDF that includes filled fields.

Recommended approach:
- Use a PDF stamping library (e.g., `pdf-lib`) in a server context (API route or Edge Function if compatible).
- Inputs:
  - source PDF bytes (version N)
  - field layout (page + normalized coords)
  - filled values (text, checkbox, signature image bytes)
- Output:
  - executed PDF bytes
  - compute checksum/hash
  - upload to Storage as a new `doc_version`
  - update document status to `signed`

Also generate a simple “certificate” page (optional but recommended):
- signing request id
- signer name/email
- signed_at, ip, user-agent
- document hash

---

## 5) Services / API / Jobs (what code you’ll need)

### 5.1 Internal services (authenticated)
- `createDocument()` (creates `documents` + `files` record + initial version)
- `upsertDocumentFields()` (write `document_fields` for revision)
- `createSigningRequest()` (create random token + token_hash, write `document_signing_requests`)
- `sendSigningRequest()` (write outbox job + mark sent)
- `voidSigningRequest()` (prevent further signing)
- `listDocumentsForProject()` (builder UI)

### 5.2 Public signing (token-based, service role)
- `getSigningRequestByToken(token)`:
  - compute token_hash (HMAC) and lookup signing request
  - enforce status, expiry, max uses
  - mark viewed_at (once)
  - return minimal payload: document, page image URLs, fields, signer display info
- `submitSignature(token, payload)`:
  - validate required fields complete
  - insert `document_signatures` (store signer metadata + values)
  - generate executed PDF + store version
  - increment `used_count`, set `signed_at`

### 5.3 Email/outbox
You already insert outbox jobs for proposals, but there is no obvious worker implementation for `send_proposal_email` in the repo.

Do for documents:
- Add outbox job type: `send_document_for_signature`
- Implement processor (wherever outbox is handled) that sends email with signing link

---

## 6) Rollout Plan (phased, safe)

### Phase 0 — Fix existing signature correctness (required before BYO docs)
- Make “signature required” actually mean “user drew or adopted signature”
- Standardize signature storage format (PNG data URL vs SVG vs stroke paths)
- Standardize signer metadata (IP, user-agent, signed_at) across proposals/COs
- Fix contract signature rendering to match stored format

Acceptance criteria:
- Cannot submit “signature required” without any user action
- Signed artifact renders correctly in the app

### Phase 1 — BYO doc upload + previews + field placement (no public signing yet)
- Document create UI (upload PDF)
- Generate page previews and store
- Field placement UI (save `document_fields`)
- Builder can preview “what client will see”

Acceptance criteria:
- Builder can place fields reliably across pages and re-open to edit

### Phase 2 — Public signing link + capture + audit (no stamping yet)
- Create token link, public page shows PDF + overlays
- Client fills fields; store `document_signatures.values` + audit metadata

Acceptance criteria:
- Signing completes and is auditable; status changes to Signed

### Phase 3 — Executed PDF stamping + versioning
- Generate flattened executed PDF
- Store as a new version (or separate executed file)
- Add “Download executed PDF” in UI

Acceptance criteria:
- Executed PDF matches placements and is immutable

### Phase 4 — Multi-signer + routing (optional)
- Multiple signer roles
- Sequential signing (owner1 → owner2 → builder)
- Partial completion tracking per signer

---

## 6.5) Progress Log

- 2026-02-04: Phase 1 **completed**. DB migration for documents/signing tables + RLS + indexes applied; validation schemas + document services added; project page for E‑Sign Documents added with PDF upload, live PDF preview, and field placement/save. Note: previews are rendered live (no stored thumbnail generation yet).
- 2026-02-04: Phase 2 **completed**. Public signing route (`/d/[token]`) added with PDF preview + field overlays, input capture, consent, and submit flow storing signatures + marking requests/documents as signed.
- 2026-02-04: Phase 3 **completed**. Executed PDF stamping via `pdf-lib`, stored in R2 with org-scoped, organized paths; executed file recorded + linked on documents; server-side validation of required fields added.
- 2026-02-04: Phase 4 **completed**. Multi-signer sequencing added via signing group columns (group_id/sequence/required/signer_role); signing UI filters fields per signer role and enforces order; server-side validation blocks out-of-sequence signing.

---

## 7) Migration + Index Checklist (copy/paste for implementation)

When writing migrations, follow best practices:
- Enable RLS + add policies
- Add FK indexes (Postgres doesn’t auto-index FKs)
- Add composite indexes that match list queries (e.g., `(org_id, project_id, created_at desc)`)
- Use partial unique index for token hashes
- Keep policies simple and index-backed (avoid per-row expensive functions)

Migration checklist:
- [ ] Create tables: `documents`, `document_fields`, `document_signing_requests`, `document_signatures`
- [ ] Add FK indexes for every `..._id` used in joins/filters
- [ ] Add composite indexes for list screens
- [ ] Add unique/partial index for `token_hash`
- [ ] Enable RLS on all new tables
- [ ] Add policies using `is_org_member(org_id)` and wrap `auth.uid()` inside `select` where used directly
- [ ] Add `tg_set_updated_at()` triggers for tables with `updated_at`

### 7.1 SQL skeleton (start here when writing migrations)

Notes:
- Keep identifiers lowercase (matches existing repo conventions).
- Prefer `timestamptz` for timestamps.
- Add explicit indexes for foreign keys + list queries.
- Do **not** grant public/anon policies for signing; use tokenized public routes that run with service role and do their own checks.

```sql
-- documents
create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  document_type text not null check (document_type in ('proposal','contract','change_order','other')),
  title text not null,
  status text not null default 'draft' check (status in ('draft','sent','signed','voided','expired')),
  source_file_id uuid not null references files(id) on delete restrict,
  executed_file_id uuid references files(id) on delete set null,
  current_revision integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists documents_org_project_created_idx on documents (org_id, project_id, created_at desc);
create index if not exists documents_org_status_created_idx on documents (org_id, status, created_at desc);
create index if not exists documents_project_id_idx on documents (project_id);
create index if not exists documents_source_file_id_idx on documents (source_file_id);
create index if not exists documents_executed_file_id_idx on documents (executed_file_id) where executed_file_id is not null;
create trigger documents_set_updated_at before update on documents for each row execute function public.tg_set_updated_at();

-- document_fields
create table if not exists document_fields (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  revision integer not null default 1,
  page_index integer not null check (page_index >= 0),
  field_type text not null check (field_type in ('signature','initials','text','date','checkbox','name')),
  label text,
  required boolean not null default true,
  signer_role text not null default 'client',
  x numeric not null check (x >= 0 and x <= 1),
  y numeric not null check (y >= 0 and y <= 1),
  w numeric not null check (w > 0 and w <= 1),
  h numeric not null check (h > 0 and h <= 1),
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists document_fields_doc_rev_idx on document_fields (org_id, document_id, revision);
create index if not exists document_fields_document_id_idx on document_fields (document_id);

-- document_signing_requests
create table if not exists document_signing_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  revision integer not null,
  token_hash text not null,
  status text not null default 'draft' check (status in ('draft','sent','viewed','signed','voided','expired')),
  recipient_contact_id uuid references contacts(id) on delete set null,
  sent_to_email citext,
  sent_at timestamptz,
  viewed_at timestamptz,
  signed_at timestamptz,
  expires_at timestamptz,
  max_uses integer not null default 1,
  used_count integer not null default 0,
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists document_signing_requests_token_hash_idx
  on document_signing_requests (token_hash) where token_hash is not null;
create index if not exists document_signing_requests_org_doc_created_idx
  on document_signing_requests (org_id, document_id, created_at desc);
create index if not exists document_signing_requests_document_id_idx on document_signing_requests (document_id);
create index if not exists document_signing_requests_recipient_contact_id_idx on document_signing_requests (recipient_contact_id)
  where recipient_contact_id is not null;

-- document_signatures
create table if not exists document_signatures (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  signing_request_id uuid not null references document_signing_requests(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  revision integer not null,
  signer_name text,
  signer_email citext,
  signer_ip inet,
  user_agent text,
  consent_text text not null,
  values jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists document_signatures_org_doc_created_idx on document_signatures (org_id, document_id, created_at desc);
create index if not exists document_signatures_signing_request_id_idx on document_signatures (signing_request_id);
create index if not exists document_signatures_document_id_idx on document_signatures (document_id);

-- RLS
alter table documents enable row level security;
alter table document_fields enable row level security;
alter table document_signing_requests enable row level security;
alter table document_signatures enable row level security;

-- Policies: internal app access (org members)
create policy documents_access on documents
  for all to authenticated
  using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy document_fields_access on document_fields
  for all to authenticated
  using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy document_signing_requests_access on document_signing_requests
  for all to authenticated
  using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy document_signatures_access on document_signatures
  for all to authenticated
  using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));
```

---

## 8) Open Questions (decide early)

1) **Document types**: do we treat proposal/CO as separate modules or unify under `documents` and link to existing `proposals` / `change_orders`?
2) **Executed PDF storage**: versioning (preferred) vs separate file record?
3) **Signer identity**: email-only magic link (recommended) vs requiring portal login?
4) **Multi-signer**: do we need it for v1 or can we ship single-signer first?
5) **Template library**: do we need org-level templates immediately?
   - If yes and `files.project_id` is not nullable in your production schema, you’ll need either:
     - a separate org-file concept/table, or
     - relax `files.project_id` to nullable for org templates.

---

## 9) Definition of Done (what “we shipped BYO docs signing” means)

- Builder can upload a PDF, place fields, send for signature, and see status.
- Client can sign without login via token link.
- Arc stores signer metadata + audit trail and produces an executed PDF stored in Arc Storage.
- All data is org-scoped with RLS, indexed for performance, and safe for growth.
