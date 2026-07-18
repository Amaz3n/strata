# Workstream 02 — Plan Library, Template Bundles, and the Instantiation Engine

> Prereq: `00-MASTER-production-expansion.md` (read FULLY first) + workstream 01
> (divisions/communities/lots) shipped. Workstream 08 is independent. This doc is
> self-contained for a fresh executor: every schema/code claim below was verified
> against the repo on 2026-07-16; re-verify against live schema before writing
> migrations (Supabase MCP `list_tables` / SELECT-only `execute_sql`).

## STATUS — NOT STARTED

No code, no migrations. `docs/production-expansion/` contains only `00-MASTER` and
this doc at time of writing.

## Mission

Production building estimates ONCE PER PLAN, then *generates* each house. This
workstream builds the org-level **Plan Library** — the manufacturing bill of
process for a production builder — and the **instantiation engine** that stamps a
plan onto a lot's project:

1. **`house_plans`** + **`house_plan_elevations`** + **`house_plan_versions`** —
   the plan catalog. Versions are **immutable once released**; re-pricing or
   value-engineering bumps the version; in-flight lots pin the version they
   started with; drift is reportable, never silently propagated (master §5.3).
2. **Plan takeoff lines** — qty × uom per cost code (+ cost type) per version,
   optionally per elevation as deltas. Workstream 04's price book
   (`vendor_price_agreements`: vendor × cost_code [× plan] [× community]) prices
   these; the takeoff shape is designed to join against it cleanly.
3. **`budget_templates`** — NET-NEW and deliberately **NEUTRAL** (no `production_`
   prefix; helps residential/commercial too). Relational
   (`budget_templates` + `budget_template_lines`), wired into existing budget
   creation as a third seed alongside blank and budget-from-estimate.
4. **Template bundles on the plan version** — refs to budget template, schedule
   template, checklist/inspection templates, drawing source file, selection
   template categories; **refs while draft, pinned snapshots at release**
   (decision + justification below).
5. **`community_plan_availability`** — which plan × elevation sells in which
   community, at what base price, over which dates.
6. **Plan drawing source** — a plan version owns its plan-set PDF; instantiation
   feeds it into the lot project's **one canonical drawing set** via the existing
   drawings pipeline (never a set per upload, never deleting old sheets —
   `lib/services/drawings-pipeline.ts` doctrine).
7. **`instantiatePlanForProject(...)`** — the composable service that, given
   lot + plan version + elevation (+ options later), generates the project's
   budget, schedule (offset to start date), checklists, and drawing set. This is
   the engine workstream 05's start-release orchestration calls; its contract is
   specced precisely here so 05 can build against it.

**The budget is a derived artifact** (master §5.4): start release generates the
lot budget from (takeoff × price book) + options; nobody hand-builds a production
budget; post-generation hand edits are variances.

## Non-goals

- Option catalog / design studio (workstream 03). The instantiation contract
  reserves an `options` input but this workstream implements only the base +
  elevation path; 03 fills the option leg.
- Price book (`vendor_price_agreements`) itself — workstream 04. This doc defines
  the **`PriceResolver` seam** and a manual/template fallback so instantiation
  works before 04 ships.
- Start packages, gates, even-flow, and the outbox orchestration around
  instantiation — workstream 05. Here we build the callable engine only.
- No changes to residential/commercial budget flows beyond ADDING the
  budget-template seed option.

## Read these files first

- `docs/production-expansion/00-MASTER-production-expansion.md` — especially §4
  (naming collisions: **`plans` is TAKEN by Stripe billing** — the tables are
  `house_plans` / `house_plan_elevations` / `house_plan_versions`), §5 (canonical
  model), §7 (repo rules).
- `docs/commercial-expansion/00-MASTER-commercial-expansion.md` §4 — repo rules
  17–22 (posture helpers, RLS `(select auth.uid())`, search-index registration,
  email allowlist, RBAC catalog seed, CRON registry) all bind here.
- `lib/services/budgets.ts` — `createBudget` (verified: inserts `budgets` row with
  next `version` per project, then `budget_lines` with `cost_code_id`,
  `description`, `amount_cents`, `sort_order`, `metadata`, `cost_type`; audits +
  emits `budget_created`). Instantiation calls THIS, never a parallel insert.
- `lib/services/budget-from-estimate.ts` — the "generate lines from another
  entity" exemplar (deterministic grouping by cost code, cost-codes-off fallback
  where every line stands alone, optional AI tidy of notes only). Budget-from-
  template mirrors its draft-then-review shape.
- `lib/services/estimate-templates.ts` — org-scoped template CRUD exemplar
  (Zod input schema, `mapTemplate` defensive DTO mapping). NOTE: it stores lines
  as jsonb; `budget_templates` deliberately does NOT (see decision below).
- `lib/services/schedule.ts` L1014–1135 — `listTemplates` / `createTemplate` /
  `applyTemplate(templateId, projectId)` / `deleteTemplate`. Verified:
  `schedule_templates.items` is jsonb; `applyTemplate` loops
  `createScheduleItem` with name/item_type/phase/trade/planned_hours/color/
  sort_order and does NOT set dates. Instantiation extends this with
  start-offset scheduling (additive jsonb fields, no schema change).
- `supabase/migrations/20260517092101_remote_schema.sql` — verified shapes:
  - `estimate_templates(id, org_id, name, description, lines jsonb, is_default,
    created_at, updated_at)`.
  - `schedule_templates(id, org_id, name, description, project_type,
    property_type, items jsonb, is_public, created_by, timestamps)`.
  - `budgets(id, org_id, project_id, version, status, total_cents, currency,
    metadata, timestamps)`; `budget_lines(id, org_id, budget_id, cost_code_id,
    description, amount_cents, metadata, sort_order, forecast_remaining_cents
    [+ cost_type from 20260710215226])`.
  - `drawing_sets.project_id` is **NOT NULL** — a drawing set cannot exist
    without a project. This forces the plan-drawing design below.
- `supabase/migrations/20260711021000_inspections.sql` —
  `checklist_templates(id, org_id, name, kind safety|quality, trade, description,
  is_active)` + `checklist_template_items` (relational lines — the shape
  `budget_template_lines` follows).
- `supabase/migrations/20260710215226_cost_type_dimension.sql` — enum
  `public.cost_type` (labor|material|equipment|subcontract|other) already on
  `cost_codes.cost_type` and `budget_lines.cost_type`; `lib/cost-types.ts`
  exports `COST_TYPES`.
- `supabase/migrations/20260711230000_specifications_module.sql` — the freshest
  full-table exemplar for DDL style (checks, partial indexes, updated_at
  triggers). Copy its RLS/policy/trigger block style.
- `lib/services/cost-codes.ts` — cost-code CRUD, `unit`,
  `default_unit_cost_cents` fields (last-resort pricing fallback).
- `lib/services/drawings-pipeline.ts` header comment + `lib/services/drawings.ts`
  (`createDrawingSet`, `createDrawingRevision`) — re-uploads stack revisions onto
  ONE canonical sheet register per project.
- Workstream 01's output (read its doc + migrations when they exist):
  `communities`, `lots`, division scoping, `production` property_type, nav
  posture wiring, new RBAC roles (purchasing manager, starts coordinator, …).
- `lib/terminology.ts`, `components/layout/project-nav-items.ts`,
  `lib/financials/billing-model.ts` — posture choke points (verified present).

## Current-state audit (verified 2026-07-16)

- There is **no `budget_templates` table** and no budget-template service —
  grep `budget_template` returns nothing. Budgets are created blank
  (`createBudget`) or seeded from an estimate (`budget-from-estimate.ts` builds a
  reviewable draft; the client then calls `createBudget`/`replaceBudgetLines`).
- There are **no `house_plan*` tables** and no plan concepts anywhere.
- `schedule_templates.items` jsonb items carry NO date/offset fields today —
  `applyTemplate` creates undated items. Offset-to-start-date scheduling is new
  work in this doc (additive: new optional keys inside the jsonb items).
- `checklist_templates` exist (safety|quality) and instantiate per-inspection,
  not per-project; there is no "seed a project's inspection plan" bulk call yet.
- `selection_categories.is_template` exists (the selection template mechanism the
  master preserved for workstream 03); this doc only *references* template
  category ids in the bundle.
- The `app/(app)/` route map has no `plans/` directory — the URL `/plans` is
  free even though the DB name `plans` is taken (tables ≠ routes).
- RLS in the era this doc lands in must use `(select auth.uid())` /
  `is_org_member(org_id)` helper style (DB access performance pass, July 2026) —
  copy a July-2026 migration's policy block, NOT the 2026-05 remote-schema style.

## Data model

Naming honors master §4: **never `plans`** (taken by Stripe billing tables), and
`budget_templates` is neutral (no product/tier prefix). All money integer cents.
All tables org-scoped with RLS. Migrations are additive.

### Migration 1 — `<ts>_budget_templates.sql` (NEUTRAL — ships first, alone)

Relational, not jsonb. Justification: unlike `estimate_templates.lines` jsonb,
budget template lines carry FKs (`cost_code_id`) that must survive cost-code
renames/deactivation, need per-line joins for pricing and reporting, and are
edited as a dense grid exactly like `budget_lines`. `checklist_templates` +
`checklist_template_items` is the in-repo precedent for relational template
lines; follow it.

```sql
create table public.budget_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  division_id uuid references public.divisions(id),   -- null = org-wide (WS01 table)
  name text not null,
  description text,
  property_type text,          -- optional default-surfacing hint, mirrors schedule_templates
  is_active boolean not null default true,
  created_by uuid references public.app_users(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);

create table public.budget_template_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  budget_template_id uuid not null references public.budget_templates(id) on delete cascade,
  cost_code_id uuid references public.cost_codes(id),  -- null OK: cost-codes-off orgs
  cost_type public.cost_type,
  description text not null,
  -- Either a fixed amount OR a quantity basis (qty × unit cost). Enforced:
  amount_cents integer check (amount_cents is null or amount_cents >= 0),
  quantity numeric check (quantity is null or quantity >= 0),
  uom text,
  unit_cost_cents integer check (unit_cost_cents is null or unit_cost_cents >= 0),
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  constraint budget_template_line_basis check (
    amount_cents is not null or (quantity is not null and unit_cost_cents is not null)
  )
);

create index budget_templates_org_idx
  on public.budget_templates (org_id, is_active, name);
create index budget_template_lines_template_idx
  on public.budget_template_lines (org_id, budget_template_id, sort_order);
create index budget_template_lines_cost_code_idx
  on public.budget_template_lines (cost_code_id) where cost_code_id is not null;
```

If WS01's `divisions` table is not yet applied when this migration lands, omit
`division_id` here and add it in Migration 2 (keep migrations independently
applyable — check live schema first).

### Migration 2 — `<ts>_house_plans.sql`

```sql
create table public.house_plans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  division_id uuid references public.divisions(id),   -- null = org-wide
  code text not null,                                  -- short plan code, e.g. "1670"
  name text not null,                                  -- e.g. "The Magnolia"
  series text,                                         -- product series/collection
  status text not null default 'draft'
    check (status in ('draft','active','retired')),
  heated_sqft integer check (heated_sqft is null or heated_sqft > 0),
  total_sqft integer check (total_sqft is null or total_sqft > 0),
  beds numeric(3,1),
  baths numeric(3,1),
  stories numeric(2,1),
  garage_bays numeric(2,1),
  description text,
  cover_file_id uuid references public.files(id),      -- rendering/photo
  created_by uuid references public.app_users(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code)
);

create table public.house_plan_elevations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  house_plan_id uuid not null references public.house_plans(id) on delete cascade,
  code text not null,                                  -- 'A','B','C'
  name text,                                           -- 'Craftsman', 'Coastal'
  swing_applicable boolean not null default true,      -- can build left/right swing
  heated_sqft_delta integer not null default 0,
  is_active boolean not null default true,
  cover_file_id uuid references public.files(id),
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (house_plan_id, code)
);

create table public.house_plan_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  house_plan_id uuid not null references public.house_plans(id) on delete cascade,
  version_number integer not null,
  status text not null default 'draft'
    check (status in ('draft','released','superseded')),
  label text,                                          -- '2027 repricing', 'VE truss pkg'
  notes text,
  -- Template bundle: live REFS while draft…
  budget_template_id uuid references public.budget_templates(id),
  schedule_template_id uuid references public.schedule_templates(id),
  drawing_source_file_id uuid references public.files(id),  -- the plan-set PDF
  -- …and pinned SNAPSHOTS captured at release (see bundle decision):
  bundle_snapshot jsonb,                               -- null until released
  released_at timestamptz,
  released_by uuid references public.app_users(id),
  created_by uuid references public.app_users(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (house_plan_id, version_number)
);

-- Many-ref bundle members (checklists now; selection template categories for WS03):
create table public.house_plan_version_template_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  house_plan_version_id uuid not null
    references public.house_plan_versions(id) on delete cascade,
  kind text not null check (kind in ('checklist','selection_category')),
  template_id uuid not null,      -- checklist_templates.id | selection_categories.id
  sort_order integer not null default 0,
  unique (house_plan_version_id, kind, template_id)
);

create table public.house_plan_takeoff_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  house_plan_version_id uuid not null
    references public.house_plan_versions(id) on delete cascade,
  elevation_id uuid references public.house_plan_elevations(id),
    -- null = base-house line; non-null = DELTA applied when that elevation builds
  cost_code_id uuid not null references public.cost_codes(id),
  cost_type public.cost_type,
  description text not null,
  quantity numeric not null check (quantity >= 0),
  uom text not null,                                   -- 'sf','lf','ea','sq','ls',…
  unit_cost_cents integer check (unit_cost_cents is null or unit_cost_cents >= 0),
    -- manual fallback price; the price book (WS04) overrides when it matches
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.community_plan_availability (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  community_id uuid not null references public.communities(id) on delete cascade,
  house_plan_id uuid not null references public.house_plans(id) on delete cascade,
  elevation_id uuid references public.house_plan_elevations(id),
    -- null = applies to ALL elevations of the plan in this community
  is_available boolean not null default true,
  base_price_cents integer not null check (base_price_cents >= 0),
  effective_start date,
  effective_end date,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_start is null or effective_end is null
         or effective_end >= effective_start)
);
create unique index community_plan_availability_uniq
  on public.community_plan_availability
  (community_id, house_plan_id, coalesce(elevation_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Lot pinning (lots created by WS01; additive columns):
alter table public.lots
  add column if not exists house_plan_id uuid references public.house_plans(id),
  add column if not exists house_plan_version_id uuid references public.house_plan_versions(id),
  add column if not exists house_plan_elevation_id uuid references public.house_plan_elevations(id),
  add column if not exists swing text check (swing is null or swing in ('left','right'));
create index lots_plan_version_idx on public.lots (house_plan_version_id)
  where house_plan_version_id is not null;

-- Immutability guard: released/superseded version rows and their takeoff lines
-- reject UPDATE/DELETE except status transitions + bundle_snapshot write-once.
create or replace function public.tg_house_plan_version_immutable() ...
  -- trigger body: allow update when OLD.status='draft'; when OLD.status='released'
  -- allow ONLY status -> 'superseded' and released_at/released_by/bundle_snapshot
  -- being set from null; raise exception otherwise.
create or replace function public.tg_house_plan_takeoff_immutable() ...
  -- block insert/update/delete on takeoff lines whose version status <> 'draft'.
```

Indexes: `(org_id, status)` on `house_plans`; `(org_id, house_plan_id,
version_number desc)` on versions; `(org_id, house_plan_version_id, sort_order)`
and `(cost_code_id)` on takeoff lines; `(org_id, community_id, is_available)` on
availability. Standard `tg_set_updated_at` triggers on every table with
`updated_at` (repo convention — verified in `20260711021000_inspections.sql`).

**RLS (every table above, both migrations):** enable RLS; org-member policy in
the current initplan-safe style, copied from the latest applied migration:

```sql
alter table public.budget_templates enable row level security;
create policy budget_templates_access on public.budget_templates
  using ((select auth.role()) = 'service_role' or public.is_org_member(org_id))
  with check ((select auth.role()) = 'service_role' or public.is_org_member(org_id));
-- repeat per table; any direct auth.uid() reference MUST be (select auth.uid()).
```

### Design decision — bundle = refs while draft, snapshot at release

The bundle references live, org-editable templates (`budget_template_id`,
`schedule_template_id`, checklist links) while the version is `draft`, so plan
managers iterate without copy churn. At **release**, the service captures
`bundle_snapshot` jsonb: the full content of each referenced template at that
moment —
`{ budget_template: {name, lines:[…]}, schedule_template: {name, items:[…]},
checklists: [{id, name, kind, items:[…]}], selection_categories: [ids only],
drawing_source_file_id, captured_at }`.

Why both, not one: refs alone violate version immutability (editing
`schedule_templates.items` next year would silently change what a released 2026
plan version instantiates — exactly the drift master §5.3 forbids). Snapshots
alone would make draft editing miserable and duplicate the template editors.
**Instantiation of a released version reads ONLY `bundle_snapshot`**; the ref
columns remain for provenance/drift reporting ("template has changed since this
version was released"). Takeoff lines are relational (not in the snapshot)
because they are per-version rows already and get their own immutability trigger.
Selection categories snapshot ids only — WS03 owns option-catalog versioning.

### Price-book join contract (binds workstream 04)

Takeoff lines carry `(org_id, cost_code_id, uom, quantity)` and belong to a
`house_plan_version_id` whose plan is `house_plan_id`; instantiation runs in the
context of a `community_id`. WS04's `vendor_price_agreements` must therefore be
resolvable by `(org_id, cost_code_id [, house_plan_id] [, community_id],
as_of_date)` returning `{ vendor_id, unit_price_cents, uom }` with
most-specific-wins precedence (plan+community > plan > community > org-wide) and
uom equality REQUIRED for an automatic match (no unit conversion in v1 — a
mismatch surfaces as a pricing warning, never a silent guess).

## Service layer

Three new services, canonical shape (`requireOrgContext` → permission → logic →
`recordEvent` + `recordAudit` → mapped DTO). No `any`, DTO mappers defensive like
`estimate-templates.ts`.

### `lib/services/budget-templates.ts` (neutral — usable by every tier)

```ts
export type BudgetTemplateLineDto = {
  id: string; cost_code_id: string | null; cost_code_label: string | null;
  cost_type: CostType | null; description: string;
  amount_cents: number | null; quantity: number | null; uom: string | null;
  unit_cost_cents: number | null; sort_order: number;
}
export type BudgetTemplateDto = {
  id: string; name: string; description: string | null;
  division_id: string | null; property_type: string | null; is_active: boolean;
  line_count: number; total_cents: number;   // Σ resolved line amounts
  lines?: BudgetTemplateLineDto[];           // detail only
  created_at: string | null; updated_at: string | null;
}

listBudgetTemplates(opts?: { includeInactive?: boolean }, orgId?): Promise<BudgetTemplateDto[]>
getBudgetTemplate(id, orgId?): Promise<BudgetTemplateDto>          // with lines
createBudgetTemplate(input: BudgetTemplateInput, orgId?): Promise<BudgetTemplateDto>
updateBudgetTemplate(id, input, orgId?): Promise<BudgetTemplateDto> // replaces lines
archiveBudgetTemplate(id, orgId?): Promise<void>                    // is_active=false
createBudgetTemplateFromProjectBudget(projectId, { name }, orgId?)  // reverse seed
buildBudgetDraftFromTemplate({ projectId, templateId, costCodesEnabled, orgId? })
  : Promise<BudgetDraftFromTemplate>   // ProposedBudgetLine[] — SAME shape as
                                       // budget-from-estimate so the existing
                                       // review UI renders it unchanged
```

Line resolution: `amount_cents ?? round(quantity × unit_cost_cents)`. Cost-codes-
off orgs (memory: budget lines are the buckets): lines keep `cost_code_id` null
and stand alone — mirror `budget-from-estimate.ts`'s `costCodesEnabled` branch
exactly. Permission: `budget.write` for mutations, `budget.read` for list (reuse
existing keys — templates are budget furniture, no new key).

**Wire-in (this is the neutral payoff):** the budget creation flow that today
offers "start blank / start from estimate" (project budget tab —
`app/(app)/projects/[id]/financials/`, budget tab components; grep
`listBudgetEstimateSources` for the entry point) gains "Start from template"
using `buildBudgetDraftFromTemplate` → existing draft-review → `createBudget`.
Also add "Save as template" on an existing project budget
(`createBudgetTemplateFromProjectBudget`). No new mutation home: templates are
managed at org Settings (see UI spec), applied from the project workbench.

### `lib/services/house-plans.ts`

```ts
export type HousePlanDto = { id; code; name; series; status; division_id;
  heated_sqft; total_sqft; beds; baths; stories; garage_bays;
  elevation_count: number; current_released_version: number | null;
  active_lot_count: number; … }
export type HousePlanVersionDto = { id; version_number; status; label; notes;
  budget_template_id; schedule_template_id; drawing_source_file_id;
  checklist_template_ids: string[]; selection_category_ids: string[];
  has_snapshot: boolean; released_at; released_by; takeoff_line_count;
  takeoff_total_cents_manual: number;  // Σ qty×unit_cost_cents fallback pricing
  pinned_lot_count: number; }
export type TakeoffLineDto = { id; elevation_id; cost_code_id; cost_code_label;
  cost_type; description; quantity; uom; unit_cost_cents; sort_order }

listHousePlans(filters?: { status?, divisionId?, communityId? }, orgId?)
getHousePlan(id, orgId?)                         // + elevations + versions
createHousePlan(input, orgId?)                   // creates plan + version 1 draft
updateHousePlan(id, input, orgId?)               // catalog attrs; status guard:
                                                 // 'active' requires ≥1 released version
upsertElevation(planId, input, orgId?)
listPlanVersions(planId, orgId?)
createPlanVersion(planId, { copyFromVersionId }, orgId?)
  // next version_number; deep-copies takeoff lines + template links + refs from
  // the source version; status draft
updatePlanVersion(versionId, input, orgId?)      // draft only (trigger enforces too)
replaceTakeoffLines(versionId, lines: TakeoffLineInput[], orgId?)
  // grid semantics like replaceBudgetLines; draft-only
releasePlanVersion(versionId, orgId?)
  // validates: ≥1 takeoff line or budget_template_id set; schedule_template_id
  // set; captures bundle_snapshot; status released; supersedes the previously
  // released version (its status -> 'superseded'); event house_plan_version.released
setCommunityAvailability(entries: AvailabilityInput[], orgId?)   // bulk matrix save
listCommunityAvailability({ communityId? | housePlanId? }, orgId?)
getPlanVersionDrift(planId, orgId?)
  // per released-but-superseded version: pinned_lot_count (lots.house_plan_version_id),
  // takeoff line diff vs current released version (added/removed/qty-changed by
  // cost code), manual-price delta cents. Report-only — drift never auto-applies.
```

Permissions: new keys `plan.read`, `plan.write`, `plan.release` (release is the
control point — separate key so a designer can edit drafts but not release).

### `lib/services/plan-instantiation.ts` — the engine (contract binds WS05)

```ts
export type PriceResolver = (line: {
  costCodeId: string; uom: string; housePlanId: string;
  communityId: string | null; asOfDate: string;
}) => Promise<{ unitPriceCents: number; vendorId: string | null;
                source: "price_agreement" | "takeoff_manual" | "cost_code_default" } | null>

export type InstantiatePlanInput = {
  projectId: string                    // the lot's project — must already exist
  lotId: string
  housePlanVersionId: string           // MUST be status='released'
  elevationId?: string | null
  swing?: "left" | "right" | null
  communityId?: string | null          // pricing + availability context
  startDate: string                    // ISO date the schedule offsets from
  optionSelectionIds?: string[]        // reserved for WS03; ignored in v1
  steps?: Array<"budget" | "schedule" | "checklists" | "drawings">  // default all
  priceResolver?: PriceResolver        // WS04 injects; default = manual fallback
  dryRun?: boolean                     // compute + return, write nothing
}

export type InstantiatePlanResult = {
  success: boolean
  budget?: { budget_id: string; total_cents: number; line_count: number;
             pricing: Array<{ cost_code_id: string; source: string }> }
  schedule?: { item_ids: string[]; start_date: string; end_date: string }
  checklists?: { inspection_ids: string[] }
  drawings?: { drawing_set_id: string; queued: boolean }
  warnings: string[]     // e.g. "3 takeoff lines had no price source — priced at 0"
  errors: string[]       // per-step failures; a failed step never blocks others
}

export async function instantiatePlanForProject(
  input: InstantiatePlanInput, orgId?: string,
): Promise<InstantiatePlanResult>
```

Contract rules (WS05 builds against these — do not weaken):

1. **Released versions only.** Draft/superseded → error (dry-run of a draft is
   allowed for the plan editor's preview).
2. **Reads the snapshot.** All template content comes from `bundle_snapshot`,
   never live template tables.
3. **Idempotent per step.** Each step marks the project
   (`projects.metadata.plan_instantiation = { version_id, steps: {...}, at }`);
   re-running skips completed steps unless `steps` explicitly re-requests, and a
   re-requested completed step fails with a clear error rather than duplicating
   artifacts. WS05's outbox retries rely on this.
4. **Composable + partial.** `steps` lets WS05 sequence/retry independently;
   each step is also exported (`generatePlanBudget`, `applyPlanSchedule`,
   `seedPlanChecklists`, `queuePlanDrawings`) for granular orchestration.
5. **Never throws for step failures** — collects into `errors` and returns; the
   caller (WS05 gate UI) decides. Throw only for contract violations (bad ids,
   cross-org, unreleased version).
6. **Pins the lot**: sets `lots.house_plan_id/…_version_id/…_elevation_id/swing`
   in the same call (validated against `community_plan_availability` when
   `communityId` given — unavailable plan/elevation = warning, not block; sales
   holds the availability line, ops may override).

Step semantics:

- **Budget** — **single-writer note (WS04/WS05 contract):** this step is the
  derived-budget writer ONLY when purchasing is not enabled (no active price
  book — WS04's `isPurchasingEnabled`). When purchasing IS enabled, WS05's
  release orchestration skips this step and WS04's PO generation writes the
  budget from the same takeoff + price book in its commit transaction
  (master §5.4). Source precedence here: takeoff lines (base + matching
  elevation deltas) priced per line via `priceResolver` → fallback
  `takeoff.unit_cost_cents` → fallback `cost_codes.default_unit_cost_cents` →
  0 + warning. If the version has NO takeoff lines but a budget-template
  snapshot, resolve the snapshot's lines instead. Group to one budget line per
  cost code (cost-codes-off orgs: one budget line per takeoff line), carry
  `cost_type`, write via `createBudget` (status `active`), record pricing
  provenance per line in `budget_lines.metadata.pricing_source`.
- **Schedule** — the snapshot's schedule-template items, extended item shape
  (additive jsonb keys on `schedule_templates.items`, editable in the existing
  template editor): `start_offset_days?: number`, `duration_days?: number`.
  Instantiation sets `start/end` dates = `startDate + offset` (calendar days
  v1; workday calendars are an open question). Items without offsets fall back
  to today's undated `applyTemplate` behavior. Implement as a new
  `applyScheduleTemplateSnapshot(projectId, items, startDate)` in
  `schedule.ts` and refactor `applyTemplate` to share it (leave-no-trash: one
  instantiation path).
- **Checklists** — for each checklist in the snapshot, create a draft
  inspection on the project from the snapshotted items (mirror
  `inspections.ts`'s create-from-template path; do not re-read
  `checklist_templates`).
- **Drawings** — see next section; queues the pipeline, returns
  `queued: true` (async completion).

Permission: instantiation runs under `plan.instantiate` (new key) — WS05's
start-release approver holds it; also emitted event `plan.instantiated` with
payload `{ project_id, lot_id, house_plan_version_id, steps }`.

### Plan drawings → the lot project (one-canonical-set rule)

`drawing_sets.project_id` is NOT NULL (verified) and the drawings doctrine is
ONE canonical sheet register per project with re-uploads stacking revisions.
Therefore the plan library does NOT own drawing_sets: a plan version owns its
**plan-set PDF as a file** (`drawing_source_file_id`, uploaded via the existing
files service in the plan editor). `queuePlanDrawings`:

1. Finds or creates the lot project's canonical drawing set (exactly the
   re-upload path in `lib/services/drawings.ts` — never a new set per plan).
2. Creates a drawing revision sourced from the plan version's PDF (copy the
   storage object into the project's drawings storage path — pipeline storage is
   project-scoped) and triggers `drawings-pipeline` processing.
3. Later plan-version changes on the SAME lot (rare; e.g. re-pin after a VE
   bump) upload as a new revision — old sheets are never deleted, versions stack.

Cost note: each lot re-processes the same PDF (~30 pages, async, off the
critical path — WS05 runs this via outbox). Cross-project tile dedupe is a
deliberate non-goal v1 (open question).

## Actions + validation

- `lib/validation/house-plans.ts` + `lib/validation/budget-templates.ts` — Zod:
  cents `z.number().int().min(0)`, `quantity` ≥ 0, uom trimmed non-empty,
  elevation code `/^[A-Z][A-Z0-9]?$/`, dates ISO, `cost_type`
  `z.enum(COST_TYPES)`.
- Actions in `app/(app)/plans/actions.ts` (plan library) and budget-template
  actions co-located with the org-settings page that hosts them. Thin: parse →
  service → `ActionResult` (`lib/action-result.ts`, `unwrapAction()` client-side
  — the invoices pattern; never throw user-visible errors).
- The project-side "start budget from template" action lives with the existing
  budget actions in the project financials area (one home per mutation:
  applying a template to a project is a project-workbench mutation; editing the
  template is an org mutation).

## UI spec

**Plan Library — org area, route `app/(app)/plans`** (URL free — verified; only
the DB name `plans` is taken). Nav: org sidebar entry "Plans" for
production-TIER orgs via `getOrgProductTier()` gating in the org nav config
(same mechanism WS01 uses for Communities — never inline tier checks). Mixed
orgs with any production project also get it. It passes the desk test: a plan
manager/purchasing manager's whole job is the plan library across communities.
This page is a **workbench for plans** (plans are org-level entities — their
mutations live here), not a project desk.

- **Index** — dense table (NO cards): Code, Name, Series, Sq Ft, Beds/Baths/
  Stories/Garage, Elevations, Released version, Active lots, Communities,
  Status. Filters: status, series, division, community. Row → detail. Cap/
  paginate at 100 (repo rule; 200-plan libraries are the design case).
- **Plan detail** — header row (code, name, status action), then tabs:
  - **Versions**: table (version, status, label, released date/by, pinned lots,
    takeoff total) + "New version" (copy-from picker). Draft rows open the
    editor; released rows are read-only with a drift indicator when a newer
    released version exists.
  - **Takeoff** (per draft version): inline-editable grid exactly matching the
    budget Detailed table's density (exemplar: budget tab inline edit) —
    cost code, cost type, description, qty, uom, manual unit cost, line total;
    elevation-delta rows grouped under an elevation header; footer totals per
    elevation. Bulk paste-from-CSV (textarea import, deterministic parse).
  - **Elevations**: table with code/name/swing/sqft-delta/active.
  - **Bundle** (per version): the five refs as labeled selects (budget template,
    schedule template, checklists multi, selection categories multi read-only
    until WS03, plan-set PDF upload). Released versions render the snapshot
    summary (captured names + line/item counts + captured_at) instead of
    selects.
  - **Availability**: matrix — rows = communities (from WS01), columns =
    elevations + "All", cells = available toggle + base price (tabular-nums,
    integer cents rendered as $), effective dates in a cell popover. Bulk save
    via `setCommunityAvailability`.
- **Release** — confirm dialog listing what will be snapshotted + validation
  failures; irreversible copy states "lots started on this version keep it
  forever."
- **Budget templates UI** — org Settings area next to estimate templates
  (grep where `estimate_templates` management lives and sit beside it): list +
  editor with the same relational line grid (cost code, cost type, description,
  amount OR qty×unit-cost). Project side: "Start from template" option added to
  the existing budget-seed chooser, reusing the budget-from-estimate review
  screen unchanged.
- Every view: empty state (e.g. "No plans yet — create your first plan or
  import from CSV"), loading, error, dark mode; tokens only, radius 0, no
  heroes; density matches org siblings (e.g. `/estimates`).

## RBAC, events, search, notifications

- **RBAC catalog seed** (catalog-as-code — `20260708120500_rbac_catalog_seed.sql`
  pattern; new migration extends it): keys `plan.read`, `plan.write`,
  `plan.release`, `plan.instantiate`. Mapping: read → all office roles +
  estimator + purchasing manager + starts coordinator; write → org_owner,
  org_admin, org_office_admin, estimator, purchasing manager; release →
  org_owner, org_admin, purchasing manager; instantiate → org_owner, org_admin,
  starts coordinator (WS01 creates the new roles; if 01 hasn't landed them,
  seed keys onto existing roles and note the follow-up). Budget templates reuse
  `budget.read`/`budget.write`. Also add keys to `TEAM_PERMISSION_OPTIONS`
  (`lib/services/team.ts`). State the final mapping in the completion note.
- **Events**: `house_plan.created`, `house_plan.updated`,
  `house_plan_version.released`, `house_plan_version.superseded`,
  `budget_template.created/updated/archived`, `community_plan_availability.updated`,
  `plan.instantiated`. Audit on every mutation (`recordAudit` entity types
  `house_plan`, `house_plan_version`, `budget_template`).
- **Search index**: register `house_plan` (title = code + name, subtitle =
  series/status) and `budget_template` in `lib/services/search-index.ts`'s
  entity map — same workstream, or they're invisible to global search.
- **Notifications**: none of these email (no `EMAIL_NOTIFICATION_TYPES`
  additions). In-app only if any at all.
- No cron routes, no `proxy.ts` changes in this workstream.

## Migration plan

1. `<ts>_budget_templates.sql` — Migration 1 (+ RLS + triggers). Standalone and
   tier-neutral; can ship before anything else in this doc.
2. `<ts>_house_plans.sql` — Migration 2 (+ RLS + triggers + immutability
   trigger functions). Requires WS01's `divisions`, `communities`, `lots` in
   prod — verify with `list_tables` first; if absent, STOP and coordinate.
3. `<ts>_plan_rbac_catalog.sql` — RBAC catalog seed extension for the four
   `plan.*` keys.

All additive; no destructive statements. Write files to `supabase/migrations/`,
then STOP for human approval before assuming tables exist (local env is
PRODUCTION). Continue writing services/UI against the planned schema while
pending, and say so.

## Phases (each ends `pnpm lint` clean)

**Phase 1 — Budget templates (neutral slice).**
Migration 1 + `budget-templates.ts` + validation + org-settings UI +
"Start from template" and "Save as template" wiring in the project budget flow.
*Accept:* create a 20-line template (mixed amount & qty basis); seed a
residential project's budget from it — draft review shows resolved amounts;
`createBudget` totals match Σ resolved lines; cost-codes-off org gets
one-line-per-template-line; save-as-template round-trips a project budget.

**Phase 2 — Plan catalog.**
Migration 2 + `house-plans.ts` CRUD (plans, elevations, versions, takeoff
grid) + `/plans` index + detail (Versions/Takeoff/Elevations tabs) + RBAC
migration + search registration.
*Accept:* create plan 1670 "Magnolia" with elevations A/B/C (B swing-off);
enter a 30-line base takeoff + 4-line elevation-C delta; totals foot; a user
without `plan.write` gets read-only; plan searchable from the command bar.

**Phase 3 — Bundles + release + availability.**
Bundle tab, `releasePlanVersion` snapshotting, immutability (trigger + service),
supersede flow, availability matrix, `getPlanVersionDrift`.
*Accept:* attach budget template + schedule template + 2 checklists + plan PDF;
release v1 → `bundle_snapshot` populated; edits to v1 takeoff/refs rejected at
BOTH service and DB layer; edit the schedule template afterward → drift
indicator on v1, snapshot unchanged; create v2 (copy from v1), change qty,
release → v1 superseded; availability matrix saves per-community base prices
with effective dates.

**Phase 4 — Instantiation engine.**
`plan-instantiation.ts` all four steps + `applyScheduleTemplateSnapshot`
refactor + schedule-template editor gains offset/duration fields + drawings
queue path. Dev-only trigger: an "Instantiate plan" action on a
production-posture project's settings (WS05 replaces this with start-release;
delete the dev trigger there — note as follow-up).
*Accept:* on a QA-org lot+project, instantiate v2 elevation C, startDate two
Mondays out → budget generated via `createBudget` with per-line pricing
provenance (manual fallback), grouped per cost code, elevation delta included;
schedule items dated `startDate + offset`; two draft inspections exist; the
canonical drawing set (created if absent) processes the plan PDF into sheets;
lot pinned to v2/C; re-running is a no-op with warnings; `dryRun` writes
nothing; step-level failure (e.g. missing PDF) reports in `errors` while other
steps complete.

## Test plan

- **`pnpm test:financials` gate applies** — this workstream generates budgets
  (financial math). Add pure functions in `lib/financials/plan-pricing.ts`:
  takeoff line resolution (qty × unit price, rounding), elevation-delta merge,
  cost-code grouping, template line basis resolution
  (`amount ?? qty × unit_cost`), price-source precedence. Unit-test them in
  `tests/plan-pricing.test.js` (node-test style, wired into `test:financials`,
  like `tests/pay-app-math.test.js`).
- Rounding rule: `Math.round(quantity * unit_cost_cents)` per line, sum after
  rounding (matches estimate math); assert Σ(rounded lines) is what lands in
  `budgets.total_cents`.
- Drift diff logic unit-tested (added/removed/changed classification).
- Manual QA runs in the **dedicated internal QA org only** (no staging; local
  env is production).
- Regression: existing budget-from-estimate flow and `applyTemplate` (undated
  path) unchanged — run one of each in the QA org after Phase 1/4 refactors.

## Open questions

1. **Workday vs calendar offsets** — v1 offsets are calendar days; production
   schedules usually run workdays with holiday calendars. Decide with WS05
   (which owns even-flow calendars); the jsonb item shape can add
   `offset_basis: "workdays"` additively.
2. **Tile/processing dedupe for plan drawings** — 100 lots reprocess the same
   PDF. Acceptable async cost v1; revisit content-hash reuse of rendered
   sheets/tiles if pipeline cost bites.
3. **Elevation-specific drawing pages** — v1 processes the full plan set per
   lot regardless of elevation. Per-elevation page filtering needs page-range
   metadata on the version (defer until a customer asks).
4. **Swing** — stored on the lot (`left|right`); no takeoff/pricing effect v1.
   Confirm with WS04 whether any trades price by swing (rare).
5. **`house_plans.division_id` semantics** — currently a scoping hint (filters
   desks); should a division-scoped plan be *blocked* from availability in
   another division's community? v1: warn, don't block.
6. **Base-price change orders** — availability rows change over time
   (effective dates); the sales price a buyer locked lives on the contract
   (WS06). Confirm WS06 snapshots price at agreement, reading availability
   only at quote time.
