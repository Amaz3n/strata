# Directory Unification + Vendor Management (Execution Plan)

## Goal

Make the app feel like it has a single, unified “Directory” area (like Procore/Buildertrend), **without** merging `companies` and `contacts` into one database table. Unification happens at the **route + navigation + UX** level.

This plan is written to be LLM-executable: explicit files, invariants, and acceptance checks with minimal ambiguity.

---

## Current State (Repo Reality Check)

- Routes exist today:
  - `app/companies/page.tsx` + `app/companies/actions.ts`
  - `app/contacts/page.tsx` + `app/contacts/actions.ts`
  - `app/team/page.tsx` + `app/team/actions.ts`
- Sidebar “Directory” is currently a dropdown (Team/Contacts/Companies): `components/layout/app-sidebar.tsx`
- Detail UI exists as sheets:
  - `components/companies/company-detail-sheet.tsx`
  - `components/contacts/contact-detail-sheet.tsx`
- Search UI exists as a command dialog spanning companies/contacts/team:
  - `components/directory/directory-search.tsx` (wired from `components/companies/companies-table.tsx`)
- DB schema already has:
  - `companies`, `contacts`, `contact_company_links`, `commitments`, `vendor_bills`, `project_vendors`, etc.: `supabase/schema.sql`
- Archive model is soft-archive via `metadata.archived_at` and is enforced in services:
  - `lib/services/companies.ts`, `lib/services/contacts.ts`

---

## Non-Negotiable Decisions (Avoid Gaps Later)

### 1) Keep separate tables; unify the experience
- Keep `companies` and `contacts` separate in DB.
- Create a single `/directory` route with internal views (tabs/segmented control).

### 2) Fix relationship consistency (required)
Right now, contacts can have `primary_company_id` without necessarily having a corresponding `contact_company_links` row; company contact lists/counts rely heavily on the link table.

**Invariant (must enforce in service layer):**
- If `contacts.primary_company_id` is set, ensure a matching `contact_company_links` row exists (`relationship = "primary"`).
- If primary company changes, update the primary link accordingly.

### 3) Define “standalone contact” correctly (for a hybrid “All” view)
A contact is standalone iff:
- `primary_company_id IS NULL` **and**
- there are **no** `contact_company_links` rows for that contact.

### 4) Scale guardrail
Do **not** preload all contacts for all companies. Company expansion should fetch contacts on-demand (server action).

---

## Phase 1 — Make `/directory` the Home (Minimal-Churn MVP) — **Status: Completed**

### 1. Create `/directory` route
**File:** `app/directory/page.tsx`

- Server component with `export const dynamic = "force-dynamic"`.
- Fetch in parallel:
  - `getCurrentUserAction()`
  - `getCurrentUserPermissions()`
  - `listCompanies()`
  - `listContacts()`
- Render “Directory” page with view tabs:
  - **Companies** tab: reuse `InsuranceWidget` + `CompaniesTable`
  - **People** tab: reuse `ContactsTable`
  - (Optional) **All** tab deferred to Phase 3

**Important:** preserve current permission behavior:
- Companies: `canCreate/canEdit = org.member`, `canArchive = org.admin || members.manage`
- Contacts: same + `canInvitePortal = project.manage`

### 2. Update sidebar navigation
**File:** `components/layout/app-sidebar.tsx`

- Replace the “Directory” dropdown with a single “Directory” link pointing to `/directory`.
- Remove Team/Contacts/Companies sub-items from sidebar.

### 3. Keep old routes working (no broken links)
Initial approach (recommended):
- Keep `app/contacts/page.tsx` and `app/companies/page.tsx` temporarily, but remove them from navigation.

Final approach (after parity confirmed):
- Redirect:
  - `/contacts` → `/directory?view=people`
  - `/companies` → `/directory?view=companies`

### Acceptance checks (Phase 1)
- Users can do everything they could do before (create/edit/archive/view details) from `/directory` via the two views. **Completed**
- Sidebar no longer feels fragmented (one Directory entry). **Completed**

---

## Phase 2 — Close Consistency + Revalidation Gaps (Must-Have) — **Status: Completed**

### 1. Enforce primary-company link invariant
**File:** `lib/services/contacts.ts`

- In `createContact`:
  - If `primary_company_id` is present, upsert into `contact_company_links` with `relationship = "primary"`.
- In `updateContact`:
  - If primary company changes: upsert new `"primary"` link, delete old `"primary"` link (recommended).
  - If primary company cleared: delete any `"primary"` link rows for that contact (recommended).

**Why:** This prevents “contact not showing under company” and mismatched counts.

### 2. Make company contact queries resilient to legacy data
**File:** `lib/services/companies.ts`

Until the invariant is fully trusted, make `getCompanyContacts` (and/or `getCompany`) include:
- contacts linked via `contact_company_links` **OR**
- contacts where `contacts.primary_company_id = companyId`

### 3. Revalidate `/directory` after mutations (easy-to-miss)
**Files:**
- `app/contacts/actions.ts`
- `app/companies/actions.ts`

Add `revalidatePath("/directory")` for:
- contact: create/update/archive/link/unlink
- company: create/update/archive

### 4. Update internal links to point at `/directory`
**File:** `components/dashboard/onboarding-checklist.tsx`

- Change “Add contacts/companies” link to `/directory` (or `/directory?view=people`).

### Acceptance checks (Phase 2)
- Creating a contact with a Primary Company makes them appear under that company everywhere (detail sheets, company contact counts, directory lists). **Completed**
- Editing/archiving from any view updates `/directory` without manual refresh. **Completed**

---

## Phase 3 — Optional “All” View (Hybrid List Done Right) — **Status: Completed**

If you want the “single list that shows everything” feel, ship it as a **third tab**, not as the only UI.

### UX rules
- Top-level shows:
  - all companies
  - standalone contacts (definition above)
- Company rows are expandable; expanding loads contacts lazily.
- Avoid duplicates:
  - Contacts that belong to a company should not also appear top-level.
  - If a contact is linked to multiple companies, display them under their **primary** company in the All view (and show additional companies inside contact detail).

### Implementation
**Server action:**
- `app/directory/actions.ts`
  - `getCompanyContactsForDirectoryAction(companyId)` → calls the company contact query and returns contacts

**New components (suggested):**
- `components/directory/directory-client.tsx` (tab state, search state, sheet open state)
- `components/directory/directory-table.tsx` (hybrid list with expand rows)
- `components/directory/directory-add-sheet.tsx` (choose Company vs Contact, reuse existing forms)

### Acceptance checks (Phase 3)
- Expanding a company does not require loading all contacts upfront. **Completed**
- Standalone contacts are correct (no company links at all). **Completed**

---

## Phase 4 — Team to Settings (Only After Permissions Decision) — **Status: Completed**

- Loosened settings access (now fetched for any org member) and gated Team actions by permissions.
- Added Team tab in `components/settings/settings-window.tsx` reusing `TeamTable` + `InviteMemberDialog`.
- Team actions now revalidate `/settings` as well as `/team`.

Acceptance:
- Users with `members.manage`/`org.admin` can manage Team from Settings; other members can still access non-Team tabs. **Completed**

---

## Phase 5 — Company Detail Page (Vendor Management) — **Status: Completed**

### Route: `/companies/[id]`
Full-page company detail with tabbed interface for vendor management. (You can keep the existing sheet for quick view.)

**Suggested layout**
```
┌────────────────────────────────────────────────────────────────┐
│  ← Back to Directory                                           │
│  ABC Electric                              [Edit] [Archive]    │
│  Subcontractor · Electrical · Since Jan 2023                   │
├────────────────────────────────────────────────────────────────┤
│  [Overview] [Contacts] [Projects] [Contracts] [Invoices] [Docs]│
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  (Tab content here)                                            │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

Tabs:
- Overview (contact info, trade/type, quick compliance summary)
- Contacts
- Projects (via `project_vendors`)
- Contracts (via `commitments`)
- Invoices (via `vendor_bills`)
- Compliance/Docs (insurance certs, license, W-9, prequal)

**Tab detail (baseline requirements)**
- Overview: phone/email/website/address, trade/type, default payment terms, internal notes, quick compliance status cards
- Contacts: list, add, edit/archive, send portal invites
- Projects: list projects where assigned (`project_vendors`), role per project, link to project
- Contracts: commitments with status + totals, invoiced vs total, create new
- Invoices: vendor bills by status, payment info, summary totals
- Compliance/Docs: insurance certs + expiry alerts, license verification, W-9, prequal status

**Implemented (repo)**
- Full-page company detail route: `app/companies/[id]/page.tsx`
- Tabbed UI: `components/companies/company-detail-page.tsx` + `components/companies/company-*-tab.tsx`
- Contracts: create + list commitments and billed/remaining totals: `lib/services/commitments.ts`
- Invoices: list vendor bills for company and update status (approve/paid + payment reference): `lib/services/vendor-bills.ts`, `app/companies/[id]/actions.ts`
- Compliance + vendor profile fields stored in `companies.metadata` (no DB migration required)

**Acceptance**
- Supports insurance/license/W-9/prequal/rating/default terms/internal notes on vendor profile. **Completed**
- Shows project history and vendor invoices; invoices can be approved/marked paid. **Completed**
- Contracts track billed totals and remaining vs contract amount. **Completed**

---

## Database Notes (Pragmatic Path)

### Today (works)
- Company “compliance” fields are stored in `companies.metadata` and mapped in `lib/services/companies.ts`.

### When expanding vendor management
- Consider normalizing compliance into tables (multiple policies, renewals, multiple files) instead of many columns on `companies`.
- Optional denormalization:
  - Add `company_id` to `vendor_bills` for faster filtering by company (source of truth should remain `commitment_id → company_id`, and you must keep them consistent).

**Existing tables used by this plan (already in `supabase/schema.sql`)**
- `companies`, `contacts`, `contact_company_links`
- `project_vendors`
- `commitments`, `commitment_lines`
- `vendor_bills`, `bill_lines`
- `files`, `file_links`

**Optional schema enhancements (only if you outgrow `companies.metadata`)**
If you choose to move key compliance fields to columns for queryability:
```sql
ALTER TABLE companies ADD COLUMN IF NOT EXISTS
  insurance_gl_expiry date,
  insurance_gl_coverage_cents integer,
  insurance_wc_expiry date,
  insurance_wc_coverage_cents integer,
  insurance_auto_expiry date,
  insurance_certificate_file_id uuid references files(id),
  license_type text,
  license_expiry date,
  license_verified boolean default false,
  w9_on_file boolean default false,
  w9_file_id uuid references files(id),
  prequalified boolean default false,
  prequalified_at timestamptz,
  rating integer check (rating between 1 and 5),
  default_payment_terms text,
  internal_notes text;
```

Optional denormalization for bills:
```sql
ALTER TABLE vendor_bills ADD COLUMN IF NOT EXISTS
  company_id uuid references companies(id) on delete set null;

CREATE INDEX IF NOT EXISTS vendor_bills_company_idx ON vendor_bills(company_id);
```

---

## File Structure (Target State)

**New**
- `app/directory/page.tsx`
- `app/directory/actions.ts` (Phase 3+)
- `components/directory/directory-client.tsx` (Phase 3+)
- `components/directory/directory-table.tsx` (Phase 3+)
- `components/directory/directory-add-sheet.tsx` (Phase 3+)

**Modified**
- `components/layout/app-sidebar.tsx`
- `app/contacts/actions.ts`
- `app/companies/actions.ts`
- `lib/services/contacts.ts`
- `lib/services/companies.ts` (recommended)
- `components/dashboard/onboarding-checklist.tsx`

---

## Implementation Order (Recommended)

1) Phase 1: `/directory` + sidebar update
2) Phase 2: relationship invariant + resilient queries + revalidation + link updates
3) Phase 1 (finalize): redirect old `/contacts`/`/companies` routes
4) Phase 3: optional “All” hybrid view with lazy expansion
5) Phase 4: Team → Settings (after permissions model is decided)
6) Phase 5: company detail full-page tabs + vendor management
