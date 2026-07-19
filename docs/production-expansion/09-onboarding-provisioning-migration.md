# Workstream 09 — Onboarding, Provisioning & Migration

> Prereq: `00-MASTER-production-expansion.md` read fully — especially §5 (data model),
> §6 (this doc executes LAST, after every other workstream, but is drafted early so the
> other docs build importable entities), and §8 (onboarding doctrine — this doc is its
> full expansion). Also read `docs/client-provisioning-gameplan.md` (shipped July 2026 —
> the provisioning machinery this doc extends) and the entity DDL in workstreams
> 01/02/03/08 (importer targets). Workstreams 04/05/06 may not be on disk yet when you
> read this: where this doc references their entities (POs, start packages), master §5
> rules 4–5 are authoritative and the column specifics here are deliberately loose.

## STATUS — IMPLEMENTED AND DEPLOYED; QA-ORG/SCALE ACCEPTANCE PENDING

Updated 2026-07-19. Phases 1–5 are implemented in the repository and the Phase 6
playbook/readiness gate is productized. The shared staged-import framework, seven
importers, AI suggest-only mapping, production onboarding workbench, org-side import
door, full NAHB seed, Open-WIP current-state cutover, and resettable Cypress Landing
sample community are wired end to end.

Live Arc Supabase deployment is complete:

- [x] `20260719112607` — `onboarding_and_import_staging`
- [x] `20260719112644` — `onboarding_permissions`
- [x] `20260719112756` — `onboarding_fk_indexes` advisor hardening
- [x] Live verification: four tables, RLS/policies, actor and workflow indexes, and
  `import.manage` grants for owner/admin/office-admin/land/purchasing roles.
- [x] Advisor verification: no Workstream 09 security or unindexed-foreign-key
  findings remain. Newly created indexes report only the expected never-used-yet
  informational notices.
- [x] Automated verification: `pnpm lint`, 8 GB TypeScript no-emit check,
  `pnpm test:onboarding` (6/6), and `pnpm test:financials` (95/95).
- [ ] Pending acceptance: signed-in QA-org upload/map/fix/commit walkthroughs,
  canned live-model header mapping, 5k-row grid/commit timing, synthetic
  250-project/400-lot readiness audit, full simulated onboarding through the first
  Arc-native start, and dark-mode/empty/loading/error visual review. No customer or
  production org was seeded merely to manufacture acceptance evidence.

## Mission

Production builders arrive BIG: divisions in multiple states, multiple legal entities
and accounting files, hundreds of in-flight houses, a plan library and price book
living in spreadsheets or a legacy ERP (MarkSystems, NEWSTAR, Buildertrend, Hyphen
BRIX). Onboarding is a **product surface, not a services engagement**. This workstream
delivers:

1. **A staged production-onboarding checklist** per org (platform admin surface):
   org shell → tier → divisions → accounting → cost codes → plan library → options →
   price book → communities/lots → team → open-WIP cutover → pilot go-live. Every
   stage has explicit data requirements, an importer, validation gates, done-criteria,
   and an owner (platform team vs customer admin).
2. **Seven first-class importers** — cost codes, plan library, option catalog, price
   book, communities/phases/lots, open-WIP, team — all **idempotent, dry-runnable,
   and staged** (upload → parse → stage → review/fix in grid → commit), following the
   QBO-import workspace grid as the reference UX.
3. **An NAHB residential cost-code seed** as a catalog-as-code alternative to the CSI
   seed (production builders use NAHB-style codes, not CSI).
4. **AI-assisted column mapping** for legacy-ERP exports whose grids don't match our
   CSV templates — suggestions only, human-confirmed in the staging grid.
5. **A phased go-live playbook** (pilot community/division → waves) and an
   **org-scale readiness audit** turning master §7.7 into a checkable list.
6. **A production sample community** for demos and training (analog of the existing
   sample project).

**The doctrine sentence that rules everything here (master §8):** in-flight houses
import at *current state* — budget snapshot, open PO balances, remaining schedule —
**never reconstructed history**. The first fully Arc-native start per community is the
real go-live.

---

## 1. Current-state audit (code-verified 2026-07-17)

| Concern | Where | State |
|---|---|---|
| Org provisioning service | `lib/services/provisioning.ts` → `provisionOrganization()` | Creates org (with `product_tier`), owner invite, trialing subscription, entitlements. Already branches seeds by tier: `commercial` → `seedCSICostCodes` + `seedChecklistTemplates`; else → `seedNAHBCostCodes`. |
| Provisioning UI | `components/platform/provision-org-sheet.tsx` + `provisionPlatformOrgAction` in `app/(app)/platform/actions.ts` | The single door (client-provisioning gameplan executed). Trial-first; optional price section → `activateOrgBilling`. |
| Billing activation | `lib/services/billing.ts` → `activateOrgBilling()` (~L181) | Stripe price + auto plan row + checkout/ACH-invoice. Reuse untouched — production orgs activate billing exactly like everyone else. |
| Dead directory | `app/(app)/admin/provision/` | **Empty directory left behind** by the provisioning consolidation. Delete it in Phase 1 (leave no trash). |
| Platform admin surfaces | `app/(app)/admin/` — `customers/`, `plans/`, `users/`, `ops/`, `analytics/` | Customers desk has per-org row actions (activate billing, extend trial). The onboarding checklist and importer workspace land here. |
| CSI seed (exemplar) | `lib/services/cost-codes.ts` → `seedCSICostCodes()` backed by `lib/data/csi-masterformat.ts` | Catalog-as-code: data module + idempotent upsert on `(org_id, code)`, `ignoreDuplicates`. **This is the pattern the NAHB seed must match.** |
| NAHB seed (stub) | `lib/services/cost-codes.ts` → `seedNAHBCostCodes()` | Exists but is a ~43-row inline array using CSI-style divisions (01–16), not real NAHB numbering. §4 replaces it. |
| Cost-code CSV import (stub) | `lib/services/cost-codes.ts` → `importCostCodes()` | Bare upsert, no staging/validation/dry-run. Absorbed into importer #1; the naive function is deleted when its callers move. |
| Import workspace pattern | `lib/services/qbo-import.ts` (3.7k lines) + `components/integrations/qbo-import-sheet.tsx` / `qbo-sync-sheet.tsx` Import tab | The reference UX: listing → staged grid → inline-editable destination column + bulk assign → per-row validation → commit batch (`importQboRecords`) with batch-invariant caches, org-validated destinations, per-row skip/error results. |
| AI assist pattern | `lib/services/receipt-extraction.ts` (also `document-ai-rename.ts`) | Gemini vision via `getPlatformAiFeatureDefaultConfig()` model resolution, strict-JSON prompt, **zod `z.preprocess` normalization schemas**, `confidence` + `notes` fields, human confirms before anything persists. §6 reuses this exact shape for column mapping. |
| Sample data seed | `lib/services/demo-seed.ts` → `seedSampleProject()` / `deleteSampleProject()` | Spec-constant-driven (`SAMPLE_PROJECT_SPEC`), created through real services, `metadata.is_sample` marker, idempotent. §9's community seed is its sibling. |
| RBAC catalog | `supabase/migrations/20260708120500_rbac_catalog_seed.sql` | Catalog-as-code, idempotent. New keys/roles land as a new migration in this pattern (WS01 adds `community.*`, `lot.write`, `division.manage`, `org_land_manager`). |
| Templates (import targets) | `schedule_templates` (org-scoped, `items` jsonb), `estimate_templates`, `checklist_templates`; WS02 adds `budget_templates` (+lines) | Plan-library importer writes template rows through WS02's services. |
| Directory | `lib/services/companies.ts` / `directory.ts` | Vendor match target for the price-book importer (fuzzy match + create-missing). |
| Entity targets | WS01: `divisions`, `communities`, `community_phases`, `lots`, `lot_takedowns`, `membership_divisions`. WS02: `house_plans`, `house_plan_elevations`, `house_plan_versions`, `house_plan_takeoff_lines`, `community_plan_availability`, `budget_templates`. WS03: catalog-lifted `selection_categories`/`selection_options`, `selection_catalog_prices`, `selection_packages`. WS04: `vendor_price_agreements`, POs as `commitments` (`commitment_type='purchase_order'`). WS08: `accounting_connections`, `accounting_entity_map`. | All verified against the workstream DDL on disk (01/02/03/08). Re-verify against the live schema before writing any importer — these docs may drift during execution. |
| No staging infra exists | — | There are no generic `import_batches`/`import_rows` tables, no CSV-parse service, no mapping-profile storage. All net-new (§2.2). |

---

## 2. The onboarding sequence — product spec

### 2.1 Where it lives

`app/(app)/admin/customers/[orgId]/onboarding` — a platform-admin page (the customers
desk already owns per-org operations; deep-link from a new "Onboarding" cell on the
customers table for orgs with `product_tier='production'` or an active onboarding run).
This is a **workbench for the platform team** during white-glove onboarding; individual
stages marked `customer_admin`-owned get a mirrored, reduced surface inside the org at
`app/(app)/settings/imports` (org-scoped, permission-gated) so a capable customer admin
can run their own importers. Same services, two doors, one mutation home each
(the stage-completion mutation lives ONLY on the platform page).

Gate: platform pages use the existing platform-access pattern
(`lib/services/platform-access.ts` — copy how `admin/customers/page.tsx` gates).
Org-side `settings/imports` requires the new `import.manage` permission (§10).

### 2.2 Data model — `onboarding_runs` + generic import staging

One migration, `202607DD######_onboarding_and_import_staging.sql`:

```sql
create table public.onboarding_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  kind text not null default 'production' check (kind in ('production')),
  status text not null default 'active'
    check (status in ('active','live','abandoned')),
  -- Stage state machine, one jsonb blob keyed by stage key (§2.3). Each entry:
  -- { status: 'pending'|'in_progress'|'done'|'skipped', completed_at, completed_by,
  --   notes, evidence: {counts...} }. A jsonb blob, not rows: stages are a fixed
  --   ordered catalog in code (STAGE CATALOG below), not user data.
  stages jsonb not null default '{}'::jsonb,
  pilot_community_id uuid,          -- FK added after WS01 tables exist in prod
  pilot_division_id uuid,
  target_live_date date,
  notes text,
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index onboarding_runs_active_idx
  on public.onboarding_runs (org_id) where status = 'active';

-- Generic import staging: ALL seven importers share these two tables.
create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  importer text not null check (importer in (
    'cost_codes','plan_library','option_catalog','price_book',
    'communities_lots','open_wip','team')),
  status text not null default 'parsing'
    check (status in ('parsing','staged','committing','committed','failed','discarded')),
  source_file_id uuid references public.files(id),   -- uploaded CSV (files service)
  source_filename text,
  -- Confirmed column mapping: { target_column: source_header | null } — human-approved,
  -- whether hand-picked or AI-suggested (§6).
  column_mapping jsonb not null default '{}'::jsonb,
  row_count integer not null default 0,
  valid_count integer not null default 0,
  warning_count integer not null default 0,
  error_count integer not null default 0,
  committed_count integer not null default 0,
  skipped_count integer not null default 0,
  -- Dry-run report from the last stage/validate pass: per-check summaries the review
  -- grid header renders ("14 vendors unmatched", "3 duplicate codes").
  report jsonb not null default '{}'::jsonb,
  context jsonb not null default '{}'::jsonb,        -- importer-specific knobs, e.g.
                                                     -- {community_id} for lots-only files
  onboarding_run_id uuid references public.onboarding_runs(id),
  created_by uuid references public.app_users(id),
  committed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index import_batches_org_idx on public.import_batches (org_id, importer, status);

create table public.import_rows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  batch_id uuid not null references public.import_batches(id) on delete cascade,
  row_number integer not null,                       -- 1-based, matches source CSV
  raw jsonb not null,                                -- source cells keyed by header
  parsed jsonb not null default '{}'::jsonb,         -- normalized, typed values
  status text not null default 'pending'
    check (status in ('pending','valid','warning','error','committed','skipped')),
  issues jsonb not null default '[]'::jsonb,         -- [{level,'code',message,column}]
  -- Idempotency spine: deterministic natural key per importer (§3 tables define each).
  natural_key text not null,
  -- Set on commit: what this row became (or matched).
  target_entity_type text,
  target_entity_id uuid,
  action text check (action in ('created','updated','skipped_existing','skipped_error')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id, row_number)
);
create index import_rows_batch_idx on public.import_rows (batch_id, status);
create index import_rows_natural_key_idx on public.import_rows (org_id, batch_id, natural_key);
```

Both tables: org-scoped RLS with `(select auth.uid())` initplan pattern, standard
`updated_at` triggers, copied from a recent neighboring migration. `import_rows.raw`
is bounded — a 10k-row cap per batch (§3.0) keeps the table sane; batches are
disposable and a cleanup cron is deliberately NOT built (they're audit evidence of
the migration; revisit only if volume ever matters).

### 2.3 Stage catalog

Code-owned constant `ONBOARDING_STAGES` in the new `lib/services/onboarding.ts`
(order is the array order; the UI renders exactly this):

| # | Key | Stage | Data required (from customer) | Tooling | Validation gates (must pass to mark done) | Done-criteria | Owner |
|---|---|---|---|---|---|---|---|
| 1 | `org_shell` | Org shell + tier | Company name, owner email, division list | `/platform` provision sheet with `product_tier='production'` | Org exists, owner invite accepted or pending, tier = production | Org row live; onboarding run created | Platform |
| 2 | `divisions` | Divisions | Division names/codes/regions (often = legal entities, but not necessarily 1:1) | WS01 divisions admin UI (no importer — rarely >10 rows) | Every planned community has a division to land in; skip allowed for single-division orgs | Divisions created or stage skipped | Platform |
| 3 | `accounting` | Accounting connections + entity map | Which books exist, which division/community posts where; QBO logins if connecting | WS08 connections UI + entity-map editor | EITHER ≥1 active `accounting_connections` row and an org-default `accounting_entity_map` row, OR the org is explicitly flagged **accounting-unconnected** (a deliberate choice recorded in stage notes — master §8: Intacct/NetSuite builders go live Arc-native, connect later via WS08 adapter as config, not migration) | Entity map resolves for a test project via `resolveAccountingTarget`, or unconnected acknowledged | Platform + customer controller |
| 4 | `cost_codes` | Cost-code structure | Their code list as CSV, or the decision to adopt the NAHB seed | NAHB seed (§4) and/or importer #1 | Zero duplicate codes; every code used by later files (takeoffs, price book, WIP budgets) will resolve | Cost codes committed; count recorded in stage evidence | Customer admin (platform assists) |
| 5 | `plan_library` | Plan library | Plans/elevations CSV + takeoff lines CSV; plan-set PDFs separately | Importer #2; **drawings upload separately through the existing drawings pipeline** (one canonical set per project — plan PDFs attach to plan versions as `files`, NOT through a new pipeline) | All takeoff cost codes resolve; every plan has ≥1 elevation; released versions have takeoff lines | Plans committed + versions released | Customer admin |
| 6 | `option_catalog` | Option catalog | Categories/options/pricing CSV | Importer #3 | Category tree resolves; plan-applicability rows reference imported plans; price/cost sanity (price ≥ 0) | Catalog committed | Customer admin |
| 7 | `price_book` | Price book | Vendor agreements CSV | Importer #4 | ≥95% of rows vendor-matched or explicitly created; cost codes resolve; no overlapping effective ranges per (vendor, cost code, scope) | Agreements committed | Customer admin (platform assists on vendor matching) |
| 8 | `communities_lots` | Communities/phases/lots | Communities+phases+lots CSV(s), takedown schedule | Importer #5 | Lot numbers unique per community/block; premiums parse; statuses legal; every lot's community exists | Communities + lots committed; counts match customer's own tally | Customer admin |
| 9 | `team_rbac` | Team + RBAC | Team roster CSV with personas | Importer #6 (team) | Every row maps to a catalog role; ≥1 org admin besides the owner; division scoping set for divisioned orgs | Invites sent; role mapping reviewed against §10's persona table | Platform + customer admin |
| 10 | `open_wip` | Open-WIP cutover | Per-house WIP workbook (lot, plan/version, stage, budget totals, open PO balances, buyer for sold homes) | Importer #7 | Every house's lot+plan resolve; budget totals = sum of lines; PO remaining ≤ original; **as-of date recorded**; schedule anchor task exists in template | All in-flight houses live as projects at current state; spot-check 5 against legacy | Platform (this is the risky one) |
| 11 | `pilot_live` | Pilot go-live | Pilot community/division choice; parallel-run rules agreed (§7) | Checklist only | Scale-readiness audit (§8) passed for this org's volumes; pilot users trained on sample community (§9) | First fully Arc-native start released in the pilot community — recorded with project id in stage evidence | Both |

Rules:

- Stages complete in order EXCEPT: 5/6/7 (plan/options/price book) may run in
  parallel once 4 is done; 9 (team) may run any time after 1. The service enforces
  hard prerequisites only where data depends on data (4→5,6,7; 8→10; 5→10).
- `skipped` is legal only where the table says so (divisions; option catalog for a
  builder without a design studio; accounting per the unconnected clause). A skip
  records who and why.
- Marking a stage done is a mutation on the platform page only:
  `completeOnboardingStage(runId, stageKey)` re-runs that stage's validation gates
  server-side (they are functions, not honor-system checkboxes) and refuses with the
  failing gate's message. `recordEvent('onboarding_stage_completed')` + audit.

### 2.4 `lib/services/onboarding.ts`

Canonical service shape (`requireOrgContext` on org-scoped reads; platform-gated
mutations follow the admin/customers action pattern):

```
createOnboardingRun(orgId)                       -- 1 active per org (partial unique idx)
getOnboardingRun(orgId)                          -- run + computed stage statuses + gate results
completeOnboardingStage({runId, stageKey, notes}) / skipOnboardingStage(...)
markRunLive(runId)                               -- requires all stages done/skipped
```

Gate implementations live beside the stage catalog as
`ONBOARDING_STAGE_GATES: Record<StageKey, (ctx) => Promise<GateResult[]>>` — each
gate is a cheap org-scoped count/exists query (e.g. stage 8's "every lot's community
exists" is definitionally true post-commit; its real gate is "committed batch for
importer `communities_lots` exists with error_count 0 and counts confirmed").

---

## 3. Importer framework + the seven importers

### 3.0 Shared framework — `lib/services/imports.ts`

One framework, seven `ImporterDefinition`s. The QBO import workspace is the UX
reference (staged grid, inline-fix, bulk assign, per-row results); this framework is
its generalization for CSV sources.

```
interface ImporterDefinition<Row> {
  key: ImporterKey
  columns: ImportColumnSpec[]        -- target columns: key, label, required, type,
                                     -- enum values, example (drives CSV template
                                     -- download AND the mapping UI)
  naturalKey(parsed: Row): string    -- deterministic; idempotency spine
  parseRow(raw, ctx): { parsed, issues }        -- typing + normalization
  validateBatch(rows, ctx): BatchReport         -- cross-row + against-DB checks
  commitRows(rows, ctx): Promise<RowResult[]>   -- chunked (500/chunk), through the
                                     -- OWNING workstream's service functions wherever
                                     -- they exist (create through services, not raw
                                     -- inserts) — the same rule demo-seed.ts follows
}
```

Pipeline (server actions in the admin/customers actions file, all Zod-validated,
returning `{ success, error }`):

1. **Upload** — CSV/XLSX-exported-CSV through the existing files service; cap 10MB,
   10k rows (covers 2× the largest expected file — 5k price rows).
2. **Parse + map** — header row read; if headers ≠ template columns, the mapping step
   (manual picker, AI-assisted §6) produces `column_mapping`; then every row is
   `parseRow`'d into `import_rows` with per-cell issues.
3. **Stage (= dry run)** — `validateBatch` runs the against-DB checks and writes the
   batch `report`. **This IS the dry run**: staging never writes domain tables. A
   "Validate again" button re-runs it after grid edits.
4. **Review/fix in grid** — dense table (§9 UI spec): status column, issue tooltips,
   inline-editable cells (edits patch `parsed`, revalidate the row), bulk actions
   (skip all errors, set column X for selected — mirrors QBO bulk-assign), filter by
   status.
5. **Commit** — only when `error_count = 0` OR erroring rows are explicitly skipped.
   `commitRows` per chunk inside the framework's claim (`status='committing'` guard,
   single-flight per batch); each row records `action` + `target_entity_id`.

**Idempotency & rerun semantics (all importers):** on commit, each row's
`naturalKey` is resolved against existing domain rows (each definition documents its
lookup). Existing match → default **`skipped_existing`** (never silently overwrite);
the review grid shows would-be-skips at stage time with a per-batch toggle **"update
existing"** → matched rows update mutable fields (each importer's table below marks
which). Re-committing the same file is therefore always safe: it converges instead
of duplicating. A second batch for the same importer is additive over the first.

**Volumes & performance:** designed for 200 lots / 50 plans (≈50 plans × ~40 takeoff
lines = 2k lines) / 5k price rows / 500 options / 200 WIP houses / 50 team rows.
Parse+stage for 5k rows must run in one server action within limits: chunk inserts
(500/insert), preload all lookup maps once per batch (cost codes, vendors,
communities — the `importQboRecords` batch-cache pattern), zero per-row queries.

### 3.1 Importer #1 — Cost codes

Target: `cost_codes`. Absorbs and deletes the naive `importCostCodes()` in
`lib/services/cost-codes.ts` (leave no trash — migrate its callers).

CSV template:

| Column | Req | Notes |
|---|---|---|
| `code` | ✓ | Unique per org. Any format ("3100", "03-100", "6-010") — stored verbatim |
| `name` | ✓ | |
| `parent_code` | | Must reference another row in the file or an existing org code; cycles rejected at stage |
| `division` | | Freeform grouping label |
| `category` | | |
| `cost_type` | | One of `COST_TYPES` (`lib/cost-types.ts`); normalized case-insensitively |
| `unit` | | uom |
| `default_unit_cost_cents` | | Also accepts dollars ("12.50" → 1250) via the cents preprocessor pattern |

Natural key: `code` (normalized: trim, collapse whitespace). Lookup: existing
`cost_codes` on `(org_id, code)`. Update-existing fields: name, parent, division,
category, cost_type, unit, default cost. Batch checks: in-file duplicate codes
(error), parent resolution + cycle check (reuse `assertNoParentCycle`'s logic
shape), unknown cost_type (warning → null). Commit order: parents before children
(topo-sort within batch).

### 3.2 Importer #2 — Plan library

Targets: `house_plans`, `house_plan_elevations`, `house_plan_versions`,
`house_plan_takeoff_lines` (WS02), committed through WS02's plan services so version
immutability and release rules hold. **Two files**, imported in order within one
stage:

**File A — plans & elevations** (one row per plan × elevation; plan fields repeat):

| Column | Req | Notes |
|---|---|---|
| `plan_code` | ✓ | e.g. "1670" — unique per org |
| `plan_name` | ✓ | e.g. "The Magnolia" |
| `series` | | |
| `heated_sqft`, `total_sqft` | | integers |
| `beds`, `baths`, `stories`, `garage_bays` | | numerics |
| `elevation_code` | ✓ | 'A','B','C' |
| `elevation_name` | | 'Craftsman' |
| `elevation_sqft_delta` | | integer, default 0 |
| `swing_applicable` | | bool, default true |

Natural keys: plan `plan_code`; elevation `plan_code:elevation_code`. Commit creates
each plan once (grouped), then elevations, then ONE draft `house_plan_versions` row
(version 1) per new plan.

**File B — takeoff lines** (targets the draft v1 created by File A):

| Column | Req | Notes |
|---|---|---|
| `plan_code` | ✓ | Must exist (from File A or already in Arc) |
| `elevation_code` | | Empty = base-house line; set = elevation delta (WS02 semantics) |
| `cost_code` | ✓ | Must resolve to org cost codes (stage 4 gate) |
| `description` | ✓ | |
| `quantity` | ✓ | ≥ 0 |
| `uom` | ✓ | 'sf','lf','ea','sq','ls',… |
| `unit_cost_cents` | | Manual fallback price; price book overrides at generation (WS04) |

Natural key: `plan_code:elevation_code:cost_code:description` (slugged). Batch
checks: plan resolution, cost-code resolution (error), unpriced lines with no price
book coverage yet (warning only — price book may import after), takeoff-less plans
(warning on File A completion). **Versions are NOT auto-released** — release (which
snapshots the bundle, WS02) is a deliberate human act in the plan library UI after
budget/schedule templates are attached. The stage-5 done-gate checks released
versions exist.

**Plan drawings are out of scope for the importer**: plan-set PDFs attach to plan
versions via `drawing_source_file_id` (plain `files` upload in the WS02 UI); per-lot
drawing sets are instantiated by WS02's engine through the existing drawings
pipeline. Never build a bulk-PDF ingest here.

### 3.3 Importer #3 — Option catalog

Targets: WS03's catalog-lifted `selection_categories` / `selection_options` (org
scope, `community_id` null) + `selection_catalog_prices` plan-applicability rows.
One file, one row per option:

| Column | Req | Notes |
|---|---|---|
| `category` | ✓ | Created if missing (org-level catalog category) |
| `parent_category` | | Optional tree (WS03 `parent_category_id`) |
| `option_code` | ✓ | Stored as `sku`; unique per org catalog |
| `option_name` | ✓ | |
| `scope` | ✓ | `structural` \| `design_studio` (WS03 `option_scope`) |
| `price_cents` | ✓ | Buyer price (dollars accepted) |
| `cost_cents` | | Builder cost |
| `cost_code` | | For PO generation; warning if empty |
| `vendor` | | Fuzzy-matched like price book (§3.4); warning if unmatched, not error |
| `lead_time_days` | | |
| `is_default` | | bool |
| `applicable_plans` | | Semicolon-separated plan codes; empty = all plans. Each listed plan → a `selection_catalog_prices` availability row against the plan's current version |

Natural key: `option_code` (fallback `category:option_name` slug when code blank —
flagged warning, codes strongly encouraged). Update-existing fields: name, prices,
cost code, vendor, lead time, applicability. Batch checks: duplicate codes,
scope enum, plan-code resolution, negative prices (error). Packages are NOT
imported (low volume, high structure — built by hand in WS03's UI); note this in
the grid's empty-state help.

### 3.4 Importer #4 — Price book

Target: `vendor_price_agreements` (WS04 — verify DDL on disk before building; until
then master §5 shape: vendor × cost code [× plan] [× community/division], unit
pricing, effective dates). One row per agreement line:

| Column | Req | Notes |
|---|---|---|
| `vendor` | ✓ | Matched against directory `companies` (§ below) |
| `cost_code` | ✓ | Must resolve |
| `description` | ✓ | |
| `uom` | ✓ | |
| `unit_price_cents` | ✓ | Dollars accepted |
| `plan_code` | | Empty = all plans |
| `community` | | Empty = org/division-wide; else community name/code |
| `division` | | Scope alternative to community |
| `effective_start` | | date; empty = today |
| `effective_end` | | date |

**Vendor matching (the load-bearing part):** stage pass builds a match per row —
(1) exact name match on org companies (case/punctuation-insensitive), (2) normalized
fuzzy match (strip legal suffixes LLC/Inc/Co, token-sort, trigram similarity ≥ 0.85
→ auto-suggest as `warning` requiring confirm; 0.6–0.85 → listed as candidate in the
grid's vendor cell picker), (3) no match → row status `warning` with actions
**"Create vendor"** (bulk: "create all unmatched") or pick manually. The vendor cell
is an inline combobox exactly like the QBO grid's destination column. Created
vendors go through `lib/services/companies.ts` create (type: vendor/subcontractor).

Natural key: `vendor_slug:cost_code:plan_code?:community_or_division?:effective_start`.
Batch checks: overlapping effective ranges for the same (vendor, cost code, scope)
tuple (error — WS04's uniqueness rule), price of 0 (warning), unresolved cost code
(error). Expected volume 5k rows — this importer is the perf benchmark (§3.0).

### 3.5 Importer #5 — Communities / phases / lots

Targets: `communities`, `community_phases`, `lots`, `lot_takedowns` (WS01), through
WS01's communities/lots services. One file, one row per lot (community/phase fields
repeat; communities and phases are derived group-by):

| Column | Req | Notes |
|---|---|---|
| `community` | ✓ | Created if missing |
| `community_code` | | e.g. "CYP" |
| `division` | | Must exist (stage 2); community lands there |
| `phase` | | e.g. "Phase 2"; created if missing, `phase_number` parsed from trailing integer else sequence |
| `lot_number` | ✓ | Text ("14", "14A") |
| `block` | | |
| `status` | ✓ | `controlled\|owned\|developed\|assigned\|started\|closed` (WS01 lifecycle); synonyms normalized (e.g. "finished"→developed) — AI value-normalization assists here (§6) |
| `address`, `city`, `state`, `postal_code` | | Street address on the lot; city/state/zip roll up to the community if uniform |
| `width_ft`, `depth_ft`, `acreage` | | → `dimensions` jsonb |
| `swing` | | `left\|right\|either`, default either |
| `premium_cents` | | Lot premium (dollars accepted) |
| `cost_basis_cents` | | |
| `takedown` | | Tranche name; groups into `lot_takedowns` rows |
| `takedown_date` | | Scheduled date for that tranche |
| `plan_code`, `elevation_code` | | Optional pre-assignment → WS02 lot pinning columns (plan must exist) |

Natural keys: community `community` name; lot `community:block?:lot_number`.
Update-existing fields (lots): status, address, dims, premium, basis, takedown,
plan pin. Batch checks: duplicate lot per community/block (error), illegal status
(error after normalization), `started`/`closed` statuses flagged **warning: "this
lot needs an open-WIP row (stage 10) — no project is created here"** (this importer
NEVER creates projects; that is exclusively §3.6's job), premium outliers (> $200k:
warning), takedown date in the past with status `controlled` (warning). Expected
volume: 200 lots/community, several communities per file.

### 3.6 Importer #6 — Team

Targets: org invites via `createOrgMemberInvite` (`lib/services/team.ts`) + role
assignment + division/project scoping.

| Column | Req | Notes |
|---|---|---|
| `email` | ✓ | Natural key (lowercased) |
| `full_name` | ✓ | |
| `role` | ✓ | Legacy-persona strings normalized to catalog roles per §10's mapping table ("purchasing agent"→`org_purchasing_manager` etc.); unmapped → error with picker |
| `division` | | Sets `membership_divisions` + `division_scope='assigned'` (WS01) |
| `send_invite` | | bool, default **false** — invites during data-load week are noise; bulk "send invites" happens at stage-9 completion |

Rerun: existing member/invite for the email → `skipped_existing` (role changes are
deliberate acts in team settings, never a CSV side effect — no update-existing mode
for this importer). Batch checks: email format, duplicate emails, role resolution,
division resolution, "no second org admin" (batch-level warning).

### 3.7 Importer #7 — Open-WIP cutover

The riskiest importer; the doctrine section. Targets per in-flight house: `lots`
(match, not create), `projects` (create, `property_type='production'`), budget
snapshot (budgets/budget_lines), open POs as `commitments`
(`commitment_type='purchase_order'`, WS04 — keep column specifics loose until 04 is
on disk; the commitments spine itself is live today), remaining schedule from the
plan's schedule template, buyer + purchase agreement for sold homes (`contracts`
row, `contract_type='purchase_agreement'`, WS06 semantics).

**The rule (master §8, verbatim doctrine): current state only, never reconstructed
history.** No historical invoices, no paid-bill backfill, no draw history, no
closed-PO archaeology. Legacy remains the system of record for everything that
happened before the as-of date; Arc owns everything after. The batch records an
explicit **`as_of_date`** in `context` (required input at upload), stamped into each
created project's `metadata.wip_cutover` (`{as_of_date, batch_id}`) so reports can
annotate "costs before <date> live in legacy".

**File A — houses** (one row per in-flight house):

| Column | Req | Notes |
|---|---|---|
| `community` + `lot_number` (+`block`) | ✓ | Must match an existing lot with no project; lot status becomes `started` |
| `plan_code` + `elevation_code` | ✓ | Pins the lot; budget/schedule generate against this version — the CURRENT released version (history rule: we don't reconstruct which version it "really" started under) |
| `stage_task` | ✓ | Name of the current schedule-template task (e.g. "Drywall hang") — the schedule anchor |
| `stage_date` | | Date the house entered that stage; default as-of date |
| `budget_total_cents` | ✓ | Legacy budget total — reconciliation check vs File B sum |
| `sold` | | bool |
| `buyer_name`, `buyer_email` | sold✓ | Buyer contact (directory + portal later) |
| `sale_price_cents` | sold✓ | Purchase-agreement amount |
| `sale_date` | sold | |

**File B — budget snapshot lines** (per house × cost code, TOTALS not transactions):

| Column | Req | Notes |
|---|---|---|
| `community`+`lot_number` | ✓ | Joins to File A |
| `cost_code` | ✓ | |
| `budget_cents` | ✓ | Current budget for the code (original + approved variances — the legacy system's current number, one number) |

**File C — open POs at remaining value:**

| Column | Req | Notes |
|---|---|---|
| `community`+`lot_number` | ✓ | |
| `po_number` | ✓ | Legacy PO number → stored on the commitment (number or metadata per WS04) |
| `vendor` | ✓ | Fuzzy match per §3.4 (price-book matching likely already populated the directory) |
| `cost_code` | ✓ | |
| `description` | ✓ | |
| `remaining_cents` | ✓ | **The commitment imports at REMAINING value** — the unpaid balance is the commitment amount. Paid-to-date stays in legacy; Arc's committed cost = what is still owed |
| `original_cents` | | Reference only → commitment metadata; gate: remaining ≤ original |

Commit sequence per house (single logical unit; a house that fails mid-sequence is
rolled back and its rows marked error — commit house-by-house, not table-by-table):

1. Resolve lot; create project via the projects service (`property_type='production'`,
   name "«Community» — Lot «n»"), link `lots.project_id`, status `started`.
2. Budget: create budget lines from File B (through the budgets service). This is a
   **snapshot budget, not a generated one** — explicitly NOT WS02's instantiation
   engine (that would produce today's plan pricing, not the legacy reality).
   `budget_total_cents` ≠ sum(lines) → row error at stage.
3. POs: one commitment per File C row at `remaining_cents`, status approved/open,
   flagged `metadata.imported_open_wip=true` (VPO reporting excludes imported base
   POs from variance-rate denominators — they carry no takeoff lineage).
4. Schedule: instantiate the plan version's schedule template **offset so
   `stage_task` starts at `stage_date`**; template tasks strictly before the anchor
   import as completed-at-cutover (one line of history-shaped data, accepted: the
   schedule needs done-ness to render truthfully); anchor + later tasks are live.
   Unmatched `stage_task` name → row error at stage (grid shows the template's task
   list to pick from — AI value normalization applies).
5. Sold homes: buyer contact via directory/contacts services; `contracts` row
   (`contract_type='purchase_agreement'`, `sale_price_cents`) linked per WS06. No
   selections backfill, no option ledger — the agreement total is one number
   (history rule again). Buyer-portal invite is NOT sent at import (go-live
   playbook §7 owns buyer comms).
6. NOT created, ever: invoices, vendor bills, payments, draws, closed POs, change
   orders, daily logs. Absence of history is correct, not a gap.

Natural key: `community:lot_number` (File A), `…:cost_code` (B),
`…:po_number` (C). Rerun: a lot that already has a project → `skipped_existing`
(no update mode — fixing a botched house means deleting the project and
re-importing; the grid links to it). Expected volume: 200 houses ≈ 200 projects +
~4k budget lines + ~2k commitments per batch.

---

## 4. NAHB cost-code seed — catalog-as-code

Production builders run NAHB-style residential cost codes (the 1000–6990 series:
1000s Preparation/Preliminaries, 2000s Excavation & Foundation, 3000s Rough
Structure, 4000s Full Enclosure, 5000s Finishing Trades, 6000s Completion & Extras),
NOT CSI divisions. The existing `seedNAHBCostCodes()` is a stub with CSI-shaped
codes — replace it (leave no trash: same exported name, inline array deleted).

- New data module **`lib/data/nahb-cost-codes.ts`** mirroring
  `lib/data/csi-masterformat.ts` exactly: typed export
  `NAHB_COST_CODE_GROUPS: { group: string; name: string; costType; codes: [code, name, uom?][] }[]`
  + `NAHB_COST_CODE_ROW_COUNT`. Content: the full NAHB residential taxonomy at
  two levels (group parents `1000 — Preparation` + child codes `1010 Permits`,
  `1020 Architect/Engineering`, … through `6990`), ~180–220 rows, each mapped to a
  `cost_type` (`lib/cost-types.ts`). Author it from the published NAHB chart of
  accounts structure; codes carry default `uom` where standard (sf/lf/ea).
- `seedNAHBCostCodes()` rewritten to the `seedCSICostCodes` shape verbatim: parent
  group rows first (`standard: 'nahb'`, `category: 'nahb-group'`), resolve ids,
  child rows with `parent_id` (`category: 'nahb-code'`), both via upsert on
  `(org_id, code)` with `ignoreDuplicates` — idempotent, safe to re-run on an org
  with custom codes.
- Provisioning already calls it for non-commercial tiers — after this change,
  production (and residential) orgs get the real catalog with zero wiring. The
  cost-codes stage (§2.3 #4) offers "adopt NAHB seed", "import your codes"
  (importer #1), or both (seed then overlay custom codes).

---

## 5. (Reserved — merged into §3.0)

Framework details, idempotency, and volumes live in §3.0 so each importer section
stays self-contained. This heading exists so cross-references in review notes don't
dangle; do not add content here.

---

## 6. AI-assisted mapping

Legacy exports (MarkSystems job-cost grids, NEWSTAR takeoff dumps, Buildertrend
CSVs, Hyphen BRIX schedules) never match our templates: different headers, merged
columns ("Lot/Block" as "14/B"), dollar strings, status vocabularies. The assist
has two parts, both **suggest-only, human-confirmed in the staging grid** — the
receipt-extraction contract (AI extracts, human confirms before persist) applied to
tabular mapping.

**6.1 Column-mapping suggestions.** When uploaded headers don't match the
importer's `columns` spec, the mapping step calls a new
`suggestImportColumnMapping()` in `lib/services/import-mapping.ts`:

- Reuses `receipt-extraction.ts` mechanics: model via
  `getPlatformAiFeatureDefaultConfig()` (google provider), strict-JSON prompt,
  zod `z.preprocess` response schema, per-suggestion `confidence: high|medium|low`
  + `notes`. Fail-soft: AI unavailable/misbehaving → manual mapping UI only, never
  a blocked importer.
- Input: the importer's column specs (key, label, type, examples) + source headers
  + the first 5 data rows (values ground the guess: a column of "14A" maps to
  `lot_number` even when headed "Homesite"). No full-file upload to the model; 5
  rows is the cap, and the platform-side flow warns that sample rows leave the
  building (same posture as receipt uploads).
- Output: `{ mappings: [{ target, source, confidence, note }], unmapped_sources,
  unmatched_targets }`. Rendered as a two-column mapping table — target column,
  suggested source header in a select (all headers available), confidence dot;
  low-confidence and unmatched-required rows demand explicit attention before
  "Apply mapping" enables. Confirmed result → `import_batches.column_mapping`.
- **Mapping profiles:** on confirm, persist `{importer, source_signature:
  sorted-header-hash, column_mapping}` into the batch and copy to
  `orgs.settings`-adjacent storage (a `mapping_profiles` jsonb on `import_batches`
  is wrong-home; store per-org in a tiny `import_mapping_profiles` table in the
  same migration: org_id, importer, source_signature unique, column_mapping,
  last_used_at). Re-uploading a file with the same header signature skips AI and
  pre-applies the profile — a builder's 3rd community CSV maps in zero clicks.

**6.2 Value normalization.** Per-column, at parse time, deterministic first:
synonym tables in each `parseRow` (status vocabularies, uom variants, money/date
preprocessors — the `centsSchema`/`dateSchema` pattern lifted into shared
`lib/services/import-parsers.ts`). AI is the fallback for enum-ish columns only:
when >10% of a column's values fail deterministic normalization, one batched call
maps distinct failing values to the enum (`{"Fin. Slab": "developed", ...}`) with
confidence; suggestions land as row `warning`s with prefilled fixes the reviewer
accepts per-value or in bulk ("accept all high-confidence"). Never auto-accept;
accepted mappings merge into the batch report for audit.

---

## 7. Phased go-live playbook

The operational script the platform team runs per builder. Stage 11 of the
checklist links here; each numbered step's completion is recorded in the run's
stage notes.

**7.1 Pick the pilot.** One community (default) or one division (multi-state orgs
where a division is the natural blast radius). Criteria: mid-size (30–80 active
lots), a superintendent and purchasing agent willing to lead, NOT the org's
messiest legacy data. Set `pilot_community_id`/`pilot_division_id` on the run.

**7.2 Parallel-run rules (what stays in legacy during pilot):**

| Stays in legacy until cutover | In Arc from pilot day 1 |
|---|---|
| Accounting postings for pre-cutover transactions; AP for invoices against legacy POs | Everything on imported-WIP houses going forward: schedules, field ops, VPOs, new POs |
| Payroll, GL, closings already in escrow at cutover | All NEW starts in the pilot community (Arc-native end-to-end: start package → generated budget → auto-POs) |
| Non-pilot communities/divisions entirely | Plan library, price book, option catalog (single source of truth immediately — org-wide, not pilot-scoped; dual-maintaining a price book is how price books die) |

One system per decision: a given house is EITHER legacy-managed or Arc-managed.
No house runs schedule-in-both. The WIP import (stage 10) for pilot houses flips
them to Arc-managed the day it commits.

**7.3 The real go-live moment** is the **first fully Arc-native start**: a lot
released through the WS05 start package with generated budget and auto-POs, zero
legacy involvement. Everything before it is data migration; this is the product
working. Record the project id in stage 11 evidence; `markRunLive` requires it.

**7.4 Cutover criteria (pilot → wave 2).** Exit the pilot when, for 4 consecutive
weeks in the pilot community: (a) ≥2 Arc-native starts released; (b) all field VPOs
captured in Arc (spot-check against super's texts); (c) weekly variance report
reviewed by the builder in Arc, not in legacy; (d) zero data-corrections requiring
re-import; (e) accounting either syncing cleanly via the entity map or the
unconnected export flow accepted by the controller.

**7.5 Rollout waves.** Wave = one division (or community cluster): rerun stages
5/7/8/10 scoped to that wave's data (importers are additive/idempotent — a second
communities CSV or WIP workbook just extends), train that wave's supers on the
sample community, first Arc-native start per wave = wave complete. The onboarding
run stays `active` until the last wave; per-wave progress lives in stage notes
(deliberately not a second state machine).

**7.6 Rollback stance.** Pre-WIP-cutover (stages 1–9): everything is reversible —
catalogs, communities, and team rows can be discarded/re-imported freely; legacy
is untouched and authoritative. Post-WIP-cutover for a given house set: rollback =
delete the imported projects (platform-assisted, the WIP grid's per-house delete)
and resume legacy — safe precisely BECAUSE we import no history: nothing in legacy
was mutated, no transactions were forked. After Arc-native starts exist in a
community, rollback is no longer offered for that community (real money and real
schedules now live only in Arc); course-corrections happen forward, in Arc. Say
this to the customer in exactly these terms before stage 10 commits.

---

## 8. Org-scale readiness audit (master §7.7, auditable)

Run per-onboarding (stage 11 gate) AND once as an engineering pass during this
workstream (Phase 5) with a synthetic 250-project/400-lot org. The design case is
200 active projects, 400-lot communities, 2k commitments, 50 team members. For
each surface: verify pagination/caps, no unbounded `select *`, aggregates via RPC
(the >1000-row rule from the platform-ops pass), and dark-mode-safe density at
volume.

| # | Surface | Where to check | Pass condition |
|---|---|---|---|
| 1 | Projects list + workspace switcher | `app/(app)/projects/`, sidebar project picker | Paginated/virtualized at 250 projects; switcher searches, never renders all |
| 2 | Portfolio schedule desk | `app/(app)/schedule/` (portfolio gantt) | 250 project rollup rows lazy-expand; item bars fetched per expanded project only |
| 3 | Receivables/billing desks | `app/(app)/invoices/` (`components/invoices/receivables-workspace.tsx`), org billing desk (`lib/services/org-billing-desk.ts`) | Server-side pagination + aggregate RPCs for header sums |
| 4 | Payables desk + review queue | `lib/services/org-payables.ts`, `lib/services/financials-review-queue.ts` | Queue capped/paginated; counts via RPC not row-fetch |
| 5 | Dashboard rollups | `lib/services/dashboard.ts` | No per-project N+1; org aggregates in SQL |
| 6 | Communities & lots (new, WS01) | `app/(app)/communities/`, lot tables | 400-lot table paginated; community list capped |
| 7 | Purchasing/starts/sales/warranty desks (WS04–07) | Their desk routes when built | Each doc owns this; audit re-verifies |
| 8 | Global search | `lib/services/search-index.ts`, ai-search | Index write-through keeps up with 200-house WIP import (bulk import must not enqueue 10k synchronous index writes — verify outbox batching); result caps hold |
| 9 | Notifications volume | `lib/services/notifications.ts`, `EMAIL_NOTIFICATION_TYPES` in `lib/types/notifications.ts` | **Importers and seeds send ZERO notifications/emails** (assert in tests); daily digest paths cap per-user rows; no import-triggered types in the email allowlist |
| 10 | Navigation badges | `lib/services/navigation-badges.ts` | Badge counts are cheap aggregates at 200 projects |
| 11 | My Work / My Houses | `lib/services/my-work.ts` (+WS05 extension) | A super with 15 houses × N items paginates |
| 12 | Portal token volume | `portal_access_tokens`, `lib/services/portal-access.ts`, portal listing surfaces | 200 buyer portals + hundreds of sub tokens: admin listings paginated; token lookup indexed (verify index on token column) |
| 13 | Events/audit/outbox throughput | `lib/services/outbox.ts`, `job_runs` | WIP commit (≈8k audit rows) doesn't starve the outbox cron; chunked commits keep action duration bounded |
| 14 | Reports | `lib/services/reports/*`, reporting-scope | Org-wide reports accept explicit project-id sets (reporting-scope rule); WIP-annotated reports render the cutover note |
| 15 | Mobile API | `/api/mobile/v1` workspace/project lists | Paginated at 250 projects |

Output: a checked table in the onboarding run's stage-11 notes naming who verified
each row and at what volume. Engineering-pass findings that need fixes are filed
against the owning workstream, not patched drive-by here.

---

## 9. Sample data — production sample community

Sibling of `seedSampleProject` in `lib/services/demo-seed.ts`:

```
export async function seedSampleCommunity(orgId: string, actorUserId: string):
  Promise<{ communityId: string }>
export async function deleteSampleCommunity(orgId: string, communityId: string, ...)
```

- Spec-constant `SAMPLE_COMMUNITY_SPEC` (one constant, swap-friendly): community
  "Cypress Landing" (code CYP, Naples FL), 2 phases, **20 lots in mixed states**
  (4 controlled, 4 owned/developed, 3 assigned, 6 started, 3 closed), **3 plans**
  (~1,650/1,900/2,400 sf, 2 elevations each, released v1 with ~25 takeoff lines
  each), a starter option set (~15 options across 4 categories), a mini price book
  (~30 agreements across 6 vendors), and for the 6 started lots: projects with
  generated-shape budgets, a handful of open POs, schedules at staggered stages,
  2 sold with buyers + purchase agreements. Closed lots get closed projects (WS06
  closing rows if built).
- Built exclusively through the same services the importers use — the seed is
  effectively a canned in-memory import, and doubles as the framework's best
  integration test. Marked `communities.metadata.is_sample = true` (and
  `is_sample` on each created project); idempotent (existing sample community →
  return it); delete hard-guards on the marker and cascades through services.
- No emails, no portal invites, no accounting sync (skip when unconnected — always,
  for sample data: the seed passes whatever "don't post" affordance WS08 exposes,
  or simply requires the org to be unconnected/sandboxed — assert, don't post
  sample POs to real books).
- Wiring: a "Seed sample community" toggle in the provision sheet **only when
  `product_tier='production'`** (next to the existing sample-project toggle, which
  production orgs default OFF — one sample, the right posture), plus a button on
  the onboarding page for training resets.

---

## 10. RBAC, permissions, events

**Permissions** (new migration in the `rbac_catalog_seed` idempotent pattern; keys
also added to `TEAM_PERMISSION_OPTIONS` in `lib/services/team.ts`):

- `import.manage` — run importers and commit batches (org-side door §2.1). Granted:
  org admin; assignable to the WS01 `org_land_manager` and (when WS04 lands)
  purchasing-manager roles for their domains — the org-side imports page also
  respects per-importer domain permissions (price book additionally requires
  `commitment.write`; team importer requires the existing member-management
  permission; open-WIP is platform-page only, full stop).
- Onboarding-run mutations need no org permission key: platform-access gated
  (§2.1), like the rest of `admin/customers`.

**Persona → role mapping** (stage 9's review table; roles from the WS01–07 catalog
additions — verify exact keys against the seed migrations at execution time):

| Customer persona | Catalog role |
|---|---|
| Owner/GM | org admin |
| Division president | org admin + `division_scope='assigned'` |
| Land manager | `org_land_manager` (WS01) |
| Purchasing manager/agent | purchasing role (WS04) |
| Starts coordinator | starts role (WS05) |
| Superintendent | field/superintendent role, `project_scope='assigned'` |
| Design studio coordinator | design-studio role (WS03) |
| Sales agent | sales role (WS06), division-scoped |
| Warranty/service manager | service role (WS07) |
| Controller/bookkeeper | `bookkeeper` (exists) |

**Events** (`recordEvent`, in-app only — none join the email allowlist):
`onboarding_run_created`, `onboarding_stage_completed`, `onboarding_stage_skipped`,
`onboarding_run_live`, `import_batch_staged`, `import_batch_committed` (payload:
importer, counts, action breakdown), `import_batch_discarded`,
`sample_community_seeded`. Every commit also `recordAudit`s per created entity via
the owning services (free, since commits go through services).

**Search:** batches/runs are NOT search entities (admin plumbing). Entities they
create are indexed by their owning services' existing registration.

---

## 11. Admin UI spec

Dense, calm, editorial — platform-admin density matches `admin/customers`; org-side
matches settings pages. Tokens only, radius 0, tabular-nums, no heroes. Every view:
empty/loading/error + dark mode.

**Onboarding page** (`admin/customers/[orgId]/onboarding`): title row (org name,
run status, target live date) then the work — a single-column stage list, one dense
row per stage: number, name, status glyph (token colors: muted=pending,
primary=in-progress, success=done), owner tag, evidence summary ("212 lots · 3
communities"), and a right-aligned action ("Open importer" / "Mark done" /
"Skip"). Expanding a row shows gate results (each gate one line, pass/fail with
message) and notes. No progress meters, no confetti.

**Importer workspace** (one route per importer under the onboarding page, e.g.
`.../onboarding/import/[importer]`): stepper as plain text ("Upload → Map →
Review → Commit"), then:

- *Upload*: file drop + template download link (CSV generated from the column
  specs) + importer-specific context inputs (e.g. WIP as-of date). Empty state
  explains the file shape in two sentences.
- *Map*: the §6 mapping table; profile auto-applied note when signature matches.
- *Review*: the grid — `components/admin/import-review-grid.tsx`, shared shell
  across importers with per-importer cell renderers. Header: count chips
  (valid/warning/error, filter on click) + batch report lines + "update existing"
  toggle + Validate again. Rows: status cell, source row number, mapped columns,
  issue icon with tooltip; inline edit on editable cells (combobox for
  vendor/cost-code/plan cells — the QBO destination-column pattern); bulk bar on
  selection (skip, set value, create vendors). Virtualized — 5k rows is the design
  case. Pinned footer: totals + Discard + Commit (disabled with reason while
  errors remain).
- *Result*: per-action counts, link list of created entities (capped at 50 +
  "and N more"), failed rows retained in the grid for a follow-up batch.

**Org-side `settings/imports`**: same importer workspace minus onboarding chrome
and minus open-WIP; lists the org's batches (paginated) with status.

---

## 12. Migration plan

| # | File | Contents |
|---|---|---|
| 1 | `202607DD######_onboarding_and_import_staging.sql` | `onboarding_runs`, `import_batches`, `import_rows`, `import_mapping_profiles` (§2.2, §6.1) — RLS, indexes, triggers |
| 2 | `202607DD######_onboarding_permissions.sql` | `import.manage` key + grants, rbac-catalog-seed pattern |
| 3 | (conditional) `202607DD######_onboarding_run_pilot_fks.sql` | FK constraints for `pilot_community_id`/`pilot_division_id` once WS01 tables exist in prod — or fold into migration 1 if 01 has shipped by then (expected, since this executes last) |

No changes to domain tables: importers write through owning-workstream services.
The NAHB seed (§4) is code-only. All migrations additive; write files, then STOP
for human approval before applying (prod database).

---

## 13. Phases & acceptance criteria

**Phase 1 — Framework + staging + NAHB seed — IMPLEMENTED AND DEPLOYED.** Migration 1–2 written; `imports.ts`
framework; shared parsers; review-grid shell; delete the empty
`app/(app)/admin/provision/` directory; `lib/data/nahb-cost-codes.ts` + rewritten
`seedNAHBCostCodes`; importer #1 (cost codes) end-to-end as the proving importer.
*Accepts when:* cost-code CSV round-trips upload→map→stage→fix→commit; re-commit
of the same file yields 100% `skipped_existing`; "update existing" updates only
documented fields; NAHB seed is idempotent on an org with existing custom codes;
`pnpm lint` clean.

**Phase 2 — Onboarding checklist — IMPLEMENTED.** `onboarding.ts` service + stage catalog +
gates; the onboarding page; customers-table deep-link; provision-sheet sample-
community toggle placeholder wiring (toggle ships in Phase 5 with the seed — no
dead UI before then). *Accepts when:* a run walks stage 1→11 with server-enforced
gates; skips record who/why; `markRunLive` refuses with an incomplete stage; events
recorded.

**Phase 3 — Catalog importers (#2 plans, #3 options, #4 price book) + AI mapping — IMPLEMENTED.**
Requires WS02/03/04 services on disk. Includes `import-mapping.ts` + profiles +
value normalization, and the price-book vendor fuzzy matcher. *Accepts when:* a
50-plan/2k-takeoff-line pair of files and a 5k-row price book each commit within
action limits with zero per-row queries (verified by query-count logging in dev);
a deliberately-mangled MarkSystems-style header set maps via AI suggestions with
required-column confirmation; re-upload with same headers skips AI via profile;
unmatched vendors resolve via create-missing bulk action.

**Phase 4 — Entity importers (#5 communities/lots, #6 team) + org-side door — IMPLEMENTED.**
Requires WS01. *Accepts when:* a 3-community/450-lot file commits with derived
phases/takedowns; `started` lots warn toward stage 10 and create no projects;
team CSV maps personas per §10 and sends zero emails until the bulk send;
`settings/imports` enforces `import.manage` + domain permissions.

**Phase 5 — Open-WIP importer + sample community — IMPLEMENTED.** Requires WS02/04/05/06.
*Accepts when:* a 200-house workbook (A+B+C) commits house-atomically; a house with
budget-sum mismatch errors at stage without touching the DB; imported POs carry
remaining-value amounts and the `imported_open_wip` flag; schedules anchor at
`stage_task` with prior tasks completed-at-cutover; sold homes get agreements, no
buyer emails; NO invoices/bills/draws/history rows exist for imported houses
(assert by query); `seedSampleCommunity` is idempotent, service-built,
notification-silent, and delete leaves zero orphans.

**Phase 6 — Playbook + scale audit — GATE IMPLEMENTED; QA EXERCISE PENDING.** §7 dry-run against the QA org; §8 engineering
pass at synthetic volume (250 projects/400 lots) with findings filed per owning
workstream; stage-11 gate wired to the audit checklist. *Accepts when:* the QA org
completes a full simulated onboarding ending in an Arc-native start, and every §8
row has a recorded verdict.

---

## 14. Test plan

- **Unit (vitest, colocated):** per-importer `parseRow`/`naturalKey`/`validateBatch`
  on fixture CSVs (happy, mangled headers, dirty money/date/status values, dupes,
  cycles); money/date preprocessors; fuzzy vendor matcher thresholds; topo-sort;
  NAHB catalog integrity (unique codes, parents exist, count matches export).
- **Framework integration:** commit idempotency (same batch twice → converged),
  update-existing field allowlists, chunking at 5k rows, house-atomic WIP rollback
  on injected mid-house failure.
- **Doctrine assertions (the ones that matter):** post-WIP-commit queries prove
  zero invoices/bills/payments/draws for imported projects; imported PO totals =
  remaining sums; notification/email counters zero across all importers and seeds.
- **Financials:** `pnpm test:financials` after Phases 3/5 (budget lines,
  commitments, contracts are financial surfaces).
- **AI mapping:** deterministic tests on the schema/normalization layers with
  canned model responses (the receipt-extraction test approach); no live-model
  tests in CI.
- **Manual (QA org only — never a customer org):** full Phase 6 simulated
  onboarding; dark mode + empty/loading/error on the onboarding page and grid;
  5k-row grid interaction latency.

## 15. Open questions

1. **XLSX ingestion** — templates are CSV; legacy ERPs export XLSX. Ship CSV-only
   (customers re-save) or add a sheet-to-CSV converter (SheetJS-class dependency)?
   Leaning CSV-only for v1; the AI mapper removes most of the re-shaping pain.
2. **Selections backfill for sold WIP homes** — doctrine says agreement-total-only,
   but design studios mid-selection at cutover lose their picked-not-confirmed
   state. Accept re-picking in Arc for pilot homes, or add an optional selections
   file to importer #7 later? (Default: re-pick; revisit after first real
   onboarding.)
3. **Customer-visible onboarding progress** — should the org see a read-only
   checklist of their own onboarding (trust-building), or is that surface noise
   until a second customer asks? (Default: platform-only.)
4. **`import_batches` retention** — kept forever as migration evidence for now;
   decide a pruning policy once a real org has >100 batches.
5. **Legacy document migration** (plan PDFs at volume, permits, photos) — out of
   scope here beyond per-version plan-set upload; does a bulk file-drop importer
   deserve a future workstream?
