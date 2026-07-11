# Workstream 09 — Deferred Platform Items + Arc Production Design Constraints

> This doc is mostly RECORD, not build. It exists so (a) deferred decisions are
> explicit and don't get accidentally half-built inside other workstreams, and (b) the
> future Production tier doesn't get designed out by accident. The only buildable
> items here are the three small "Prep tasks" at the end — everything else requires a
> human go-decision first.

## A. Consciously deferred (do NOT build without explicit instruction)

### A1. Accounting beyond QBO (Sage 300 CRE / Vista / Foundation / CMiC)

- Current state: QBO is hardcoded — `qbo_*` columns denormalized onto financial
  tables, sync functions named `...ToQBO`, no provider interface
  (`lib/integrations/accounting/` is QBO-only).
- Why deferred: target segment ($5–50M GCs) predominantly runs QBO. ERP adapters are
  months of work each and demand enterprise support posture.
- Standing rule for ALL workstreams: when touching sync code, do not deepen the
  coupling — new financial entities (pay applications) sync via the existing invoice
  path rather than growing new `qbo_*` columns of their own.
- Trigger to revisit: 3+ lost deals naming a specific ERP.

### A2. SSO / SAML / SCIM

- None exists (Supabase email/password + portal accounts). Enterprise-only need.
- Trigger: first customer >100 employees or a security questionnaire demanding it.
  Likely path: Supabase Auth SAML or WorkOS in front; decide then.

### A3. Customer-facing API + webhooks

- Today: internal session APIs + mobile v1 only. Commercial GCs eventually want
  Zapier/PowerBI feeds. Cheap interim already exists: report CSV exports.
- Trigger: repeated integration requests; start with a read-only reports API + org
  API keys.

### A4. P6 / MS Project schedule interchange

- Deferred with schedule hardening shipped (08). XER/XML import is a real
  differentiator for commercial but parsing is gnarly; consider a services-level
  import (XER → schedule_items+dependencies) as its own future gameplan.

### A5. Multi-org hierarchy (divisions/regions) and GC↔sub federation

- Single-tenant orgs, no hierarchy, no cross-org identity. Both are deep platform
  work. Portal accounts already give externals a cross-token workspace within one
  org — good enough for now.

### A6. Consolidations noted during the audit (cleanup debt, not expansion)

- Estimates-as-executed-offer vs Proposals: two overlapping signable artifacts.
- Legacy CRM (`lib/services/crm.ts`) vs prospects.
- Schedule-item `inspection` type vs the new inspections engine (06).
- `change_orders.status` free-text column after lifecycle (03) fully lands.
Each is a candidate `/simplify`-style follow-up; none blocks commercial launch.

### A7. Certified payroll / prevailing wage (Davis-Bacon)

- Not built anywhere in this suite. Any commercial GC touching public work (schools,
  municipal, federally funded) will ask in the first demo — sales needs a scripted
  answer: "time tracking captures the hours; certified payroll reports (WH-347) are
  on the roadmap." `time_entries` + billing-rate schedules are the substrate; the
  gap is worker classifications, wage determinations, and the WH-347 report format.
- Trigger: first prospect whose pipeline is majority public work, or 2+ lost deals
  naming certified payroll.

### A8. GC-side insurance & bonding

- Arc tracks SUB compliance thoroughly; owners impose the same on the GC (the GC's
  own COIs per project, payment/performance bonds, owner-required coverage limits).
  Today this lives in the files area untyped.
- Likely small: a per-project "our compliance" record reusing the
  compliance-documents engine with the org itself as the subject.
- Trigger: repeated requests, or when a pay-app package needs the bond rider attached.

### A9. Sub-tier lien waivers

- Standard commercial practice: collecting waivers from your subs' suppliers and
  sub-subcontractors, not just first-tier subs. Current `lien_waivers` is
  first-tier only.
- Trigger: first customer on a project whose owner/lender demands full-tier waiver
  packages with each pay app.

### A10. iOS parity for field modules (deferred with a DATE, not a shrug)

- Workstreams 06 and 08 each note "iOS out of scope" — but inspections, punch
  dispatch, and daily-report sections are the most field-centric features in the
  program, and the commercial pitch includes field crews. Deferring is fine;
  letting it drift is not.
- Commitment: when 06 and 08 both land, file `docs/` gameplan for `/api/mobile/v1`
  + ios/Arc parity (inspections run screen, punch queue, daily-report sections) as
  the NEXT mobile workstream, before other iOS work.

## B. Arc Production (Lennar-style) — design constraints to honor NOW

Production building is a different operating model: the unit of work is the **lot**
inside a **community**, built from a **plan** (floor plan + elevation + option
packages), on a repeatable schedule, with purchasing done via unit-price catalogs per
plan, and sales/warranty at volume. Do not build any of this yet. DO honor these
constraints so it stays buildable:

1. **Tier plumbing:** `production` is already a valid `product_tier` (01). All tier
   switches go through the 01 helpers — never binary residential/commercial checks.
2. **Project stays the atom.** A lot will be modeled as a project belonging to a
   grouping (community). Therefore: never assume org→projects is a flat two-level
   world in NEW code — avoid baking "the org's projects" aggregations into services
   where a scoping container could sit in between; prefer passing explicit project-id
   sets into rollup helpers (the portfolio schedule and org desks already query by
   org — fine — but keep rollup functions parameterizable by project list, which most
   already are via reporting-scope).
3. **Templates are the seam.** Production = templatized everything. The existing
   template patterns (schedule_templates, estimate_templates, checklist_templates,
   e-sign templates, submittal workflow templates) are the mechanism plan libraries
   will hang off. When building any new entity in workstreams 02–08, ask "could an org
   define a reusable template of this?" and keep creation paths factored so a
   template-instantiation call site is easy to add (this was done for inspections and
   submittal workflows — keep the discipline).
4. **Terminology:** `production` rows already exist in the terminology map ("Buyer",
   "Purchase agreement"). Extend the map, never inline.
5. **Selections is Production's friend.** The residential Selections feature
   (deprioritized for commercial nav) maps almost 1:1 to production option/upgrade
   selection — do not delete it during commercial work.
6. **Naming:** no `commercial_*` table or column names anywhere (restated from 00).

When Production gets green-lit, its gameplan starts with: `communities` table
(org→community→projects-as-lots), `plans` library (plan + elevation + option packages
→ estimate/budget/schedule template bundles), volume purchasing (unit-price catalogs
per plan against `commitments`), and sales pipeline per community. File that gameplan
as `docs/production-expansion/` when the time comes.

## C. Prep tasks (buildable now, small)

1. **Reporting-scope audit (½ day):** verify every org-wide rollup
   (`reporting-scope.ts` consumers, org desks, portfolio schedule) goes through a
   single project-scoping helper; refactor stragglers to it. This is the seam
   communities will slot into.
2. **CSV-everything (1 day):** every register/log built in 02–08 (pay apps, change
   events, meetings, transmittals, inspections, incidents, delay log, prequal
   directory) ships CSV export via `lib/services/reports/csv.ts`. Sweep and fill
   gaps. Interim answer to A3.
3. **Marketing-surface flag only:** if the human wants tier names public (Arc /
   Arc Commercial / Arc Production), that's `PRODUCT_TIER_LABELS` (01) + website copy
   — confirm final names with the human first; do not invent branding in code beyond
   the labels constant.

## Acceptance

- [ ] This doc reviewed by the human; deferred items explicitly acknowledged.
- [ ] Prep tasks 1–2 done after workstreams 02–08 land (they sweep those outputs).
- [ ] No `commercial_*` identifiers exist in the codebase
      (`grep -ri "commercial_" lib/ app/ components/ supabase/migrations/` returns
      only comments/copy, no schema or symbol names).
