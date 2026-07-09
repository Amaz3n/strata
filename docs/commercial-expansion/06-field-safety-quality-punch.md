# Workstream 06 — Safety Module, Quality Inspections, Punch Ball-in-Court

> Prereq: 00 master, 01. Benefits from 05 (PDF kit) — build after it if possible.
> Safety is essentially absent in Arc today (only a file category); quality exists only
> as a schedule-item subtype; punch is internal-user-assigned with no sub loop. All
> three are Procore checklist items a commercial GC will ask about in the demo.

## Goal

1. **Inspections & checklists** — one engine serving both safety and quality:
   org-level checklist template library → project inspections → failed items spawn
   punch items or observations.
2. **Safety records**: incident reports, toolbox talks, observations.
3. **Punch ball-in-court**: assign punch items to subcontractor companies, notify via
   sub portal, sub marks complete, GC verifies (verification workflow already exists).

## Non-goals

- No OSHA electronic submission, no EMR analytics, no TRIR dashboards (report later).
- No standalone "Quality" nav module — inspections live under a single Field module;
  keep nav lean.
- Do not migrate the existing schedule-item `inspection` type yet — leave it working;
  new inspections are standalone. Add a note in code where the old one lives pointing
  to the new engine (full consolidation is follow-up debt, record it in the completion
  note).

## Read these files first

- `lib/validation/inspections.ts` + `schedule.ts` (~L520-575: failed schedule
  inspection → punch item) — the existing inspection concept and its punch hookup.
- `lib/services/punch-lists.ts` + punch actions in
  `app/(app)/projects/[id]/actions.ts` (~L1200-1260) + `components/punch/punch-tab.tsx`
  — current punch model. Verified `punch_items` columns: assigned_to (uuid → user),
  verification_* fields, created_via_portal, portal_token_id, file_id, severity,
  location. **No company columns.**
- `lib/services/warranty.ts` — `assigned_company_id` + dispatch email pattern
  (`sendWarrantyDispatchEmail`): THE exemplar for punch-to-sub dispatch.
- `app/s/[token]/` sub portal structure + `portal-access.ts` `loadSubPortalData` —
  where the sub's punch queue will surface.
- `lib/services/daily-logs.ts` — daily-log entry types (safety events should be
  referencable from logs).
- Workstream 05's PDF kit.

## Part 1 — Checklist templates + inspections engine

**Migration — `<ts>_inspections.sql`:**

```sql
create table public.checklist_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  name text not null,
  kind text not null check (kind in ('safety','quality')),
  trade text,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.checklist_template_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  template_id uuid not null references public.checklist_templates(id) on delete cascade,
  section text,
  prompt text not null,
  response_type text not null default 'pass_fail'
    check (response_type in ('pass_fail','yes_no','text','number')),
  sort_order integer not null default 0
);

create table public.inspections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  inspection_number integer not null,
  template_id uuid references public.checklist_templates(id),
  kind text not null check (kind in ('safety','quality')),
  title text not null,
  status text not null default 'draft'
    check (status in ('draft','in_progress','completed')),
  result text check (result in ('pass','fail','partial')),
  inspected_at timestamptz,
  inspector_user_id uuid,
  inspector_name text,
  location text,
  company_id uuid references public.companies(id),  -- sub being inspected, optional
  notes text,
  pdf_file_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, inspection_number)
);

create table public.inspection_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  inspection_id uuid not null references public.inspections(id) on delete cascade,
  section text,
  prompt text not null,
  response text,                -- 'pass','fail','yes','no','n/a', or free text/number
  is_deficient boolean not null default false,
  note text,
  photo_file_id uuid,
  punch_item_id uuid references public.punch_items(id),
  observation_id uuid,          -- FK added after observations table exists
  sort_order integer not null default 0
);
```

Numbering via project-sequence RPC. Seed ~6 starter templates in the service (not the
migration): Site Safety Audit, Fall Protection, Housekeeping, Pre-Pour Concrete,
Drywall Pre-Cover, MEP Rough-In — each 8–15 real items (write them with domain care).
Seeding: org settings page button + auto for new commercial-tier orgs (mirror the CSI
seed hookup from workstream 01).

**Service `lib/services/inspections.ts`:** template CRUD; start-from-template
(snapshot items); item responses (autosave-friendly single-item update action);
complete (derives result: fail if any deficient, partial if mixed n/a); "create punch
item" / "create observation" per deficient item (punch inherits photo, location,
description, and — after Part 3 — company). PDF export via the kit (checklist table,
photos, signature line).

**UI:** project route `app/(app)/projects/[id]/inspections/` (new; nav-tiered
commercial, project sidebar). List grouped by kind; run screen = dense checklist with
tap targets sized for tablet (still web; the iOS app is out of scope — note API
parity as debt). Template library under org settings.

## Part 2 — Safety records

**Migration — `<ts>_safety_records.sql`:**

```sql
create table public.safety_incidents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  incident_number integer not null,
  occurred_at timestamptz not null,
  severity text not null check (severity in
    ('near_miss','first_aid','medical_treatment','lost_time','fatality')),
  classification text,            -- injury/illness/property_damage/environmental
  location text,
  description text not null,
  involved_company_id uuid references public.companies(id),
  involved_person_name text,
  witness_names text,
  immediate_action text,
  root_cause text,
  is_osha_recordable boolean not null default false,
  reported_by uuid,
  status text not null default 'open' check (status in ('open','under_review','closed')),
  closed_at timestamptz,
  pdf_file_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, incident_number)
);

create table public.toolbox_talks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  project_id uuid not null references public.projects(id),
  held_at date not null,
  topic text not null,
  notes text,
  presenter_name text,
  presenter_user_id uuid,
  attendee_count integer,
  attendees jsonb not null default '[]'::jsonb,  -- [{name, company}] snapshot
  file_id uuid,                                   -- signed sign-in sheet photo/scan
  created_at timestamptz not null default now()
);

create table public.observations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  project_id uuid not null references public.projects(id),
  observation_number integer not null,
  kind text not null check (kind in ('safety','quality')),
  category text,                 -- 'positive','at_risk','deficiency'
  description text not null,
  location text,
  company_id uuid references public.companies(id),
  photo_file_id uuid,
  status text not null default 'open' check (status in ('open','resolved')),
  resolved_at timestamptz,
  due_date date,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (project_id, observation_number)
);
```

(Then add the deferred FK `inspection_items.observation_id → observations`.)

**Service `lib/services/safety.ts`** (one service, three entities — they're small).
Incident emails: notify org admins on `lost_time`+ severity (reuse notification
service; add event types to `events.ts` map). Incident PDF (the fields above laid out
as a report — investigators print these).

**UI:** project route `app/(app)/projects/[id]/safety/` with tabs: Incidents, Toolbox
Talks, Observations. All dense logs + create sheets. Observations get a quick-create
(photo + one line + company) — field speed matters. `drawing_pins.entity_type` already
allows `observation` — wire pin-create → observation once the table exists (check the
pin creation UI for how rfi/punch pins are created and add the type).

## Part 3 — Punch ball-in-court

**Migration — `<ts>_punch_company_assignment.sql`:**

```sql
alter table public.punch_items
  add column if not exists assigned_company_id uuid references public.companies(id),
  add column if not exists dispatched_at timestamptz,
  add column if not exists sub_completed_at timestamptz,
  add column if not exists back_charge_flag boolean not null default false;
```

**Service (`punch-lists.ts`):**
- Assignment accepts user OR company (or both — company owns the work, user owns
  verification). Setting company → dispatch email to company contacts with sub-portal
  link (copy `sendWarrantyDispatchEmail` mechanics; token capability: extend
  `loadSubPortalData` to include punch items where `assigned_company_id` = token's
  company).
- Sub portal: punch queue tab (list assigned open items, photos, mark
  "Work complete" → `sub_completed_at`, status → `ready_for_review`, optional photo
  upload via `portal-uploads.ts`).
- GC verify path: existing verification workflow (`verification_required`,
  `verified_*`) — on verify, close; on reject, clear `sub_completed_at`, bump back to
  open, notify company again with the rejection note.
- BIC derivation on DTOs: "Sub (Company)" when dispatched & not complete; "GC verify"
  when ready_for_review; matches workstream 04's BIC display conventions.
- `back_charge_flag`: just a flag + filter for now (money flows stay manual; note in
  UI copy "tracked for back-charge" — deeper AP integration is future work).

**UI (`punch-tab.tsx`):** company assignee picker (companies on the project via
`project_vendors`, fall back to all subs), BIC column, "by company" grouping, bulk
assign-to-company, dispatch indicator. Punch list PDF (05 kit) gains per-company
filtering — that's the packet a super hands a sub.

## Permissions / events

- Keys: `inspection.write`, `safety.write`, plus reuse punch's existing gating.
- Events: `inspection.completed`, `safety_incident.reported`, `observation.created`,
  `punch.dispatched`, `punch.sub_completed`.
- Zod: `lib/validation/{inspections-v2 or extend,safety,punch}.ts` (extend existing
  punch validation file — find it; don't create a parallel one).

## Phases

1. Punch ball-in-court (smallest, highest demo value; pure pattern-copy from warranty).
2. Checklist templates + inspections engine + seeds + PDF.
3. Observations (+ drawing-pin wiring) — shares list UI patterns with punch.
4. Incidents + toolbox talks + notification rules.

## Acceptance checklist

- [ ] Punch item assigned to "ABC Drywall" → dispatch email → sub portal shows it →
      sub marks complete with photo → GC rejects → sub re-notified → sub completes →
      GC verifies → closed. BIC correct at every step.
- [ ] Per-company punch PDF prints only that company's open items.
- [ ] Run "Pre-Pour Concrete" inspection from template; 2 deficient items → 1 punch
      item (to a company) + 1 observation; inspection result = fail; PDF exports.
- [ ] Incident (lost_time) → org admins notified; incident PDF prints; observations
      quick-create from a drawing pin works.
- [ ] Residential orgs: punch unchanged unless they assign a company; no new nav items
      (tier-gated).
- [ ] `pnpm lint` clean.
