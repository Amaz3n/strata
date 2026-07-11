# Workstream 01 — Product Tiers, Project Posture, Terminology, CSI Cost Codes

> Prereq: read `00-MASTER-commercial-expansion.md`. This workstream has no dependencies
> and unblocks every other one. It is mostly plumbing — resist the urge to redesign UI.

## The two-level posture model (read carefully — this shapes everything)

Many GCs do both residential and commercial work in one company under one Arc
subscription. So posture lives at TWO levels:

- **Project posture** = `projects.property_type` (existing enum). This is what drives
  behavior inside a project workbench: terminology, sidebar modules, billing defaults.
- **Org tier** = new `orgs.product_tier`. Only three jobs: default posture for new
  projects/prospects, vocabulary on org-level surfaces (org nav, desks), and the
  marketing/packaging segment shown in platform admin. It never gates anything.

Every helper below is written so a "commercial" org with a residential project (or
vice versa) behaves correctly per project.

## Goal

1. An org-level `product_tier` flag (`residential` | `commercial` | `production`) and a
   **project posture resolver** (`getProjectPosture()`) that every other workstream
   consumes.
2. A terminology layer so commercial-posture contexts see "Owner" where residential
   sees "Client," without forking components.
3. Posture-appropriate defaults at project/prospect creation (property type, billing
   basis, retainage) and posture-driven module visibility in the project sidebar.
4. A shipped CSI MasterFormat cost-code library (seedable per org, like the NAHB seed —
   mixed orgs can hold BOTH libraries side by side).
5. A cost-type dimension (labor/material/equipment/subcontract/other) on cost codes and
   budget lines.

## Non-goals

- No new modules. No visual redesign. No changes to residential orgs' experience
  (default tier = `residential`, behavior identical to today).
- Do NOT rename database columns (`client_visible`, `client_id` stay). Terminology is a
  presentation layer only.

## Read these files first

- `lib/services/orgs.ts`, `lib/auth/context.ts` (org context resolution)
- `lib/services/cost-codes.ts` (NAHB seed `seedNAHBCostCodes` ~L178; `standard` enum
  already allows `nahb | csi | custom`)
- `components/pipeline/convert-prospect-sheet.tsx` (~L66: `property_type` defaults to
  `"residential"`)
- `app/(app)/layout.tsx` + whatever nav config component it renders (find the sidebar
  nav definition — grep for the nav item labels like "Warranty" or "Pipeline")
- `lib/services/feature-flags.ts` (existing flag pattern — reuse its shape if sane)
- One page that says "Client" prominently, e.g.
  `app/(app)/projects/[id]/financials/` receivables area and
  `lib/services/cost-plus.ts` ("Builder's fee" labels ~L2337, L2368)

## Verified schema facts (July 2026)

- `orgs` columns: id, name, slug, billing_model, status, billing_email, locale,
  created_by, address, compliance_rules, default_compliance_requirements, logo_url,
  timestamps. **There is NO settings/product_tier column — add one.**
- `cost_codes` columns include: parent_id, code, name, category (free text), division,
  `standard` (text, default 'custom'), unit, default_unit_cost_cents, is_active,
  is_reimbursable_default, default_markup_percent, metadata. **No cost_type column.**
- `projects.property_type` is a USER-DEFINED enum — check its labels with
  `select enum_range(null::property_type)` (or the actual enum name) before touching.

## Phase A — `product_tier` flag + posture resolver

**Migration** (write to `supabase/migrations/<ts>_org_product_tier.sql`, do not apply):

```sql
alter table public.orgs
  add column if not exists product_tier text not null default 'residential'
  check (product_tier in ('residential', 'commercial', 'production'));
comment on column public.orgs.product_tier is
  'Default posture for new projects + org-surface vocabulary + packaging segment. Never gates data; per-project behavior follows projects.property_type.';
```

No project-side migration: `projects.property_type` already exists. First verify its
enum labels (`select enum_range(null::<actual enum name>)` — find the enum name via
information_schema) — the plan assumes it has at least `residential` and `commercial`
values. If it has extra values (e.g., land/multifamily), map them in the resolver
(multifamily → commercial), don't touch the enum.

**Service layer:**

- Extend the org DTO in `lib/services/orgs.ts` (and any org-context type in
  `lib/auth/context.ts`) with `product_tier`.
- New file `lib/product-tier.ts` (pure, no server-only imports so client components can
  use the types):

```ts
export type ProductTier = "residential" | "commercial" | "production";
export type ProjectPosture = "residential" | "commercial"; // production posture comes later
export const PRODUCT_TIERS: ProductTier[] = ["residential", "commercial", "production"];
// display names for platform admin / onboarding UI (packaging only — one product)
export const PRODUCT_TIER_LABELS: Record<ProductTier, string> = {
  residential: "Arc",           // final branding TBD by human
  commercial: "Arc Commercial",
  production: "Arc Production",
};

// THE resolver. Pure so client components can use it with data they already have.
export function getProjectPosture(
  propertyType: string | null | undefined,
  orgTier: ProductTier,
): ProjectPosture {
  if (propertyType === "commercial") return "commercial";
  if (propertyType === "residential") return "residential";
  // unknown/legacy/null property types fall back to the org default:
  return orgTier === "commercial" ? "commercial" : "residential";
}
```

- Server helper `getOrgProductTier()` colocated with org context (returns the tier from
  the already-loaded org context — do NOT add a new query; piggyback on
  `requireOrgContext()`'s org row). Project-scoped services already load the project
  row — pass its `property_type` + the org tier into `getProjectPosture` where needed;
  never add extra queries for posture.
- **QA/demo org (program-wide deliverable):** using the existing provisioning flow,
  create one internal org in production named clearly as internal (e.g. "Arc QA —
  Commercial") with one residential and one commercial project. Every workstream's
  acceptance checklist runs here — never in a customer org (there is no staging;
  local dev hits prod). Flip THIS org's tier when testing tier behavior. It doubles
  as the commercial sales-demo org, so keep its data presentable. This is a HUMAN
  action to approve (it writes prod rows) — prepare it, then ask.
- Platform admin: add a tier selector to the customer admin surface
  (`app/(app)/admin/customers/` — there is an actions.ts/page.tsx pair; follow its
  existing edit patterns). Only platform admins change tier. Org users change a
  PROJECT's posture simply by editing its property type (existing project edit sheet —
  verify property_type is editable there; add it if the create sheet has it but the
  edit sheet doesn't).
- Emit `recordAudit` + `recordEvent` on tier change.

## Phase B — Terminology layer

Single choke point for tier-dependent nouns.

- New file `lib/terminology.ts`:

```ts
// Keyed by POSTURE (project-level noun sets). "production" included now so the
// map is the only file Production touches later.
const TERMS = {
  residential: { owner: "Client", owners: "Clients", ownerPortal: "Client portal",
                 fee: "Builder's fee", primeContract: "Contract" },
  commercial:  { owner: "Owner", owners: "Owners", ownerPortal: "Owner portal",
                 fee: "Fee", primeContract: "Prime contract" },
  production:  { owner: "Buyer", owners: "Buyers", ownerPortal: "Buyer portal",
                 fee: "Fee", primeContract: "Purchase agreement" },
} as const;

export type TermKey = keyof (typeof TERMS)["residential"];
export function terminology(posture: keyof typeof TERMS) { return TERMS[posture]; }
```

- **Which posture wins where:**
  - Inside a project workbench (`app/(app)/projects/[id]/**`), portals for that
    project, and any project-scoped email/PDF: the PROJECT's posture via
    `getProjectPosture`.
  - Org-level surfaces (org nav, desks, settings, org-wide reports): the ORG tier.
    A mixed org that is residential-default therefore still says "Clients" in org
    nav while its commercial projects say "Owner" inside — that asymmetry is fine
    and correct; do not try to blend.
- Thread posture into client components the same way other context reaches them
  today: the project layout (`app/(app)/projects/[id]/layout.tsx` or the
  project-detail client) already passes project data down — add posture there; the
  app shell (`app/(app)/layout.tsx`) passes the org tier for org surfaces. Expose a
  small context/provider ONLY if one already exists for this kind of info. Do not
  invent a new global store.
- **Scope discipline:** do NOT attempt a total sweep in this phase. Convert the ~30
  highest-visibility "Client" strings: app nav, project financials tab labels,
  invoice composer recipient labels, portal-link management UI, "Builder's fee" line
  labels in `cost-plus.ts` and invoice rendering, prospect/pipeline labels. Grep
  `"Client"` and `"client "` in `components/` and `app/(app)/` and triage: only strings
  a commercial GC will see weekly. Leave long-tail strings for opportunistic cleanup in
  later workstreams (each workstream doc reminds the executor to use `terminology()` in
  any file it touches).
- Emails: `getOrgSenderEmail`/templates that say "your builder" or "client" — same
  triage, top templates only (invoice, change order, RFI, portal invite).

## Phase C — Posture-driven defaults + module visibility

**Creation defaults (keyed on ORG tier — it's the default posture):**

- `convert-prospect-sheet.tsx` and project creation sheet(s): default `property_type`
  to `"commercial"` for commercial-tier orgs, keep the field prominent and editable
  both ways — for a mixed company this picker IS the product switch, so make sure it
  reads as "what kind of job is this," not buried metadata.

**Setup defaults (keyed on the PROJECT's chosen posture, reactively):**

- When the create/convert sheet's property type is set to commercial: default project
  `retainage_percent` to 10 (verify the field is on the create flow; it exists on
  `projects`).
- Billing model picker (`lib/financials/billing-model.ts` consumers — the project
  financial setup step, see memory: two-step project sheet,
  `project-financial-setup.ts`): for commercial-posture projects, order the options
  fixed_price (progress billing) first, cost_plus_gmp second; de-emphasize
  `time_and_materials`. Residential-posture projects keep today's ordering. Do NOT
  remove any option for any posture.

**Module visibility (the seam later workstreams plug into):**

- Project sidebar nav config: add a `postures?: ProjectPosture[]` field to the
  project-nav item type, default "all." Later workstreams register their new project
  modules (meetings, transmittals, inspections, safety) with
  `postures: ["commercial"]`; Selections gets `postures: ["residential"]`. Hiding
  only — routes always work, and add a per-project "Modules" override in project
  settings (simple jsonb on `projects.metadata` — check whether projects has a
  metadata column first; if not, a `project_module_overrides` approach needs a tiny
  migration) so a residential project can turn on Meetings if the builder wants it.
- Org-level nav: an org tier of commercial shows commercial vocabulary; org desks for
  new modules appear when the org tier is commercial OR any active project has
  commercial posture (compute cheaply — a single exists-query in the layout's existing
  nav data load, or piggyback `navigation-badges.ts`).
- Plumbing check: confirm org tier + project posture reach every layout that renders
  nav (org shell and project workbench layout).

## Phase D — CSI MasterFormat seed

- Add `seedCSICostCodes(orgId)` to `lib/services/cost-codes.ts`, sibling of
  `seedNAHBCostCodes` and reusing its insert mechanics (parent/child, `standard: 'csi'`,
  `division` populated).
- Content: 2-level library. Level 1 = divisions, Level 2 = common sections.
  Divisions to include (standard MasterFormat 2020 numbering):
  01 General Requirements, 02 Existing Conditions, 03 Concrete, 04 Masonry, 05 Metals,
  06 Wood/Plastics/Composites, 07 Thermal & Moisture Protection, 08 Openings,
  09 Finishes, 10 Specialties, 11 Equipment, 12 Furnishings, 13 Special Construction,
  14 Conveying Equipment, 21 Fire Suppression, 22 Plumbing, 23 HVAC, 26 Electrical,
  27 Communications, 28 Electronic Safety & Security, 31 Earthwork,
  32 Exterior Improvements, 33 Utilities.
  Under each division add the 5–15 most common Level-2 sections (e.g., 03 30 00
  Cast-in-Place Concrete; 09 29 00 Gypsum Board; 23 05 00 Common Work Results for HVAC).
  Write codes in `XX XX XX` MasterFormat format in `code`, division number in
  `division`. Target roughly 200–260 rows total. Generate the list carefully — this is
  domain data, take the time to make section numbers real MasterFormat numbers.
- Wire into provisioning: wherever `seedNAHBCostCodes` is called for new orgs
  (`lib/services/provisioning.ts` / admin customer provisioning), choose the seed by
  the org's tier. Also add a one-click "Import CSI cost codes" to the org cost-code
  settings UI so existing orgs can adopt it (find the cost-codes settings page under
  `app/(app)/settings/` or financials settings; follow whatever import/seed affordance
  NAHB has — if none exists in UI, add a small button for both standards).
- **Mixed orgs hold both libraries.** Cost codes are org-level and both seeds coexist
  (`standard` column distinguishes them). Do not scope codes per project. Quality of
  life: cost-code pickers group by standard, and a commercial-posture project's picker
  lists the CSI group first (residential-posture lists NAHB first). Pure ordering — no
  filtering.

## Phase E — Cost-type dimension

**Migration** (`<ts>_cost_type_dimension.sql`):

```sql
do $$ begin
  create type public.cost_type as enum
    ('labor','material','equipment','subcontract','other');
exception when duplicate_object then null; end $$;

alter table public.cost_codes
  add column if not exists cost_type public.cost_type;
alter table public.budget_lines
  add column if not exists cost_type public.cost_type;
```

Nullable on purpose — residential orgs never have to touch it.

- Surface: cost-code settings editor (add a small select), budget Detailed view (column,
  hidden when the whole budget has no cost types — follow the budget tab's existing
  Simple/Detailed toggle conventions), and the budget rollup: extend the aggregation in
  `budgets.ts` to optionally group by cost_type within a cost code (additive; do not
  change existing return shapes — add a parallel field).
- CSI seed (Phase D) pre-populates sensible cost_types (03 30 00 → subcontract, etc.;
  default `subcontract` for trade divisions, `other` for Division 01).
- Job-cost actuals: when a vendor bill/expense line lands on a cost code, it inherits
  the code's cost_type for reporting. Check `job-cost-actuals.ts` for where the rollup
  reads cost codes and add pass-through, not new queries.

## Permissions / events

- No new permission keys. Tier change is platform-admin-only (reuse platform RBAC).
- Events: `org.product_tier_changed`.

## Acceptance checklist

- [x] Migration files written (tier column, cost_type) and applied with explicit human
      approval via Supabase MCP. Live schema, enum labels, RLS, policy, and migration
      history verified on 2026-07-10.
- [ ] Flipping a test org to `commercial` (via admin UI) changes: org nav labels
      (Client→Owner), prospect-convert default property type; new projects default to
      commercial posture with progress-first billing ordering and "Fee" labels.
- [x] **Mixed-org test (the key one):** a residential-default org creates one
      commercial project — inside that project: Owner terminology, commercial billing
      ordering, commercial modules in sidebar (once later workstreams land, the
      `postures` field); its sibling residential project and all org-level surfaces:
      unchanged Client language. Flipping the project's property type flips its
      posture live. Verified with 12 pure resolver/terminology/nav/ordering assertions
      and a live tier-flip invariant against the internal mixed-posture QA org.
- [ ] Residential org (default) with only residential projects: zero visible change.
      Verify by loading the main surfaces before/after.
- [x] `seedCSICostCodes` produces a browsable 2-level CSI tree; new commercial orgs get
      it automatically; existing orgs can import from settings; an org holding both
      NAHB + CSI shows grouped pickers ordered by project posture. Live QA result: 23
      divisions + 207 sections = 230 unique CSI rows; commercial/residential group
      ordering assertions pass.
- [x] Budget Detailed view shows cost-type column for a budget using CSI codes. The QA
      commercial project has five CSI-backed budget lines spanning four cost types,
      with budget-line types verified to match their cost-code types.
- [x] `pnpm lint` clean; `pnpm test:financials` passes (45/45). `pnpm test:auth`
      (18/18), `pnpm test:mobile` (2/2), and `pnpm db:schema:check` also pass.
- [x] No inline `product_tier === ...` or `property_type === ...` posture checks
      outside `lib/product-tier.ts`, `lib/terminology.ts`, nav config, and
      default-choosing call sites.

### Internal QA fixture

- [x] Production org `Arc QA — Commercial` (`arc-qa-commercial`) provisioned as an
      active commercial-tier internal workspace with invites disabled.
- [x] One residential control project (0% retainage) and one commercial demo project
      (10% retainage), both excluded from production reporting.
- [x] Active internal demo membership, trial subscription, provisioning event, and
      provisioning audit record verified.

The two remaining unchecked items require the Workstream 01 application code to be
deployed and a signed-in browser session; the current production UI still serves the
pre-workstream build, so checking them here would not be evidence-based.
