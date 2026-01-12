# Strata Snappiness Gameplan (LLM-Optimized, Foundation-Level)

Goal: Make Strata feel **dramatically faster than Procore/Buildertrend** by fixing foundational routing/layout + data-fetching patterns so:
- The **app shell (sidebar/topbar) never disappears** during navigation
- Most navigations feel **instant** (content swaps + localized skeletons only)
- Server work per route is **minimal, cached, and parallelized**
- Client JS is **small and responsive** (great INP)

This plan is explicitly grounded in **current repo reality** (see §0).

---

## 0) Repo Reality (Current State Findings)

### 0.1 App shell is implemented as a per-page client component
- `components/layout/app-shell.tsx` is `"use client"` and includes `SidebarProvider`, `AppSidebar`, `AppHeader`.
- Many pages render `<AppShell ...>{children}</AppShell>` directly (not via a shared segment `layout.tsx`).

Impact:
- On navigation, the shell can **unmount/remount**, causing “whole app reload” perception and re-running mount-time work.

### 0.2 Blanket dynamic rendering across the app
- Many pages set `export const dynamic = "force-dynamic"` (observed across the majority of `app/*/page.tsx`).

Impact:
- Reduced caching and less effective prefetching.
- More frequent server work, higher TTFB, slower route transitions.

### 0.3 Middleware does DB work for authorization on matched routes
- `middleware.ts` calls `supabase.auth.getUser()` on every request.
- For certain prefixes, it may query memberships + permissions (including via service role).

Impact:
- Middleware can add latency to navigations (App Router/RSC requests) and increase overall server overhead.

### 0.4 Repeated “auth/org context resolution” is not memoized per request
- Many service calls rely on `requireOrgContext()` → `requireOrgMembership()` → `supabase.auth.getUser()` + membership resolution.
- A single page often triggers multiple services concurrently (e.g. list entities + permissions + current user), which can duplicate auth/org resolution and queries.

Impact:
- Higher server time per route; slower navigations; more Supabase queries than necessary.

### 0.5 Shell-level client fetching adds churn
- `components/layout/org-switcher.tsx` fetches `/api/orgs` with `{ cache: "no-store" }` on mount.

Impact:
- If shell remounts during navigation, org list fetch re-runs frequently, adding extra requests + visible skeletons in the sidebar header.

---

## 1) Success Criteria (What “Extremely Snappy” Means)

### 1.1 User-perceived targets
- Sidebar/topbar are **always present** during navigation (no full-page blanking).
- Intra-app navigations feel like **<200ms** for “shell stable + cached data” cases.
- Loading states are **localized to the content panel** (or even smaller subsections), not global.

### 1.2 Metrics (Vercel + Web Vitals)
Targets for typical logged-in desktop on good connection:
- **TTFB (median)**: < 300ms for common pages
- **LCP (p75)**: < 1.5s
- **INP (p75)**: < 200ms
- **CLS**: ~0
- **Route transition “content visible”**: < 300–500ms for common routes; < 1.0s for heavy pages

### 1.3 Backend/DB targets (Supabase)
- Common navigations should execute **single-digit queries** (not “dozens”).
- Avoid repeated auth/org lookups per request; ideally **1 context resolution** + N domain queries.
- For list pages: avoid full-table scans; ensure key filters are indexed.

---

## 2) Principles (Non-Negotiables)

1) **Persistent shell**: Sidebar/topbar must live in a shared App Router `layout.tsx` segment so they do not remount per navigation.
2) **Cache by default**: Only force dynamic where genuinely required (real-time / user-personalized without safe caching).
3) **Request-scoped memoization**: “Who is the user / what org / what membership” computed once per request and reused.
4) **Minimize client JS**: Keep client components as “islands” for interactivity. Prefer RSC for layout + data display.
5) **Localized loading states**: Place `loading.tsx` and Suspense fallbacks at the smallest reasonable segment.
6) **Measure → change → verify**: Every phase has instrumentation + expected results.

---

## 3) Phased Rollout Plan (Do in this order)

### Phase A — Baseline + observability (1–2 days)
Purpose: know what’s slow, and avoid “optimizing blind.”

**Tasks**
- Enable/confirm Vercel Speed Insights + Web Vitals dashboards.
- Add a shared “performance notes” checklist (see §6) to every performance PR.
- Identify the 5 most important user flows (examples):
  - `/projects` → `/projects/[id]` → `/projects/[id]/schedule`
  - `/projects` → `/directory`
  - `/projects/[id]` → `/projects/[id]/files`
  - `/projects/[id]/financials` load
  - `/tasks` list + interactions

**Acceptance**
- You can state (with data) whether slowness is primarily:
  - server/TTFB, or
  - client/main-thread (INP), or
  - DB latency.

**Expected results**
- No speed change yet; clarity on biggest bottlenecks.

---

### Phase B — Routing foundation: persistent shell + correct loading boundaries (highest ROI)
Purpose: fix the “whole app skeleton” perception and reduce remount churn.

**Tasks**
- Introduce route groups:
  - `(auth)` for auth pages (no shell)
  - `(app)` for logged-in pages (shell)
  - keep tokenized public pages (`/p/[token]`, `/s/[token]`, `/i/[token]`, `/proposal/[token]`) outside `(app)` if they should not show the internal shell
- Move shell (sidebar/topbar + providers that should persist) into `app/(app)/layout.tsx`.
- Ensure `loading.tsx` exists only where it should affect **content**, not the shell.

**Acceptance**
- Navigating via sidebar never removes sidebar/topbar.
- Only the content region shows skeleton/loading state.

**Expected results**
- Massive perceived speed improvement.
- Fewer mount-time client effects per navigation (org switcher, notification bell, etc.).

---

### Phase C — Stop blanket `force-dynamic`; reintroduce caching and prefetch wins
Purpose: unlock Next’s strengths (RSC streaming, caching, prefetch) for “snappy clicks.”

**Tasks**
- Inventory every `export const dynamic = "force-dynamic"`:
  - Keep only on routes that truly require it.
  - For list/detail pages, prefer cache + revalidate where safe.
- Identify “user-specific but cacheable-ish” data:
  - Most org-scoped lists (projects, contacts, companies) can be revalidated (e.g. 30–120s) and invalidated on mutation.
- Ensure mutations call `revalidatePath` precisely (avoid revalidating `/` + large trees unnecessarily).

**Acceptance**
- Sidebar navigations begin to feel near-instant on repeated clicks.
- Reduced TTFB variance across requests.

**Expected results**
- 30–70% faster repeat navigations to common pages (especially list pages).

---

### Phase D — Request-scoped memoization of auth/org/membership context
Purpose: reduce server cost and DB queries per navigation.

**Tasks**
- Memoize “auth context” + “org context” per request so repeated calls don’t re-hit Supabase.
- Ensure services that call `requireOrgContext()` do not cascade into repeated membership queries.
- Standardize a pattern:
  - page → server action/service(s) → accepts a context (supabase, orgId, userId) when available
  - avoid re-deriving the same context in each service call

**Acceptance**
- Same page render does not call `supabase.auth.getUser()` multiple times.
- DB queries per page drop measurably (track via Supabase logs + instrumentation).

**Expected results**
- 100–500ms improvements on many routes depending on current duplication.
- Lower Supabase load; better p95/p99 consistency.

---

### Phase E — Middleware slimming (move expensive checks out)
Purpose: reduce “hidden tax” paid on every request.

**Tasks**
- Keep middleware responsible for *simple gating* only (e.g. redirect unauthenticated users).
- Move permission graph checks out of middleware into:
  - server layouts/pages (where memoization + caching can help), or
  - a faster authorization strategy (e.g. coarse route-level checks + per-action checks in services)
- Ensure public routes remain public and skip heavy work.

**Acceptance**
- Middleware avoids DB queries (or reduces them to near-zero for most routes).
- Faster route transitions and lower server overhead.

**Expected results**
- Lower baseline latency and less jitter, especially on cold-ish navigations.

---

### Phase F — Client responsiveness: reduce JS, hydration, and expensive render paths
Purpose: fix “sluggish” feel even when network is fast.

**Tasks**
- Audit client component footprint:
  - Shell components should be as light as possible.
  - Heavy widgets (charts, gantt, PDF viewers, large tables) should be lazy-loaded and/or split.
- Reduce unnecessary `useEffect` / `useState` in frequently-mounted components.
- Ensure lists are virtualized where needed (large tables).
- Make skeletons cheap (avoid rendering huge skeleton trees if not needed).

**Acceptance**
- INP improves; UI interactions (opening menu, switching tabs, scrolling lists) feel crisp.

**Expected results**
- Big improvements in perceived “snappiness” on mid-tier laptops and mobile.

---

### Phase G — Database + query tuning (make “fast by default” at scale)
Purpose: keep performance stable as data grows.

**Tasks**
- For each hot page/service, list:
  - query shape
  - filters/sorts
  - expected index
- Add/verify indexes for the most common patterns:
  - `(org_id, created_at)`
  - `(org_id, status, created_at)`
  - project-scoped tables: `(org_id, project_id, created_at)` and `(org_id, project_id, status, due_date)` as relevant
- Reduce payload:
  - select only columns required for the current view
  - avoid joining large nested objects when counts or small previews suffice

**Acceptance**
- No sequential query chains in common route loads unless absolutely necessary.
- Supabase query times remain stable as rows scale.

**Expected results**
- Lower p95/p99 route latency; fewer “random” slow loads.

---

### Phase H — Navigation UX polish (perceived speed multipliers)
Purpose: make fast feel even faster.

**Tasks**
- Add prefetch strategy for sidebar routes (default Next prefetch where caching allows).
- Use optimistic UI for common mutations (create/update) so UI responds immediately.
- Keep scroll positions and UI state stable across route transitions where appropriate.

**Acceptance**
- “Click → response” feels immediate even when background refresh happens.

**Expected results**
- Procore-beating “snap” in everyday use.

---

## 4) Workstreams (Prioritized Backlog)

### P0 (Do first)
- Persistent shell in `layout.tsx` (stop shell remounts).
- Fix loading boundary placement (content-only skeletons).
- Reduce or eliminate `force-dynamic` blanket usage.

### P1
- Request-scoped memoization of auth/org context.
- Middleware slimming.
- Cut redundant network requests from shell (org switcher, etc.).

### P2
- Client JS reduction + lazy loading heavy modules.
- DB indexes and query slimming for hot paths.

### P3
- Prefetch/optimistic UX; deeper polish (virtualization, caching layers).

---

## 5) Expected Results by Phase (What You Should See)

### After Phase B (persistent shell)
- **Sidebar/topbar never disappear** on navigation.
- Perceived load time drops immediately even if backend work remains.

### After Phase C + D (caching + memoization)
- Many navigations feel **near-instant** on repeat.
- Median TTFB drops; p95 becomes less spiky.

### After Phase F (client JS + INP)
- UI becomes crisp: menus open instantly, scrolling stays smooth, less “sluggishness.”

### After Phase G (DB tuning)
- Performance stays stable with more projects, tasks, schedule items, files.

---

## 6) Snappiness Checklist (Use for Every Performance PR)

### 6.1 Routing/layout checklist
- [ ] Shell is in a shared `layout.tsx` and does not remount per page navigation.
- [ ] `loading.tsx` fallbacks are placed at the **smallest** segment that makes sense.
- [ ] Navigation uses Next `<Link>` (no full reloads).

### 6.2 Caching checklist
- [ ] No blanket `force-dynamic`; only where required.
- [ ] Mutations revalidate the smallest necessary paths (avoid global revalidate).
- [ ] Data payloads are minimized to required columns.

### 6.3 Data + auth context checklist
- [ ] Auth/org context is computed once per request (memoized).
- [ ] Services accept context when available; do not re-derive repeatedly.

### 6.4 Middleware checklist
- [ ] Middleware avoids DB work where possible.
- [ ] Any remaining middleware work is justified and measured.

### 6.5 Client performance checklist
- [ ] Client components are minimized; heavy widgets are lazy-loaded.
- [ ] Large lists are virtualized (if needed).
- [ ] Avoid expensive mount-time `useEffect` in shell.

### 6.6 Verification checklist
- [ ] Before/after measurements captured (TTFB/LCP/INP, route transition timings).
- [ ] Supabase logs checked for query count/time changes on hot routes.

---

## 7) LLM Execution Notes (How to Implement Safely)

When implementing these changes:
- Prefer **refactors at the root cause** (layout + caching + memoization), not “more skeletons.”
- Maintain security invariants:
  - RLS remains the ultimate guardrail.
  - Authorization checks stay in services/actions.
- Keep public token routes isolated from the internal shell and internal auth assumptions.

---

## 8) Open Questions (Answer before Phase B if possible)
- Which routes should share the internal shell?
  - Should global pages like `/projects`, `/directory`, `/settings`, `/tasks` all be under `(app)`? (Likely yes.)
- Should token routes (`/p/[token]`, `/s/[token]`, `/i/[token]`, `/proposal/[token]`) ever show the internal shell? (Likely no.)
- Which pages truly require always-dynamic behavior (real-time)? List them explicitly.




