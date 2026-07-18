# Workstream 01 — Foundation: Production Posture, Divisions, Communities, Lots

> Prereq: `00-MASTER-production-expansion.md` read fully, plus the commercial suite's
> `00-MASTER` and `09-platform-deferred-and-production.md`. This workstream is the
> root of the production dependency graph: every later doc (plans, purchasing, starts,
> sales, warranty) assumes the entity spine built here.

## STATUS — NOT STARTED

No code, no migrations. This doc is the execution plan.

## Mission

Give Arc the production-homebuilder entity spine and posture wiring:

1. **`production` becomes a real project posture** end-to-end: enum value on
   `projects.property_type`, `ProjectPosture` union, `getProjectPosture()`,
   terminology (already seeded), project nav + module filtering, financial-setup
   defaults. A production-posture project is a **house on a lot**.
2. **`divisions`** — an optional light scoping layer (name/code/region/settings).
   Orgs without divisions never see the concept (null everywhere, zero UI).
3. **`communities` + `community_phases`** — the container production work lives in.
4. **`lots` as land records** — they exist from land control/takedown onward, BEFORE
   any project. Status lifecycle `controlled → owned → developed → assigned → started
   → closed`; premiums, dimensions, swing; takedown tranches via `lot_takedowns`.
   `lots.project_id` is nullable 0..1 — the job is attached at/near start release.
5. **Community workbench** — `app/(app)/communities/[id]` with a dense, paginated
   lot table as the centerpiece (400-lot communities are the design case).
6. **Nav + rollup + RBAC wiring** — workspace sidebar gains Communities for
   production-tier orgs; org desks gain community/division filter dimensions through
   the `reporting-scope.ts` pattern; new permission keys + one new assignable role
   land in the RBAC catalog seed.

**Not in scope** (later workstreams): house plans and instantiation (02), option
catalog (03), price book/POs/VPOs (04), start packages and even-flow (05), sales
pipeline/purchase agreements/closings (06), accounting entity mapping (08 — but this
doc leaves the seams it needs).

## Current-state audit (verified against repo 2026-07-16)

Claims below were verified by reading the code — re-verify against live schema with
Supabase MCP `list_tables` before writing migrations (master process rule).

- **Enum:** `project_property_type` is `('residential','commercial')` — defined in
  `supabase/migrations/20260517092101_remote_schema.sql` (~L175). No `production`
  value yet. `projects.property_type` uses this enum (nullable).
- **Tier plumbing:** `orgs.product_tier` exists
  (`20260710184245_org_product_tier.sql`), values residential/commercial/production,
  default residential, comment documents "never gates data."
  `lib/product-tier.ts` — `PRODUCT_TIERS` already includes `"production"`, but
  `ProjectPosture = "residential" | "commercial"` and `getProjectPosture()` /
  `getDefaultProjectPropertyType()` only know two postures. **This is the main TS
  seam to extend.** `requireOrgContext()` returns `productTier` on the context
  (`lib/services/context.ts`); `getOrgProductTier()` exists.
- **Terminology:** `lib/terminology.ts` already has the `production` row
  (Buyer / Buyer portal / Purchase agreement). Add nothing here except any nouns a
  UI you build needs; Lot/Community/Division are first-class nouns, NOT terminology
  swaps (master §2).
- **Project nav:** `components/layout/project-nav-items.ts` —
  `buildProjectNavGroups({ projectId, section, project, reviewBadgeCount, orgTier })`
  computes `posture = getProjectPosture(project?.property_type, orgTier)` and filters
  items by `postures?: ProjectPosture[]` + `module_overrides`. Commercial-only items
  (Specifications, Meeting Minutes, Transmittals, Inspections, Safety) carry
  `postures: ["commercial"]`. `lib/project-modules.ts` mirrors this with
  `PROJECT_MODULES` (+ `postures`) and `isProjectModuleEnabled()`.
- **Workspace sidebar:** `components/layout/app-sidebar.tsx` —
  `buildWorkspaceGroups(...)` already branches on tier once
  (`if (productTier === "commercial")` pushes Safety into Office). The sidebar IS
  the nav-config choke point, so a tier branch there is legitimate; follow that
  exact precedent for Communities.
- **RBAC:** catalog-as-code at `supabase/migrations/20260708120500_rbac_catalog_seed.sql`
  (permissions + roles + role_permissions, idempotent). Incremental additions follow
  `20260710140200_progress_billing_permissions.sql` (insert permissions on conflict
  update; grant via `unnest(array[...])` to role keys). Assignable-role exemplars:
  `org_bookkeeper`, `org_estimator`. Enforcement: `requirePermission()` in
  `lib/services/permissions.ts` → `lib/services/authorization.ts`. UI catalog:
  `TEAM_PERMISSION_OPTIONS` in `lib/services/team.ts` (~L119).
- **Project scope precedent:** `memberships.project_scope` text 'all'|'assigned'
  (`20260708121000_membership_project_scope.sql`); enforcement reads it in
  `authorization.ts` `fetchOrgPermissions()` (~L114–139, `assignedOnly` flag) and
  restricts to explicit `project_members` rows. The division analog mirrors this
  shape (column + join table), see Data model.
- **Reporting scope:** `lib/services/reporting-scope.ts` —
  `getReportingExcludedProjectIds()` + `applyReportingExclusion()` (or-group filter
  preserving `project_id is null` rows) + `applyProjectReportingScope()`. Community/
  division rollups extend THIS file with explicit-project-id-set helpers; no new
  aggregation framework (master §3).
- **RLS pattern:** recent migrations (e.g. `20260711120200_prequalification.sql`)
  use `create policy <t>_org_access on public.<t> for all to authenticated using
  (public.is_org_member(org_id)) with check (public.is_org_member(org_id));` —
  `is_org_member` internally uses the `(select auth.uid())` initplan form. Copy
  this block verbatim per table.
- **Service canon:** `lib/services/change-orders.ts` is the exemplar shape
  (`requireOrgContext` → `requirePermission` → logic → `recordEvent`
  (`lib/services/events.ts`) + `recordAudit` (`lib/services/audit.ts`) → mapped DTO).
  Actions return `ActionResult<T>` from `lib/action-result.ts` with
  `actionError()` / client `unwrapAction()`.
- **Search index:** `lib/services/search-index.ts` maps `recordAudit` entity types
  → search entity types via `AUDIT_ENTITY_TYPE_TO_SEARCH`; unregistered entities are
  invisible to global search.
- **Does NOT exist:** no `divisions`, `communities`, `community_phases`, `lots`,
  `lot_takedowns` tables; no `lib/services/{divisions,communities,lots}.ts`; no
  `app/(app)/communities`; grep for `community|lots` in `lib/` and `app/` finds
  nothing relevant. Nothing to migrate, nothing to delete.

## Read these files first

- `lib/product-tier.ts`, `lib/terminology.ts`, `lib/project-modules.ts`
- `components/layout/project-nav-items.ts`, `components/layout/app-sidebar.tsx`
- `lib/services/context.ts`, `lib/services/permissions.ts`,
  `lib/services/authorization.ts` (project_scope enforcement, ~L105–180)
- `lib/services/reporting-scope.ts`
- `supabase/migrations/20260708120500_rbac_catalog_seed.sql`,
  `20260710140200_progress_billing_permissions.sql`,
  `20260708121000_membership_project_scope.sql`,
  `20260710184245_org_product_tier.sql`,
  `20260711120200_prequalification.sql` (RLS block to copy)
- `lib/services/change-orders.ts` (service shape), `lib/action-result.ts`
- `app/(app)/projects/` list page + `app/(app)/projects/[id]/financials/`
  (workbench exemplar), `app/(app)/directory/` (org list-page exemplar with
  server-side pagination — verify which sibling paginates best and copy it)
- `lib/financials/billing-model.ts` (`getProjectFinancialFeatureConfig`)
- `docs/database-overview.md`

## Data model

Six migrations, all additive, all org-scoped, RLS + indexes + `updated_at` trigger
in the same file as each table (commercial master rule 18). Use the repo's standard
trigger helper — check a recent migration for the exact function name
(`set_updated_at` / `handle_updated_at`) and copy it.

### Migration 1 — `202607DD######_project_property_type_production.sql`

```sql
-- Enum extension MUST be its own migration: a value added by ALTER TYPE cannot be
-- referenced later in the same transaction.
alter type public.project_property_type add value if not exists 'production';
```

### Migration 2 — `202607DD######_divisions.sql`

```sql
create table public.divisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  name text not null,
  code text,                                   -- short label for tables/exports, e.g. "SWFL"
  region text,                                 -- freeform market/geo label
  settings jsonb not null default '{}'::jsonb, -- future: accounting-entity hints (WS08), defaults
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);
create index divisions_org_idx on public.divisions (org_id);
alter table public.divisions enable row level security;
create policy divisions_org_access on public.divisions for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
-- + standard updated_at trigger

-- Denormalized division on projects (master §5.2). Maintained by the communities
-- service whenever a project is attached to a lot or a community moves division.
alter table public.projects
  add column if not exists division_id uuid references public.divisions(id);
create index projects_division_idx on public.projects (org_id, division_id)
  where division_id is not null;

comment on table public.divisions is
  'Optional org scoping layer (region/brand/entity). Filters desks, reports, RBAC scope, and (WS08) accounting-entity mapping. Never an isolation boundary: RLS stays org-based.';
```

### Migration 3 — `202607DD######_communities_phases.sql`

```sql
create table public.communities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  division_id uuid references public.divisions(id),   -- null = "main" (no-division org)
  name text not null,
  code text,                                          -- e.g. "CYP" -> lot label CYP-014
  status text not null default 'active'
    check (status in ('planning','active','sold_out','closed')),
  address text,
  city text,
  state text,
  postal_code text,
  description text,
  planned_lot_count integer,                          -- target at buildout; actual = count(lots)
  settings jsonb not null default '{}'::jsonb,        -- future: base-price defaults (WS02), release cadence (WS05)
  metadata jsonb not null default '{}'::jsonb,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);
create index communities_org_idx on public.communities (org_id, status);
create index communities_division_idx on public.communities (org_id, division_id)
  where division_id is not null;

create table public.community_phases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  community_id uuid not null references public.communities(id) on delete cascade,
  name text not null,                                 -- "Phase 2", "The Preserve"
  phase_number integer not null,
  status text not null default 'planned'
    check (status in ('planned','open','built_out')),
  target_open_date date,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (community_id, phase_number)
);
create index community_phases_org_idx on public.community_phases (org_id, community_id);
-- RLS: same org_access policy block on both tables; updated_at triggers on both.
```

### Migration 4 — `202607DD######_lots_and_takedowns.sql`

```sql
create table public.lot_takedowns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  community_id uuid not null references public.communities(id),
  community_phase_id uuid references public.community_phases(id),
  name text not null,                       -- "Q3 2026 takedown", "Tranche 2"
  scheduled_date date,                      -- contractual takedown (closing) date
  actual_date date,                         -- when the lots actually closed
  lot_count integer not null default 0,     -- contracted count; lots link when identified
  price_per_lot_cents bigint,               -- contracted finished-lot price
  deposit_cents bigint not null default 0,  -- option deposit tied to this tranche
  status text not null default 'scheduled'
    check (status in ('scheduled','closed','cancelled')),
  seller_company_id uuid references public.companies(id),  -- verify FK table name (directory companies) before applying
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index lot_takedowns_org_idx on public.lot_takedowns (org_id, community_id, status);

create table public.lots (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  community_id uuid not null references public.communities(id),
  community_phase_id uuid references public.community_phases(id),
  division_id uuid references public.divisions(id),   -- denormalized from community; service-maintained
  lot_number text not null,                           -- "14", "14A" — text, plats aren't integers
  block text,                                         -- plat block, optional
  status text not null default 'controlled'
    check (status in ('controlled','owned','developed','assigned','started','closed')),
  address text,                                       -- street address once platted/assigned
  dimensions jsonb not null default '{}'::jsonb,      -- {width_ft, depth_ft, acreage, irregular: bool}
  swing text not null default 'either'
    check (swing in ('left','right','either')),       -- garage-swing constraint; plan fit checks in WS02
  premium_cents bigint not null default 0,            -- lot premium added to base price (WS06)
  cost_basis_cents bigint,                            -- acquisition/finished-lot cost, for margin later
  takedown_id uuid references public.lot_takedowns(id),
  acquired_date date,                                 -- when status crossed to owned
  project_id uuid references public.projects(id),     -- 0..1: the job/house, set at start release
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (community_id, lot_number, block)
);
-- 400-lot communities are the design case: every list query hits these.
create index lots_org_community_idx on public.lots (org_id, community_id, status);
create index lots_project_idx on public.lots (project_id) where project_id is not null;
create unique index lots_project_unique on public.lots (project_id)
  where project_id is not null;                       -- enforce 0..1 project per lot AND per project
create index lots_takedown_idx on public.lots (takedown_id) where takedown_id is not null;
-- RLS org_access block + updated_at triggers on both tables.
```

**Decision — `lot_takedowns` is a table, not columns on `lots` (justification):**
takedowns are contractual *tranches* negotiated with a land seller/developer — "12
finished lots per quarter at $85k, 15% deposit." A tranche exists before its specific
lots are identified (`lot_count` vs linked lots), carries tranche-level economics
(deposit, per-lot price, scheduled vs actual close), and one tranche covers many
lots. Per-lot `takedown_date + deposit_cents` columns cannot express any of that and
would force duplication across every lot in a tranche. Lots keep only the FK plus
their own `acquired_date`/`cost_basis_cents`. This also gives workstream 05 the feed
it needs (finished-lot delivery dates → starts calendar, master §9) and keeps the
`draw_schedules` name collision (master §4) fully avoided.

**Lot status lifecycle (service-enforced, not a DB state machine):**

| Status | Meaning | Entry condition |
|---|---|---|
| `controlled` | Under option/contract, not owned | default on create |
| `owned` | Closed/taken down | manual, or auto when its takedown closes |
| `developed` | Finished lot, buildable | manual |
| `assigned` | Plan and/or buyer attached (WS02/WS06 set this) | manual in WS01 |
| `started` | Construction released — **requires `project_id`** | set by `attachProjectToLot` (WS01) / start release (WS05) |
| `closed` | Sold/settled (WS06 closing sets this) | manual in WS01 |

Forward and backward single-step moves are allowed (mistake correction) EXCEPT:
`started` requires a linked project, and leaving `started`/`closed` requires the
`community.write` holder to pass an explicit `force` flag (audited). Skipping states
forward is allowed (a builder importing an active community sets lots straight to
`started`).

### Migration 5 — `202607DD######_membership_division_scope.sql`

Mirror `20260708121000_membership_project_scope.sql` exactly in tone and shape:

```sql
set local lock_timeout = '3s';

alter table public.memberships
  add column if not exists division_scope text not null default 'all';
alter table public.memberships
  add constraint memberships_division_scope_check
  check (division_scope in ('all', 'assigned'));

create table public.membership_divisions (
  membership_id uuid not null references public.memberships(id) on delete cascade,
  division_id uuid not null references public.divisions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (membership_id, division_id)
);
alter table public.membership_divisions enable row level security;
-- Copy the memberships-table RLS posture from 20260708122000_membership_rls_write_lockdown.sql:
-- reads for org members, writes only for can_manage_members holders.

comment on column public.memberships.division_scope is
  'Division visibility scope: all = every division, assigned = only membership_divisions rows. A filter on top of org RLS, never an isolation boundary. Ignored for org.admin/platform access.';
```

Enforcement (Phase 4): `authorization.ts` `fetchOrgPermissions()` additionally
selects `division_scope` and, when `'assigned'`, the allowed division ids; expose
them on the decision context the same way `assignedOnly` is. Services that list
division-scoped entities (communities, lots, and the desks' rollup helpers) filter
by the allowed set. Division scope is a *visibility filter* like project_scope —
RLS stays org-based (master §5.2).

### Migration 6 — `202607DD######_land_permissions.sql`

RBAC catalog additions — see the RBAC section for contents.

## Service layer

Three new services. All follow the canonical shape; every function takes
`orgId?: string` last (resolved via `requireOrgContext`), every mutation calls
`recordEvent` + `recordAudit`, every DTO is explicitly mapped (no raw rows out).

### `lib/services/divisions.ts`

```ts
export interface DivisionDTO {
  id: string; name: string; code: string | null; region: string | null;
  archived: boolean; communityCount: number; activeProjectCount: number;
}
export async function listDivisions(orgId?: string): Promise<DivisionDTO[]>
  // ~5 rows/org max in practice; counts via two grouped count queries in Promise.all.
export async function createDivision(input: DivisionInput, orgId?: string): Promise<DivisionDTO>
export async function updateDivision(id: string, input: Partial<DivisionInput>, orgId?: string): Promise<DivisionDTO>
export async function archiveDivision(id: string, orgId?: string): Promise<void>
  // Blocks if any non-archived community references it (return a clear error).
export async function orgHasDivisions(orgId?: string): Promise<boolean>
  // Cheap head-count; drives "zero UI for null-division orgs" everywhere.
```

Permissions: mutations `division.manage`; reads `org.member`.
Events: `division.created` / `division.updated` / `division.archived`.

### `lib/services/communities.ts`

```ts
export interface CommunityListItemDTO {
  id: string; name: string; code: string | null; status: string;
  divisionId: string | null; divisionName: string | null;
  city: string | null; state: string | null;
  plannedLotCount: number | null;
  lotCounts: Record<LotStatus, number>;   // one grouped-count query, keyed by community
}
export interface CommunityDetailDTO extends CommunityListItemDTO {
  address: string | null; postalCode: string | null; description: string | null;
  phases: CommunityPhaseDTO[];
  takedowns: LotTakedownDTO[];
}
export async function listCommunities(
  { divisionId, status }: { divisionId?: string; status?: string } = {}, orgId?: string,
): Promise<CommunityListItemDTO[]>   // capped/ordered; an org has dozens, not thousands
export async function getCommunity(id: string, orgId?: string): Promise<CommunityDetailDTO>
export async function createCommunity(input: CommunityInput, orgId?: string): Promise<CommunityDetailDTO>
export async function updateCommunity(id: string, input: Partial<CommunityInput>, orgId?: string): Promise<CommunityDetailDTO>
  // Changing division_id re-denormalizes divisions onto the community's lots AND
  // their linked projects (single update ... from statements, org-scoped).
export async function archiveCommunity(id: string, orgId?: string): Promise<void>
// Phases
export async function createCommunityPhase(communityId: string, input: PhaseInput, orgId?: string): Promise<CommunityPhaseDTO>
export async function updateCommunityPhase(id: string, input: Partial<PhaseInput>, orgId?: string): Promise<CommunityPhaseDTO>
export async function deleteCommunityPhase(id: string, orgId?: string): Promise<void>  // blocked if lots reference it
// Takedowns
export async function createLotTakedown(communityId: string, input: TakedownInput, orgId?: string): Promise<LotTakedownDTO>
export async function updateLotTakedown(id: string, input: Partial<TakedownInput>, orgId?: string): Promise<LotTakedownDTO>
export async function closeLotTakedown(id: string, { actualDate }: { actualDate: string }, orgId?: string): Promise<LotTakedownDTO>
  // status -> closed; flips its linked lots from controlled -> owned (skip lots already past owned), sets acquired_date.
```

Permissions: reads `community.read`; mutations `community.write` (takedowns and
phases included — they are community facts).
Events: `community.created/updated/archived`, `lot_takedown.created/closed`.

### `lib/services/lots.ts`

```ts
export type LotStatus = "controlled" | "owned" | "developed" | "assigned" | "started" | "closed"
export interface LotDTO {
  id: string; communityId: string; phaseId: string | null; phaseName: string | null;
  lotNumber: string; block: string | null; status: LotStatus;
  address: string | null; dimensions: { widthFt?: number; depthFt?: number; acreage?: number };
  swing: "left" | "right" | "either";
  premiumCents: number; costBasisCents: number | null;
  takedownId: string | null; acquiredDate: string | null;
  projectId: string | null; projectName: string | null;  // joined when linked
}
export interface LotListPage { lots: LotDTO[]; total: number; page: number; pageSize: number }

export async function listLots(
  communityId: string,
  { page = 1, pageSize = 100, status, phaseId, search }: LotListFilters = {},
  orgId?: string,
): Promise<LotListPage>
  // Server-paginated day one (400-lot design case). `search` matches lot_number/address
  // via ilike. Ordered by block nulls first, then natural lot_number sort
  // (order by block, lot_number collate "C" is fine; do NOT load all rows client-side).
export async function getLotStatusCounts(communityId: string, orgId?: string): Promise<Record<LotStatus, number>>
export async function createLots(
  communityId: string,
  input: { lots: LotCreateInput[] },   // bulk: "add lots 1–48 to Phase 2" is the normal case
  orgId?: string,
): Promise<{ created: number }>
  // Accepts explicit rows AND a range helper resolved in the action (see validation).
  // Single insert statement; duplicate (lot_number, block) rows fail the whole batch
  // with a message naming the collisions.
export async function updateLot(id: string, input: Partial<LotUpdateInput>, orgId?: string): Promise<LotDTO>
export async function bulkUpdateLots(
  communityId: string,
  { lotIds, patch }: { lotIds: string[]; patch: Partial<Pick<LotUpdateInput, "status"|"phaseId"|"takedownId"|"premiumCents"|"swing">> },
  orgId?: string,
): Promise<{ updated: number }>      // grid multi-select actions; lotIds capped at 500 by validation
export async function setLotStatus(id: string, status: LotStatus, { force = false } = {}, orgId?: string): Promise<LotDTO>
  // Enforces the lifecycle table above; audited with from/to in metadata.
export async function attachProjectToLot(lotId: string, projectId: string, orgId?: string): Promise<LotDTO>
  // Validates: project org matches, project not linked to another lot (unique index
  // backstops), project.property_type = 'production' (set it if null). Denormalizes
  // division_id onto the project. Sets lot status -> started if it was earlier.
export async function detachProjectFromLot(lotId: string, orgId?: string): Promise<LotDTO>
  // Rare correction path; reverts lot to 'assigned'; clears projects.division_id
  // only if it came from this lot's community.
export async function deleteLot(id: string, orgId?: string): Promise<void>
  // Only when no project linked and status in (controlled, owned, developed).
```

Permissions: reads `community.read`; mutations `lot.write`; `attachProjectToLot`
additionally requires `project.manage`.
Events: `lot.created` (one per bulk batch with count), `lot.updated`,
`lot.status_changed`, `lot.project_attached`, `lot.project_detached`.

### Posture wiring (`lib/product-tier.ts`)

```ts
export type ProjectPosture = "residential" | "commercial" | "production"

export function getProjectPosture(propertyType, orgTier): ProjectPosture {
  if (propertyType === "production") return "production"
  if (propertyType === "commercial") return "commercial"
  if (propertyType === "residential") return "residential"
  if (orgTier === "commercial") return "commercial"
  if (orgTier === "production") return "production"
  return "residential"
}

export function getDefaultProjectPropertyType(orgTier: ProductTier): ProjectPosture {
  if (orgTier === "commercial") return "commercial"
  if (orgTier === "production") return "production"
  return "residential"
}
```

Then chase the compiler: every switch/record keyed by `ProjectPosture` must gain a
`production` arm deliberately (terminology already has one). Project creation flows
must accept `property_type = 'production'` — find the project-create Zod schema and
widen its enum. `getProjectFinancialFeatureConfig` (`lib/financials/billing-model.ts`):
production-posture projects with no billing contract default to fixed-price with
draws/SOV/pay-app surfaces HIDDEN (`showDraws`-equivalent false — inspect the config
flags and set posture-aware defaults; the buyer flow is one closing invoice, master
§5.6). Receivables keeps plain invoices. Workstream 06 owns the real purchase-
agreement billing; WS01 only ensures nothing residential-shaped (draw tab) or
commercial-shaped (SOV tab) appears by default on a production project.

### Reporting scope (`lib/services/reporting-scope.ts`)

Extend the existing file — same doctrine (explicit project-id sets):

```ts
export async function getCommunityProjectIds(supabase, orgId, communityId): Promise<string[]>
  // select project_id from lots where org_id = $1 and community_id = $2 and project_id is not null
export async function getDivisionProjectIds(supabase, orgId, divisionId): Promise<string[]>
  // select id from projects where org_id = $1 and division_id = $2
export function applyProjectIdScope<Q>(query: Q, projectIds: string[] | null): Q
  // null = no scoping; [] = impossible filter (project_id.in.())
```

Org desks that gain a Community/Division filter (Phase 5) resolve the id set once,
then reuse their existing queries through `applyProjectIdScope` alongside
`applyReportingExclusion`. No desk grows a new aggregation path.

## Server actions + validation

- `app/(app)/communities/actions.ts` — thin `ActionResult` wrappers over the three
  services: `createCommunityAction`, `updateCommunityAction`, `archiveCommunityAction`,
  phase + takedown actions, `createLotsAction`, `updateLotAction`,
  `bulkUpdateLotsAction`, `setLotStatusAction`, `attachProjectToLotAction`,
  `detachProjectFromLotAction`, `deleteLotAction`. Every action: Zod parse →
  service call → `revalidatePath` → `{ success, data } | actionError(e)`.
- Division actions live with the settings surface:
  `app/(app)/settings/divisions/actions.ts` (or the settings-tab actions file the
  Team tab uses — match the sibling).
- `lib/validation/communities.ts` — `communityInputSchema`, `phaseInputSchema`,
  `takedownInputSchema` (cents: `z.number().int().min(0)`; dates ISO strings).
- `lib/validation/lots.ts` — `lotCreateSchema`, `lotUpdateSchema`,
  `bulkLotPatchSchema` (`lotIds` max 500), `lotRangeSchema`
  (`{ fromNumber: number, toNumber: number, prefix?: string, phaseId?, takedownId? }`,
  max 500 per batch — the action expands the range into rows before calling
  `createLots`), `lotStatusSchema` (the enum + `force` boolean).
- `lib/validation/divisions.ts` — name required/trimmed, code ≤ 8 chars uppercase.

## UI spec

Design rules bind hard: tokens only, radius 0, no hero/marquee, shadcn primitives,
dense editorial tables with `tabular-nums` money, color = state only. Every view:
empty + loading + error states, dark mode. Match sibling density (`/projects` list,
financials tabs).

### `app/(app)/communities/page.tsx` — Communities list (entry surface)

- Server component. Title row ("Communities" + New community button gated
  `community.write`), then the table — page opens with the work.
- Columns: Community, Division (only rendered when `orgHasDivisions()`), Status,
  City/State, Lots (total), then per-status count chips (controlled / owned /
  developed / assigned / started / closed — muted text, numbers only), Planned.
- Filters: status select; division select (only when org has divisions). Row click
  → `/communities/[id]`.
- Empty state: "No communities yet" + one-line explainer + New community CTA.
- This page passes the desk rule as the noun's list page (like `/projects`), not a
  symmetry desk: mutations live in the workbench below.

### `app/(app)/communities/[id]/` — Community workbench

Route structure (mirrors the project workbench pattern of nested segments):

```
app/(app)/communities/[id]/page.tsx        -> Lots (default tab, the centerpiece)
app/(app)/communities/[id]/land/page.tsx   -> Phases & takedowns
app/(app)/communities/[id]/settings/page.tsx -> name/division/status/code/address
app/(app)/communities/[id]/layout.tsx      -> header (name, division, status) + tab strip
app/(app)/communities/[id]/loading.tsx     -> skeleton table
```

**Lot grid (the centerpiece):**
- Dense table, server-paginated (100/page; pager identical to the repo's existing
  pagination exemplar — find one, e.g. payables/directory, and copy it). Above the
  table: status filter chips WITH counts (from `getLotStatusCounts` — counts are for
  the whole community, not the page), phase filter, search box (lot # / address),
  and the New lots button (`lot.write`).
- Columns: Lot (block-lot label), Phase, Status (small state-colored badge — reuse
  the existing status-badge primitive), Address, Dimensions (w×d ft, muted),
  Swing, Premium (right-aligned tabular-nums, "—" when 0), Takedown (name, muted),
  Project (link to `/projects/[id]` when attached; otherwise em dash).
- Row actions (dropdown): Edit, Set status…, Attach project… / Open project,
  Delete (only when deletable). Multi-select checkboxes → bulk bar (Set status,
  Assign phase, Assign takedown) calling `bulkUpdateLotsAction`.
- **New lots dialog**: two modes in one small Dialog — "Range" (prefix + from/to +
  phase + takedown → preview count) and "Single" (full field set). No wizard.
- Edit lot: a compact Sheet (detail-sheet exemplar: invoice detail sheet in
  `components/invoices/`) with the land fields + status timeline (from audit rows).
- Attach project: dialog with a project search (existing project-picker component if
  one exists — grep before building) filtered to unlinked, non-archived projects;
  offers "Create project from this lot" later (WS05) — WS01 only links existing.
- Empty state (no lots): centered quiet block + "Add lots" CTA. Error state: the
  repo's standard error boundary presentation. 400 lots: verified snappy because
  the page never loads more than `pageSize` rows and counts are one grouped query.

**Land tab:** two stacked dense tables — Phases (name, #, status, target open,
lot count) and Takedowns (name, scheduled/actual date, lot count linked vs
contracted, price/lot, deposit, status, Close action). Inline create rows via small
dialogs. **Settings tab:** plain form, `community.write`, archive at the bottom.

Client components live under `components/communities/` (`lot-table.tsx`,
`lot-create-dialog.tsx`, `lot-detail-sheet.tsx`, `community-form.tsx`,
`takedown-table.tsx`, …) with the client boundary as low as possible — the pages
stay server components that fetch via `Promise.all`.

### Divisions UI (settings surface — zero UI for null-division orgs)

- New settings entry "Divisions" in `app-sidebar.tsx` `settingsItems`, rendered only
  when `productTier === "production"` OR the org already has divisions (pass a flag
  from the layout the same way `productTier` is passed today).
- `app/(app)/settings/divisions/page.tsx`: single dense table (Name, Code, Region,
  Communities, Active projects, actions), inline create dialog, archive with
  in-use guard. `division.manage` gates mutations.
- Team tab: when the org has divisions, the member edit surface gains a Division
  scope control (All divisions / Selected…) mirroring the existing project-scope
  toggle UI exactly. Hidden entirely otherwise.

## Nav + posture wiring

**Workspace sidebar** (`app-sidebar.tsx` `buildWorkspaceGroups`): add to
`workspaceItems` after Projects, following the existing commercial-Safety precedent:

```ts
if (productTier === "production") {
  workspaceItems.push({
    title: "Communities",
    url: "/communities",
    icon: Building2,   // or Map — pick from components/icons, no new icon lib
    isActive: pathname.startsWith("/communities"),
    requiredAny: ["community.read"],
  })
}
```

The route itself is NOT tier-gated (tier never gates data — a mixed org that got a
community via support tooling can still open the URL); only the nav default is.

**Project nav** (`project-nav-items.ts` + `lib/project-modules.ts`): with
`ProjectPosture` widened, every `postures: ["commercial"]` entry (Specifications,
Meetings, Transmittals, Inspections, Safety) automatically excludes production —
correct and intended for WS01 (inspections/safety return as production defaults in
workstream 05/06 when the field suite is tuned; flipping is a one-array change).
Items with no `postures` (Schedule, Daily Logs, Photos, Punch, RFIs, Submittals,
Decisions, Documents, Drawings, Bids, Signatures, Warranty, Closeout) show for
production. Financial sub-tabs stay driven by `getProjectFinancialFeatureConfig`
(see posture wiring above): production default = Review / Budget / Receivables /
Payables / Expenses / Change Orders / Reports; no draws surface, no SOV/pay-apps,
no T&M. Lien Waivers stays (payables-side is universal). `module_overrides` lets
any project deviate — no new mechanism needed.

**Overview breadcrumb:** a production project linked to a lot shows
"Community · Lot" (link to the community) in the project header area — small,
muted, matching existing header metadata style. Resolve via one query in the
project layout only when posture is production.

## RBAC, events, search index, notifications

**Migration 6 — `202607DD######_land_permissions.sql`** (follow
`20260710140200_progress_billing_permissions.sql`; also fold the same statements
into the desired-state list in `20260708120500_rbac_catalog_seed.sql` so a rebuild
stays correct):

```sql
insert into public.permissions (key, description) values
  ('community.read',  'View communities, phases, lots, and takedowns'),
  ('community.write', 'Create and manage communities, phases, and lot takedowns'),
  ('lot.write',       'Create and edit lots and lot status'),
  ('division.manage', 'Create and manage org divisions and division scoping')
on conflict (key) do update set description = excluded.description;

-- Grants to existing roles:
--   community.read  -> org_owner, org_admin, org_office_admin, org_project_lead,
--                      org_user, org_viewer, org_estimator, pm, field
--   community.write -> org_owner, org_admin, org_office_admin
--   lot.write       -> org_owner, org_admin, org_office_admin, org_project_lead, pm
--   division.manage -> org_owner, org_admin
-- (unnest(array[...]) pattern, on conflict do nothing)

insert into roles (key, label, scope, description) values
  ('org_land_manager', 'Land & Community Manager', 'org',
   'Land pipeline and community operations. Manages communities, phases, lots, and takedowns; no access to job financials.')
on conflict (key) do update set label = excluded.label, scope = excluded.scope, description = excluded.description;
-- org_land_manager grants: org.member, org.read, project.read, report.read,
-- community.read, community.write, lot.write, directory.read, docs.read, docs.download
```

`org_land_manager` is the one WS01 persona (master §7.11's other roles — purchasing
manager, starts coordinator, sales agent, service manager — belong to the
workstreams that build their surfaces; seeding them without permissions to hold
would be trash). Add all four keys to `TEAM_PERMISSION_OPTIONS` in
`lib/services/team.ts`, and `org_land_manager` to whatever assignable-role list the
Team UI uses (find where `org_bookkeeper`/`org_estimator` are surfaced and mirror).

**Events:** listed per service above; all via `recordEvent`. **Audit:** every
mutation calls `recordAudit` with entity types `division`, `community`,
`community_phase`, `lot`, `lot_takedown`.

**Search index** (`lib/services/search-index.ts`): register `community` and `lot`
in `AUDIT_ENTITY_TYPE_TO_SEARCH` (title = community name / "Lot {block-number} —
{community}"; url = the workbench routes). Divisions, phases, and takedowns are NOT
registered — they are settings-grade objects nobody global-searches.

**Notifications:** none. No new entries in `EMAIL_NOTIFICATION_TYPES`
(`lib/types/notifications.ts`) — nothing in WS01 should email. Takedown-due
reminders are an open question below, deliberately deferred.

**proxy.ts / crons:** no new public routes, no crons. Nothing to add.

## Migration plan (recap)

| # | File (`supabase/migrations/`) | Contents |
|---|---|---|
| 1 | `202607DD######_project_property_type_production.sql` | enum value (own file) |
| 2 | `202607DD######_divisions.sql` | divisions + projects.division_id |
| 3 | `202607DD######_communities_phases.sql` | communities, community_phases |
| 4 | `202607DD######_lots_and_takedowns.sql` | lot_takedowns, lots |
| 5 | `202607DD######_membership_division_scope.sql` | division_scope + membership_divisions |
| 6 | `202607DD######_land_permissions.sql` | permission keys, grants, org_land_manager |

All additive; each table ships RLS + indexes + updated_at trigger in its own file.
Write files, then STOP for human approval before assuming tables exist (process
contract §5.4 of the commercial master — local env points at production Supabase).
Before writing, re-verify with MCP `list_tables` that none of these names appeared
since 2026-07-16, and confirm the directory-companies FK target for
`lot_takedowns.seller_company_id`.

## Phases

### Phase 1 — Posture end-to-end (no new tables yet except the enum)

Migration 1; `ProjectPosture` widened; `getProjectPosture` /
`getDefaultProjectPropertyType` / terminology arms; project-create validation
accepts `production`; nav + module filtering compile with the third posture;
`getProjectFinancialFeatureConfig` production defaults.

- [ ] Enum migration written (pending apply) and TS compiles with three postures —
      every posture switch handled deliberately, none by fallthrough accident.
- [ ] In the QA org (tier flipped to `production` by platform admin): new projects
      default to `property_type='production'`; the project workbench shows Buyer
      terminology; specs/meetings/transmittals/inspections/safety absent; financial
      tabs show no draws/SOV surfaces; a `module_overrides` flip can re-enable any
      hidden module.
- [ ] Residential + commercial projects in the same org: zero visible change
      (spot-check one of each posture).
- [ ] `pnpm lint` clean.

### Phase 2 — Divisions + communities + lots data layer

Migrations 2–4 + 6; `divisions.ts`, `communities.ts`, `lots.ts` services;
validation schemas; actions files; events/audit/search-index registration;
`TEAM_PERMISSION_OPTIONS` additions.

- [ ] Migrations written (pending apply); DDL matches this doc or deviations noted.
- [ ] Service CRUD round-trips in the QA org: division → community (in division) →
      2 phases → takedown (12 lots, deposit) → bulk-create lots 1–48 → close
      takedown flips its linked lots to `owned` with `acquired_date`.
- [ ] Lifecycle guards: `started` without project rejected; leaving `closed`
      without `force` rejected; duplicate lot_number batch fails with named lots.
- [ ] Every mutation produces an `events` row and an `audit_log` row; communities
      and lots appear in global search after creation.
- [ ] `pnpm lint` clean.

### Phase 3 — Community workbench + Communities list UI

Routes and components per the UI spec; workspace sidebar Communities item;
divisions settings page.

- [ ] `/communities` list with counts, filters, empty state; sidebar item appears
      for the production-tier QA org only.
- [ ] Workbench: paginated lot grid at 400 lots (seed via range-create in the QA
      org) — pager works, status-chip counts reflect the whole community, search
      and phase filter compose with pagination.
- [ ] Range-create, edit sheet, bulk status change, attach project → lot shows
      project link, project gains `division_id`, project header shows
      Community · Lot; detach reverts.
- [ ] Land tab: phase + takedown tables with create/close flows.
- [ ] Divisions settings page: create/edit/archive with in-use guard; entry hidden
      for a non-production org with zero divisions.
- [ ] Empty/loading/error states + dark mode verified on every new view; density
      matches `/projects`.
- [ ] `pnpm lint` clean.

### Phase 4 — Division RBAC scope

Migration 5; `authorization.ts` division-scope resolution; team UI scope control;
service-level filtering in `listCommunities`/`listLots` and the desk helpers.

- [ ] A QA member with `division_scope='assigned'` + one division sees only that
      division's communities/lots; org desks' community/division filters offer only
      allowed divisions; `org.admin` unaffected.
- [ ] Orgs without divisions: no behavior change, no UI (verify a residential org).
- [ ] `pnpm lint` clean.

### Phase 5 — Rollup scoping on org desks

`reporting-scope.ts` helpers; Community/Division filter added to the org desks
where production PMs live — minimum set: `/billing`, `/payables`, `/schedule`
(portfolio Gantt rows filterable), plus the projects list. Filter UI only renders
when the org has ≥1 community (community filter) / ≥1 division (division filter).

- [ ] Each desk filtered by community shows exactly the lots' linked projects'
      rows; division filter composes; excluded-from-reporting projects still
      excluded; desks with no filter selected are byte-identical to before.
- [ ] No desk loads unbounded project-id lists into the client — id sets resolve
      server-side.
- [ ] `pnpm lint` clean.

## Test plan

- `pnpm lint` after every phase (type-aware; the Phase 1 posture-widening is
  deliberately compiler-driven).
- Unit tests for the pure parts, node-test style in `tests/` (the pattern
  `tests/pay-app-math.test.js` established): lot lifecycle transition matrix
  (allowed/blocked/force), lot-range expansion (prefix, bounds, cap at 500),
  posture resolution (`getProjectPosture` 3×3 property_type × tier matrix). Keep
  the logic in pure modules (`lib/land/lot-lifecycle.ts` or similar) so tests need
  no DB. Wire into an existing test script or add `test:land` mirroring
  `test:financials`.
- Financials untouched except `billing-model.ts` defaults → run
  `pnpm test:financials` once in Phase 1 and confirm 0 regressions.
- Manual acceptance runs in the dedicated QA org only (tier flipped to
  `production` for it) — never a customer org.

## Open questions

1. **Takedown-due reminders** — a cron + email for approaching `scheduled_date`
   is obvious value but adds a notification type and cron registry entry; deferred
   until a real user asks (WS05's starts calendar may subsume it).
2. **Community-level document/photo storage** — communities will eventually want
   files (plats, HOA docs). WS01 ships none; if needed early, reuse the files
   service keyed by a community entity rather than inventing storage.
3. **`projects.community_id` denormalization** — deliberately NOT added (master
   §5.2 denormalizes only division_id; community resolves via `lots.project_id`).
   If Phase 5 desk queries prove the join painful at scale, add the column in a
   follow-up migration with the same service-maintained discipline, and note it.
4. **Inspections/safety defaults for production** — hidden in WS01 (arrays say
   commercial-only). Workstream 05/06 decide whether production supers get them by
   default; it is a one-line `postures` array change when they do.
5. **Where "assigned" gets set automatically** — WS02 (plan attached) and WS06
   (buyer attached) will both want to auto-advance `controlled/owned/developed →
   assigned`; they must route through `setLotStatus` so the audit trail stays whole.
