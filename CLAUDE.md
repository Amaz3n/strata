# CLAUDE.md — Arc

Arc is construction management SaaS for local builders/GCs: projects, scheduling,
daily logs, drawings, client portals, financials (invoices, draws, change orders,
QBO sync). Next.js 16 App Router + Supabase + Stripe. Users are construction PMs
and bookkeepers: they live in dense tables and money numbers, not marketing pages.

## ⚠️ Read before doing anything

- **Local dev points at PRODUCTION Supabase.** `.env.local` writes hit real
  customer data. Never run destructive SQL, seeds, or "test" mutations locally
  without asking. Schema changes go through `supabase/migrations/` only.
- Do NOT run `pnpm dev` (already running) or `pnpm build` (CI only).
  Verify with `pnpm lint` (type-aware; also surfaces TS errors).
- Server actions must return `{ success, error }` result objects — thrown
  errors get redacted to a useless digest in prod.
- Any new `/api/qbo/*` or webhook route must be added to PUBLIC_API_ROUTES in
  `proxy.ts` or it 307s to signin.
- Vercel Cron sends GET. Cron route handlers must handle GET, not just POST.

## Before you build anything

1. **Search first.** ~90 services in `lib/services/`, ~440 components. Assume
   the helper, service function, or component already exists. Grep before
   writing. Duplicating an existing capability is a defect, not a style issue.
2. **Find the exemplar.** Every kind of thing has a reference implementation:
   - Project workbench tab: `app/(app)/projects/[id]/financials/`
   - Service: `lib/services/change-orders.ts`
   - Server action + form: `app/(app)/projects/[id]/expenses/`
   - Detail sheet: invoice detail sheet in `components/invoices/`
   Copy the structure of the exemplar. Do not invent a new pattern for a
   problem an existing page already solves.
3. **One home per mutation.** Project pages are workbenches (where mutations
   live). Org pages are desks (read-mostly, rank/aggregate, deep-link into
   workbenches; may one-click-complete ONLY by calling the workbench's server
   action). A feature earns an org desk only if someone's whole JOB is that
   feature across projects. "My Work" is the personal cross-project scope.
   Never build an org view for symmetry.

## Non-negotiable code rules

- Services own business logic (`lib/services/`): `requireOrgContext()` →
  `requirePermission()` → logic → `recordEvent()` + `recordAudit()` → mapped DTO.
  Pages and actions stay thin; if an action has business logic, move it.
- Every query scoped by `org_id`. No exceptions, RLS depends on it.
- Server Components by default. A file gets `"use client"` only for
  interactivity, and the client boundary sits as low in the tree as possible.
- No sequential awaits for independent data — `Promise.all`. No client-side
  fetch waterfalls for data a server component can load.
- Lists that can grow unbounded get pagination or a cap from day one.
- Zod-validate every action input (`lib/validation/`).
- TypeScript: no `any`, no `as` casts to silence errors, no `!` unless provably
  safe. If types fight you, the model is wrong — fix the model.

## Design rules (violating these is a bug, not a style choice)

- **Tokens only.** Colors come from `app/globals.css` variables (oklch).
  Never a hex/rgb/oklch literal in a component, never a new Tailwind gray.
  Radius is 0 — this app is square. No gradients, no glassmorphism, no emoji
  in product UI, no drop shadows beyond what existing components use.
- **No hero/marquee banners.** Do not open pages with large decorative hero
  blocks, colored marquee panels, or oversized stat billboards. Pages open
  with the work: a title row, then the data. Existing marquee-style headers
  are legacy, not a pattern to copy.
- **shadcn/ui primitives only** (`components/ui/`). Need a variant? Extend the
  primitive, don't fork it or inline a new one.
- **Dense, calm, editorial.** These are pros scanning numbers: prefer tables
  over cards, tabular-nums for money, small type sizes matching neighboring
  pages, restrained color (color means state, not decoration). When in doubt,
  choose the quieter option.
- Every view ships with empty state, loading state, and error state, and works
  in dark mode. A page missing any of these is unfinished.
- Match the information density and spacing of the page's siblings. If your
  new tab looks like it came from a different app, it did — redo it.

## Leave no trash

- Replacing something? The old component/route/flag/helper is DELETED in the
  same change. A redirect is acceptable; a parallel implementation is not.
- No `-v2`, `-new`, `-enhanced`, `-improved` names. The new thing takes the
  real name; the old thing dies.
- No commented-out code, no console.log, no unused exports/imports/props left
  behind. No "for future use" parameters or speculative abstractions.
- No fallback branches for states that can't occur. Handle real failure modes;
  don't wrap everything in try/catch that swallows errors.

## Database & Supabase

- Schema reference: `docs/database-overview.md`.
- **Supabase MCP tools are available** — use them instead of guessing:
  - `list_tables` to check real schema before writing queries or migrations
  - `execute_sql` for read-only inspection (remember: this is PRODUCTION —
    SELECTs only unless the user explicitly approves a write)
  - `apply_migration` to apply migrations when asked; also save the SQL to
    `supabase/migrations/` so the repo stays the source of truth
  - `get_logs` / `get_advisors` when debugging before changing anything
- CLI equivalents: `npx supabase db push`, `db diff -f <name>`,
  `functions deploy <name>`.
- Multi-tenant: all tables scoped by `org_id` with RLS. Events → `events`,
  audit → `audit_log`, async work → `outbox`.

## Definition of done

- `pnpm lint` clean.
- Empty/loading/error states + dark mode verified.
- Mutations: org-scoped, permission-checked, event emitted, returns
  `{ success, error }`.
- You searched for and deleted anything your change obsoleted.
- Financials work: run `pnpm test:financials`.

## Deep dives (read the doc BEFORE touching the area)

- QBO sync/import: sharp edges everywhere (SyncToken backfill, no complex
  columns in QBO queries — use `SELECT *`, proxy routes). Check `docs/`
  financials gameplans and ask if unsure.
- Drawings pipeline: `lib/services/drawings-pipeline.ts` — re-uploads stack
  versions onto ONE canonical sheet set per project; never create a set per
  upload, never delete old sheets.
- Client/sub portals are token-based public routes: `app/p/[token]`,
  `app/s/[token]`, `app/proposal/[token]`, `app/i/[token]`.
