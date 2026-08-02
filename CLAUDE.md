# CLAUDE.md — Arc

Arc is a construction platform with **three postures**, one codebase, one schema:

| Tier | Name | Segment | Status |
|---|---|---|---|
| `residential` | Arc | Custom-home builders | Live |
| `commercial` | Arc Commercial | Commercial GCs ($5–50M/yr) | Shipped Jul 2026 |
| `production` | Arc Production | Production builders (25–250 closings/yr) | Code-complete, deployed; QA-org acceptance pending |

Next.js 16 App Router + React 19 + Supabase + Stripe + Tailwind v4, plus an iOS
app on `/api/mobile/v1`. Users are construction PMs, superintendents, purchasing
and starts managers, sales consultants, and bookkeepers. They live in dense
tables and money numbers, not marketing pages.

**The two-level posture model is load-bearing.**

- **The PROJECT is the unit of posture** (`projects.property_type`). It decides
  terminology, which modules appear in the project sidebar, and financial
  defaults. In production posture a project is a *house on a lot*.
- **The ORG tier** (`orgs.product_tier`) only sets defaults for new projects,
  org-surface vocabulary, and packaging. Never a capability gate, never a data gate.
- **Mixed orgs are normal and are the design case** — a custom home and a 60-lot
  community side by side, one subscription. Nothing may assume an org is homogeneous.

Above the project sit **divisions** → **communities** → **lots**. These are
scoping filters layered on `org_id`; they never replace it and never isolate.

## ⚠️ Read before doing anything

- **Local dev points at PRODUCTION Supabase.** `.env.local` writes hit real
  customer data. Never run destructive SQL, seeds, or "test" mutations.
- **Never apply a migration yourself.** Write the `.sql` into
  `supabase/migrations/` (`YYYYMMDDHHMMSS_name.sql`), then STOP and tell the human
  it needs approval. You may keep writing service/UI code against the planned
  schema — just say clearly that the migration is pending.
- **`supabase/pending-migrations/` is a gated holding pen** for destructive
  cutovers held behind release gates. Never apply it, never move a file into
  `migrations/`, and never run a blanket `db push` that might sweep it in.
- Do NOT run `pnpm dev` (already running) or `pnpm build` (CI only).
- Server actions must return `{ success, error }` (or `ActionResult` from
  `lib/action-result.ts` — match the nearest sibling). Thrown errors get redacted
  to a useless digest in prod.
- Any new `/api/qbo/*`, `/api/jobs/*`, mobile, or webhook route must be added to
  `PUBLIC_API_ROUTES` in `proxy.ts` or it 307s to signin.
- Vercel Cron sends **GET**. Cron handlers must handle GET, not just POST.
- Never write new `qbo_*` columns. QBO is one adapter behind the accounting
  abstraction (`lib/services/accounting-*.ts`); entity mapping is a layer, not columns.

## Before you build anything

1. **Search first.** 220 services in `lib/services/`, 489 components, 179 pages.
   Assume the helper, service function, or component already exists. Grep before
   writing. Duplicating an existing capability is a defect, not a style issue.
2. **Find the exemplar.** Every kind of thing has a reference implementation.
   Open it and mirror its structure — file layout, naming, error handling — not
   just its idea.
   | Thing | Exemplar |
   |---|---|
   | Org desk | `app/(app)/sales/page.tsx` (ambient scope, row cap, `Promise.all`) |
   | Project workbench tab | `app/(app)/projects/[id]/financials/` |
   | Service | `lib/services/change-orders.ts`, `lib/services/house-plans.ts` |
   | Server action + form | `app/(app)/projects/[id]/expenses/` |
   | Detail sheet | `components/invoices/invoice-detail-sheet.tsx` |
   | Token portal | `app/s/[token]/` — layout gates + renders `PortalShell`, each section is a route |
   | Per-project numbering | `lib/services/project-sequence.ts` (copy the RFI impl) |
   | PDF | `lib/services/reports/pay-application.ts`, `lib/pdfs/esign.ts` |
   | Email | `lib/emails/` + `lib/services/mailer.ts` (`rfi-notification-email`) |
3. **One home per mutation.** Project pages are **workbenches** (mutations live
   there). Org pages are **desks** (read-mostly: rank, aggregate, deep-link; may
   one-click-complete ONLY by calling the workbench's server action). A feature
   earns a desk only if someone's whole JOB is that feature across projects —
   Purchasing, Starts, Sales, Warranty, Design Studio all pass. "My Work" and
   "My Houses" are the personal cross-project scopes. Never build a desk for symmetry.
4. **Community is a lens, not a nav mode.** Desk scope is ambient, from
   `getAmbientDeskContext()` (`lib/services/desk-context.ts`), defaulted by
   `community_assignments`. Never add a per-desk community `<Select>`, and never
   fork navigation by scope. Assignment is convenience; **division scope is the
   enforcement layer**.

## Posture: never branch inline

Posture-dependent behavior routes **only** through these choke points. Writing
`if (org.product_tier === 'commercial')` or `property_type === 'production'`
inline in a component is a defect — it breaks mixed orgs.

- `getProjectPosture()` / `getOrgProductTier()` — `lib/product-tier.ts`
- `terminology(posture)` — `lib/terminology.ts` (Client→Owner→Buyer,
  Contract→Purchase agreement). The single choke point for user-facing nouns.
- `PROJECT_MODULES` + `isProjectModuleEnabled()` — `lib/project-modules.ts`
- `getProjectFinancialFeatureConfig()` — `lib/financials/billing-model.ts`
- `components/layout/project-nav-items.ts` (`postures:` field)

**Naming:** never bake a posture into a table, column, or service name. It is
`prime_sov_lines`, not `commercial_sov_lines`; `budget_templates`, not
`production_budget_templates`. Domain terms that genuinely *are* the production
domain (communities, lots, house plans, starts, closings) keep their real names.

## Non-negotiable code rules

- Services own business logic (`lib/services/`): `requireOrgContext()` →
  `requirePermission()` → logic → `recordEvent()` + `recordAudit()` → mapped DTO.
  Pages and actions stay thin; if an action has business logic, move it.
- **Every query scoped by `org_id`.** No exceptions, RLS depends on it. Division
  and community are filters on top, never a substitute.
- **Money is integer cents** (`*_cents`) everywhere — unit costs, option prices,
  lot premiums, incentives. Percentages are numeric. Format at the edge only.
- Server Components by default. `"use client"` only for interactivity, and the
  client boundary sits as low in the tree as possible.
- No sequential awaits for independent data — `Promise.all`. No client-side fetch
  waterfalls for data a server component can load.
- **Lists get pagination or an explicit cap from day one,** and the cap is visible
  to the user when it truncates. 400-lot communities and 200-active-project orgs
  are the design case, not the stress case.
- Zod-validate every action input (`lib/validation/`).
- TypeScript: no `any`, no `as` casts to silence errors, no `!` unless provably
  safe. If types fight you, the model is wrong — fix the model. (Note: the ESLint
  config has `no-explicit-any` off, so this is on you, not the linter.)

## Registering a new entity

A new entity is not done when its table and page exist. In the **same change**:

- [ ] **RLS + indexes** in the migration — org-scoped policies copied from a
      recent neighbor, with every `auth.uid()` written `(select auth.uid())`
      (bare calls re-introduce the initplan perf bug fixed Jul 2026); indexes on
      `(org_id, project_id)` and every FK-hot column; the standard `updated_at` trigger.
- [ ] **RBAC catalog seed** — the catalog-as-code migration is the source of
      truth, not just `TEAM_PERMISSION_OPTIONS` in `lib/services/team.ts`. Follow
      `<domain>.<verb>`. State which existing roles receive the key.
- [ ] **Search index** — `lib/services/search-index.ts` maps `recordAudit()`
      entity types onto search types. Unregistered = invisible to global search.
- [ ] **Events** via `recordEvent()`.
- [ ] **Email allowlist** — only types in `EMAIL_NOTIFICATION_TYPES`
      (`lib/types/notifications.ts`) ever send email. Wiring the notification
      service is NOT enough; that silent-no-send bug has shipped before.
- [ ] **Mobile API** (`/api/mobile/v1`) if field-relevant.
- [ ] **Cron registry** — `CRON_JOBS` in `lib/services/job-runs.ts` mirrors
      `vercel.json`, and the route is in `PUBLIC_API_ROUTES`.

## Design

Full standard: **`docs/design.md`** — read it before building any new surface.
The hard rules:

- **Two zones.** `app/(app)/**` is ascetic: no gradients, no glows, no
  glassmorphism, no hero/marquee banners, no decorative color, no idle animation.
  Auth pages, token portals, and legal/marketing are expressive. Only three
  identity elements cross into the ascetic zone (see `docs/design.md` §1).
- **Tokens only** — no hex/rgb/oklch literals, no raw Tailwind palette classes.
  Tokens are `oklch`; never wrap one in `hsl()`. **Linted** — new `.tsx` errors;
  132 legacy files are grandfathered in `.eslintrc.js` (`pnpm lint:tokens`).
  Clean a file → delete its path from that list. Never add one.
- **Radius is 0.** Never set a radius class to control shape; `--radius` owns it.
  `rounded-full` for chips, dots, and avatars only.
- **Color is state,** never decoration and never section identity.
- **Dense tables over cards,** `tabular-nums` for money, match your siblings'
  type sizes and spacing.
- **Every view ships empty, loading, error, and dark mode.** Missing any = unfinished.
- Motion: one `.desk-rise` entrance per page, hover ≤200ms, no infinite animation
  except live-progress indicators for work actually happening.

## Leave no trash

- Replacing something? The old component/route/flag/helper is DELETED in the same
  change. A redirect is acceptable; a parallel implementation is not.
- No `-v2`, `-new`, `-enhanced`, `-improved` names. The new thing takes the real
  name; the old thing dies.
- No commented-out code, no console.log, no unused exports/imports/props. No
  "for future use" parameters or speculative abstractions.
- No fallback branches for states that can't occur. Handle real failure modes;
  don't wrap everything in try/catch that swallows errors.

## Database & Supabase

- Schema reference: `docs/database-overview.md`. 216 migrations, 258+ tables.
- **Supabase MCP tools are available** — use them instead of guessing:
  - `list_tables` to check real schema before writing queries or migrations
  - `execute_sql` for read-only inspection (PRODUCTION — **SELECTs only**)
  - `get_logs` / `get_advisors` when debugging, before changing anything
  - `apply_migration` — only when the human explicitly asks, never on your own
- Multi-tenant: all tables `org_id`-scoped with RLS. Events → `events`,
  audit → `audit_log`, async work → `outbox`, cron telemetry → `job_runs`.

## Verifying your work

`pnpm lint` is **NOT type-aware** — the ESLint config has no `parserOptions.project`.
Type errors need a separate `tsc` run. Always both:

```bash
pnpm lint && npx tsc --noEmit
```

`pnpm lint` runs `--quiet`, so it reports errors only and must come back
completely silent. The token-debt backlog (949 warnings across 132 grandfathered
files) is behind `pnpm lint:tokens`.

Then the suites your change touches:

| Area | Command |
|---|---|
| Financials, accounting, pay apps, COs, pricing, POs, VPOs, warranty | `pnpm test:financials` |
| Permissions / RBAC | `pnpm test:auth` |
| Mobile API contract | `pnpm test:mobile` |
| Schedule math | `pnpm test:schedule` |
| Posture, terminology, land foundation | `pnpm test:land` |
| Starts / even-flow | `pnpm test:starts` |
| Importers / onboarding | `pnpm test:onboarding` |
| Floorplan interpretation / 3D geometry | `pnpm test:floorplan` |
| Schema drift | `pnpm db:schema:check` |

## Definition of done

- `pnpm lint` clean **and** `npx tsc --noEmit` clean.
- The relevant test suites above pass.
- Empty / loading / error states + dark mode verified.
- Mutations: org-scoped, permission-checked, event + audit emitted, returns
  `{ success, error }`.
- New entity? The registration checklist above is complete.
- You searched for and deleted anything your change obsoleted.

## docs/ — what is authoritative

`docs/README.md` is the map; read it before reading anything else in `docs/`.

- **Reference** — the `docs/` top level and the two expansion suites. True now,
  maintained. Safe to rely on.
- **`docs/plans/**`** — INTENT, never truth. Nothing in there is guaranteed to
  exist. Read it when you are about to execute that plan; **never** cite it as
  how Arc behaves.
- **`docs/archive/**`** — off-limits. Executed or superseded plans, kept only for
  historical rationale. Do not read unless the human explicitly asks for history,
  and never use one as an implementation guide.
- **Where a doc and the code disagree, the code wins.** For schema, the live
  Supabase MCP `list_tables` beats `docs/database-overview.md`.
- **When a plan ships, delete it in the same change** (the "Leave no trash" rule,
  applied to docs). Fold anything durable into a reference doc or this file
  first; git keeps the rest.

## Deep dives (read the doc BEFORE touching the area)

- **Expansion gameplans** — `docs/commercial-expansion/00-MASTER-*.md` and
  `docs/production-expansion/00-MASTER-*.md` are the authoritative context for
  everything commercial/production. Read the master before any workstream doc.
- **Role/surface map** — `docs/production-org-playbook.md`: who lives on which
  desk and what they mutate. Read it before deciding where a production feature belongs.
- **QBO / accounting** — sharp edges everywhere (SyncToken backfill, no complex
  columns in QBO queries — use `SELECT *`, proxy routes). Workstream 08's cutover
  is mid-flight behind release gates; ask before touching sync.
- **Drawings pipeline** — `lib/services/drawings-pipeline.ts`: re-uploads stack
  versions onto ONE canonical sheet set per project. Never create a set per
  upload, never delete old sheets.
- **Portals** are token-based public routes: `app/p` (client/buyer), `app/s`
  (sub), `app/b` (bid), `app/proposal`, `app/i` (invoice), plus `app/d`, `app/e`,
  `app/f`, `app/r`, `app/t`. The workspace portals (`p`, `s`, `r`) share one
  chrome: the route layout runs `resolvePortalGate()` (`lib/portal/gate.tsx`) for
  the token → account → PIN sequence, then renders `PortalShell` with a nav built
  by `buildXPortalNav()`. Every section is a real route so it can be deep-linked
  from a notification email — never add a client-side tab switcher. Only the
  portal **root** calls `recordPortalAccess()`; `max_access_count` limits link
  uses, so counting on each page would let one visit burn several.
- **Acceptance testing runs in the dedicated QA org.** There is no staging
  environment. Never run acceptance scenarios in a customer org.
