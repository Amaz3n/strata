# Workstream 03 — Option Catalog & Design Studio

> **STATUS: NOT STARTED.**

> **Audience:** an LLM executing agent. Prereqs: `00-MASTER-production-expansion.md`
> (fully — especially §3 "Selections are the seed", §5.8 "Enforcement is the product",
> and §4 naming collisions), workstream 01 (divisions/communities/lots exist), and
> workstream 02 (`house_plans` / `house_plan_versions` and the plan instantiation
> engine exist). Workstream 04 (purchasing) consumes this doc's pricing join shape —
> do not change it without updating 04. Repo rules: `CLAUDE.md` at root is
> authoritative (services own logic, org_id scoping, integer cents, ActionResult
> returns, tokens-only design, dense editorial UI, additive migrations only).

## Mission

Lift Arc's per-project Selections feature into a production-builder **option
catalog**: org-level (with community overrides) categories, options, packages, and
plan-applicable pricing (price AND cost); **structural vs design-studio option
scopes**; **selection groups whose cutoffs derive from the lot's schedule** (never
hand-typed dates as the primary mechanism); **hard server-side enforcement** — past
cutoff the ONLY path to change a selection is a fee-bearing change order that flows to
the lot's `change_orders` and signals purchasing (workstream 04) as a variance; a
**design-studio appointment** workflow with a coordinator desk; and a **buyer portal**
selection flow. All of it is **additive**: existing residential per-project selections
keep working exactly as they do today.

Why this is the product: option revenue is 10–20% of a production home's price and
design-studio margin is the best margin in the house. The industry norm is cutoff
discipline collapsing under sales pressure ("just this once") — every late change
ripples into purchasing (wrong PO), the field (wrong material on site), and margin
(unbilled work). Arc holds the line structurally: the cutoff comes from the schedule,
the block is server-side, and the escape hatch (fee-bearing CO) is itself revenue and
a purchasing signal. Per master §9: post-cutoff = refusal or fixed CO fees ($250–500
typical).

## Current-state audit (verified against code + live schema, 2026-07-16)

**Tables** (DDL in `supabase/migrations/20260517092101_remote_schema.sql`):

- `selection_categories` — org-scoped: `name`, `description`, `sort_order`,
  `is_template boolean` (exists in DDL; unused by the service layer today). No
  project or community scoping — categories are already org-global. This is the
  catalog seed.
- `selection_options` — `category_id`, `name`, `description`, `price_cents`,
  `price_type` check `('included','upgrade','downgrade')`, `price_delta_cents`,
  `image_url`, `file_id`, `sku`, `vendor`, `lead_time_days`, `sort_order`,
  `is_default`, `is_available`. Single flat price; **no cost side, no plan or
  community dimension, no cost code**.
- `project_selections` — `unique(project_id, category_id)`; `status` check
  `('pending','selected','confirmed','ordered','received')`; `due_date date`
  (**manually entered, display-only — nothing enforces it**); `selected_at`,
  `confirmed_at`, `selected_by_user_id`, `selected_by_contact_id`, `notes`,
  `metadata jsonb` (holds e-sign approval evidence: `approved_via_envelope`,
  `approved_envelope_id`, signer fields).
- `allowances` — links `contract_id` + `selection_category`; `budget_cents`,
  `used_cents`, `overage_handling` check `('co','client_direct','absorb')`. Consumed
  by `lib/services/cost-plus.ts` (~L497+) which posts `allowance_overage` cost-ledger
  rows. Residential-only bookkeeping; unchanged by this workstream, but the
  overage→CO pattern is the precedent for post-cutoff CO generation.

**Service** — `lib/services/selections.ts` (241 lines):

- `listSelectionCategories` / `listSelectionOptions` — service-role client, org-scoped
  reads, **no permission check** (they serve both app and portal paths).
- `listProjectSelections(orgId?, projectId?)` — `requireOrgContext`, ordered by
  due_date.
- `selectProjectOption` — service-role update to `selected`/`selected_at`/
  `selected_by_contact_id`. **No permission check, no events/audit, and no gating of
  any kind** — the portal can flip a selection at any time while status permits.
- `createProjectSelection` — org context, insert, `recordEvent('selection_created')`
  + `recordAudit`. **No `requirePermission` call** (predates the RBAC sweep — the
  RBAC catalog seed `20260708120500_rbac_catalog_seed.sql` has **no selection
  permissions at all**; this workstream adds them).
- `confirmSelectionFromEnvelopeExecution` — idempotent e-sign confirmation: stamps
  metadata evidence, transitions to `confirmed`, attaches the executed file via
  `attachFileWithServiceRole`, emits `selection_confirmed`.

**Validation** — `lib/validation/selections.ts`: one schema (`selectionInputSchema`:
project_id, category_id, status, due_date, notes ≤1000).

**UI:**

- `app/(app)/selections/page.tsx` **redirects to `/projects`** (desk-rule cleanup —
  there is currently no org selections surface). `app/(app)/selections/actions.ts`
  still exports `loadSelectionsBuilderAction` / `createSelectionAction` (ActionResult
  pattern) used by the project workbench.
- `components/selections/selections-client.tsx` (393 lines,
  `SelectionsBuilderClient`) — builder-side list with project filter, status badges,
  e-sign `EnvelopeWizard` launch, `EntityAttachments`. `selection-form.tsx` (256
  lines) — create form. **Card-based; predates the dense-table design language.**
- Portal: `app/p/[token]/selections/` — `assertPortalActionAccess(token,
  {portalType:'client', permission:'can_submit_selections'})`; `loadSelectionsAction`
  returns selections + categories + optionsByCategory; `selectOptionAction` calls
  `selectProjectOption`. `selections-client.tsx` (165 lines) renders category cards
  with option buttons and `+$X / -$X / Included` price labels via
  `price_delta_cents ?? price_cents`.

**Adjacent systems this doc builds on:**

- `lib/services/change-orders.ts` — `createChangeOrder` (L571): Zod'd lines,
  `calculateTotals`, lifecycle `draft→pricing→proposed→approved` (commercial 03),
  `requireAuthorization('change_order.write')`, metadata carries lines/totals.
  Post-cutoff selection COs ride this exact path.
- `lib/services/schedule.ts` — `schedule_templates` are org rows with `items jsonb`
  (name/item_type/phase/trade/sort_order — **no stable per-item key**);
  `applyTemplate` (L1085) instantiates `schedule_items` copying only
  name/type/phase/trade/hours/color/sort_order — **no back-reference to the template
  item survives instantiation**. `updateScheduleItem` (L371) and
  `bulkUpdateScheduleItems` (L589) are the date-mutation choke points cutoff
  recompute must hook.
- Workstream 02 gives us `house_plan_versions` (immutable once released) and the
  start-release instantiation engine — selection group instantiation and cutoff
  seeding plug into it.

**Gap summary:** no cost side, no plan/community pricing dimension, no packages, no
groups, no cutoff derivation, no enforcement of any kind, no appointments, no
selection RBAC, portal is category-flat. Everything below is additive on this seed.

## Data model

One migration: `supabase/migrations/<ts>_option_catalog_design_studio.sql`. All
tables org-scoped with RLS (`(SELECT auth.uid())` initplan pattern, mirroring the
policies on `selection_categories`). All money integer cents.

### 1. Evolve `selection_categories` (columns, not a new table)

```sql
alter table public.selection_categories
  add column if not exists community_id uuid references public.communities(id) on delete cascade,
  add column if not exists parent_category_id uuid references public.selection_categories(id) on delete cascade,
  add column if not exists image_url text,
  add column if not exists is_archived boolean not null default false;
create index if not exists selection_categories_community_idx
  on public.selection_categories (community_id) where community_id is not null;
```

- `community_id null` = org-catalog category (and every existing residential row —
  untouched). `community_id set` + `parent_category_id set` = a **community override**
  of an org category (rename/reorder/hide per community). `community_id set` +
  `parent_category_id null` = community-only category.
- Justification for columns-over-new-table: master §3 mandates evolving these tables;
  a parallel `catalog_categories` table would fork every consumer (portal, e-sign,
  allowances) for zero benefit. Resolution ("effective catalog for community X") is a
  service-layer merge, not a schema concern.
- `is_template` (existing, unused) is **retired**: nothing writes it today; the
  migration leaves the column (additive rule) and the doc's cleanup phase notes it
  for a later drop. Do not build on it.

### 2. Evolve `selection_options`

```sql
alter table public.selection_options
  add column if not exists option_scope text not null default 'design_studio'
    check (option_scope in ('structural','design_studio')),
  add column if not exists community_id uuid references public.communities(id) on delete cascade,
  add column if not exists parent_option_id uuid references public.selection_options(id) on delete cascade,
  add column if not exists cost_cents integer,
  add column if not exists cost_code_id uuid references public.cost_codes(id),
  add column if not exists is_archived boolean not null default false;
create index if not exists selection_options_community_idx
  on public.selection_options (community_id) where community_id is not null;
create index if not exists selection_options_parent_idx
  on public.selection_options (parent_option_id) where parent_option_id is not null;
```

- `option_scope`:
  - **`structural`** — changes the building (elevation-dependent items, garage
    extensions, bonus rooms, covered lanais, gas lines). Locked at **purchase
    agreement signing** (contract execution), affects POs, permits, and the schedule.
  - **`design_studio`** — finish-level (flooring, cabinets, counters, fixtures).
    Lockable until the owning **selection group's cutoff**.
  - Default `design_studio` keeps every existing residential option semantically
    unchanged (residential has no purchase-agreement lock trigger and no groups, so
    the default is inert there).
- `cost_cents` — builder cost, **never serialized to portal DTOs** (margin is
  builder-side only; same discipline as `internal_cost_cents` on CO lines and
  `financials.margin.read` from the RBAC overhaul).
- `cost_code_id` — required for catalog options that generate POs/budget lines
  (workstream 04 join); nullable so residential options are unaffected.
- Overrides mirror categories: `parent_option_id` + `community_id` = community
  variant (price/cost/availability differ per community); base fields fall back to
  the parent when null.

### 3. Plan-applicability pricing — new table `selection_catalog_prices`

```sql
create table public.selection_catalog_prices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  option_id uuid references public.selection_options(id) on delete cascade,
  package_id uuid references public.selection_packages(id) on delete cascade,
  house_plan_version_id uuid not null references public.house_plan_versions(id) on delete cascade,
  community_id uuid references public.communities(id) on delete cascade,
  price_cents integer not null,
  cost_cents integer,
  is_available boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint one_subject check (num_nonnulls(option_id, package_id) = 1)
);
create unique index selection_catalog_prices_option_key
  on public.selection_catalog_prices (option_id, house_plan_version_id, coalesce(community_id, '00000000-0000-0000-0000-000000000000'))
  where option_id is not null;
create unique index selection_catalog_prices_package_key
  on public.selection_catalog_prices (package_id, house_plan_version_id, coalesce(community_id, '00000000-0000-0000-0000-000000000000'))
  where package_id is not null;
create index selection_catalog_prices_org_idx on public.selection_catalog_prices (org_id);
create index selection_catalog_prices_plan_idx on public.selection_catalog_prices (house_plan_version_id);
```

- **Resolution precedence** (most specific wins):
  1. `(option, plan_version, community)` row
  2. `(option, plan_version, null community)` row
  3. option's own `price_cents` / `cost_cents` (community override option first,
     then org option) — the "any plan" base price.
  A row with `is_available=false` means "this option does not exist for this plan"
  (e.g., a fireplace option a plan can't take) — plan applicability and pricing are
  the same table.
- Justification for a separate table (vs columns): pricing is genuinely
  N-dimensional (option × plan version × community); jamming it into options rows
  would force option duplication per plan, breaking the single-catalog premise.
- **This join is workstream 04's contract.** Auto-PO generation at start release
  resolves each confirmed selection to `{cost_cents, cost_code_id, vendor, sku,
  lead_time_days}` via `resolveOptionPricing` (below) + option fields. 04 must call
  the service function, never re-derive precedence in SQL.
- Plan versions are immutable (master §5.3): re-pricing a plan means new
  `house_plan_version` rows and new price rows; in-flight lots keep their pinned
  version's prices. Snapshots on confirm (below) make this airtight.

### 4. Packages — new tables `selection_packages`, `selection_package_items`

```sql
create table public.selection_packages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  community_id uuid references public.communities(id) on delete cascade,
  name text not null,
  description text,
  image_url text,
  price_cents integer not null,          -- package price (usually < sum of parts)
  cost_cents integer,
  is_available boolean not null default true,
  is_archived boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.selection_package_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  package_id uuid not null references public.selection_packages(id) on delete cascade,
  option_id uuid not null references public.selection_options(id) on delete cascade,
  unique (package_id, option_id)
);
```

- A package (e.g., "Coastal Kitchen — Level 2") bundles one option from each of
  several categories at a bundle price. Choosing a package writes the member option
  into each covered `project_selections` row and stamps `package_id` (below); the
  package price replaces the sum of member prices in totals (allocation: first
  member line carries the package price, other members price at 0 with
  `metadata.package_allocated=true` — keeps per-category rows honest and totals
  exact in integer cents).
- Plan-specific package pricing rides `selection_catalog_prices.package_id`.
- A package is all-or-nothing at selection time; unbundling later = clearing
  `package_id` and repricing members individually (pre-cutoff only).

### 5. Selection groups + per-lot instances — new tables

```sql
create table public.selection_groups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  community_id uuid references public.communities(id) on delete cascade,  -- null = org default set
  name text not null,                          -- "Structural", "Flooring & Tile", "Electrical Walk"
  sort_order integer not null default 0,
  schedule_task_key text not null,             -- stable key of a schedule-template item (see Cutoff engine)
  cutoff_offset_days integer not null default 0,  -- negative = N days BEFORE the anchor
  cutoff_anchor text not null default 'start'
    check (cutoff_anchor in ('start','end')),  -- anchor to task start_date or end_date
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.selection_group_categories (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  group_id uuid not null references public.selection_groups(id) on delete cascade,
  category_id uuid not null references public.selection_categories(id) on delete cascade,
  unique (group_id, category_id)
);
create table public.project_selection_groups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  group_id uuid not null references public.selection_groups(id) on delete cascade,
  cutoff_date date,                            -- COMPUTED; null until the lot has a schedule
  cutoff_source text not null default 'schedule'
    check (cutoff_source in ('schedule','manual_override')),
  override_reason text,
  overridden_by uuid,                          -- app_users id
  status text not null default 'open'
    check (status in ('open','locked')),
  locked_at timestamptz,
  matched_schedule_item_id uuid references public.schedule_items(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, group_id)
);
create index project_selection_groups_project_idx on public.project_selection_groups (project_id);
create index project_selection_groups_cutoff_idx on public.project_selection_groups (org_id, cutoff_date) where status = 'open';
```

- `selection_groups` is **configuration** (per community, with an org-level default
  set clonable into new communities). `project_selection_groups` is the **per-lot
  instance** holding the computed cutoff — the row enforcement reads. NEVER a
  manually entered date as the primary mechanism: `cutoff_date` is written only by
  the derivation engine or by an audited manual override.
- The "Structural" group is conventional, not special-cased: structural options lock
  at purchase-agreement signing regardless of any group cutoff (enforcement §), so a
  structural group's cutoff is a secondary backstop for unsold specs.

### 6. Evolve `project_selections`

```sql
alter table public.project_selections
  add column if not exists group_id uuid references public.selection_groups(id),
  add column if not exists package_id uuid references public.selection_packages(id),
  add column if not exists price_cents_snapshot integer,
  add column if not exists cost_cents_snapshot integer,
  add column if not exists locked_at timestamptz,
  add column if not exists source_change_order_id uuid references public.change_orders(id);
```

- Snapshots are stamped at **confirm** time from `resolveOptionPricing` — the
  contract price is what the buyer confirmed, immune to later catalog edits.
  Residential rows: snapshots stay null; existing price display paths unchanged.
- `locked_at` — set when the owning group locks or the purchase agreement executes
  (structural). A locked row rejects mutation server-side.
- `source_change_order_id` — set on rows whose current value was changed via a
  post-cutoff CO (audit trail + purchasing variance join).
- `due_date` remains the residential mechanism and a portal display fallback; in
  catalog mode the group's `cutoff_date` supersedes it (service always prefers
  group cutoff when `group_id` is set).

### 7. Appointments — new table `design_studio_appointments`

```sql
create table public.design_studio_appointments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  community_id uuid references public.communities(id) on delete set null,
  project_id uuid not null references public.projects(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,     -- the buyer
  coordinator_user_id uuid,                                              -- app_users id
  scheduled_at timestamptz not null,
  duration_minutes integer not null default 120,
  location text,
  status text not null default 'scheduled'
    check (status in ('scheduled','completed','no_show','canceled')),
  group_ids uuid[] not null default '{}',       -- groups due at this appointment
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index design_studio_appointments_org_time_idx
  on public.design_studio_appointments (org_id, scheduled_at);
create index design_studio_appointments_project_idx
  on public.design_studio_appointments (project_id);
```

`group_ids uuid[]` (not a join table): appointments are operational records, the
group list is display/checklist data, never joined against for money — the array
keeps it one row. Justify-each-table rule satisfied.

### 8. Community CO fee — column on `communities` (workstream 01 table)

```sql
alter table public.communities
  add column if not exists selection_change_fee_cents integer not null default 25000;  -- $250
```

### RLS

Every new table: enable RLS; `select/insert/update/delete` policies scoped
`org_id in (select org_id from org_memberships where user_id = (select auth.uid()))`
— copy the exact policy shape from `selection_categories` in the remote schema and
keep the `(select auth.uid())` initplan pattern (DB performance pass rule). Portal
and cron paths use the service-role client as today. No community/division RLS —
divisions filter, never isolate (master §5.2).

## Service layer

### New: `lib/services/option-catalog.ts` (catalog config — org/community side)

```ts
// Catalog CRUD (all: requireOrgContext → requirePermission("selections.catalog.manage") → logic → recordEvent/recordAudit → DTO)
listCatalog(opts: { communityId?: string; includeArchived?: boolean }): Promise<CatalogDTO>
  // merged view: org categories/options with community overrides applied; each node
  // carries { source: "org" | "community_override" | "community_only" }
upsertCategory(input: CategoryInput): Promise<SelectionCategory>
upsertOption(input: OptionInput): Promise<SelectionOption>          // includes option_scope, cost_cents, cost_code_id
archiveCategory / archiveOption / archivePackage(id): Promise<void> // archive, never delete (referenced by history)
upsertPackage(input: PackageInput): Promise<SelectionPackageDTO>    // with member option ids
setCatalogPrice(input: { optionId?: string; packageId?: string; housePlanVersionId: string;
  communityId?: string; priceCents: number; costCents?: number; isAvailable?: boolean }): Promise<void>
listPlanPricingMatrix(opts: { housePlanVersionId: string; communityId?: string }): Promise<PlanPricingRowDTO[]>

// THE pricing contract (workstream 04 + 06 call this; nobody re-derives precedence):
resolveOptionPricing(opts: {
  orgId: string
  items: Array<{ optionId?: string; packageId?: string }>
  housePlanVersionId?: string       // from the lot's pinned plan version; undefined = residential/base
  communityId?: string
}): Promise<Array<{
  optionId?: string; packageId?: string
  priceCents: number; costCents: number | null
  costCodeId: string | null; vendor: string | null; sku: string | null; leadTimeDays: number | null
  available: boolean
  source: "plan_community" | "plan" | "option_community" | "option_base"
}>>

// Groups
listSelectionGroups(opts: { communityId?: string }): Promise<SelectionGroupDTO[]>
upsertSelectionGroup(input: GroupInput): Promise<SelectionGroupDTO>   // schedule_task_key validated against the community's schedule template
setGroupCategories(groupId: string, categoryIds: string[]): Promise<void>
cloneOrgGroupsToCommunity(communityId: string): Promise<void>

// Appointments (permission "design_studio.manage")
listAppointments(opts: { communityId?: string; from?: string; to?: string; status?: string; limit/cursor }): Promise<Paginated<AppointmentDTO>>
createAppointment / updateAppointment / setAppointmentStatus(...)
getCoordinatorDesk(opts: { communityId?: string; divisionId?: string }): Promise<CoordinatorDeskDTO>
  // { upcomingAppointments, overdueSelections (past cutoff & not confirmed),
  //   cutoffRisk (open groups with cutoff within N days and pending selections),
  //   counts per community } — capped/paginated queries, 400-lot communities are the design case
```

DTO rule: any DTO that can reach the portal or a non-margin role **omits
`cost_cents`** at the type level (separate `BuyerOptionDTO` without the field —
mirror how CO owner-facing sanitization strips `internal_cost_cents`). Builder-side
DTOs include cost/margin only when the caller passes a `financials.margin.read`
authorized context.

### New: `lib/services/selection-cutoffs.ts` (derivation engine — spec below)

```ts
recomputeProjectSelectionCutoffs(projectId: string, orgId: string): Promise<CutoffRecomputeResult>
recomputeCommunityCutoffs(communityId: string, orgId: string): Promise<void>   // fan-out via outbox
overrideGroupCutoff(input: { projectId: string; groupId: string; cutoffDate: string; reason: string }): Promise<void>
  // requirePermission("selections.cutoff.override"); sets cutoff_source='manual_override',
  // override_reason, overridden_by; recordEvent + recordAudit. reason is REQUIRED (Zod min 5).
revertCutoffToSchedule(input: { projectId: string; groupId: string }): Promise<void>
lockDueGroups(orgId?: string): Promise<LockSweepResult>   // cron sweep, see engine spec
instantiateSelectionGroupsForProject(projectId: string, orgId: string): Promise<void>
  // called by workstream 02's start-release/plan-instantiation engine: creates
  // project_selection_groups rows + a project_selections row per (group category ×
  // lot), stamping group_id; then recomputes cutoffs
```

### Evolve: `lib/services/selections.ts`

- `listProjectSelections` — join group + snapshot fields; DTO gains
  `{ group, cutoff_date, locked, effective_due_date }` (`effective_due_date` =
  group cutoff when grouped, else `due_date`).
- `selectProjectOption` — **gains the enforcement gate** (spec below), pricing
  resolution + snapshot stamping, package handling (`packageId` param fans out to
  member categories), `recordEvent("selection_updated")` + `recordAudit` (fixing
  today's silent update).
- `confirmSelection(selectionId)` — explicit builder-side confirm (status →
  `confirmed`, stamps snapshots); `confirmSelectionFromEnvelopeExecution` keeps
  working and also stamps snapshots.
- New `applySelectionChangeFromChangeOrder(changeOrderId)` — called from the CO
  approval path (see Enforcement) to apply the post-cutoff change.
- Existing residential callers (`SelectionsBuilderClient`, portal actions) keep
  their signatures — ungrouped selections take the legacy path untouched.

### Evolve: `lib/services/schedule.ts` (minimal, surgical)

- `applyTemplate` — stamp `metadata.template_item_key` on each created
  `schedule_items` row (key spec below).
- `updateScheduleItem` / `bulkUpdateScheduleItems` — after a successful write that
  changed `start_date`/`end_date`, enqueue outbox job
  `selection_cutoff_recompute` `{ project_id }` (deduped per project via the outbox
  dedupe keys from `20260715200001_qbo_outbox_dedupe_and_claims.sql` pattern).
  Fire-and-forget; schedule mutations must not slow down or fail on cutoff logic.

## Actions + validation

- `lib/validation/selections.ts` grows: `optionScopeSchema`, `catalogCategorySchema`,
  `catalogOptionSchema` (cost/price ints ≥ 0 where non-delta, `cost_code_id` uuid
  optional), `catalogPriceSchema`, `packageSchema`, `selectionGroupSchema`
  (`cutoff_offset_days` int −365..365, `schedule_task_key` min 1),
  `cutoffOverrideSchema` (reason min 5 max 500), `appointmentSchema`,
  `postCutoffChangeSchema`.
- New `app/(app)/design-studio/actions.ts` — thin wrappers over `option-catalog.ts`
  and `selection-cutoffs.ts`, all returning `ActionResult<T>` via the existing
  `run()`/`actionError` pattern from `app/(app)/selections/actions.ts`; clients use
  `unwrapAction`.
- Portal actions (`app/p/[token]/selections/actions.ts`) — keep
  `assertPortalActionAccess(..., permission: "can_submit_selections")`; add
  `confirmGroupAction(token, groupId)` (buyer confirms a whole group) and pass
  through the enforcement error copy verbatim (result objects, never throws —
  Server Action redaction rule).

## UI spec

Design rules bind everywhere: tokens only, radius 0, no heroes/marquees, shadcn
primitives, dense tables with tabular-nums for money, empty/loading/error + dark
mode on every view, pagination/caps on every list. Match sibling-page density.

### 1. Org Design Studio desk — `app/(app)/design-studio/`

Passes the desk test: the design-studio coordinator's whole JOB is selections across
communities. Title row + tabs (no billboard):

- **Catalog** — two-pane: category list (left, sortable, archive toggle), option
  table (right: name, scope chip `Structural`/`Design`, SKU, vendor, lead time,
  cost, price, margin %, availability). Cost/margin columns render only with
  `financials.margin.read`. Community switcher (Select) at the tab header: "Org
  catalog" or a community — community view shows merged rows with a subtle
  `override` badge on overridden rows; edit-in-community creates/updates the
  override row. Option editor is a detail Sheet (invoice-detail-sheet exemplar):
  fields, image upload (existing file upload actions), plan-pricing sub-table
  (plan version × community rows with inline price/cost/availability editing —
  QBO import workspace inline-edit pattern).
- **Packages** — table (name, community, members count, price, cost, margin,
  availability); Sheet editor with member picker (one option per category enforced
  client + server).
- **Groups & cutoffs** — per community: table of groups (name, categories,
  schedule task anchor, offset, e.g. "Drywall — 14 days before start"), task key
  picked from a Select populated by the community's schedule template items.
  "Clone org defaults" button for new communities.
- **Appointments** — coordinator desk (below).

### 2. Coordinator desk (Appointments tab)

Three dense sections (tables, not cards): **Upcoming appointments** (date, buyer,
lot, community, coordinator, groups due, status; row actions complete/no-show/
reschedule), **Overdue selections** (lot, group, cutoff date, days overdue, pending
count — deep-links to the lot's selections tab; desk may one-click nothing here —
mutations live in the workbench), **Cutoff risk** (open groups with cutoff ≤ 14
days and unconfirmed selections, sorted soonest-first, community filter). Division/
community filters top-right. Capped at 50 rows per section with "view all" links.

### 3. Lot (project workbench) selection view

Evolve `components/selections/selections-client.tsx` (and redesign toward the dense
table language — the card layout is legacy):

- Grouped by selection group (catalog mode) with a group header row: name, cutoff
  date, source chip (`from schedule` / `manual override` with tooltip showing
  reason/actor), status (`Open` / `Locked`), days-remaining.
- Rows: category, chosen option (image thumb 32px), scope chip, price snapshot,
  status badge, confirmed date. Locked rows show a lock glyph; the change action on
  a locked row reads **"Change via CO"** and opens the post-cutoff CO flow.
- Cutoff override affordance (permission-gated) in the group header overflow menu —
  Dialog requiring a reason.
- Residential projects (no groups): the current flat list renders exactly as today.

### 4. Buyer portal — `app/p/[token]/selections/`

Reshape (reusing `SelectionsPortalClient` structure, `formatPriceLabel`, and the
select-option transition wiring):

- **Group list page**: each group = a section with name, deadline
  ("Due Aug 14 — 12 days left"; overdue = destructive-token text), progress
  ("3 of 5 selected"), locked groups collapsed with "Locked — contact your builder
  to make changes" (never expose fee mechanics or cost data in copy here).
- **Option browsing**: within a group, categories in order; options as a compact
  media list (image, name, description, `+$X / Included` price labels from
  **buyer-safe DTOs** — price only, never cost). Packages render first in covered
  categories as a bundled row ("Coastal Kitchen — includes 4 selections — +$8,450").
- **Confirm flow**: per-group "Review & confirm" — summary table of choices +
  price deltas + group total, confirm button → statuses `selected→confirmed`,
  snapshots stamped. E-sign confirmation (existing envelope path) remains available
  builder-initiated.
- Past cutoff, the server rejects with the enforcement copy and the client renders
  it inline (result objects, no thrown errors).

### 5. Empty/loading/error/dark

Catalog empty: "No options yet. Add a category to start your catalog." Coordinator
desk empty: "No upcoming appointments." Lot view with no groups + no selections:
existing empty state. Loading: Skeleton rows matching table geometry. Errors: inline
destructive-token text with retry. All chips/badges from existing token classes —
no new colors.

## Cutoff derivation engine (exact spec)

**Template task key.** `schedule_templates.items` jsonb entries gain a stable
`key` field: on template save, `key = slugify(name)` de-duplicated with `-2`, `-3`
suffixes; existing templates get keys lazily on next save (and `applyTemplate`
falls back to slugified-name matching for items created before keys existed).
`applyTemplate` stamps `metadata.template_item_key` on each created schedule item.
`selection_groups.schedule_task_key` stores this key.

**Derivation algorithm** (`recomputeProjectSelectionCutoffs`):

1. Load the lot's `project_selection_groups` joined to `selection_groups`; skip rows
   with `cutoff_source = 'manual_override'` (overrides are sticky until reverted).
2. Load the project's `schedule_items` (id, name, start_date, end_date,
   metadata->>'template_item_key').
3. For each group: find the anchor item by `template_item_key = schedule_task_key`;
   fallback: `slugify(name) = schedule_task_key`; if multiple match, earliest
   `start_date` wins; if none match → `cutoff_date = null`,
   `matched_schedule_item_id = null`, emit `selection_cutoff_unresolved` event
   (coordinator desk surfaces these as risk rows — a null cutoff never blocks, but
   it is loudly visible).
4. `anchor_date` = item `start_date` (or `end_date` per `cutoff_anchor`); if the
   anchor date is null, treat as unresolved (step 3 behavior).
5. `cutoff_date = anchor_date + cutoff_offset_days` (calendar days; date-only math,
   no timezones — cutoffs are dates, enforcement compares against the org-local
   date via the existing org timezone helper; if none exists, UTC date with a noted
   open question).
6. Write only changed rows; if `cutoff_date` moved and the group is `locked` but
   the new cutoff is in the future, **unlock** (status `open`, clear `locked_at`) —
   a slipped schedule legitimately reopens a window. Emit
   `selection_cutoff_changed` per changed row with `{ old, new, group_id }`.

**Recompute triggers:**

- Schedule item date writes (`updateScheduleItem` / `bulkUpdateScheduleItems`) →
  outbox `selection_cutoff_recompute { project_id }`, deduped.
- Group config change (offset/task key/anchor) → `recomputeCommunityCutoffs`:
  outbox fan-out, one job per lot-project in the community (batched 50/job).
- Plan instantiation / start release (workstream 02 engine) →
  `instantiateSelectionGroupsForProject` then immediate recompute.
- Nightly cron `selection-cutoff-sweep` (vercel.json + CRON_JOBS registry +
  `PUBLIC_API_ROUTES` in proxy.ts; **GET handler** — cron rule): calls
  `lockDueGroups` — for every `open` group instance with
  `cutoff_date < today`: set `locked`, `locked_at = now()`, stamp `locked_at` on
  its member `project_selections`, emit `selection_group_locked`. The sweep is a
  belt; the buckle is that enforcement (below) checks the date live — a lock is
  never *dependent* on the cron having run.

**Notification hooks** (via existing notifications service; email only for
buyer-facing ones added to `EMAIL_NOTIFICATION_TYPES` deliberately):

- T−14 and T−7 days before cutoff with unconfirmed selections → buyer portal email
  (`selection_cutoff_reminder`) + in-app to coordinator.
- Cutoff passed with unconfirmed selections → in-app to coordinator + PM
  (`selection_cutoff_missed`), no buyer email.
- `selection_cutoff_changed` by >3 days → in-app to coordinator.
- Reminder sends ride the same nightly cron; idempotency via a
  `metadata.reminders_sent` array on `project_selection_groups` (`["t14","t7"]`).

## Enforcement spec (server-side gates)

**Gate location:** a single `assertSelectionMutable(selection, { forStructural })`
helper in `selections.ts`, called by `selectProjectOption`, `confirmSelection`,
package apply, and any future mutation of a selection's chosen value. UI disabling
is cosmetic; the service gate is the enforcement.

**Rules, in order:**

1. **Structural lock:** if the option being set (or currently set) has
   `option_scope = 'structural'` and the lot's project has an executed purchase
   agreement (`contracts` row, `contract_type = 'purchase_agreement'`, executed —
   workstream 06's helper), reject:
   > "Structural options are locked once the purchase agreement is signed. Changes
   > require a change order — contact your builder." (portal) /
   > "Structural options locked at agreement signing. Create a change order to
   > modify." (builder UI)
2. **Group cutoff:** if `group_id` is set, load the group instance; if
   `status = 'locked'` OR `cutoff_date < org-local today` (live check — cron
   independence), reject:
   > "The selection deadline for {group name} was {date}. Changes now require a
   > change order{fee copy}." Builder-side fee copy: " (${fee} change fee applies
   > per {community} policy)". Portal copy omits the fee amount (the CO proposal
   > carries it formally).
3. **Row lock:** `locked_at` set on the row itself (e.g., structural sweep) →
   same rejection.
4. Otherwise proceed; stamp snapshots on confirm.

Rejections are returned as `{ success: false, error }` result objects with the
error codes `SELECTION_LOCKED_STRUCTURAL` / `SELECTION_LOCKED_CUTOFF` in a
`code` field so clients can render the CO affordance instead of a plain toast.

**The only path past the gate — fee-bearing CO** (`selections.ts`):

```ts
createPostCutoffSelectionChangeOrder(input: {
  projectId: string
  changes: Array<{ selectionId: string; newOptionId?: string; newPackageId?: string }>
  waiveFee?: boolean            // requires selections.cutoff.override; audited
}): Promise<ChangeOrderDTO>
```

1. `requireOrgContext` → `requireAuthorization("change_order.write", ...)` (the CO
   permission, not a selections one — the CO is the artifact).
2. Resolve old/new pricing via `resolveOptionPricing`; delta per change =
   `new price − old snapshot price`.
3. Call the existing `createChangeOrder` with lines: one line per change
   (description "Selection change: {category} — {old} → {new}",
   `unit_cost_cents = delta`, `internal_cost_cents = cost delta`,
   `cost_code_id` from the option) plus one **fee line**
   ("Post-cutoff selection change fee", `unit_cost_cents =
   communities.selection_change_fee_cents`, `internal_cost_cents = 0`) unless
   waived. CO `metadata.selection_change = { changes: [...], fee_cents,
   fee_waived, group_ids }`.
4. The CO rides the normal lifecycle (draft→proposed→approved, e-sign, portal) from
   `change-orders.ts` — nothing forked.
5. On approval, `approveChangeOrder`'s existing hook chain calls
   `applySelectionChangeFromChangeOrder(coId)`: updates each `project_selections`
   row (new option, re-stamped snapshots, `source_change_order_id = coId`,
   status `confirmed`), emits `selection_changed_post_cutoff` per row with
   `{ old_option_id, new_option_id, cost_delta_cents, cost_code_id, project_id }`.
6. **Purchasing variance signal (workstream 04 contract):**
   `selection_changed_post_cutoff` is the event 04 subscribes to (outbox consumer).
   If a PO already exists for the affected cost code on this lot, 04 raises a VPO
   proposal referencing the CO; if not yet released, the start-package PO generator
   picks up the new selection naturally. This doc only guarantees the event shape
   above — 04 owns the consumption.

No enforcement bypass exists outside `overrideGroupCutoff` (moves the date,
audited) and `waiveFee` (keeps the CO, drops the fee, audited). There is
deliberately no "admin edit anyway" path.

## RBAC, events, notifications, search

**RBAC** (new migration extending the catalog-as-code seed pattern from
`20260708120500_rbac_catalog_seed.sql` — there are currently NO selection
permissions):

- Permissions: `selections.read`, `selections.write` (project-level select/confirm),
  `selections.catalog.manage` (org/community catalog, packages, groups, pricing),
  `selections.cutoff.override`, `design_studio.manage` (appointments/desk).
  Cost/margin visibility rides the existing `financials.margin.read`.
- New assignable role **`org_design_studio_coordinator`** (catalog role keys
  are `org_`-prefixed — see the existing seed: org_bookkeeper/org_estimator;
  bookkeeper/estimator
  assignable-role pattern): selections.*, design_studio.manage,
  change_order.write, schedule read; NOT financials beyond margin.read.
- Existing admin/PM roles gain the selections permissions matching their current
  de-facto access so nothing regresses; `createProjectSelection` and
  `selectProjectOption` (builder path) gain `requirePermission("selections.write")`.

**Events** (`recordEvent`): `selection_updated`, `selection_confirmed` (exists),
`selection_group_locked`, `selection_cutoff_changed`, `selection_cutoff_unresolved`,
`selection_cutoff_overridden`, `selection_changed_post_cutoff`,
`option_catalog_updated` (coarse, per entity save), `design_studio_appointment_created/
updated/completed`.

**Notifications:** in-app for coordinator/PM items; `EMAIL_NOTIFICATION_TYPES`
gains exactly one type: `selection_cutoff_reminder` (buyer-facing T−14/T−7).
Nothing else emails.

**Search:** register `selection_option` (name, sku, vendor, category) and
`design_studio_appointment` (buyer, lot) entity types in the search index
write-through (recordAudit+outbox pattern per the search overhaul).

## Migration plan (existing customers unaffected)

1. Migration files (all additive, order): `<ts>_option_catalog_design_studio.sql`
   (tables/columns above), `<ts>_rbac_selections_catalog.sql` (catalog seed
   extension). No data backfill required: every new column is nullable or
   defaulted such that existing residential rows are semantically unchanged
   (`option_scope` defaults `design_studio`; no groups → no gates; snapshots null →
   legacy price display).
2. **Mode is implicit, not a flag:** a project is in catalog mode iff its
   selections carry `group_id` (which only `instantiateSelectionGroupsForProject`
   writes, which only runs for lots in communities). Residential projects can never
   enter enforcement accidentally.
3. The enforcement gate short-circuits when `group_id is null` AND the option is
   `design_studio` scope AND no purchase agreement exists (residential contracts
   use other `contract_type` values — verify 06's enum before shipping; if
   residential ever uses `purchase_agreement`, gate structural-lock on
   `property_type = 'production'` via `getProjectPosture()`, noted in open
   questions).
4. Portal: the group list page renders only when groups exist; ungrouped portals
   render today's flat category view (same component, branch at data shape).
5. Cutover checklist for a builder adopting the catalog: define org catalog →
   clone groups to community → set plan pricing → new lots instantiate groups at
   start release. No migration of in-flight residential selections — ever.
6. Cleanup (leave-no-trash, end of workstream): note `selection_categories.
   is_template` and `project_selections.due_date`-as-primary as retired-for-catalog;
   schedule a later drop of `is_template` once confirmed unread (do NOT drop here —
   additive rule).

## Phases + acceptance criteria

**Phase 1 — Catalog data model + admin (org/community).**
Migration applied; `option-catalog.ts` CRUD + merged `listCatalog`; Design Studio
desk Catalog tab with community overrides; RBAC seed extension.
*Accept:* create org category/option with cost+scope; override price in a
community; archived options hidden from pickers; residential selections UI
unchanged (`pnpm lint` clean; existing portal flow manually verified).

**Phase 2 — Plan pricing + packages.**
`selection_catalog_prices` resolution + `resolveOptionPricing` with full precedence;
packages CRUD + plan pricing matrix UI.
*Accept:* unit tests prove precedence (plan+community > plan > option override >
base) and package allocation sums exactly in cents; `is_available=false` per plan
hides the option for that plan's lots; buyer DTOs never contain `cost_cents`
(type-level test).

**Phase 3 — Groups + cutoff engine.**
Groups config UI; template item keys + `applyTemplate` stamping; recompute engine +
outbox triggers + nightly sweep cron (vercel.json + CRON_JOBS + proxy allowlist);
lot view grouped with cutoff chips.
*Accept:* moving a schedule item's date recomputes the cutoff (visible after outbox
run); unresolved task key surfaces on the desk, never blocks; slipped schedule
reopens a locked future-cutoff group; override requires permission + reason and
shows actor in UI.

**Phase 4 — Enforcement + fee-bearing CO.**
`assertSelectionMutable` in every mutation path; structural lock on purchase
agreement execution; `createPostCutoffSelectionChangeOrder` + approval hook +
`selection_changed_post_cutoff` event.
*Accept:* past-cutoff portal select returns `SELECTION_LOCKED_CUTOFF` result (no
throw); CO created with delta + fee lines matching community fee; approving the CO
updates the selection with re-stamped snapshots and `source_change_order_id`; fee
waiver requires override permission and is audited; event payload matches the 04
contract verbatim.

**Phase 5 — Buyer portal + appointments + coordinator desk.**
Portal group/browse/confirm flow; appointments CRUD; coordinator desk;
notifications (reminder email type added).
*Accept:* buyer confirms a group and snapshots stamp; locked group shows the buyer
copy with no fee/cost leakage; desk sections paginate and filter by community;
T−14/T−7 reminders send once each (idempotent under repeated cron runs);
empty/loading/error/dark verified on every new view.

**Phase 6 — Integration + hardening.**
Workstream 02 start-release calls `instantiateSelectionGroupsForProject`; search
registration; docs/database-overview.md updated; cleanup notes filed.
*Accept:* `pnpm lint` + `pnpm test:financials` green; a full lot walkthrough
(instantiate → buyer selects → cutoff passes → CO change → purchasing event) works
end-to-end in the QA org.

## Test plan

- **Unit (vitest, alongside `pnpm test:financials`):** pricing precedence matrix
  (all 4 sources × availability), package price allocation (integer-cents
  exactness, odd totals), cutoff math (offsets, anchor start/end, null anchors,
  slugified-name fallback, multi-match earliest-wins), reopen-on-slip, reminder
  idempotency keys, enforcement matrix (scope × contract state × group state ×
  cutoff date) — pure functions extracted so tests need no DB.
- **Service/integration (QA org):** recompute via real outbox jobs; CO
  generation/approval round-trip including snapshot re-stamp; RBAC denials for
  each new permission; portal token path cannot mutate a locked selection.
- **Regression:** residential project — create selection, portal select, e-sign
  confirm — byte-identical behavior (no group, no gate, no snapshot requirement).
- **Scale:** coordinator desk and `recomputeCommunityCutoffs` against a seeded
  400-lot community (caps respected, fan-out batched).

## Open questions

1. **Org-local "today" for cutoff comparison** — is there an existing org timezone
   helper? If not, cutoffs compare against UTC dates (a builder in Hawaii gets a
   few extra hours). Decide before Phase 4; a `orgs.timezone` column is out of
   scope here.
2. **Does residential ever use `contract_type='purchase_agreement'`?** If yes, the
   structural lock must additionally gate on posture (`getProjectPosture() ===
   'production'`). Verify against production contracts data before Phase 4.
3. **Fee taxability / accounting treatment** of the selection change fee line —
   confirm with workstream 08 whether the fee needs its own income mapping or rides
   the CO's default.
4. **Package changes post-cutoff** — v1 treats a package swap as N member changes
   in one CO with one fee. Should the fee be per-group instead of per-CO? Default:
   per-CO (one fee per change event), configurable later if a customer asks.
5. **Option images at volume** — catalogs run to thousands of images; current
   `image_url`/`file_id` is fine, but the buyer portal browse page may want the
   drawings pipeline's thumbnail treatment. Defer unless portal perf demands it.
6. **Appointment scheduling depth** (coordinator calendars, buyer self-scheduling)
   — v1 is builder-entered records only; self-scheduling is a future portal
   feature, deliberately out of scope.
