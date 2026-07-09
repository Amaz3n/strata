# Workstream 01 — Product Tiers, Terminology, Commercial Defaults, CSI Cost Codes

> Prereq: read `00-MASTER-commercial-expansion.md`. This workstream has no dependencies
> and unblocks every other one. It is mostly plumbing — resist the urge to redesign UI.

## Goal

1. An org-level `product_tier` flag (`residential` | `commercial` | `production`) with
   helpers every other workstream consumes.
2. A terminology layer so commercial orgs see "Owner" where residential sees "Client,"
   without forking components.
3. Commercial-appropriate defaults (project property type, billing posture, nav).
4. A shipped CSI MasterFormat cost-code library (seedable per org, like the NAHB seed).
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

## Phase A — `product_tier` flag

**Migration** (write to `supabase/migrations/<ts>_org_product_tier.sql`, do not apply):

```sql
alter table public.orgs
  add column if not exists product_tier text not null default 'residential'
  check (product_tier in ('residential', 'commercial', 'production'));
comment on column public.orgs.product_tier is
  'Product posture: changes terminology, defaults, and module visibility. Never gates data.';
```

**Service layer:**

- Extend the org DTO in `lib/services/orgs.ts` (and any org-context type in
  `lib/auth/context.ts`) with `product_tier`.
- New file `lib/product-tier.ts` (pure, no server-only imports so client components can
  use the types):

```ts
export type ProductTier = "residential" | "commercial" | "production";
export const PRODUCT_TIERS: ProductTier[] = ["residential", "commercial", "production"];
// display names for platform admin UI
export const PRODUCT_TIER_LABELS: Record<ProductTier, string> = {
  residential: "Arc",           // final branding TBD by human
  commercial: "Arc Commercial",
  production: "Arc Production",
};
```

- Server helper `getOrgProductTier()` colocated with org context (returns the tier from
  the already-loaded org context — do NOT add a new query; piggyback on
  `requireOrgContext()`'s org row).
- Platform admin: add a tier selector to the customer admin surface
  (`app/(app)/admin/customers/` — there is an actions.ts/page.tsx pair; follow its
  existing edit patterns). Only platform admins change tier.
- Emit `recordAudit` + `recordEvent` on tier change.

## Phase B — Terminology layer

Single choke point for tier-dependent nouns.

- New file `lib/terminology.ts`:

```ts
import type { ProductTier } from "./product-tier";

const TERMS = {
  residential: { owner: "Client", owners: "Clients", ownerPortal: "Client portal",
                 fee: "Builder's fee", primeContract: "Contract" },
  commercial:  { owner: "Owner", owners: "Owners", ownerPortal: "Owner portal",
                 fee: "Fee", primeContract: "Prime contract" },
  production:  { owner: "Buyer", owners: "Buyers", ownerPortal: "Buyer portal",
                 fee: "Fee", primeContract: "Purchase agreement" },
} as const;

export type TermKey = keyof (typeof TERMS)["residential"];
export function terminology(tier: ProductTier) { return TERMS[tier]; }
```

- Thread the tier into client components the same way other org-level context reaches
  them today (find how org name/logo reach the app shell — likely props from
  `app/(app)/layout.tsx`; add tier there, and expose a small context/provider ONLY if
  one already exists for org info. Do not invent a new global store).
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

## Phase C — Commercial defaults

Gate on `getOrgProductTier()`:

- `convert-prospect-sheet.tsx`: default `property_type` to `"commercial"` for commercial
  orgs (keep the field editable both ways).
- Project creation sheet(s): same default; also default project `retainage_percent` to
  10 for commercial tier (verify the field exists on the create flow; it exists on
  `projects`).
- Billing model picker (`lib/financials/billing-model.ts` consumers — find the project
  financial setup step, see memory: two-step project sheet, `project-financial-setup.ts`):
  for commercial orgs, order the options fixed_price (progress billing) first,
  cost_plus_gmp second; hide `time_and_materials` less prominently. Do NOT remove any
  option for any tier.
- Nav config: this phase only *prepares* — add a `tiers?: ProductTier[]` field to the
  nav item config type with default "all tiers." Later workstreams register their new
  modules with `tiers: ["commercial", "production"]`. Residential-only surfaces
  (Selections) get `tiers: ["residential", "production"]`.
- `orgs.locale`-style plumbing check: confirm tier reaches every layout that renders nav.

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

- [ ] Migration files written (tier column, cost_type) — NOT applied without approval.
- [ ] Flipping a test org to `commercial` (via admin UI) changes: nav labels
      (Client→Owner), prospect-convert default property type, billing-mode ordering,
      "Builder's fee" → "Fee" on a cost-plus invoice preview.
- [ ] Residential org (default): zero visible change. Verify by loading the main
      surfaces before/after.
- [ ] `seedCSICostCodes` produces a browsable 2-level CSI tree; new commercial orgs get
      it automatically; existing orgs can import from settings.
- [ ] Budget Detailed view shows cost-type column for a budget using CSI codes.
- [ ] `pnpm lint` clean; `pnpm test:financials` passes.
- [ ] No inline `product_tier === ...` checks outside `lib/product-tier.ts`,
      `lib/terminology.ts`, nav config, and default-choosing call sites.
