# Workstream 08 — Daily Reports (Commercial Fields) + Schedule Hardening

> Prereq: 00 master, 01; 05's PDF kit for the daily-report PDF (build Part A phases in
> any order relative to 05, but the PDF phase needs the kit). Two half-workstreams
> bundled: commercial-grade daily reports (delay/equipment/visitor/delivery records,
> sub authoring, auto-weather) and schedule write-path hardening (dependency types +
> lag are in the schema but hard-coded to FS/0 on write).

## Part A — Daily reports

### Context

`daily_reports` (per project/day, draft→submitted lock) + `daily_report_manpower`
(company/trade/workers/hours) + `daily_logs`/`daily_log_entries` (narrative, typed
entries) exist and are good. Missing for commercial: structured **delays** (claims
evidence!), **equipment on site**, **deliveries**, **visitors**; automatic weather;
sub-authored reports; PDF.

### Read first

- `app/(app)/projects/[id]/actions.ts` ~L77-160 (submit/reopen/lock guards) and
  ~L3260-3420 (daily report select/CRUD); `lib/services/daily-logs.ts`;
  the daily-logs desktop day-document UI (memory: daily-logs-desktop-redesign) —
  find `components/daily-logs/` day view.
- `daily_reports.weather` jsonb shape; `day_type` enum values.
- Sub portal `can_submit_time`/`can_submit_expenses` mechanics in
  `portal-access.ts` — the pattern for `can_submit_daily_logs`.

### Changes

**Migration — `<ts>_daily_report_sections.sql`:**

```sql
create table public.daily_report_delays (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  daily_report_id uuid not null references public.daily_reports(id) on delete cascade,
  delay_type text not null check (delay_type in
    ('weather','owner','design','material','labor','equipment','utility','other')),
  description text not null,
  hours_lost numeric,
  affected_trades text,
  schedule_item_id uuid references public.schedule_items(id),
  potential_claim boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.daily_report_equipment (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  daily_report_id uuid not null references public.daily_reports(id) on delete cascade,
  description text not null,        -- 'Excavator CAT 320'
  company text,                     -- owner/renter of the equipment
  count integer not null default 1,
  hours_used numeric,
  idle boolean not null default false,
  notes text
);

create table public.daily_report_visitors (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  daily_report_id uuid not null references public.daily_reports(id) on delete cascade,
  name text not null,
  company text,
  purpose text,                     -- 'Owner walkthrough', 'City inspector'
  time_in text, time_out text
);

create table public.daily_report_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  daily_report_id uuid not null references public.daily_reports(id) on delete cascade,
  description text not null,
  supplier text,
  quantity text,
  ticket_number text,
  received_by text,
  notes text
);

alter table public.daily_reports
  add column if not exists weather_auto jsonb,        -- fetched observation snapshot
  add column if not exists created_via_portal boolean not null default false,
  add column if not exists portal_company_id uuid references public.companies(id);
```

**Service/actions:** CRUD for the four sections, gated by the same draft-only guard as
manpower (reuse the exact guard helper; if it's inline, extract it once). All sections
included in the submitted lock.

**Auto-weather:** on report create (and a refresh button), fetch from Open-Meteo
(free, no key: `api.open-meteo.com/v1/forecast?latitude=..&longitude=..&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max&past_days=1`)
using the project's `location` jsonb lat/lng — geocode is out of scope; if the project
has no coordinates, skip silently (manual weather stays). Store raw snapshot in
`weather_auto`, keep the manual `weather` field authoritative for display when filled.
Server-side fetch in the service with a short timeout and graceful failure (never
block report creation on the weather API).

**Sub-authored reports:** new capability `can_submit_daily_logs` on
`portal_access_tokens` (migration above ↑ add the boolean there too — single
migration). Sub portal gains a simple day entry: their manpower row(s) + narrative +
photos for today. Sub submissions write `daily_report_manpower` rows tagged with their
company and a `daily_log_entries` narrative on the day's report,
`created_via_portal`/`portal_company_id` set; they see only their own entries. GC's
day document shows a "from subs" strip. Do NOT let subs submit/lock the GC's report.

**Delay ↔ schedule:** the delay row's optional `schedule_item_id` + `potential_claim`
flag feed a small project-level "Delay log" view (filterable list across reports —
add as a filter/tab within the daily-logs area, not a new nav item). This is the
claims-notebook commercial PMs keep in Excel today.

**PDF (needs 05 kit):** the day document printed: header (project, date, weather,
day type), manpower table with totals, sections (work performed narrative, delays,
equipment, deliveries, visitors), photo grid, submitted-by/timestamp footer. Bulk
export: date-range → merged PDF (cap 31 days).

**UI:** extend the desktop day-document with the four sections as collapsible blocks
matching the manpower block's editing pattern; empty sections collapse to one-line
add buttons (keep the document calm). Mobile/iOS parity: out of scope; note as debt.

## Part B — Schedule hardening

### Context

`schedule_dependencies` has `dependency_type` + `lag_days` but create/update hard-code
`FS`/`0` (`lib/services/schedule.ts` ~L345-346, L461-462). CPM (`is_critical_path`,
`float_days`) is computed client-side in `lib/utils/schedule-calc.ts` assuming FS.

### Changes

1. **Write path:** accept `dependency_type` (`FS|SS|FF|SF`) and `lag_days` (signed
   int, sane bounds ±365) through validation (`lib/validation/schedule.ts`), service
   create/update, and the Gantt dependency UI (edit affordance on the dependency —
   find how dependencies are created in `components/schedule/gantt-chart.tsx` and add
   type+lag to that interaction; a small popover on the dependency line is enough).
2. **Calc:** extend `calculateCriticalPath` in `lib/utils/schedule-calc.ts` to honor
   all four types + lag (standard forward/backward pass; write unit tests for the
   pass logic — pure function, test file next to it following repo test conventions).
   Keep it client-side (server-authoritative CPM is future work; note as debt).
3. **Guard rails:** cycle detection on dependency create (walk the graph server-side,
   reject cycles with a clear error) — verify whether it exists today; add if not.
4. Portfolio schedule (`app/(app)/schedule/`) needs no changes beyond not breaking.

Explicitly deferred (do not build): resource leveling, multi-assignee, cost-loaded
schedule, P6/MS Project import-export (workstream 09 records these).

## Permissions / events

- Daily report sections ride existing daily-log permissions; `can_submit_daily_logs`
  is token-level. Schedule edits ride existing schedule permissions.
- Events: `daily_report.delay_logged` (only when `potential_claim` — keep noise down),
  `daily_report.sub_submitted`.

## Phases

1. Section tables + CRUD + day-document UI blocks.
2. Auto-weather.
3. Sub-authored entries (capability + portal UI + day-document strip).
4. Delay log view + report PDF (+ bulk export).
5. Schedule: dependency type/lag write path + calc + cycle guard + tests.

## Acceptance checklist

- [ ] A day report captures: 3 manpower rows, a weather delay (4 hrs, potential claim,
      linked to a schedule item), 2 equipment rows, a delivery with ticket #, a city
      inspector visit — then submits and locks all of it; reopen unlocks.
- [ ] Auto-weather populates for a project with coordinates; absent coordinates,
      creation works with no error.
- [ ] Sub token with `can_submit_daily_logs` adds manpower + narrative + photo from
      the portal; GC sees it flagged "from ABC Drywall"; sub cannot see GC narrative.
- [ ] Delay log lists all potential-claim delays across the month; day PDF and a
      7-day bulk PDF render correctly.
- [ ] Create an SS dependency with 3-day lag in the Gantt; critical path updates
      correctly (unit tests cover FS/SS/FF/SF + lag); creating a cycle is rejected.
- [ ] `pnpm lint` clean; schedule calc tests pass.
