# Workstream 05 — Project Document Suite: Meeting Minutes, Transmittals, Numbering, PDF Exports

> Prereq: 00 master, 01. Independent of 02–04 except where noted. In commercial work,
> documents ARE the project record — they get printed, attached to pay apps, and cited
> in disputes. Arc currently has no meeting minutes, no transmittals, integer-only
> numbering, and no PDF export for RFIs/submittals/daily reports/punch.

## Goal

1. A shared **document PDF layer** (one exemplar-quality generator + shared layout kit)
   producing print-grade PDFs for: RFI, Submittal (register + individual), Daily
   Report, Punch List, Meeting Minutes, Transmittal.
2. **Meeting minutes** module (OAC-style): numbered meetings, carried-forward business
   items, attendees, distribution.
3. **Transmittals**: numbered, tracked document distribution records with recipients
   and (where portal links are used) view/download acknowledgement.
4. **Formatted document numbering**: org-configurable prefixes/padding rendered
   everywhere (display layer over the existing integer sequences — do NOT change the
   stored integers).

## Read these files first

- `lib/services/reports/pay-application.ts` + `lib/pdfs/esign.ts` — the two existing
  pdf-lib generators; extract common table/header helpers from them into the shared kit
  rather than writing a third bespoke layout.
- `lib/services/project-sequence.ts` — numbering RPC pattern (you'll add sequences for
  meetings and transmittals).
- `lib/services/rfis.ts`, `submittals.ts`, punch (`punch-lists.ts` + punch actions in
  `app/(app)/projects/[id]/actions.ts` ~L1200), daily reports (same file ~L3260) — DTOs
  you'll render.
- `lib/services/files.ts` + `file-share-links.ts` + `file-access-events.ts` — storage,
  share links, and the access-event log transmittal acknowledgement will reuse.
- Workstream 04's `project_distribution_members` (recipient source, if 04 shipped;
  otherwise recipients are picked ad hoc and the table can land here — coordinate: check
  whether the table exists before creating it).
- `lib/services/tasks.ts` (meeting action items create tasks — reuse, don't fork).

## Part 1 — Shared PDF kit

`lib/pdfs/document-kit.ts`: header block (org logo/name/address from org row, project
name/number, document title + number, date), footer (page X of Y, generated-by line),
table primitive (column defs, repeated header on page break, zebra-free dense rows,
tabular numerals), key-value grid, signature-line block. Refactor
`pay-application.ts`'s internals onto the kit ONLY if low-risk; otherwise new documents
use the kit and the old two stay as-is (note as debt).

Then per-document generators, each a small file in `lib/pdfs/`:
- `rfi-pdf.ts` — RFI header fields, question, drawing/spec refs, cost/schedule impact,
  response thread (chronological, author + date), decision block.
- `submittal-pdf.ts` — individual submittal (header, items with manufacturer/model,
  revision chain, review/decision history incl. workflow steps if 04 shipped) AND
  `submittal-register-pdf.ts` (the log: number, rev, title, spec section, status,
  BIC, dates).
- `daily-report-pdf.ts` — date/weather/day type, manpower table with totals,
  log entries grouped by type, photos as thumbnail grid (cap ~12/page).
- `punch-list-pdf.ts` — filterable subset (all/open/by company once 06 ships), photo
  thumbnails, signature lines (Contractor / Owner-Architect).
- Meeting + transmittal PDFs in their parts below.

Delivery: server actions `exportXPdfAction(id)` returning a file URL via the files
service (store under the project, category matching existing file categories), plus a
Download button on each detail view and register/log views. Follow how the estimate
export route works (`app/(app)/estimates/[id]/export/route.ts`) if a route handler
fits better than an action for streaming.

## Part 2 — Meeting minutes

**Migration — `<ts>_meetings.sql`:**

```sql
create table public.meetings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  meeting_number integer not null,
  series text not null default 'oac',          -- 'oac','sub','safety','custom'
  title text not null,
  held_at timestamptz,
  location text,
  status text not null default 'draft' check (status in ('draft','finalized')),
  finalized_at timestamptz,
  pdf_file_id uuid references public.files(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, series, meeting_number)
);

create table public.meeting_attendees (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  contact_id uuid references public.contacts(id),
  user_id uuid,
  display_name text not null,       -- snapshot; contacts change
  company_name text,
  present boolean not null default true
);

create table public.meeting_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  project_id uuid not null,
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  item_number text not null,        -- '12.3' = first raised meeting 12, item 3
  first_meeting_id uuid references public.meetings(id),
  carried_from_item_id uuid references public.meeting_items(id),
  topic text not null,
  discussion text,
  status text not null default 'open' check (status in ('open','closed','info')),
  ball_in_court text,               -- free label: 'GC', 'Architect', company name
  due_date date,
  task_id uuid references public.tasks(id),   -- optional linked action item
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
```

Numbering: `next_meeting_number(project_id, series)` RPC via the project-sequence
pattern (note the extra series dimension — extend the pattern, keep atomicity).

**Service `lib/services/meetings.ts`:**
- CRUD; `createNextMeeting(projectId, series)` — key feature: **carries forward** every
  `open` item from the previous finalized meeting in the series as new rows
  (carried_from_item_id set, item_number preserved from origin, discussion blank for
  new notes).
- `finalizeMeeting(id)` — locks edits, generates PDF (old business = carried items,
  new business = items first raised this meeting; attendees; header), emails
  distribution (attendees + distribution list scope 'all').
- Item → task: "Create task" per item using existing task service (assignee, due date);
  closing the task suggests closing the item (badge, not automation).

**UI:** project workbench route `app/(app)/projects/[id]/meetings/` (add to project
sidebar nav with `postures: ["commercial"]` per 01; any project can enable it via the
per-project Modules override — posture only hides, never blocks routes).
Minutes editor = the day-document pattern from Daily Logs desktop redesign (one
document per meeting, inline item rows, keyboard-friendly). List view = series-grouped
log. Org desk: none (desk rule — nobody's whole job is minutes).

## Part 3 — Transmittals

**Migration — `<ts>_transmittals.sql`:**

```sql
create table public.transmittals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  transmittal_number integer not null,
  subject text not null,
  purpose text not null default 'for_review'
    check (purpose in ('for_review','for_approval','for_record','for_construction','as_requested')),
  notes text,
  sent_at timestamptz,
  sent_by uuid,
  pdf_file_id uuid references public.files(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (project_id, transmittal_number)
);

create table public.transmittal_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  transmittal_id uuid not null references public.transmittals(id) on delete cascade,
  file_id uuid references public.files(id),
  entity_type text,   -- 'drawing_sheet','submittal','rfi','file' — display metadata
  entity_id uuid,
  description text not null,
  copies integer not null default 1
);

create table public.transmittal_recipients (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  transmittal_id uuid not null references public.transmittals(id) on delete cascade,
  contact_id uuid references public.contacts(id),
  email text not null,
  display_name text not null,
  company_name text,
  share_link_id uuid,                -- file share link / portal link used
  first_viewed_at timestamptz,
  first_downloaded_at timestamptz
);
```

**Service `lib/services/transmittals.ts`:** create (pick files and/or drawing sheets /
submittal docs — resolve to file ids + description snapshot), send (generate cover PDF,
email each recipient with links via existing share-link machinery), and an
acknowledgement sync: piggyback `file_access_events` — when an access event lands for a
file+share-link tied to a transmittal recipient, stamp first_viewed/downloaded (do this
at read time in the transmittal detail loader by joining events — no new write path,
no cron).

**Drawings hookup:** the drawings sharing UI (`bulkUpdateSheetSharing` flow) gains a
"Send as transmittal" action that pre-fills items from the selected sheets — the share
flags remain the access mechanism; the transmittal is the RECORD.

**UI:** project route `app/(app)/projects/[id]/transmittals/` — log table (number,
date, subject, purpose, recipients, viewed badges) + create sheet. Posture-gated in
the project sidebar like meetings (`postures: ["commercial"]`, overridable).

## Part 4 — Formatted numbering

Org-level setting (extend org settings storage — find where org-level jsonb settings
live; `orgs` has no settings column, so either a dedicated column exists elsewhere
(check `org_settings`-like tables / feature-flags storage) or add
`orgs.document_numbering jsonb`):

```json
{ "rfi": {"prefix": "RFI-", "pad": 3},
  "submittal": {"prefix": "SUB-", "pad": 3},
  "change_order": {"prefix": "CO-", "pad": 3},
  "meeting": {"prefix": "MTG-", "pad": 2},
  "transmittal": {"prefix": "T-", "pad": 4} }
```

`lib/document-number.ts`: `formatDocNumber(kind, n, orgSettings)` → "RFI-007";
default (no settings) = today's bare integer so residential display is unchanged.
Sweep the display sites: registers, detail headers, emails, PDFs, portal views — grep
`rfi_number`, `submittal_number`, `co_number` render sites. Stored integers and
sequence RPCs unchanged.

## Permissions / events

- Keys: `meeting.write`, `transmittal.write` in TEAM_PERMISSION_OPTIONS; reads ride
  project access.
- Events: `meeting.finalized`, `transmittal.sent`. Audit everywhere.
- Zod schemas `lib/validation/meetings.ts`, `transmittals.ts`.

## Phases

1. PDF kit + RFI/submittal/daily-report/punch exports (highest demand, zero schema).
2. Formatted numbering (display layer).
3. Meetings (schema → service → editor UI → carry-forward → finalize+PDF+email).
4. Transmittals (schema → service → log/create UI → drawings hookup → ack sync).

## Acceptance checklist

- [ ] RFI, submittal, submittal register, daily report, punch list each export a clean
      multi-page PDF with org header; money/dates formatted like the app.
- [ ] Org sets RFI prefix/padding → "RFI-007" appears on register, detail, email
      subject, PDF; residential org with no settings sees plain "7" as today.
- [ ] OAC meeting #3 carries forward open items from #2 with original item numbers;
      finalize locks it, generates PDF, emails attendees; an item creates a linked task.
- [ ] Transmittal of 4 drawing sheets to 2 recipients: numbered record, cover PDF,
      emails sent; recipient opens link → viewed badge appears on the log.
- [ ] `pnpm lint` clean.
