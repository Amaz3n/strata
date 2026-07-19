# Workstream 05 — Start Packages, Even-Flow, and Multi-House Scheduling

> Prereq: `00-MASTER-production-expansion.md` read FULLY (especially §5.8 —
> start packages hard-gate release; even-flow slots make over/under-starting
> visible — and §9's even-flow math), plus workstreams 01 (communities/lots),
> 02 (plan library + `instantiatePlanForProject`), and 04 (price book /
> auto-PO). The commercial suite's `00-MASTER` rules still bind. This doc is
> self-contained for a fresh executor: every code claim below was verified
> against the repo 2026-07-16/17; re-verify against live schema with Supabase
> MCP `list_tables` before writing migrations.

## STATUS — IMPLEMENTED AND DEPLOYED; MANUAL QA PENDING

Implemented 2026-07-18 across four additive migrations, data-driven start
gates, the resumable start-release outbox pipeline, even-flow slots and release
board, superintendent assignment and My Houses (desktop + mobile), trade
look-aheads and coalesced schedule-change notices, reporting, RBAC, search,
notifications, and cron wiring. Static verification passes (`pnpm lint`,
`pnpm exec tsc --noEmit`, and `pnpm next build`); the starts suite passes 4/4
and the financial regression suite passes 77/77.

The five production migrations are recorded as `20260718214633`,
`20260718214636`, `20260718214643`, `20260718214710`, and
`20260718214849` (the fifth is advisor-driven FK-index hardening). Live
verification confirmed all five tables, `projects.superintendent_id`, RLS
policies, authenticated/service-role grants, four permissions, both new roles,
and FK coverage. Supabase security and relevant performance advisors report no
Workstream 05 findings. QA-org walkthroughs and scale acceptance remain.

## Mission

Production building runs on a drumbeat: N starts per community per week, every
start released complete. This workstream builds the drumbeat machinery:

1. **Start packages** — a gate record per lot. A house cannot start until its
   package is green: permit approved, plot plan on file, structural selections
   locked, budget generated, PO set generated, financing cleared (when
   applicable), final sign-off. Gates are **data-driven** (org-configurable
   definitions, seeded defaults), **auto-derived where the system knows the
   answer** and manually attestable where it can't. Release with open gates is
   rejected **server-side** — enforcement is the product (master §5.8).
2. **Start-release orchestration** — an outbox-driven pipeline (the
   drawings-pipeline claim/heartbeat/reclaim pattern + conversion-run-style
   step rows) that turns "Release" into: instantiate plan artifacts (budget,
   schedule offset to start date, checklists, drawings — via WS02's
   `instantiatePlanForProject`), generate the PO set (WS04), notify trades,
   mark the lot started. Idempotent, resumable, every failure lands in the
   starts coordinator's queue — never silent.
3. **Even-flow** — `community_release_slots` (target starts per week per
   community, seeded from community settings) and the **release board**: the
   Starts desk centerpiece showing the precon pipeline (gate completeness,
   precon aging) against weekly slots, over/under-flow visible per community.
   Slot discipline is advisory-but-loud: releasing over target is allowed with
   an explicit confirm + event, never silently.
4. **"My Houses"** — the superintendent's multi-house surface (10–15
   concurrent houses, master §9), desktop + mobile: all my lots, this week's
   tasks ACROSS houses grouped by task type ("all frame inspections this
   week"), quick actions (complete task, daily log, photo, EPO request →
   WS04). Supers live on mobile — the `/api/mobile/v1` additions are
   first-class deliverables, not parity debt.
5. **Trade look-aheads + notifications** — 2–4 week look-ahead per trade
   company across lots; schedule-change notices to affected trades over the
   existing portal/email rails; trade confirm/ack rides WS04's sub-portal
   trade loop (referenced, not duplicated).
6. **Reporting** — cycle time (start→close, by plan/community/super, trend
   against the 120–130-day north star), even-flow adherence (planned vs actual
   starts/closings per week), WIP counts (precon backlog ~18 / under
   construction ~40 at 100/yr — master §9), late-task heatmap.

**Scale doctrine:** 400-lot communities and a 100-start/yr org (≈2 starts/wk,
~58 concurrent lots in motion) are the DESIGN CASE. Every list here paginates
or caps; every rollup is a grouped count, never a row scan into the client.

## Non-goals

- Plan instantiation internals (WS02 owns `instantiatePlanForProject`; this doc
  only calls it and honors its contract — released-version-only, snapshot-only,
  idempotent-per-step, composable, never-throws-per-step).
- PO generation and the trade confirm→complete loop (WS04 owns
  `generatePurchaseOrders` and the sub-portal ack surface; this doc
  calls the former and links to the latter).
- Sales/buyer flows, closings (WS06 — but `closings` feed cycle-time when they
  exist; until then start→project-completed substitutes, flagged in the UI).
- Workday/holiday calendars for schedule offsets (WS02 open question 1 stays
  open; v1 is calendar days).
- Resource leveling, crew optimization, AI schedule prediction.

## Read these files first

- `docs/production-expansion/00-MASTER-production-expansion.md` §5.8, §9;
  `01-foundation-divisions-communities-lots.md` (lots lifecycle, `started`
  requires project; `attachProjectToLot`; community `settings` jsonb reserved
  for release cadence); `02-plan-library-template-bundles.md`
  (`InstantiatePlanInput`/`Result` contract, step exports, idempotence rules).
- `lib/services/outbox.ts` — `enqueueOutboxJob` (dedupe_key via
  `dedupeByPayloadKeys`, `runAt`, org-scoped).
- `lib/services/drawings-pipeline.ts` L44–340 — THE pipeline exemplar:
  `claim_jobs` RPC (FOR UPDATE SKIP LOCKED), 45-s heartbeat on `updated_at`,
  3-minute stale-processing reclaim, `MAX_JOB_RETRIES=3` with exponential
  backoff `run_at`, terminal failure marks the domain entity failed.
- `lib/services/conversions.ts` — `conversion_runs` + `conversion_run_steps`
  (upsert on `(run_id, step_key)`, status running/completed/failed,
  started_at/completed_at) — the step-ledger shape our release steps copy.
- `lib/services/schedule.ts` — `schedule_items` (assigned_to user, `trade`
  text, `phase`, status, dates), `schedule_assignments` (user OR contact OR
  company — company assignment is how a trade firm attaches to an item),
  `schedule_dependencies` (FS/SS/FF/SF + lag), `applyTemplate` (undated; WS02
  adds `applyScheduleTemplateSnapshot` with offsets), baselines.
- `lib/services/my-work.ts` + `lib/services/tasks.ts` — the personal
  cross-project pattern (approvals band on the Tasks hub) My Houses extends.
- `app/(app)/schedule/` — portfolio Gantt desk (projects as rollup rows,
  expand→items; `components/schedule/gantt.css` reuse; rows are projects,
  never tasks). The community schedule view builds on this, not beside it.
- `lib/services/daily-reports.ts` + the mobile daily-log flow
  (`app/api/mobile/v1/projects/[projectId]/daily-logs/`), mobile conventions:
  `requireMobileOrg(request)` → `lib/mobile/*` service → `mobilePageResponse`
  / `mobileErrorResponse` with `mobileRequestId`.
- `lib/services/job-runs.ts` — `CRON_JOBS` registry (must mirror
  `vercel.json`) + `withCronRun` wrapper; `vercel.json` crons + `maxDuration`;
  `proxy.ts` `PUBLIC_API_ROUTES` (any new cron route MUST be listed or it
  307s to signin and never runs — repeated prod incident).
- `lib/types/notifications.ts` — `NotificationType` union +
  `EMAIL_NOTIFICATION_TYPES` allowlist (only listed types ever email users).
- `supabase/migrations/20260708120500_rbac_catalog_seed.sql` +
  `20260710140200_progress_billing_permissions.sql` (RBAC catalog-as-code
  pattern), `20260711120200_prequalification.sql` (RLS block style).

## Current-state audit (verified 2026-07-16/17)

- **No starts concepts exist.** Grep `start_package|release_slot|even.?flow|
  my.?houses` across `lib/` and `app/` returns nothing. Nothing to migrate or
  delete.
- **Outbox infra is real and hardened**: `outbox` has `dedupe_key` unique
  handling (23505 → duplicate), `claim_jobs(job_types, limit_value)` RPC used
  by drawings/specs pipelines, `status pending|processing|completed|failed`,
  `retry_count`, `run_at`, `last_error`. The drawings pipeline demonstrates
  heartbeat + stale reclaim + capped retries + terminal domain-failure
  marking. Copy that skeleton wholesale.
- **`conversion_runs`/`conversion_run_steps`** give the step-ledger UX shape:
  per-step rows upserted on `(run_id, step_key)` with status timestamps —
  what a coordinator needs to see "budget ✓ schedule ✓ POs ✗ retry".
- **Schedule**: items carry `assigned_to` (user), `trade` text, `phase`;
  `schedule_assignments` supports `company_id` — a trade company can already
  be attached to an item (`setScheduleItemAssignee` clears+recreates). Typed
  dependencies + lag shipped in commercial WS08. `schedule_templates.items`
  jsonb gains `start_offset_days`/`duration_days` in WS02.
- **My Work pattern**: `my-work.ts` exposes `loadMyApprovals()` rendered as a
  band on `/tasks` (the personal hub after the org-wide tasks merge). There
  is no per-persona route today; My Houses is the first (justified below).
- **Org schedule desk**: `app/(app)/schedule/` is the portfolio Gantt
  (projects as rows). WS01 Phase 5 adds community/division filters to it via
  `reporting-scope.ts` id-set helpers — this doc assumes that filter exists
  and adds the even-flow lens beside it.
- **Mobile API**: bearer-token routes under `app/api/mobile/v1/` with
  `requireMobileOrg`, thin handlers calling `lib/mobile/*`. Existing
  per-project schedule (`listMobileScheduleItems`), tasks (list + `[taskId]`
  mutation), daily-logs (list/create/photos/comments), punch. There is NO
  cross-project surface beyond the projects list — My Houses endpoints are
  net-new. `proxy.ts` already allowlists `/api/mobile/`.
- **Crons**: `vercel.json` ↔ `CRON_JOBS` in `lib/services/job-runs.ts` are
  mirrored (17 entries); route handlers are GET (Vercel Cron sends GET) and
  self-authenticate via CRON_SECRET; `withCronRun` records heartbeats to
  `job_runs` for the Ops page.
- **Notifications**: `NotificationType` union + 12-entry
  `EMAIL_NOTIFICATION_TYPES` allowlist. In-app notifications are
  unrestricted; only allowlisted types email, per user preference. External
  parties (trades) are NOT app users — trade emails ride dispatch-style
  sends (warranty `warranty_requests` assigned-company dispatch is the
  precedent) + sub-portal links, not user notification prefs.
- **Superintendent assignment**: there is no super concept anywhere. Audit
  for "does `project_members` suffice": `project_members` rows are
  membership-scoping facts (assigned-scope RBAC reads them in
  `authorization.ts`); they carry no "role on this project" semantics usable
  as "the super of record", and a lot/project has exactly ONE accountable
  super (10–15 houses each). Conclusion: **first-class field needed** —
  `projects.superintendent_id` (decision + DDL below), with a
  service-maintained companion `project_members` row so assigned-scope RBAC
  keeps working. Re-verify `project_members` columns via MCP before build.
- **`pnpm test:financials`** gate exists; starts math (slot adherence, cycle
  time) is not financial but gets the same pure-function unit treatment.

## Data model

Four migrations, additive, org-scoped, RLS + indexes + `updated_at` trigger
per table in the same file. RLS uses the current initplan-safe org-member
block (copy `20260711120200_prequalification.sql`). Money in integer cents.
Dates are dates; weeks are the **Monday** `date` of the ISO week (a plain
`week_start date` column with a `check (extract(isodow from week_start) = 1)`
— no separate calendar table).

### Migration 1 — `<ts>_start_gate_definitions.sql`

Org-configurable gate catalog, seeded with the industry-default set. A gate
definition says WHAT must be true and HOW it's checked (auto vs manual).

```sql
create table public.start_gate_definitions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  key text not null,                    -- stable machine key, e.g. 'permit'
  label text not null,                  -- 'Permit approved'
  description text,
  check_kind text not null default 'manual'
    check (check_kind in ('auto','manual')),
  auto_source text                      -- non-null when check_kind='auto':
    check (auto_source is null or auto_source in
      ('selections_locked','budget_generated','pos_generated',
       'plan_pinned','plot_plan_file')),
  requires_attestation_permission text, -- permission key required to attest,
                                        -- e.g. 'start.release' for final signoff;
                                        -- null = any start.write holder
  applies_when text not null default 'always'
    check (applies_when in ('always','financed_only')),
    -- 'financed_only': gate participates only when the package is flagged
    -- financed (spec homes skip financing/appraisal)
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, key)
);
create index start_gate_definitions_org_idx
  on public.start_gate_definitions (org_id, is_active, sort_order);
```

**Seeded defaults** (service seeds on first Starts-desk visit per org, or the
provisioning flow — idempotent upsert on `(org_id, key)`):

| key | label | check_kind | auto_source | applies_when |
|---|---|---|---|---|
| `permit` | Permit approved | manual | — | always |
| `plot_plan` | Plot/site plan on file | auto | `plot_plan_file` | always |
| `selections_locked` | Structural selections locked | auto | `selections_locked` | always |
| `plan_pinned` | Plan version & elevation pinned | auto | `plan_pinned` | always |
| `price_book` | Price book resolves (no open PO exceptions) | auto | `po_exceptions_clear` | purchasing_enabled |
| `budget` | Budget generated | auto | `budget_generated` | always |
| `po_set` | PO set generated | auto | `pos_generated` | always |
| `financing` | Financing/appraisal cleared | manual | — | financed_only |
| `final_approval` | Final start approval | manual (requires `start.release`) | — | always |

Auto-derivation semantics (service layer, one query per source per refresh):

- `plot_plan_file` — a `files` row on the lot's project tagged
  `metadata.document_kind = 'plot_plan'` (the upload control on the package
  detail sets this tag; no new storage concept).
- `selections_locked` — every **structural-scope** selection category
  applicable to the lot's pinned plan version has a confirmed/locked
  `project_selections` row (WS03 owns the structural flag and lock state —
  read its state, never re-model it; until WS03 ships, orgs flip this
  definition to `manual` — seeding keeps `auto`, service degrades to manual
  with a warning when the WS03 tables are absent).
- `plan_pinned` — `lots.house_plan_version_id` set AND version status
  `released` AND elevation chosen.
- `po_exceptions_clear` — WS04's `hasOpenPoExceptions(projectId)` returns
  false: the coordinator (or purchasing, from the exceptions queue) has run a
  dry-run PO generation and every takeoff/option line resolves against the
  price book. This is the READINESS-side blocker WS04 exports for exactly this
  gate; `applies_when: purchasing_enabled` hides it for wedge orgs with no
  price book.
- `budget_generated` / `pos_generated` — the release pipeline's own steps
  (below) — auto-green mid-release; before release they read
  `projects.metadata.plan_instantiation.steps.budget` (WS02) and WS04's PO
  existence for the project. NOTE: `budget`/`po_set` gates green during
  orchestration, not before it — see "two-stage release" under Orchestration.

### Migration 2 — `<ts>_start_packages.sql`

```sql
create table public.start_packages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  lot_id uuid not null references public.lots(id),
  community_id uuid not null references public.communities(id), -- denorm from lot
  project_id uuid references public.projects(id),
    -- set when the job exists (attachProjectToLot may run before or during release)
  status text not null default 'open'
    check (status in ('open','ready','releasing','released','attention','cancelled')),
    -- open: gates in progress · ready: all required gates green, not yet released
    -- releasing: orchestration running · released: done, lot started
    -- attention: a release step failed terminally — coordinator queue
    -- cancelled: package abandoned (lot resold/replanned); a new package may open
  is_financed boolean not null default false,   -- activates financed_only gates
  target_week date check (target_week is null or extract(isodow from target_week) = 1),
    -- the release-board slot this lot is aimed at (Monday of ISO week)
  scheduled_start_date date,                    -- the date instantiation offsets from
  released_at timestamptz,
  released_by uuid references public.app_users(id),
  actual_start_date date,                       -- = released date's schedule start
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index start_packages_active_lot_uniq on public.start_packages (lot_id)
  where status not in ('cancelled');            -- one live package per lot
create index start_packages_org_board_idx
  on public.start_packages (org_id, community_id, status, target_week);
create index start_packages_project_idx on public.start_packages (project_id)
  where project_id is not null;

create table public.start_package_gates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  start_package_id uuid not null
    references public.start_packages(id) on delete cascade,
  gate_definition_id uuid not null references public.start_gate_definitions(id),
  status text not null default 'pending'
    check (status in ('pending','passed','waived','not_applicable')),
  passed_via text check (passed_via is null or passed_via in ('auto','attested','waived')),
  attested_by uuid references public.app_users(id),
  attested_at timestamptz,
  waived_reason text,                 -- required when status='waived' (service-enforced)
  notes text,
  evidence_file_id uuid references public.files(id),  -- optional attachment (permit doc…)
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (start_package_id, gate_definition_id)
);
create index start_package_gates_pkg_idx
  on public.start_package_gates (org_id, start_package_id);

-- Step ledger for release orchestration (conversion_run_steps shape):
create table public.start_release_steps (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  start_package_id uuid not null
    references public.start_packages(id) on delete cascade,
  step_key text not null check (step_key in
    ('project','budget','schedule','checklists','drawings','pos','notify_trades','finalize')),
  status text not null default 'pending'
    check (status in ('pending','running','completed','failed','skipped')),
  attempt integer not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  error text,
  detail jsonb not null default '{}'::jsonb,   -- step outputs: {budget_id}, {po_count}…
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (start_package_id, step_key)
);
create index start_release_steps_attention_idx
  on public.start_release_steps (org_id, status) where status = 'failed';
```

**Waivers are loud, not silent:** `waived` counts as satisfied for release but
requires `start.release` permission, a non-empty `waived_reason`, emits
`start_gate.waived`, and renders amber (never green) everywhere.

### Migration 3 — `<ts>_community_release_slots.sql`

```sql
create table public.community_release_slots (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  community_id uuid not null references public.communities(id) on delete cascade,
  week_start date not null check (extract(isodow from week_start) = 1),
  target_starts integer not null default 0 check (target_starts >= 0),
  notes text,                         -- 'holiday week', 'lot delivery slip'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (community_id, week_start)
);
create index community_release_slots_org_idx
  on public.community_release_slots (org_id, community_id, week_start);
```

Slots are **materialized rows, not a formula**, because real calendars have
exceptions (holiday weeks, phase gaps, lot-delivery slips) and the board must
show an editable number per week. Seeding: `communities.settings` gains
`{ "starts_per_week": 2, "release_horizon_weeks": 16 }` (jsonb — 01 reserved
this); `ensureReleaseSlots(communityId)` upserts rows for the next
`release_horizon_weeks` Mondays at `starts_per_week`, never overwriting
hand-edited rows (upsert `on conflict do nothing`). Called lazily when the
board loads and by the weekly cron. Actual starts are NOT stored on the slot —
they are counted from `start_packages` (`released` + `target_week`) so there
is exactly one source of truth.

### Migration 4 — `<ts>_superintendent_and_start_rbac.sql`

```sql
-- Decision (audited above): project_members rows are RBAC-scoping facts with
-- no per-project role semantics; a house has exactly one accountable super.
-- First-class column, service-maintained:
alter table public.projects
  add column if not exists superintendent_id uuid references public.app_users(id);
create index projects_superintendent_idx
  on public.projects (org_id, superintendent_id)
  where superintendent_id is not null;
comment on column public.projects.superintendent_id is
  'Accountable field superintendent. setProjectSuperintendent() also upserts a
   project_members row so assigned-scope RBAC sees the project. Null = unset
   (residential/commercial projects typically leave it null).';

-- RBAC catalog additions (progress_billing_permissions.sql pattern; also fold
-- into the rbac_catalog_seed desired state):
insert into public.permissions (key, description) values
  ('start.read',    'View start packages, gates, and the release board'),
  ('start.write',   'Edit start packages and attest gates'),
  ('start.release', 'Give final start approval, waive gates, and release starts'),
  ('start.slots',   'Edit community even-flow release slots')
on conflict (key) do update set description = excluded.description;
-- Grants: start.read -> all office roles + pm + field + org_land_manager;
-- start.write -> org_owner, org_admin, org_office_admin, org_project_lead, pm;
-- start.release + start.slots -> org_owner, org_admin (+ the new coordinator role).

insert into roles (key, label, scope, description) values
  ('org_starts_coordinator', 'Starts Coordinator', 'org',
   'Owns the start pipeline: gate completeness, even-flow release board, and
    start releases across communities. No access to job financials beyond
    budget read.'),
  ('org_superintendent', 'Superintendent', 'org',
   'Field lead running multiple houses. Schedule, daily logs, photos, punch,
    inspections, and EPO requests on assigned projects; no office financials.')
on conflict (key) do update set label = excluded.label,
  scope = excluded.scope, description = excluded.description;
-- org_starts_coordinator grants: org.member, org.read, project.read,
--   community.read, plan.read, plan.instantiate, start.read, start.write,
--   start.release, start.slots, budget.read, report.read, schedule.read.
-- org_superintendent grants: org.member, org.read, project.read, community.read,
--   start.read, schedule.read, schedule.edit, task.read/write (use the repo's
--   actual task keys — verify), daily-log + photo + punch + inspection keys
--   (mirror the existing 'field' role's grants and trim office surfaces).
--   Typically paired with memberships.project_scope='assigned'.
```

Superintendents are commonly `project_scope='assigned'` members — assignment
to a house = `setProjectSuperintendent` upserting their `project_members` row,
so both the RBAC scope and My Houses derive from the same act.

## Orchestration spec — start release

### Two-stage model

**Stage 1 — Readiness (human speed).** Gates green up over days/weeks. The
package auto-moves `open → ready` when every applicable required gate is
`passed`/`waived`/`not_applicable` — EXCEPT `budget` and `po_set`, which are
**release-produced** gates: they display as "generated at release" on the
board (muted, not blocking readiness) because master §5.4 makes the budget a
release-time derived artifact. Orgs that pre-generate budgets (long precon)
can pass them early — the auto-check greens if the artifact already exists.
`final_approval` is always last: attesting it requires `start.release` and
every OTHER applicable gate already green (service-enforced ordering).

**Stage 2 — Release (machine speed).** `releaseStart(packageId, {...})`:

1. Re-validates server-side, inside the service (never trust the board):
   package status `ready`; all applicable gates green (re-runs auto-checks
   fresh — a selection unlocked yesterday must fail here); lot status allows
   `started`; plan version still `released`.
2. **Slot discipline — advisory but loud:** counts releases already targeting
   `target_week` in that community vs `target_starts`. Over target → the
   action returns `{ requiresConfirm: true, over: {...} }` once; the client
   re-submits with `confirmOverSlot: true`; the service then proceeds AND
   emits `start.released_over_slot` + audit metadata. Never silently.
3. Ensures the project exists: if `lots.project_id` is null, creates the
   project (name from community code + lot label, `property_type='production'`,
   division denormalized) and runs WS01's `attachProjectToLot`. Recorded as
   step `project`.
4. Sets package `status='releasing'`, upserts the 8 `start_release_steps`
   rows to `pending`, and enqueues ONE outbox job:
   `{ jobType: 'start_release', payload: { start_package_id },
      dedupeByPayloadKeys: ['start_package_id'] }` — the dedupe key makes
   double-clicks and retry storms idempotent.
5. Returns immediately — the board shows the step ledger live (poll or
   refresh; no websockets).

### The pipeline runner

`lib/services/starts-pipeline.ts`, a structural copy of
`drawings-pipeline.ts`'s skeleton:

- `START_PIPELINE_JOB_TYPES = ['start_release'] as const`. **One job = one
  release run**, executing steps sequentially in-process (steps are seconds
  each; fan-out per step would buy nothing and cost ordering — the
  drawings pipeline fans out because pages are parallel; releases are not).
  `runStartsPipeline({ deadlineMs })`: `resetStaleProcessingJobs` (3-min
  reclaim) → loop `claim_jobs(['start_release'], 2)` → per job: 45-s
  heartbeat interval on `outbox.updated_at` → `executeRelease` → mark
  completed/failed with `MAX_JOB_RETRIES=3` + exponential-backoff `run_at`,
  exactly the drawings constants.
- `executeRelease(supabase, job)` — for each step in order
  (`project, budget, schedule, checklists, drawings, pos, notify_trades,
  finalize`):
  1. Skip steps already `completed` (resume semantics — a retried job
     re-enters and continues where it died; WS02's per-step idempotence
     guarantees the underlying artifacts aren't duplicated).
  2. Upsert step `running`, `attempt += 1`, `started_at`.
  3. Execute:
     - `schedule` / `checklists` / `drawings` → WS02
       `instantiatePlanForProject({ projectId, lotId, housePlanVersionId,
       elevationId, swing, communityId, startDate: scheduled_start_date,
       steps: [<that step>] })`. Per the WS02 contract the call returns
       `errors`/`warnings` instead of throwing — a step error marks THIS
       step failed (with the message) and **stops the sequence** (later
       steps stay `pending`). `drawings` returns `queued: true` — the
       step completes on queue (the drawings pipeline owns the async tail;
       its failures surface in drawings, not here).
     - `budget` — **single-owner rule (resolves WS02×WS04 overlap):** when
       purchasing is enabled for the org/community (an active price book
       exists — WS04 exposes `isPurchasingEnabled(orgId, communityId)`),
       this step is a no-op marked `completed` with
       `detail: { delegated_to: 'pos' }` — the derived budget is written
       by WS04's PO generation in the `pos` step (master §5.4; WS04's
       supersede/re-run logic owns those budget rows). When purchasing is
       NOT enabled (wedge deployments without a price book), this step
       runs WS02 `instantiatePlanForProject({ steps: ['budget'] })`, which
       prices from takeoff fallbacks / budget-template snapshot (WS02's
       manual-fallback `priceResolver` default). Exactly one of the two
       paths ever writes budget lines.
     - `pos` → WS04 `generatePurchaseOrders({ orgId, projectId,
       mode: 'commit' })` (the WS04 contract: fingerprint-idempotent,
       writes the derived budget + `commitment_lines.budget_line_id`
       links in the same RPC transaction, returns the run DTO — record
       `{ po_count: pos.length, total_cents, exceptions: exceptions.length }`
       into `detail`). Skipped as `completed`/`delegated` when purchasing
       is not enabled (mirror of the `budget` rule; a wedge org releases
       with a WS02 budget and no POs). A run ending
       `succeeded_with_exceptions` marks the step `completed` with the
       exception count in `detail` — release proceeds (the `price_book`
       readiness gate already blocked on `hasOpenPoExceptions` before
       release, so exceptions here are ones purchasing accepted).
     - `notify_trades` → for each distinct trade company holding a PO or a
       schedule assignment in the first 4 weeks: send the start notice
       (portal-link email rail, Notifications section below). Failures here
       are recorded but do NOT fail the release (notify is at-least-once
       advisory; `finalize` still runs) — step status `failed` + package
       still completes, flagged on the ledger.
  4. Mark step `completed` with `detail`, or `failed` with `error`.
- **Finalize** (only when steps 1–6 succeeded; notify may be failed):
  `setLotStatus(lotId, 'started')` via WS01 (audit trail stays whole), package
  `status='released'`, `released_at/by` (from the enqueuing action's stored
  user in payload), `actual_start_date = scheduled_start_date`, green the
  `budget`/`po_set` gates (`passed_via='auto'`), `recordEvent('start.released')`
  + notifications.
- **Terminal failure** (retries exhausted): package `status='attention'`,
  `recordEvent('start.release_failed')` + coordinator notification. The
  Attention queue on the Starts desk lists these with the failed step +
  error; actions: **Retry** (re-enqueues the job — completed steps skip) and
  **Cancel release** (package back to `ready`, steps reset to `pending`,
  audited; already-created artifacts remain — WS02 idempotence makes a later
  retry safe). Never silent, never lost.

### Cron + routes

- `app/api/jobs/starts-pipeline/route.ts` — **GET** handler (Vercel Cron
  sends GET), CRON_SECRET check, wrapped in
  `withCronRun("starts-pipeline", …)`, calls `runStartsPipeline()`.
- `vercel.json`: `{ "path": "/api/jobs/starts-pipeline",
  "schedule": "*/5 * * * *" }` + `maxDuration: 300` for the route.
- `lib/services/job-runs.ts` `CRON_JOBS`: add the mirrored entry
  (expectedIntervalMinutes 5).
- `proxy.ts` `PUBLIC_API_ROUTES`: add `/api/jobs/starts-pipeline` — WITHOUT
  this the route 307s to signin and never runs (standing incident pattern).
- Kick-on-release: after enqueueing, the action fire-and-forgets a fetch to
  the pipeline route (the drawings `triggerDrawingsPipeline` pattern) so a
  release starts in seconds, with the 5-min cron as the guarantee.
- Weekly slot upkeep rides the same cron: `runStartsPipeline` ends by calling
  `ensureReleaseSlots` for communities whose horizon has less than
  `release_horizon_weeks` of future rows (cheap grouped query, org-scoped
  loop capped at 200 communities/run).

## Service layer

### `lib/services/starts.ts`

Canonical shape (`requireOrgContext` → `requirePermission` → logic →
`recordEvent` + `recordAudit` → mapped DTO). All money cents, all lists
paginated/capped.

```ts
export type StartPackageStatus = "open"|"ready"|"releasing"|"released"|"attention"|"cancelled"
export interface StartGateDTO {
  id: string; definitionId: string; key: string; label: string;
  checkKind: "auto"|"manual"; status: "pending"|"passed"|"waived"|"not_applicable";
  passedVia: "auto"|"attested"|"waived"|null;
  attestedBy: string | null; attestedByName: string | null; attestedAt: string | null;
  waivedReason: string | null; evidenceFileId: string | null;
  releaseProduced: boolean;   // budget/po_set — rendered muted pre-release
}
export interface StartPackageListItemDTO {
  id: string; lotId: string; lotLabel: string; communityId: string; communityName: string;
  projectId: string | null; status: StartPackageStatus;
  planCode: string | null; planName: string | null; elevationCode: string | null;
  targetWeek: string | null; scheduledStartDate: string | null;
  gatesPassed: number; gatesTotal: number;       // applicable, non-release-produced
  precomAgeDays: number;                          // days since package created
  isFinanced: boolean; releasedAt: string | null;
  superintendentId: string | null; superintendentName: string | null;
}
export interface StartPackageDetailDTO extends StartPackageListItemDTO {
  gates: StartGateDTO[];
  steps: Array<{ stepKey: string; status: string; attempt: number;
                 error: string | null; detail: Record<string, unknown>;
                 completedAt: string | null }>;
  notes: string | null;
}

export async function listStartPackages(
  filters: { communityId?: string; status?: StartPackageStatus[]; targetWeek?: string;
             page?: number; pageSize?: number },   // pageSize default 50, max 200
  orgId?: string,
): Promise<{ packages: StartPackageListItemDTO[]; total: number }>
export async function getStartPackage(id: string, orgId?: string): Promise<StartPackageDetailDTO>
export async function openStartPackage(
  lotId: string, input: { isFinanced?: boolean; targetWeek?: string }, orgId?: string,
): Promise<StartPackageDetailDTO>
  // Creates package + one gate row per active applicable definition; blocked if
  // the lot has a live package (unique index backstops) or status closed.
  // Runs refreshAutoGates immediately. Permission start.write.
export async function updateStartPackage(
  id: string, input: { targetWeek?: string | null; scheduledStartDate?: string | null;
                       isFinanced?: boolean; notes?: string | null }, orgId?: string,
): Promise<StartPackageDetailDTO>
  // isFinanced flip re-derives financed_only gate applicability.
export async function refreshAutoGates(packageId: string, orgId?: string): Promise<StartGateDTO[]>
  // Re-runs every auto_source check (queries batched via Promise.all); flips
  // passed<->pending; auto transitions never overwrite waived. Recomputes
  // package open<->ready. Called on detail load + before release.
export async function attestGate(
  packageId: string, gateId: string,
  input: { evidenceFileId?: string; notes?: string }, orgId?: string,
): Promise<StartGateDTO>
  // Manual gates only; enforces requires_attestation_permission; final_approval
  // additionally requires all other applicable gates green. Event start_gate.attested.
export async function waiveGate(
  packageId: string, gateId: string, input: { reason: string }, orgId?: string,
): Promise<StartGateDTO>   // start.release; reason required; event start_gate.waived
export async function reopenGate(packageId: string, gateId: string, orgId?: string): Promise<StartGateDTO>
  // Un-attest/un-waive (mistake path); blocked once status releasing/released.
export async function releaseStart(
  packageId: string, input: { scheduledStartDate: string; confirmOverSlot?: boolean },
  orgId?: string,
): Promise<{ released: true } | { requiresConfirm: true; slot: { targetWeek: string;
             target: number; alreadyTargeted: number } }>
  // The stage-2 sequence above. Permission start.release.
export async function retryRelease(packageId: string, orgId?: string): Promise<void>
export async function cancelRelease(packageId: string, orgId?: string): Promise<void>
export async function cancelStartPackage(id: string, { reason }: { reason: string }, orgId?: string): Promise<void>
// Gate definitions (org settings surface):
export async function listGateDefinitions(orgId?: string): Promise<GateDefinitionDTO[]>
export async function upsertGateDefinition(input: GateDefinitionInput, orgId?: string): Promise<GateDefinitionDTO>
export async function seedDefaultGateDefinitions(orgId?: string): Promise<void>
export async function setProjectSuperintendent(
  projectId: string, userId: string | null, orgId?: string,
): Promise<void>
  // Sets projects.superintendent_id + upserts/cleans the project_members row
  // (never deletes a row the member needs for other reasons — verify shape).
  // Permission project.manage. Event project.superintendent_changed.
```

### `lib/services/even-flow.ts`

Read-mostly desk/report queries. Every aggregate is a grouped count/sum via
SQL (RPC where >1000-row sums bite — platform-ops precedent), never row scans.

```ts
export interface ReleaseBoardWeekDTO {
  weekStart: string; targetStarts: number; slotNoteId: string | null;
  released: number; targeted: number;          // packages released / aimed at week
  variance: number;                            // released(past)|targeted(future) - target
}
export interface ReleaseBoardCommunityDTO {
  communityId: string; communityName: string;
  weeks: ReleaseBoardWeekDTO[];                // [weeksBack .. weeksAhead] window
  precon: { open: number; ready: number; attention: number; oldestAgeDays: number }
  underConstruction: number;                   // lots status='started' not closed
}
export async function getReleaseBoard(
  opts: { communityId?: string; divisionId?: string; weeksBack?: number;  // default 4
          weeksAhead?: number },                                          // default 12
  orgId?: string,
): Promise<ReleaseBoardCommunityDTO[]>          // capped 50 communities/page
export async function setReleaseSlot(
  communityId: string, weekStart: string,
  input: { targetStarts: number; notes?: string }, orgId?: string,
): Promise<void>                                 // start.slots; event release_slot.updated
export async function ensureReleaseSlots(communityId: string, orgId?: string): Promise<void>

// Reporting
export interface CycleTimeRow {
  groupKey: string; groupLabel: string;         // plan | community | super
  count: number; medianDays: number; p80Days: number; trendDelta: number;
}                                                // start->close actuals; until WS06
                                                 // closings, close = project completed_at
export async function getCycleTimeReport(
  opts: { groupBy: "plan"|"community"|"superintendent"; from?: string; to?: string;
          communityId?: string }, orgId?: string,
): Promise<CycleTimeRow[]>
export async function getEvenFlowAdherence(
  opts: { communityId?: string; from: string; to: string }, orgId?: string,
): Promise<Array<{ weekStart: string; communityId: string;
                   plannedStarts: number; actualStarts: number;
                   plannedClosings: number | null; actualClosings: number }>>
export async function getWipCounts(
  opts: { divisionId?: string }, orgId?: string,
): Promise<Array<{ communityId: string; communityName: string;
                   precon: number; underConstruction: number;
                   readyBacklog: number; attention: number }>>
export async function getLateTaskHeatmap(
  opts: { communityId?: string; superintendentId?: string }, orgId?: string,
): Promise<Array<{ projectId: string; lotLabel: string; phase: string | null;
                   lateCount: number; maxDaysLate: number }>>
  // schedule_items past end_date and not completed, grouped project × phase;
  // capped to active production projects (id set via reporting-scope helpers).
```

### `lib/services/my-houses.ts` (extends the My Work pattern)

```ts
export interface MyHouseDTO {
  projectId: string; lotLabel: string; communityId: string; communityName: string;
  planCode: string | null; elevationCode: string | null;
  startDate: string | null; targetDays: number | null;   // template duration
  daysInProgress: number; percentComplete: number;        // schedule progress avg
  currentPhase: string | null;                            // phase of earliest open item
  lateCount: number; openPunch: number; openTasks: number;
  lastDailyLogDate: string | null;                        // "no log yesterday" nudge
}
export async function listMyHouses(
  opts: { userId?: string; page?: number; pageSize?: number },  // default: current user, 25/page
  orgId?: string,
): Promise<{ houses: MyHouseDTO[]; total: number }>
  // projects where superintendent_id = user, status active, production posture;
  // rollups via 3 grouped queries in Promise.all (schedule, punch, daily-log max),
  // never per-project loops.
export interface MyHouseTaskGroupDTO {
  groupKey: string; groupLabel: string;   // schedule item name normalized, or task type
  items: Array<{ scheduleItemId: string; projectId: string; lotLabel: string;
                 name: string; trade: string | null; status: string;
                 startDate: string | null; endDate: string | null; daysLate: number }>
}
export async function listMyHouseWork(
  opts: { window: "today"|"week"|"twoweek"; userId?: string }, orgId?: string,
): Promise<MyHouseTaskGroupDTO[]>
  // Schedule items across my houses due/active in window, GROUPED BY normalized
  // item name ("Frame inspection" x 6 lots) — the task-type-across-lots view.
  // Grouping = lower(trim(name)); items without dates excluded. Cap 500 items.
export async function completeMyHouseScheduleItem(
  scheduleItemId: string, orgId?: string,
): Promise<void>
  // One-click-complete calling the workbench's mutation (updateScheduleItem
  // status/progress) — desk doctrine: the desk may complete ONLY via the
  // workbench's server action path. Requires schedule.edit on that project.
```

### `lib/services/trade-lookahead.ts`

```ts
export interface TradeLookaheadRow {
  companyId: string; companyName: string; trade: string | null;
  items: Array<{ scheduleItemId: string; projectId: string; lotLabel: string;
                 communityName: string; name: string; startDate: string;
                 endDate: string; status: string;
                 confirmation: "unsent"|"sent"|"confirmed"|"declined" }>
}
export async function getTradeLookahead(
  opts: { weeks: 2|3|4; communityId?: string; companyId?: string;
          page?: number; pageSize?: number }, orgId?: string,
): Promise<{ rows: TradeLookaheadRow[]; total: number }>
  // Trade company resolution precedence per schedule item:
  // 1) schedule_assignments.company_id  2) WS04 PO vendor for the item's cost
  // code on that project  3) unmatched — grouped under "Unassigned" (visible,
  // not hidden). Window = items starting within N weeks on active production
  // projects (reporting-scope id sets). Confirmation state comes from WS04's
  // trade-loop table (read-only here; "—" until WS04 ships it).
export async function sendTradeLookahead(
  companyId: string, opts: { weeks: 2|3|4; communityId?: string }, orgId?: string,
): Promise<{ sent: boolean }>
  // Renders the company's rows into the dispatch-style email (warranty dispatch
  // precedent) with a sub-portal link (app/s/[token] — WS04's confirm surface).
  // Event trade_lookahead.sent; audited. Cap one send per company per day
  // (dedupe via outbox dedupe_key on (company, date)).
```

Schedule-change notices: `updateScheduleItem`/`bulkUpdateScheduleItems` in
`schedule.ts` gain a **post-mutation hook** (small, additive): when a date
changes on an item within the next 4 weeks on a production-posture project
with a resolvable trade company, enqueue
`{ jobType: 'trade_schedule_change_notice', payload: { company_id, project_id,
schedule_item_id, old_start, new_start }, dedupeByPayloadKeys:
['company_id','project_id'] , runAt: +15min }` — the 15-minute delay +
company-level dedupe coalesces a drag-heavy Gantt session into one digest
email per company per project. The starts pipeline cron processes these
(same `claim_jobs` loop, job type added to its list).

## Server actions + validation

- `app/(app)/starts/actions.ts` — thin `ActionResult` wrappers (Zod parse →
  service → `revalidatePath` → `{ success, data } | actionError(e)`):
  `openStartPackageAction`, `updateStartPackageAction`, `refreshGatesAction`,
  `attestGateAction`, `waiveGateAction`, `reopenGateAction`,
  `releaseStartAction` (handles the `requiresConfirm` round-trip),
  `retryReleaseAction`, `cancelReleaseAction`, `cancelStartPackageAction`,
  `setReleaseSlotAction`, `upsertGateDefinitionAction`,
  `sendTradeLookaheadAction`, `setProjectSuperintendentAction` (may also live
  with project settings actions — one home: pick project settings, the desk
  deep-links).
- `app/(app)/my-houses/actions.ts` — `completeScheduleItemAction` (calls the
  schedule service path).
- `lib/validation/starts.ts` — `startPackageInputSchema`, `gateAttestSchema`
  (notes ≤ 2000), `gateWaiveSchema` (reason min 10 chars),
  `releaseInputSchema` (`scheduledStartDate` ISO date, not past),
  `slotSchema` (`targetStarts` int 0–20, `weekStart` Monday check mirrored in
  Zod), `gateDefinitionSchema` (key `/^[a-z][a-z0-9_]{1,40}$/`, enum-checked
  `auto_source`), `lookaheadSchema` (weeks 2|3|4).

## UI spec

Design rules bind: tokens only, radius 0, NO hero/marquee (the release board
opens with a title row then the grid), shadcn primitives, dense editorial
tables, tabular-nums for numbers, color = state only. Every view: empty +
loading + error states, dark mode, density matched to `/schedule` and
`/billing` siblings.

### `app/(app)/starts/` — the Starts desk

**Whole-JOB test (documented per master §7.6):** a starts coordinator's
entire job is this pipeline across communities — gate chasing, weekly release
cadence, failure triage. That is a full-time role at 100+ starts/yr and the
reason this desk exists; it is NOT a symmetry desk. Mutations that belong to
the lot/project workbench (schedule edits, budget edits) stay there; the desk
mutates only its own nouns (packages, gates, slots) and one-click-releases
via its own server actions.

Sidebar: workspace item "Starts" for production-tier orgs (exact
`app-sidebar.tsx` precedent WS01 used for Communities), `requiredAny:
["start.read"]`. Route not tier-gated.

```
app/(app)/starts/page.tsx          -> Release board (default)
app/(app)/starts/pipeline/page.tsx -> Package pipeline table (all packages, filters)
app/(app)/starts/reports/page.tsx  -> Cycle time / even-flow / WIP / heatmap
app/(app)/starts/settings/page.tsx -> Gate definitions + community slot defaults
app/(app)/starts/layout.tsx        -> title row + tab strip; Attention badge count
app/(app)/starts/loading.tsx       -> skeleton grid
```

**Release board (centerpiece).** One section per community (community/division
filter; 50-community pagination; default sorted by nearest unfilled slot):

- A **week strip grid**: columns = weeks (4 back, 12 ahead; horizontal
  scroll inside `overflow-x-auto`), one row per community section. Each cell:
  `released/target` for past weeks, `targeted/target` for future (tabular
  nums). Variance state colors: at-target muted, under = amber, over = the
  destructive token — color is the whole message, no badges/icons. Cell click
  (with `start.slots`) opens a small popover to edit `target_starts` + note.
- Under the strip, the **precon pipeline table** for that community: packages
  not yet released, ordered by target week then gate completeness desc.
  Columns: Lot, Plan/Elev, Target week (inline editable select of upcoming
  weeks, showing each week's remaining slot count), Gates (n/m + a compact
  segmented progress bar — no charts), Age (days since opened; >45 days
  amber — precon aging visible), Financed, Super, Status. Row click → package
  detail sheet.
- **Attention queue**: pinned strip above everything ONLY when non-empty:
  failed releases with step + error + Retry/Cancel actions. Loud by
  existence, calm by styling.
- Header actions: "Start package…" (lot picker filtered to package-less
  developed/assigned lots) gated `start.write`.
- Empty state: "No start packages yet — open one from a lot or here." Errors:
  standard boundary. 400-lot community: board queries are grouped counts +
  one page of packages; verified snappy by construction.

**Pipeline tab:** the full packages table (all statuses incl. released, with
status/community/week filters + search by lot), server-paginated 50/page —
the audit/history view the board deliberately isn't.

**Package detail — Sheet** (invoice detail-sheet exemplar): header (lot,
community, plan/elevation, status, target week, scheduled start date);
**gate checklist** as a dense vertical list — each row: state icon (token
colors), label, auto/manual tag, evidence link, attested-by + timestamp
muted, and the action (Attest / Waive… / Reopen) per permission. Auto gates
show "checked just now" with a manual Refresh. `final_approval` renders last
with a rule above it. Below gates: the **release step ledger** (only once
releasing/released/attention): 8 rows, status + duration + error + detail
summary (budget total, PO count). Footer: the Release button (enabled only
when `ready`; opens a confirm dialog showing scheduled start date picker +
slot status for the target week; over-slot re-confirm states the numbers
plainly: "Week of Mar 2 targets 2 starts; this is #3. Release anyway?").

**Reports tab:** four dense report blocks, each a table (dataviz only if a
sibling report already charts — default tables): cycle time grouped by
plan/community/super with median/p80/trend vs the 120–130-day benchmark
(muted footnote, no billboard); even-flow adherence per week per community
(planned vs actual starts, closings when WS06 lands); WIP counts; late-task
heatmap (project × phase grid, intensity = late count via the state color
scale — token-based). CSV export per block (existing report-export pattern).

**Settings tab:** gate definitions table (label, kind, source, applies-when,
attestation permission, active; drag sort) + per-community
`starts_per_week` / horizon editors (writes `communities.settings`, calls
`ensureReleaseSlots`). `start.release` required to edit definitions.

### `app/(app)/my-houses/` — superintendent desktop

Whole-JOB test: a production super's entire job is their 10–15 houses; My
Work (`/tasks`) stays the generic personal hub — My Houses is the field
persona's own scope (the "My Work is the personal cross-project scope"
doctrine names this exact extension). Sidebar item for users who ARE a
superintendent of ≥1 active project (cheap head-count in the layout), plus
always for `org_superintendent` role holders.

- **Header row**: "My Houses" + window toggle (Today / This week / 2 weeks).
- **Work section (top, the point of the page):** grouped task list —
  group header = normalized item name ("Frame inspection — 6 houses"),
  rows = lot label, community, dates, trade, days-late amber, and a
  one-click Complete (calls the workbench action). Dense list, no cards,
  no kanban.
- **Houses table (below):** one row per house: Lot, Community, Plan, Phase,
  Start date, Days in progress (vs target muted), % complete, Late items,
  Open punch, Last daily log (yesterday-missing amber). Row click → the
  project workbench (deep link — mutations live there).
- Empty state ("No houses assigned"), loading skeleton, error boundary,
  dark mode. 15 houses × grouped queries = trivially fast; still capped.

### Community schedule views

No new Gantt. Two additions to existing surfaces:

- **Org portfolio Gantt** (`/schedule`): WS01 Phase 5's community filter
  scopes rows; this workstream adds a "Start" marker (baseline-style tick at
  `actual_start_date`) and sorts community-filtered rows by start date — the
  even-flow visual: staggered identical bars. One marker + sort, reusing
  `gantt.css`.
- **Community workbench** gains a **Starts tab**
  (`app/(app)/communities/[id]/starts/page.tsx`): that community's release
  board section (same component, single community) — the community-scoped
  lens without a second implementation. Component lives in
  `components/starts/release-board.tsx` and is shared.

## Mobile API spec (`/api/mobile/v1`) — supers live here

New routes, existing conventions exactly (`requireMobileOrg` → `lib/mobile/*`
→ `mobilePageResponse`/`mobileErrorResponse`; bearer auth; `proxy.ts` already
allowlists `/api/mobile/`):

- `GET /api/mobile/v1/my-houses` — `lib/mobile/my-houses.ts`
  `listMobileMyHouses(context)` → MyHouseDTO list (snake_case JSON like
  existing mobile DTOs; ISO8601 with fractional seconds — the iOS decoder
  gotcha is already handled globally).
- `GET /api/mobile/v1/my-houses/work?window=today|week|twoweek` — the grouped
  cross-house work feed (MyHouseTaskGroupDTO). This is the super's home
  screen feed.
- `POST /api/mobile/v1/my-houses/schedule-items/[scheduleItemId]/complete` —
  one-tap complete; body `{ progress?: number }`; validates the item belongs
  to a project the caller supervises or can edit.
- Quick actions reuse EXISTING per-project routes (no duplication): daily log
  + photo → `POST /projects/[projectId]/daily-logs` (+ `/photos`), punch →
  `/projects/[projectId]/punch-items`, tasks → `/projects/[projectId]/tasks`.
  My Houses responses carry `project_id` on every row so the app can hop
  into the existing project flows.
- **EPO request** (WS04's noun): `POST /api/mobile/v1/projects/[projectId]/
  epo-requests` is WS04's deliverable — this doc reserves the My Houses UI
  entry point only; ship the button when WS04's endpoint exists (reference,
  don't stub).

**iOS implications (note for the ios/Arc repo, not built here):** the Logs
day-first diary and workspace tabs stay; add a "My Houses" tab for
superintendent users (server-driven: presence of ≥1 house in
`/my-houses` response), with the work feed as its landing list and
house rows deep-linking into the existing project workspace. Offline: the
work feed is read-cache-friendly (plain GET lists); completes queue like
existing task mutations.

## Notifications spec

**In-app types** (extend `NotificationType` union; in-app is unrestricted):

- `start_package_ready` — to `start.release` holders when a package flips to
  ready ("Lot CYP-014 is ready to release").
- `start_released` — to the package's community stakeholders (coordinator +
  the assigned super, who now has a new house).
- `start_release_failed` — to `start.release` holders (attention queue push).
- `start_gate_waived` — to `start.release` holders (waivers are loud).
- `project_superintendent_assigned` — to the assigned super.

**EMAIL_NOTIFICATION_TYPES additions (exactly two — the allowlist stays
tight):**

```ts
{ key: "start_release_failed", label: "Start release failed",
  description: "Email me when a start release fails and needs attention." },
{ key: "start_package_ready", label: "Start package ready",
  description: "Email me when a lot's start package has all gates cleared." },
```

`start_released` and waivers stay in-app only (the board is the loud surface;
release emails at 2/wk/community would train people to ignore the allowlist's
purpose). Revisit on user demand.

**Trade emails are NOT user notifications.** Trades are external companies:
start notices, look-aheads, and schedule-change digests send via the
dispatch-email rail (warranty assigned-company dispatch precedent) with a
sub-portal link (`app/s/[token]`, token per company via
`portal_access_tokens` — WS04 owns the confirm/ack capability on that
surface; this doc's emails deep-link to it). Template content: lot address,
community, item names + dates (change notices show old → new), and the
portal CTA. All sends audited (`recordAudit` source `trade_notice`) and
event-logged; per-company daily dedupe via outbox `dedupe_key`.

## RBAC, events, search

- **Permissions/roles**: Migration 4 above (`start.read/write/release/slots`,
  `org_starts_coordinator`, `org_superintendent`). Add all four keys to
  `TEAM_PERMISSION_OPTIONS` (`lib/services/team.ts`) and the two roles to the
  assignable-role list (bookkeeper/estimator pattern). Fold into the
  rbac_catalog_seed desired state in the same change.
- **Events** (`recordEvent`): `start_package.opened/updated/cancelled`,
  `start_gate.attested/waived/reopened`, `start.released`,
  `start.released_over_slot`, `start.release_failed`, `start.release_retried`,
  `release_slot.updated`, `trade_lookahead.sent`,
  `trade_schedule_change_notice.sent`, `project.superintendent_changed`.
  Audit on every mutation (entity types `start_package`, `start_gate`,
  `start_gate_definition`, `community_release_slot`).
- **Search index** (`lib/services/search-index.ts`): register `start_package`
  (title "Start — {lot label} · {community}", url the Starts desk detail).
  Gate definitions, slots, and steps are NOT registered (settings-grade /
  derivative rows).

## Migration plan (recap)

| # | File (`supabase/migrations/`) | Contents |
|---|---|---|
| 1 | `<ts>_start_gate_definitions.sql` | gate catalog + seed-ready shape |
| 2 | `<ts>_start_packages.sql` | start_packages, start_package_gates, start_release_steps |
| 3 | `<ts>_community_release_slots.sql` | slots table |
| 4 | `<ts>_superintendent_and_start_rbac.sql` | projects.superintendent_id + permissions/roles |
| 5 | `<ts>_workstream_05_fk_indexes.sql` | advisor-driven FK coverage |

All additive; RLS + indexes + updated_at triggers per table in-file.
Prerequisite tables (`lots`, `communities`, `house_plan_versions`, WS04's PO
surface) must exist in prod first — verify with MCP `list_tables`; if absent,
STOP and coordinate. Write files, then STOP for human approval before
assuming tables exist (local env is PRODUCTION). Infra edits (`vercel.json`,
`CRON_JOBS`, `proxy.ts`) land with Phase 2, all three in the same commit —
a partial trio is a silent-dead cron.

## Phases (each ends `pnpm lint` clean)

### Phase 1 — Packages + gates (no orchestration yet)

Migrations 1, 2 (steps table included but unused), 4; `starts.ts` minus
release; validation; actions; seeded definitions; package detail sheet +
pipeline tab; `setProjectSuperintendent` + project-settings control.

- [ ] QA org: open a package on a developed lot → 7 applicable gates (8 when
      financed); plot-plan upload + plan pin flip their auto gates on
      refresh; attest permit; `final_approval` rejects while others open,
      accepts after; waive without reason rejected; package flips to
      `ready`; all transitions produce events + audit rows.
- [ ] Second package on the same lot rejected; cancel → reopen works.
- [ ] Package searchable; a `start.read`-only member sees read-only.

### Phase 2 — Release orchestration

`starts-pipeline.ts`; `releaseStart` + retry/cancel; cron route +
`vercel.json` + `CRON_JOBS` + `proxy.ts` (same commit); step ledger UI;
attention queue; notifications (`start_release_failed`,
`start_package_ready` incl. allowlist entries).

- [ ] Releasing a ready package (QA org, WS02 plan pinned, WS04 available):
      steps run in order; budget/schedule/checklists/drawings appear via the
      WS02 engine; POs via WS04; lot → `started`; package `released`;
      `budget`/`po_set` gates green; ledger shows per-step detail.
- [ ] Kill the runner mid-release (simulate) → stale reclaim resumes within
      minutes; completed steps skip; nothing duplicated (WS02 idempotence).
- [ ] Force a step failure (e.g. unrelease… not possible — use a missing
      plan PDF for drawings): retries then `attention`; coordinator gets the
      notification + email; Retry completes the remainder; Cancel returns to
      `ready` audited.
- [ ] `job_runs` shows starts-pipeline heartbeats; Ops page green; the cron
      answers GET with CRON_SECRET and 401s without.

### Phase 3 — Even-flow board + slots

Migration 3; `even-flow.ts` board/slot functions; `/starts` board page;
community Starts tab; over-slot confirm loop; slot seeding + weekly upkeep.

- [ ] Seed a community at 2/wk × 16 weeks; board shows the strip; editing a
      week persists and survives re-seeding; releasing a 3rd start into a
      2-slot week demands the confirm and emits `start.released_over_slot`;
      under/over weeks colored; precon aging visible at >45 days.
- [ ] Board on a 400-lot community stays paginated + grouped-count fast.

### Phase 4 — My Houses (desktop + mobile)

`my-houses.ts`; `/my-houses` route; mobile `my-houses` + `work` + `complete`
endpoints; portfolio-Gantt start markers.

- [ ] A super assigned 12 QA houses: desktop shows the grouped week feed
      ("Frame inspection — 6 houses") and the houses table with late/punch/
      log rollups; Complete round-trips through the workbench action.
- [ ] Mobile endpoints return the same data under bearer auth; complete
      works; a non-super gets empty lists, not errors.

### Phase 5 — Trade look-aheads + reports

`trade-lookahead.ts`; schedule-change hook + digest job type; look-ahead
surface (a Trades tab on the Starts desk reports area or `/starts/trades` —
pick one, document); reports tab (4 blocks + CSV).

- [ ] 3-week look-ahead groups items per company across lots with the PO/
      assignment/unassigned precedence; Send delivers the dispatch email
      with the portal link; same-day resend deduped.
- [ ] Dragging 5 items for one company in one session yields ONE digest
      email listing all 5 changes (15-min coalesce).
- [ ] Cycle-time medians match hand-computed fixtures; even-flow adherence
      matches the board's history; heatmap intensity = late counts.

## Test plan

- `pnpm lint` per phase; `pnpm test:financials` once after Phase 2 (release
  writes budgets/POs through WS02/WS04 paths — assert zero regressions).
- Pure-function unit tests (node-test style in `tests/`, wired like
  `tests/pay-app-math.test.js` into a `test:starts` script): gate
  applicability + readiness matrix (financed × waived × release-produced),
  slot variance math (past-released vs future-targeted), week normalization
  (Monday snapping incl. year boundaries), work-feed grouping key, cycle-time
  median/p80, digest coalescing key. Keep logic in pure modules
  (`lib/starts/gate-logic.ts`, `lib/starts/even-flow-math.ts`) so tests need
  no DB.
- Pipeline semantics tested by construction against the drawings-pipeline
  skeleton (same constants/paths) + the Phase 2 kill/resume manual check.
- Manual QA in the dedicated QA org only — local env is PRODUCTION; never
  release against a customer org.

## Open questions

1. **Slot targets vs closings** — slots model starts; builders also pace
   CLOSINGS per week. `getEvenFlowAdherence` reserves `plannedClosings`
   (null v1); decide with WS06 whether closings get their own slot rows or a
   projection from starts + plan cycle time.
2. **Workday offsets** (shared with WS02 OQ1) — calendar days v1; the even-
   flow calendar is the natural home for org holiday calendars when workday
   scheduling lands. Additive (`offset_basis` on template items).
3. **Gate SLA nudges** — email when a package ages past N days without
   movement? Deferred until a coordinator asks; the board's aging column is
   the v1 answer (and WS01's takedown-reminder OQ may merge into it).
4. **`start_release_steps` vs reusing `conversion_runs`** — deliberately a
   new table: conversion runs are estimate→project conversions with their own
   step keys and UI; overloading them would couple two unrelated state
   machines. Shape is copied, table is not. Revisit only if a third
   step-ledger appears (then extract a generic `run_steps`).
5. **Super capacity guardrail** — warn when assigning a 16th house to one
   super (master §9 says 10–15)? v1: show the count in the assignment picker,
   no block.
6. **Trade look-ahead push notifications** — trades get email + portal v1;
   a trade-facing push surface is the deferred SupplyPro-competitor seed
   (master §10), not this workstream.
