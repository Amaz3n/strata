# Wave 2 — Commercial Hardening & Field Gameplan

> **Audience:** an LLM executing agent. Read `00-MASTER-commercial-expansion.md` FIRST —
> every rule there (sections 4–7) applies here verbatim, with ONE amendment (§2 below).
> This doc extends the commercial expansion with the gaps identified in the July 2026
> post-ship review: the progress-billing default is still flag-gated, certified payroll
> is a demo dealbreaker for public work, the four new field modules have no mobile
> surface, and document control lacks specs/locations/photos. Plus one differentiator:
> AI-drafted meeting minutes.

## 1. Mission

Wave 1 (workstreams 01–08) shipped the commercial spine: posture model, owner SOV +
pay apps, change lifecycle, external collaborators, docs suite, field/safety/quality,
financial controls, daily-report/schedule hardening. Wave 2 closes what a commercial
GC notices next:

| WS | Name | Why now |
|---|---|---|
| A | Progress-billing default un-gating | Wave 1's flagged default means fresh commercial orgs still get residential draw billing. Silent product defect. |
| B | Structured locations | Foundation consumed by C, D, and F. Commercial jobs track everything by building/floor/area. |
| C | Photos lens | Cheap, high-visibility. Derived view, zero new storage. |
| D | Specifications module | The missing third leg of document control (drawings ✓, submittals ✓, specs ✗). |
| E | Certified payroll / prevailing wage | Public-work GCs ask in the first demo. Was deferred item A7 in doc 09 — now green-lit. |
| F | GC-side bonds/insurance + sub-tier lien waivers | Deferred items A8 + A9 in doc 09 — now green-lit. Completes the pay-app package. |
| G | Meetings supercharged | Recorder + AI-drafted minutes + live run mode. The wave's differentiator. |
| H | Mobile parity (iOS + mobile API + responsive web) | Doc 09 item A10 commitment, honored. Field modules are phone-native or they are compliance chores. |

**Execution order: A → B → C → D → E → F → G → H.** A is a half-day and fixes a live
defect — do it first. B before C/D/F because they consume locations. H last because it
consumes everything (it exposes B–G to the field). Within a workstream, follow its
phase order. Do not start a workstream until the previous one's acceptance passes.

## 2. Process amendment: migrations

**This wave, the executor MAY apply migrations directly** via Supabase MCP
`apply_migration` without pausing for human approval, under these conditions:

1. The SQL file is ALSO saved to `supabase/migrations/` with a `YYYYMMDDHHMMSS_name.sql`
   prefix in the same change — the repo stays the source of truth.
2. The migration is **purely additive and backward-compatible**: new tables, new
   nullable columns (or columns with defaults), new indexes, new RPCs, new RLS
   policies. Existing rows keep working with zero code deployed.
3. **Destructive operations still require the human**: DROP anything, ALTER a column
   type, rewrite data in customer tables, DELETE rows — EXCEPT the one deletion
   explicitly pre-approved in WS-A (feature-flag config rows).
4. Every new table still ships complete per master rule 18: org-scoped RLS with
   `(select auth.uid())` (never bare `auth.uid()`), indexes on `(org_id, project_id)`
   for list-queried tables plus FK-hot columns, and the standard `updated_at` trigger.
5. Remember this is PRODUCTION. Verify schema claims with MCP `list_tables` /
   SELECT-only `execute_sql` before writing any migration. Acceptance testing runs in
   the internal QA org only.

All other master rules stand unchanged, especially: posture helpers only (rule 17),
search-index registration (19), email allowlist (20), RBAC catalog seed (21),
`pnpm lint` after every phase, `pnpm test:financials` for anything financial.

---

## WS-A — Un-gate the commercial billing default (½ day)

**Problem.** `emptyFinancialSetup()` defaults commercial-posture projects to
`fixed_price` + `fixed_price_billing_basis: "progress"` ONLY when the org's
`progress_billing_enabled` feature flag is on — and the flag defaults OFF
(`lib/services/feature-flags.ts:16`, documented as a rollout kill-switch to be
deleted after a QA cycle). Net effect today: a fresh commercial org gets residential
draw billing by default. Workstream 02 has passed its QA cycle; the flag dies now.

**Read first:** `lib/services/feature-flags.ts`, `app/(app)/layout.tsx` (~L36 Promise.all),
`components/layout/page-title-context.tsx`, `app/(app)/projects/projects-client.tsx`
(emptyFinancialSetup call sites), `components/projects/project-settings-sheet.tsx` (~L821),
`components/projects/project-financial-setup-fields.tsx`,
`components/admin/feature-flags-table.tsx`.

**Do:**

1. Delete `PROGRESS_BILLING_FLAG_KEY` and `isProgressBillingEnabledForOrg` from
   `lib/services/feature-flags.ts`. Check remaining consumers of the generic
   `isFeatureEnabledForOrg` (grep) — if the file has no other users, delete it entirely;
   if other flags use it, keep the generic helper only.
2. Remove the `progressBillingEnabled` plumbing end to end: the layout Promise.all
   entry, the `PageTitleProvider` prop, `usePageTitle()` consumers, the
   `progressBillingEnabled` params on `emptyFinancialSetup()` and
   `ProjectFinancialSetupFields`. The draws-vs-progress radio
   (project-financial-setup-fields.tsx ~L407) becomes always visible for
   `fixed_price`. Default basis: `posture === "commercial" ? "progress" : "draws"`.
3. Remove the flag row from `components/admin/feature-flags-table.tsx`.
4. Migration (pre-approved deletion): `delete from feature_flags where
   flag_key = 'progress_billing_enabled';` — config rows only, no customer data.
5. Leave no trash: grep `progress_billing\|progressBillingEnabled` must return zero
   hits in `lib/ app/ components/` when done.

**Accept:** `pnpm lint` + `pnpm test:financials` clean. In the QA org: new
commercial-posture project → financial setup pre-selects Fixed price + Progress
billing (SOV) + 10% retainage; new residential project still defaults to Draws + 0%.
Existing projects' settings unchanged.

---

## WS-B — Structured locations (1–2 days)

**Problem.** `punch_lists.location`, inspections, observations use free text.
Commercial jobs track work by Building → Floor → Area. Locations are also the filter
spine for Photos (C) and useful metadata for daily logs and incidents.

**Read first:** `lib/services/punch-lists.ts`, `lib/services/inspections.ts`,
`lib/services/safety.ts`, `components/projects/project-settings-sheet.tsx` (module
toggles section — locations management lands in this sheet),
`lib/services/project-sequence.ts` (NOT needed here — locations are unnumbered; listed
so you don't reach for it).

**Schema** (one migration, apply directly per §2):

```sql
create table project_locations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  project_id uuid not null references projects(id),
  parent_id uuid references project_locations(id),
  name text not null,
  full_path text not null,          -- denormalized "Building A > Level 2 > Corridor"
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- + RLS, (org_id, project_id) index, parent_id index, updated_at trigger (master rule 18)
```

Additive nullable `location_id uuid references project_locations(id)` columns on:
`punch_lists`, `inspections`, `observations`, `safety_incidents`, `daily_logs`
(verify exact table names via `list_tables` first). Keep every existing free-text
`location` column untouched — new picker writes both (`location` gets the
`full_path` string so PDFs/CSVs/old UI keep working with zero changes).

**Do:**

1. Service `lib/services/locations.ts`: `listProjectLocations` (tree-ordered),
   `createLocation`, `updateLocation` (rename cascades `full_path` to descendants —
   do it in the service, recursive CTE update), `setLocationActive`. Permission:
   reuse `project.manage` for mutations — no new key; reads are unrestricted within
   org context. Support a `bulkCreate` that takes pasted multi-line text
   ("Building A\n  Level 1\n  Level 2" — two-space indent = child) so setup takes
   one paste, not thirty dialogs.
2. `LocationPicker` client component (combobox on shadcn primitives, shows
   `full_path`, inline "create" affordance for `project.manage` holders). One
   component, used everywhere.
3. Wire the picker into punch item create/edit, inspection create, observation
   create, incident create, daily log entry. Each write sets `location_id` AND
   mirrors `full_path` into the legacy text column.
4. Management UI: a "Locations" section in the project settings sheet (same pattern
   as the module toggles block): indented tree list, add/rename/deactivate, bulk
   paste. No separate page — this is setup, not daily work.
5. Filters: punch list, inspections list, observations list each gain a location
   filter (match each list's existing filter row pattern exactly).

**Accept:** lint clean. QA org: create a 3-level tree via bulk paste; punch item
created with a location shows the path in list + detail + existing PDF (via the text
mirror); renaming a parent updates descendants' `full_path`; deactivated locations
disappear from pickers but historical records still render; filters narrow correctly.
Empty state on the tree ("No locations yet — paste your building/floor list").

---

## WS-C — Photos lens (1–2 days)

**Principle (decided, do not revisit): Photos is a derived VIEW, not a storage
destination.** Photos already live attached to daily logs, punch items, inspection
items, observations, RFIs, and plain files. Three upload homes for the same jobsite
photo would fragment the archive. This module is one query + a grid.

**Read first:** `lib/services/file-source-contexts.ts` (the entity-attribution
substrate — `file_links` with entity_type/entity_id), `lib/services/files.ts`,
`lib/project-modules.ts`, the daily logs tab (photo attach flow), an existing
project tab for layout (`app/(app)/projects/[id]/punch/`).

**Schema:** NONE. Zero new tables. If query performance demands it, one additive
index on `files` (e.g. partial index on org_id/project_id where mime_type like
'image/%' — verify actual column names first).

**Do:**

1. Service `lib/services/photos.ts`: `listProjectPhotos({ projectId, cursor, filters })`
   → paginated (mandatory — this list is unbounded by definition; cursor on
   created_at desc). Joins files (mime image/*) with `file_links` /
   `listFileSourceContexts` to attach source: `{ entity_type, entity_id, label, href }`.
   Filters: date range, source entity type, uploader, location (via the source
   entity's `location_id` where the entity has one — B). Include un-linked image
   files with source "Files".
2. Page `app/(app)/projects/[id]/photos/`: dense date-grouped grid (day headers),
   source badge per thumbnail ("Daily log · Jun 12", "Punch #47"), click → lightbox
   with metadata rail (source deep-link, uploader, location, date). Infinite scroll
   via the cursor. Empty/loading/error states, dark mode — the grid must feel like
   the drawings sheets grid, not a consumer gallery. No masonry, no rounded corners.
3. Capture path: the page's single "Add photos" action uploads via the existing files
   flow and **attaches to today's daily log** (creating today's log if absent — reuse
   the daily-logs service). This restores the old "chronological stream" behavior
   without a new home. State this in the empty-state copy.
4. Module entry in `PROJECT_MODULES`: key `photos`, NO `postures` restriction
   (residential wants this too), placed after `daily_logs`.
5. Search: photos are files — already indexed; no search-index work. No new
   permissions — file read/write perms govern.

**Accept:** lint clean. QA org: photos attached via punch, inspection, observation,
daily log, and a raw file upload ALL appear once each, correctly badged, deep links
land on the owning record; upload from the Photos page lands on today's daily log;
filters + pagination work; a project with 0 photos shows the empty state.

---

## WS-D — Specifications module (3–4 days)

**Problem.** Submittals carry a free-text `spec_section`; there is no spec book.
Commercial document control expects: upload the project manual (one or several PDFs),
get a browsable per-section register (CSI-organized), re-upload addenda as revisions,
and pick real sections on submittals.

**Read first (mandatory, this is the sharp-edge workstream):**
`lib/services/drawings-pipeline.ts` — the architectural template: ONE canonical
section set per project, re-uploads stack revisions onto existing sections, never a
set per upload, never delete old revisions. Also: `lib/services/drawings.ts`,
whatever OCR/text-extraction utilities the drawings pipeline uses (find and reuse
them — do not add a second OCR stack), `lib/services/submittals.ts` (spec_section
usage), `lib/services/search-index.ts`, `lib/services/document-numbering.ts`.

**Schema:**

```sql
create table spec_sections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  project_id uuid not null references projects(id),
  division text not null,            -- "09"
  section_number text not null,      -- "09 91 23"
  title text not null,               -- "Interior Painting"
  current_revision_id uuid,          -- FK added after spec_revisions exists
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, section_number)
);
create table spec_revisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  project_id uuid not null references projects(id),
  section_id uuid not null references spec_sections(id),
  revision_number integer not null,
  source_upload_id uuid,             -- groups revisions born from one upload
  file_id uuid not null,             -- the per-section split PDF
  page_start integer, page_end integer,
  extracted_text text,               -- for search
  issued_date date,
  created_at timestamptz not null default now()
);
create table spec_uploads (          -- pipeline job tracking, mirrors drawings upload rows
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null, project_id uuid not null,
  file_id uuid not null, status text not null default 'pending',  -- pending|processing|complete|failed
  sections_detected integer, error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
-- + RLS/indexes/triggers per master rule 18, on all three
```

Plus additive on `submittals`: `spec_section_id uuid references spec_sections(id)`
(nullable; existing free-text `spec_section` column stays and keeps working).

**Do (phases):**

1. **Pipeline.** `lib/services/specs-pipeline.ts` copying the drawings pipeline's
   structure (job status, async processing via the same trigger mechanism —
   see `drawings-pipeline-trigger.ts`): split the uploaded PDF on CSI section
   headings (regex on extracted text: `SECTION\s+\d{2}\s?\d{2}\s?\d{2}` plus title
   line; use the AI provider via `lib/services/ai-config.ts` ONLY for pages where
   the regex is ambiguous — cheap model, classification not generation). Each
   detected section → upsert `spec_sections` by `section_number` (canonical-set
   rule), append a `spec_revisions` row, bump `current_revision_id`. Re-uploading an
   addendum revises matched sections and creates new ones; it NEVER duplicates or
   deletes.
2. **Register page** `app/(app)/projects/[id]/specs/`: table grouped by division
   (division header rows), columns section number / title / rev / issued date /
   linked submittals count. Row → section viewer (PDF of current revision, revision
   history rail). Upload affordance shows pipeline status (copy the drawings upload
   status UI). Fallback path: manual "add section" + attach PDF, for when the split
   fails — pipeline failure must never block the module.
3. **Integration.** Submittal create/edit: `spec_section` free-text input becomes a
   combobox backed by `spec_sections` when the project has any (writes both
   `spec_section_id` and the text column); stays free text otherwise. Section viewer
   lists submittals referencing it.
4. **Registration.** Module entry in `PROJECT_MODULES` (`specs`, postures
   `["commercial"]`, description "Project manual and spec sections."). Search-index
   registration for `spec_section` (master rule 19). Permission: new key `spec.write`
   in the RBAC catalog seed + `TEAM_PERMISSION_OPTIONS` — grant to admin/PM-class
   roles, same set that holds `drawing`-write-equivalent; state the mapping in the
   completion note. Reads need no new key.

**Accept:** lint clean. QA org: upload a multi-section PDF project manual → sections
appear under correct divisions with correct page splits; re-upload an addendum PDF →
matched sections gain rev 2, history intact; submittal links to a real section and
the section shows it; global search finds a section by number and title; pipeline
failure path shows the error state and manual add works.

---

## WS-E — Certified payroll / prevailing wage (4–5 days)

**Scope guardrail (decided): Arc is NOT becoming a payroll system.** No taxes, no
net-pay computation, no payments. Arc owns what it already has — hours
(`time_entries` with OT/DT), workers, projects — adds prevailing-wage metadata, and
generates the WH-347 certified payroll report + Statement of Compliance. Deductions
and net pay are keyed in (or left for the attached payroll register) per report.

**Read first:** `lib/services/tm-tickets.ts` + `lib/services/billing-rate-schedules.ts`
+ the time tab (`app/(app)/projects/[id]/time/`) to learn the time_entries model
(verify columns via `list_tables`: user linkage, OT/DT fields, approval states);
`lib/services/reports/pay-application.ts` (PDF conventions);
`lib/services/project-sequence.ts` (payroll numbering);
`lib/services/team.ts` (permission catalog).

**Schema:**

```sql
create table wage_determinations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null, project_id uuid not null,
  determination_number text not null,   -- e.g. "GA20260012"
  source text,                           -- sam.gov ref / state agency
  effective_date date,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table wage_classifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  determination_id uuid not null references wage_determinations(id),
  classification text not null,          -- "Electrician", "Laborer Group 1"
  base_rate_cents integer not null,
  fringe_rate_cents integer not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table payroll_worker_profiles (   -- payroll metadata for people who log time
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  user_id uuid,                          -- nullable: crews may not be Arc users
  display_name text not null,
  address text,
  tax_id_last4 text,                     -- LAST 4 ONLY. Never store full SSN. Enforce in zod (max length 4).
  default_classification_id uuid references wage_classifications(id),
  fringe_paid_in_cash boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table certified_payroll_reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null, project_id uuid not null,
  payroll_number integer not null,       -- sequential per project, includes no-work weeks
  week_ending date not null,
  status text not null default 'draft',  -- draft|finalized
  is_no_work boolean not null default false,
  is_final boolean not null default false,
  pdf_file_id uuid,
  finalized_at timestamptz, finalized_by uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (project_id, payroll_number)
);
create table certified_payroll_lines (   -- one row per worker per report; day hours + money snapshot
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  report_id uuid not null references certified_payroll_reports(id),
  worker_profile_id uuid not null references payroll_worker_profiles(id),
  classification_id uuid references wage_classifications(id),
  day_hours jsonb not null,              -- {"2026-07-06": {"st": 8, "ot": 1.5}, ...}
  st_rate_cents integer not null, ot_rate_cents integer not null,
  fringe_rate_cents integer not null default 0,
  gross_this_project_cents integer not null,
  gross_all_projects_cents integer,      -- keyed in; WH-347 column 7 allows split
  deductions jsonb,                      -- keyed in: {"fica": 12345, "fed_tax": 23456, "other": ...}
  net_pay_cents integer,                 -- keyed in or null ("see attached register")
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
-- + RLS/indexes/triggers per master rule 18, on all five
```

Plus additive on `projects` (or its settings table — inspect first, follow where
sibling flags live): `is_public_work boolean not null default false`.

Numbering: `next_certified_payroll_number(project_id)` RPC + retry helper — copy the
RFI implementation per master rule 13.

**Do (phases):**

1. **Setup surfaces.** Project settings gains "Public work / prevailing wage" toggle;
   when on, a "Prevailing wage" section under the project's Time tab (workbench —
   this is where the work lives): wage determination + classification rates table
   (manual entry + CSV paste; do NOT build a sam.gov integration), worker profile
   management (seeded from users who have time entries on the project; add
   non-user workers manually).
2. **Report builder.** "Certified payroll" subpage under Time: pick week-ending →
   service pulls APPROVED time_entries for that project/week grouped by worker →
   drafts `certified_payroll_lines` (day-hours grid from entries, rates from
   classification with OT = 1.5× base — fringe never multiplies, that's the classic
   WH-347 error). Review grid: PM/bookkeeper adjusts classifications, keys
   deductions/net (or leaves null → PDF prints "See attached payroll register"),
   marks no-work weeks (creates the numbered no-work report — number continuity is a
   compliance requirement). Finalize locks the report (same lock pattern as meeting
   finalize).
3. **PDF.** WH-347-equivalent on the existing pdf-lib stack, following
   `pay-application.ts` conventions: page 1 grid (worker / classification / day
   hours ST+OT / rate / gross / deductions / net), page 2 Statement of Compliance
   with fringe checkbox (4(a) plans vs 4(b) cash from worker profiles) and signature
   block. Label it "Certified Payroll Report (WH-347 format)" — same
   own-layout rule as the G702/G703. Store via `generated-project-pdfs` pattern.
4. **Registration.** Permission key `payroll.write` → catalog seed +
   `TEAM_PERMISSION_OPTIONS`; grant admin + bookkeeper (mirrors `payapp.write`),
   NOT field roles — state mapping in the completion note. Search-index entry for
   `certified_payroll_report`. Events + audit on create/finalize. CSV export of the
   report register via `lib/services/reports/csv.ts`.

**Explicitly out of scope:** e-filing (LCPtracker/DOL portals), state-specific forms
(CA A-1-131 etc.), apprentice ratios, restitution workflows. If tempted, stop — these
are follow-up gameplans after customer signal.

**Accept:** lint + `pnpm test:financials` clean. QA org: public-work project with a
determination + 2 classifications + 3 workers (one non-user) → week of approved time
→ draft report shows correct day-hours grid and gross (OT at 1.5× base, fringe added
not multiplied) → finalize → clean 2-page PDF → next week's report auto-numbers +1;
a no-work week consumes a number; non-public-work projects show none of this UI.

---

## WS-F — GC-side compliance + sub-tier lien waivers (3 days)

Two halves, one theme: complete the owner-facing pay-app package.

### F1. GC-side bonds & insurance (doc 09 item A8)

Owners impose on the GC what the GC imposes on subs: the GC's own COIs, payment/
performance bonds, licenses per project. Today these live untyped in files.

**Read first:** `lib/services/compliance-documents.ts` (the engine being reused —
note it is keyed by `company_id`), `lib/services/compliance.ts`,
`lib/services/owner-billing-packages.ts` (package assembly this feeds).

**Design:** reuse the compliance-documents engine with the org as subject. Inspect
the real `compliance_documents` schema first, then additively add:
`project_id uuid` (nullable — GC-side docs are usually per-project) and
`subject text not null default 'company'` (`company` | 'org'`), relaxing the
company_id NOT NULL only if required (if it is NOT NULL today, prefer keeping it and
pointing at an org-self companies row ONLY if such a pattern already exists —
otherwise make company_id nullable with a CHECK that exactly one subject shape is
set; choose whichever is the smaller diff and note it).

**Do:** service functions `listProjectOwnComplianceDocuments` / upsert / expiry
(reuse the engine's existing expiry machinery — verify the compliance-autopilot cron
picks these up, and that its job name is in `CRON_JOBS`); UI = an "Our compliance"
card in the project Financials area (near contracts — match sibling density), listing
doc type / carrier or surety / expiry / file, with expired highlighted via existing
status tokens. Pay-app integration: `owner-billing-packages` gains optional
"attach GC compliance documents" toggles so the bond rider/COI rides along with the
G702/G703 package. Existing `compliance.*` permission keys govern — no new keys.

### F2. Sub-tier lien waivers (doc 09 item A9)

Owners/lenders on commercial jobs demand waivers from the subs' suppliers and
sub-subcontractors, not just first-tier subs.

**Read first:** `lib/services/lien-waivers.ts` (full matrix conditional/unconditional
× progress/final — reuse, don't fork), `lib/services/invoice-lien-waivers.ts`,
`lib/services/portal-uploads.ts` + the sub portal (`app/s/[token]`) upload flow,
`lib/services/vendor-bills.ts` ~L699-720 (the payment-block mechanism).

**Schema (additive on `lien_waivers`):** `tier integer not null default 1`,
`through_company_id uuid references companies(id)` (the first-tier sub the claimant
works under; null for tier 1), `claimant_company_name text` (sub-tier claimants are
usually not `companies` rows — free text is correct, do NOT force directory entries).
Plus on the project settings home for such flags: `require_subtier_waivers boolean
not null default false`.

**Do:**

1. Service: extend the existing waiver create/list to accept tier +
   through_company_id; new `listWaiverMatrixForPayPeriod(projectId, period)` that
   groups tier-1 waivers by commitment with their tier-2 children.
2. Collection path: the sub portal (tokenized, existing capability-boolean pattern
   in `portal_access_tokens`) gains an "upload waivers from your subs/suppliers"
   section on the existing waiver step — claimant name + amount + waiver type +
   file, written as tier-2 rows through the sub's own company as
   `through_company_id`. GC-side: waivers tab shows the tree (tier 1 rows expandable
   to tier 2), with "request from sub" firing the existing waiver-request email
   (check `EMAIL_NOTIFICATION_TYPES` — if a new notification type is introduced, add
   it to the allowlist in the same change, master rule 20).
3. Enforcement: when `require_subtier_waivers` is on, the existing
   payment-block/compliance-hold path (vendor-bills) extends its waiver check to
   "tier-1 waiver present AND no tier-2 claimants flagged missing for this
   commitment/period". Do not invent a parallel hold mechanism — extend the one at
   vendor-bills ~L699-720.
4. Package: owner-billing-packages includes the full-tier waiver set per pay app
   when the flag is on.

**Accept:** lint + `pnpm test:financials`. QA org: GC uploads own bond + COI, expiry
alerting fires, pay-app package includes them; sub portal uploads two tier-2 supplier
waivers under a commitment; GC waiver tab shows the tree; with the flag on, paying
that sub's bill is blocked until tier-2 waivers land, and the block message names the
missing claimants; flag off = zero behavior change (regression-critical).

---

## WS-G — Meetings supercharged (4–6 days)

Wave 1 meetings are structurally right (carried-forward numbered items via
`carried_from_item_id`/`first_meeting_id`, ball-in-court, finalize lock,
`createTaskFromMeetingItem`). This workstream makes the register write itself.
**North star: the PM leaves the OAC meeting with the minutes already drafted.**

**Read first:** `lib/services/meetings.ts` (whole file — it's 237 lines), the
meetings tab UI, `lib/services/ai-config.ts` + `lib/services/ai-assistant/harness.ts`
(provider plumbing), `lib/services/distribution-lists.ts` + `lib/services/mailer.ts`,
`lib/services/transmittals.ts` (recipient view-tracking to reuse),
`lib/services/file-share-links.ts`, `lib/types/notifications.ts`
(EMAIL_NOTIFICATION_TYPES), `lib/services/receipt-extraction.ts` (the existing
"AI extracts → human reviews → apply" exemplar — copy its shape).

**Phases (each independently shippable, in order):**

1. **Item ↔ entity links + aging.** Additive columns on `meeting_items`:
   `linked_entity_type text`, `linked_entity_id uuid` (follow the `drawing_pins`
   linking convention — same entity_type vocabulary). Item editor gains a link
   picker (RFIs, submittals, change orders, tasks of this project); item rows render
   the linked entity's LIVE status chip (fetch in the meeting detail loader,
   `Promise.all`, no client waterfalls) so old business self-updates. Aging badge:
   meetings-elapsed count derived from the `first_meeting_id` chain (compute in the
   service: count of meetings in the series since the first appearance; show "3rd
   meeting" style, muted, color only at threshold ≥3 via existing warning token).
2. **Run mode.** A "run meeting" view of an in-progress meeting: items as a focused
   list, keyboard-first — j/k move, `e` edit discussion inline, `s` cycle status,
   `b` ball-in-court, `t` create task (existing service call), `n` new item, one
   keystroke "no update" advance. This is a view over the EXISTING mutations — no
   new service functions beyond what exists; client boundary as low as possible.
3. **Finalize → distribute.** On finalize: generate the minutes PDF (05's pdf stack —
   a meetings PDF may already exist from workstream 05; check
   `generated-project-pdfs.ts` and reuse), send to a chosen distribution list via
   mailer with tracked share links (reuse the transmittal recipient/view-receipt
   mechanics — do not build parallel tracking). NEW notification type
   `meeting_minutes_distributed` added to `EMAIL_NOTIFICATION_TYPES` in the same
   change (master rule 20). Distribution recorded on the meeting (sent_at,
   recipients, viewed receipts visible on the meeting detail).
4. **Transcripts.** New table `meeting_transcripts` (org_id, project_id, meeting_id
   FK, source `recorded|audio_upload|pasted`, status
   `pending|transcribing|ready|failed`, transcript_text, audio_file_id nullable,
   error, timestamps; RLS/indexes/trigger per rule 18). Three input paths, in
   priority order: (a) **in-app recorder** — browser `MediaRecorder` on the meeting
   page (chunked upload to the files bucket via the existing multipart client;
   visible recording indicator — consent laws — plus a fixed footer line on the PDF:
   "Minutes drafted from a recorded session"); (b) **paste/upload transcript**
   (VTT/plain text from Teams/Zoom — parse VTT to plain text, store directly as
   `ready`); (c) audio file upload. Transcription for (a)/(c): server-side call
   through the ai-config provider layer — add a `transcription` feature entry to
   `AI_FEATURE` config (OpenAI `whisper-1`-class default; keep it provider-switchable
   like every other entry). Process async via the outbox/job pattern the drawings
   pipeline uses — transcription of an hour of audio cannot live in a server action.
   **Retention (decided):** transcript text is the durable artifact; audio files are
   deleted 30 days after transcript status `ready` by a cron route (GET handler,
   registered in `vercel.json` AND `CRON_JOBS`, master rule 22).
   **Do NOT build** a bot that joins Zoom/Teams calls — explicitly out of scope;
   paste-the-transcript is the answer for remote meetings.
5. **AI-drafted minutes (the payoff).** Service `draftMinutesFromTranscript(meetingId)`:
   prompt = transcript + the meeting's CURRENT item register (numbers, topics, last
   discussion, BIC, linked entities) → cheap model (Haiku-class via ai-config, the
   task is constrained extraction, not generation) → structured JSON proposals:
   per existing item `{ item_id, discussion_update, proposed_status, proposed_bic,
   proposed_due }`, plus `new_items[]`. Zod-validate the model output — reject and
   retry once on schema failure, then surface the error; never apply unvalidated
   output. Persist proposals on the transcript row (jsonb `draft_proposals`). Review
   UI: accept/reject per proposal, side-by-side (proposal vs current), edits allowed
   before accept; accepting applies through the EXISTING `updateMeetingItem` /
   `addMeetingItem` services — the AI path gets zero write privileges of its own,
   and every application is audited like a human edit. **Never auto-finalize**; the
   finalize lock + human review is what keeps minutes trustworthy as a contractual
   record.

**Accept:** lint clean. QA org, full cycle: create meeting #2 (items carried) → run
mode: update 3 items by keyboard → record 2 minutes of audio on the page → transcript
ready → draft proposals reference the right item numbers → accept 2, reject 1, edit 1
→ finalize → PDF distributed to a list, recipient view receipt appears → meeting #3
carries the still-open items with aging badges. Paste-VTT path produces proposals
with zero audio infrastructure. Audio cleanup cron dry-runs correctly in QA.

---

## Implementation status — 2026-07-12

Web/server scope A–G is implemented and its additive migrations are applied to production. Mobile parity remains intentionally deferred per the product decision for this execution.

- [x] WS-A — progress billing default is posture-driven; the feature flag and production config row are removed.
- [x] WS-B — structured project locations, management/picker integration, legacy text mirrors, field-list filters, and unified/AI search registration with bulk-import reindexing.
- [x] WS-C — cursor-paginated derived Photos lens with source attribution, filters, deep links, and daily-log capture.
- [x] WS-D — canonical CSI specifications register, append-only revisions, async split/classification pipeline, submittal linkage, search, and `spec.write` RBAC.
- [x] WS-E — prevailing-wage setup, worker profiles, approved-time report builder, sequential no-work reports, locked two-page WH-347-format PDF, CSV/search/events, and `payroll.write` RBAC.
- [x] WS-F — project-owned GC compliance in the existing compliance engine, fixed-price G702/G703 package attachments, sub-tier claimant/waiver portal workflow, tree register, project payment gate, and full-tier package manifest.
- [x] WS-G — linked/live meeting records and aging, keyboard run mode, tracked distribution, recorder/paste/audio transcript paths, async provider-configurable transcription, human-reviewed AI proposals, and 30-day audio cleanup.
- [ ] WS-H — mobile parity (deferred; no iOS or mobile API work included).

Validation recorded for this implementation: `pnpm lint`, `pnpm test:financials` (58/58), `pnpm test:auth` (18/18), and `pnpm exec tsc --noEmit` are clean; Supabase security advisor has no Wave 2 findings; and all new tables were verified with RLS, project/FK indexes, and `updated_at` triggers.

## WS-H — Mobile parity: iOS + mobile API + responsive web (5–8 days)

This honors doc 09 item A10: inspections, punch dispatch, safety, and daily-report
sections are the most field-centric features in the product and currently have no
mobile surface. **Rule of thumb for scoping: a superintendent standing on a slab with
one free hand is the user.** Everything else is secondary.

**Read first:** `ios/README.md`, the iOS app source under `ios/Arc/` (learn the
screen/networking patterns actually used — mirror them, don't import new
architecture), every route under `app/api/mobile/v1/` (current surface: session,
organizations, projects, daily-logs [+context], drawings [sets/sheets], expenses
[+scan], files, punch-items, rfis, schedule, tasks, team, notifications, devices,
platform), `lib/services/inspections.ts`, `lib/services/safety.ts`,
`lib/services/daily-logs.ts` (the 08 sections), `lib/services/photos.ts` (from C),
`lib/services/locations.ts` (from B), `proxy.ts` (`PUBLIC_API_ROUTES` — mobile v1
auth pattern: verify how existing mobile routes authenticate and copy it exactly).

**Phase 1 — audit + API additions.** Every endpoint is a thin wrapper over the
existing service (services already own auth/permissions/audit — the mobile route
maps DTOs, nothing more; copy the shape of `punch-items/route.ts`). Add, in this
order:

| Endpoint group | Backing service | Notes |
|---|---|---|
| `projects/[id]/inspections` (+`[inspectionId]`, +`items/[itemId]`) | inspections.ts | list, get detail, update item result, complete; create-from-template |
| `projects/[id]/safety/observations` | safety.ts | list + create (photo-first: accept file ids) |
| `projects/[id]/safety/toolbox-talks` | safety.ts | list + create; attendee suggestions from that day's time entries |
| `projects/[id]/safety/incidents` | safety.ts | create (guided intake fields) + list |
| `projects/[id]/locations` | locations.ts (B) | read-only tree for pickers |
| `projects/[id]/photos` | photos.ts (C) | cursor-paginated lens; upload = existing files endpoint + daily-log attach |
| `projects/[id]/daily-logs` EXTEND | daily-logs.ts | expose the 08 sections (delays, equipment, visitors, deliveries) on the existing endpoints — verify what `context` already returns first |
| `projects/[id]/meetings` | meetings.ts | READ-ONLY list + detail (run mode stays desktop this wave) |

No new tables. Any new route is session-authed mobile v1 — NOT added to
`PUBLIC_API_ROUTES` (that list is for public/webhook routes only).

**Phase 2 — iOS screens, strict priority order** (ship 1–3 even if 4–6 slip):

1. **Inspection run screen** — the flagship: full-width one-tap pass/fail/NA,
   camera forced on fail, auto-advance to next item, offline-tolerant queueing only
   if the existing app already has a queueing pattern (do NOT invent an offline sync
   engine this wave — if none exists, require connectivity and note it).
2. **Punch queue** — assigned/dispatched punch items with location + photo + one-tap
   status transitions (endpoints exist; screen doesn't).
3. **Daily log sections** — extend the existing daily-log screen with the 08
   sections (delay/equipment/visitors/deliveries) + photo capture to today's log.
4. **Safety quick capture** — observation (photo → one-line note → location → done in
   under 15 seconds) and toolbox talk (topic, crew pre-filled from today's time
   entries, finger-signature if the app has a signature control; skip signatures
   otherwise).
5. **Photos lens** — grid consuming the C endpoint, source badges, filter by date.
6. **Meetings read-only** — my open ball-in-court items surfaced.

**Phase 3 — responsive web sweep.** Field users without the app use mobile Safari.
Audit at 390px width every wave-1 + wave-2 field surface: inspections run view,
punch detail, daily log entry, observation create, photos grid, meeting run mode.
Fix layout breakage (tables → existing responsive patterns; check how sibling pages
already degrade). This is a sweep, not a redesign — no new components.

**Accept:** an inspection can be created from a template, run to completion with a
failed item + photo + auto-created punch item, entirely from the iOS app; a punch
item dispatched to a sub can be photographed and completed from the field; a toolbox
talk with 4 attendees takes <60 seconds; every Phase-1 endpoint enforces org scoping
+ permissions via its service (spot-check with a wrong-org token in QA); the Phase 3
surfaces are usable at 390px. iOS builds clean; note in the completion report which
priority screens shipped vs slipped.

---

## Master acceptance (wave 2 is done when)

- [ ] A fresh commercial-posture project defaults to Fixed price + SOV progress
      billing with zero flags involved; `progress_billing` appears nowhere in the code.
- [ ] A public-work QA project produces a numbered, finalized WH-347-format PDF from
      approved time entries, including a no-work week.
- [ ] The QA project has: a locations tree used by punch/inspections/observations; a
      spec book split into browsable CSI sections with a submittal linked to one; a
      photos lens aggregating five source types with zero duplicate storage.
- [ ] A pay-app package can include the GC's own bond/COI and a full-tier lien-waiver
      set; a sub's payment blocks on missing tier-2 waivers when the flag is on, and
      nothing changes when it is off.
- [ ] A meeting goes recording → transcript → AI proposals → human accept/reject →
      finalize → distributed PDF with view receipts, and the next meeting carries
      open items with aging badges.
- [ ] An inspection and a punch item complete end-to-end from the iOS app.
- [ ] Every new table has RLS with `(select auth.uid())`, indexes, and triggers; every
      migration file exists in `supabase/migrations/`; every new entity is in the
      search-index map; every new email notification type is in the allowlist; every
      new permission key is in the catalog seed with stated role mappings; new cron
      routes are in `vercel.json` + `CRON_JOBS`.
- [ ] `pnpm lint` and `pnpm test:financials` pass at every phase boundary.
- [ ] Zero regressions for residential orgs: the wave-1 mixed-org scenario still
      passes untouched.
