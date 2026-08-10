# Community Websites Gameplan — Marketing Sites as a Byproduct

> **Status: ACTIVE PLAN — intent, not a description of the system.**
> Nothing in this document is guaranteed to exist. Never infer current app
> behavior from it. Source of truth is the code, `CLAUDE.md`, and the
> reference docs at the `docs/` top level.

**Status:** EXPLORATORY — this idea is flagged "maybe" by the owner. Phase 0 is a
go/no-go gate; do NOT proceed past it without an explicit human GO. Written 2026-07-31.
**Audience:** an LLM executor.

---

## 0. The idea, and the go/no-go gate

Every production community's marketing content — plans, elevations, specs/inventory,
lot availability, live pricing, incentives — already lives in Arc and is maintained
daily because operations depend on it. Builders separately pay agencies for marketing
sites that go stale the day pricing changes. The product: a hosted, SEO-real,
never-stale public site per community, rendered from the offering engine, with an
inquiry form that feeds the CRM directly.

**Why "maybe" is rational:** this is Arc's first consumer-marketing surface — public
SEO, brand expression, uptime expectations, and content that sales/marketing (not
ops) own. It drags in brand theming, image galleries, and content editing that Arc
deliberately doesn't have. The counter: the data freshness advantage is real and the
funnel lands in `sales-inquiries` → prospects → traffic counts, closing the loop no
agency site can.

### Phase 0 — validation (do this, then STOP for GO/NO-GO)
1. Read `public/website-structure.docx` (exists in-repo, content unknown — the owner
   has prior thinking here; it may redefine scope).
2. Build ONE static mock (no routes, no schema): render a real community's price
   sheet data (`getCommunityPriceSheet`) into a polished single-page site design,
   as a design-review artifact. Expressive zone rules apply (this is marketing, not
   the ascetic app — see `docs/design.md` §zones).
3. Present with the honest gap list from §0.1 (images, branding, content fields).
   Human decides: GO / NO-GO / reduced scope (e.g., "embed widget only" — see
   WS-W4 alternative).

## 0.1 Ground truth (verified 2026-07-31)

**Data that's ready:**
- Price sheet: `getCommunityPriceSheet(communityId, { onDate })` in
  `lib/services/community-sales.ts:419` — plans (name/code/beds/baths/heated_sqft/
  stories/garage_bays) × elevations, `base_price_cents` from
  `community_plan_availability` (effective-dated), sold/building counts.
- Incentive math is pure and reusable: `offeringPrice(basePriceCents,
  liveIncentives)` → `{ netCents, giveCents }` in `lib/sales/offering.ts`;
  `incentives` table (fixed/percent, effective windows, community or org-wide).
- Inventory: `listSpecInventory`, `listSellableLots` (community-sales.ts),
  `community-inventory.ts` (statuses, premiums, `INVENTORY_MAP_PAGE_SIZE = 600`).
- Lot map seed: `lots.plat_x / plat_y` integer grid (20260726212804 migration) — a
  coarse plat rendering exists for internal use and is reusable publicly.
- Communities have typed `address/city/state/postal_code`, `status`, `description`.
- Inquiry intake: `registerProductionInquiry(input, orgId)` in
  `lib/services/sales-inquiries.ts` validated by `productionInquiryInputSchema`
  (`lib/validation/prospects.ts:117`) — creates prospect + contacts + optional
  co-op agent + traffic bump. CAVEAT: it calls `requireOrgContext(orgId)` AND the
  traffic bump requires `sales.manage` — a public form needs a service-context
  wrapper (`runWithServiceOrgContext` in `lib/services/context.ts` is the existing
  escape hatch, used by starts-pipeline).

**Gaps that are real:**
- **Images are thin:** exactly `house_plans.cover_file_id` +
  `house_plan_elevations.cover_file_id`. No galleries, no floorplan image sets, no
  community hero imagery. Option catalog has `image_url` on options/categories.
- **Image serving is session-gated:** `/api/files/[fileId]/raw` is not public; a
  public site needs a public image route (WS-W1.4).
- **Branding is thin:** orgs have `name`, `logo_url`, `slug`, `address` — NO brand
  colors/fonts/social links.
- **Zero public-web plumbing:** no `app/robots.ts`, no `app/sitemap.ts`; every token
  route sets `robots: { index: false }`. `PUBLIC_ROUTES` in `proxy.ts` is
  token-portals only. A marketing site is the first surface that MUST index.
- New-route-family checklist (from portal infrastructure): top-level route dir
  outside `(app)`; prefix in `PUBLIC_ROUTES`; API companions in
  `PUBLIC_API_ROUTES`; service-role client for data (RLS is membership-based);
  explicit robots decision.

---

## WS-W1 — Foundation: public rendering of one community (GO required)

1. **Routing:** `app/w/[orgSlug]/[communitySlug]/` (top-level, outside `(app)`).
   Add `"/w/"` to `PUBLIC_ROUTES`. Community slug: new column `communities.slug`
   (unique per org, generated from name, editable in community settings) — one small
   migration, STOP after writing. Custom domains are WS-W3; the path-based URL is
   the permanent canonical fallback.
2. **Data:** `lib/services/community-site.ts` — `getPublicCommunitySite(orgSlug,
   communitySlug)` using `createServiceSupabaseClient()`; composes: community record
   (only `status = 'active'`; anything else 404s), price sheet via
   `getCommunityPriceSheet`, live incentives, spec inventory (cap 24), sellable-lot
   counts by plan, org name/logo. Returns a mapped DTO — NEVER raw rows; explicitly
   exclude cost fields (`cost_basis_cents`, margins, `previousBasePriceCents`) at
   the DTO layer, with a unit test asserting the DTO type contains no `cost`/
   `margin` keyed fields (this is customer-financial data on a PUBLIC page; the
   test is the guardrail).
3. **Publish gate:** `communities.settings.public_site = { enabled: false, ... }` —
   default OFF; enabling is an explicit action in community settings (org admins,
   audited). Disabled/unknown slug → 404. Pricing display is a per-community choice:
   `show_pricing: 'exact' | 'from' | 'hidden'` (builders are opinionated here).
4. **Public images:** new route `app/api/public/site-images/[fileId]/route.ts` that
   serves ONLY file ids referenced by an enabled public site (resolve through a
   `community_site_assets` allowlist table populated when the site config saves —
   never a blanket public file proxy). Long cache headers. Add to
   `PUBLIC_API_ROUTES`.
5. **Rendering:** static-friendly server component page; `export const revalidate =
   300` (pricing staleness tolerance 5 min — the "never stale" pitch with CDN
   caching). Expressive-zone design; mobile-first (homebuyers browse on phones);
   `metadata` fully populated (OG image = community hero or org logo fallback).
   Sections v1: hero (name, city/state, description), available plans grid (cover,
   beds/baths/sqft, price per `show_pricing`), current incentives, move-in-ready
   (spec) homes, inquiry form, builder footer (org name/logo/contact).
6. **Inquiry form:** POST to a server action in the `app/w` tree wrapping
   `registerProductionInquiry` via `runWithServiceOrgContext`, `channel: 'web'`,
   community pre-bound. Anti-abuse: honeypot field + per-IP rate limit + optional
   platform captcha config later; validate with the existing schema. On success:
   plain confirmation. Traffic increments `web_inquiries` (the wrapper runs with
   service context, bypassing the `sales.manage` gate legitimately).
7. **SEO plumbing (first in repo):** `app/robots.ts` (allow `/w/`, disallow
   everything else), `app/sitemap.ts` (enumerate enabled community sites),
   JSON-LD (`Residence`/`Offer`-flavored schema.org on plan cards).

## WS-W2 — Content depth (make it not embarrassing)

1. **Galleries:** `community_site_assets` grows roles (`hero | gallery |
   plan_gallery:<planId>`), managed from a "Website" tab on
   `/communities/[id]/settings` — upload via existing files machinery, ordered,
   alt text required. This intentionally does NOT touch `house_plans` schema —
   marketing imagery is site content, not plan-library data.
2. **Brand block:** `orgs.settings`-adjacent branding is org-level platform data;
   add `org_branding` (org_id pk, primary_color, accent_color, font_choice from a
   curated set, social links jsonb, marketing_email/phone). Used ONLY by expressive
   surfaces (this site + portals later if desired). Small migration; STOP.
3. **Copy fields:** per-site editable copy blocks (headline, community story,
   amenities list, disclaimers) in `communities.settings.public_site.copy` —
   plain-text-with-line-breaks only in v1 (no rich text; deliberate, see estimate
   customization precedent).
4. **Lot availability map:** render `plat_x/plat_y` grid colored by
   available/reserved/sold (map statuses to buyer-safe labels: `controlled/owned/
   developed` → "available", `assigned/started` → "reserved", `closed` → "sold";
   never leak internal status names).

## WS-W3 — Custom domains + analytics (productization)

1. Custom domains (`www.willowcreekbytaylor.com`): Vercel Domains API per-site
   attach, TXT verification UX in the Website tab, path URL 308s to the custom
   domain when live. STOP: pricing/packaging of custom domains is a human decision
   (natural add-on SKU).
2. Analytics: page views + inquiry conversion per site, privacy-light (no cookies;
   server-side counting into `community_traffic`-adjacent daily rows). Surface in
   the community's traffic panel next to walk-ins — the closed loop an agency site
   can't do ("14 web inquiries → 3 appointments → 1 contract, this week").
3. OG/social cards generated per plan (`@vercel/og`-style edge image or prerendered).

## WS-W4 — Reduced-scope alternative (if Phase 0 verdict is "not full sites")

An **embeddable widget** instead: a script/iframe embed of the price sheet +
availability + inquiry form that builders paste into their EXISTING agency site.
Same `community-site.ts` DTO, same publish gate, same inquiry action; rendering is a
self-contained embed route (`app/w/embed/[token]/`) with `X-Frame-Options` relaxed
for that route only and a per-site embed token instead of slugs. ~30% of the work,
80% of the freshness value, zero brand/SEO burden. Keep this option in front of the
human at the Phase 0 gate.

## Acceptance (WS-W1)
- Lighthouse ≥ 90 performance/SEO/accessibility on mobile for a real community.
- Cost/margin leak test passes (DTO-level).
- Disabled site 404s; enabling is audited; pricing honors `show_pricing`.
- Inquiry lands as prospect + contact + traffic bump in under 5s; honeypot drops
  bots silently.
- `pnpm lint && npx tsc --noEmit` clean; `pnpm test:land` (posture/terminology)
  untouched-green.

## Non-goals
- No CMS/page-builder. Sections are code; copy fields are the only free text.
- No lead routing/drip campaigns (CRM follow-ups exist in-app).
- No listing-syndication (Zillow/BDX feeds) in v1 — note as future one-up; feeds are
  a data-mapping chore on top of the same DTO.
- Residential/commercial postures: out of scope entirely (this is a production
  community product; a custom builder's "portfolio site" is a different, un-scoped
  idea).
