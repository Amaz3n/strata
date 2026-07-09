# Client Provisioning & Billing Activation — Implementation Gameplan

> **Audience:** an LLM agent implementing this end-to-end. Read this whole doc before writing code.
> **Status:** approved by owner (Agustin), July 2026. Implement in phase order; each phase is independently shippable.

## Product context

Arc is sales-led B2B SaaS for construction GCs. There are **no pricing tiers** — every client
pays a negotiated custom price. Clients arrive one of two ways:

1. **Trial** — demoed the product (online/in person), wants hands-on access. Price NOT yet negotiated.
2. **Closed deal** — demoed and committed. Price known on day one.

The core design decision: **provisioning (access) and billing activation (money) are two separate
stages.** Sometimes they happen together, sometimes weeks apart. One flow, price optional:
presence of a price is what activates billing.

Target operator experience (Agustin, platform owner):
- Day of demo: open `/platform` → "New client" sheet → company + owner email + trial length → done.
  Client gets ONE welcome email (workspace invite). Optionally seeded with a sample project.
- Deal closes: `/admin/customers` → "Activate billing" on the org row → enter negotiated price +
  payment method (card checkout OR ACH invoice) → Stripe wiring happens automatically.
- Trial expiring with no price set: Agustin gets notified 5 days out (his cue to call). On expiry
  the org locks with a "we'll be in touch" screen, never a dead-end paywall.
- Stripe dashboard becomes read-only for the operator. Arc is the source of truth.

## Non-negotiable house rules (from CLAUDE.md — violating these fails review)

- **Local dev points at PRODUCTION Supabase.** Never run destructive SQL or test mutations.
  Schema changes ONLY via files in `supabase/migrations/` (apply with `npx supabase db push`
  or the Supabase MCP `apply_migration` — ask the owner before applying to prod).
- Server actions return `{ success, error }` result objects (or the established
  `{ error?, message? }` state shape for `useActionState` forms — match the file you're editing).
  Never throw from an action: thrown errors get redacted to a digest in prod.
- Services own business logic (`lib/services/`); actions/pages stay thin.
- Every query scoped by `org_id`. Zod-validate every action input.
- Mutations call `recordEvent()` + `recordAudit()`.
- New cron/API routes: Vercel Cron sends **GET** (handler must export GET), and any public route
  must be added to `PUBLIC_API_ROUTES` in `proxy.ts` or it 307s to signin.
- Design: tokens only (globals.css oklch vars), radius 0, no heroes/marquees/gradients, dense
  tables, tabular-nums for money. Empty/loading/error states + dark mode on every view.
- **Leave no trash:** anything this plan obsoletes is DELETED in the same change. No `-v2` names,
  no commented-out code, no console.log.
- `pnpm lint` must pass. Do NOT run `pnpm dev` or `pnpm build`.

## Current-state map (verified July 2026)

| Concern | Where | Notes |
|---|---|---|
| Org provisioning service | `lib/services/provisioning.ts` → `provisionOrganization()` | Creates org, owner invite, trialing subscription (trial default 7d, clamp 1–30), entitlements sync. `planCode` already nullable. |
| Provisioning UI (keep) | `components/platform/provision-org-sheet.tsx` (~390 lines) + `provisionPlatformOrgAction` in `app/(app)/platform/actions.ts:188` | Most complete entry point: team invites, optional checkout link. |
| Provisioning UI (DELETE) | `app/(app)/admin/provision/` (page + actions) and `provisionCustomerAction` in `app/(app)/admin/customers/actions.ts:67` | Duplicate doors. Kill both; `/platform` sheet becomes the only entry. |
| Checkout creation | `lib/services/billing.ts` → `createOrgSubscriptionCheckout()` | Creates Stripe customer with `org_id` metadata + checkout session; passes `trialEnd`. Currently requires a pre-existing `plans` row with `stripe_price_id`. |
| Plans/entitlements | `plans`, `plan_features`, `plan_feature_limits`, `entitlements` tables; `app/(app)/admin/plans/` admin; `syncOrgEntitlementsFromPlan()`, `ensureBillingFeatureCatalog()`, `allBillingFeatureKeys()` in `lib/billing-feature-catalog.ts` / `lib/services/billing.ts` | Keep the tables & admin (rare custom packages), but normal deals must never require visiting `/admin/plans`. |
| Stripe SDK helpers | `lib/integrations/payments/stripe.ts` | Has `createStripeCustomer`, `createStripeCheckoutSession`, `createStripeBillingPortalSession`, `constructWebhookEvent`, `getAppBaseUrl`. No price-creation helper yet. |
| Webhook | `app/api/webhooks/stripe/route.ts` | Handles `customer.subscription.created/updated/deleted` → `upsertSubscriptionFromStripe()` (matches org via `metadata.org_id`, adopts pending local sub row). Idempotent via `webhook_events`. Does NOT yet handle `invoice.paid` / `invoice.payment_failed` for platform subscriptions. |
| Subscription upsert | `lib/services/subscriptions.ts` → `upsertSubscriptionFromStripe()` | Maps Stripe statuses to local enum (`trialing/active/past_due/canceled`). |
| Access enforcement | `lib/services/access.ts` → `getOrgAccessState()`; consumed in `app/(app)/layout.tsx` (~line 53 renders locked state) | Trial expiry locks; past_due grace to period end; license model bypasses. Works — extend, don't rewrite. |
| Customers desk | `app/(app)/admin/customers/` | Already has `extendCustomerTrialAction` (keep), `updateCustomerDetailsAction`, `updateCustomerSubscriptionAction`, `deleteOrganizationAction`. |
| `subscriptions` table columns | see `supabase/migrations/20260517092101_remote_schema.sql:5396` | `id, org_id, plan_code, status, current_period_start, current_period_end, trial_ends_at, cancel_at, external_customer_id, external_subscription_id, created_at, updated_at`. **No `checkout_url` or collection-method column — migration needed.** |
| Invites/email | `lib/services/team.ts` → `createOrgMemberInvite()` (sends via `lib/services/mailer.ts`), `resendInvite()` | Welcome email = invite email. Reuse. |
| Crons | `vercel.json` `crons[]`, handlers in `app/api/jobs/*` | Remember GET + proxy allowlist. `follow-up-reminders` exists. |
| Signup | invite-only (`SIGNUP_INVITE_CODE` gate in `app/(auth)/auth/actions.ts`) | Leave as is. |

## Human prerequisites (owner does these; code may assume them)

1. Stripe: one Product named "Arc"; its ID set as env `STRIPE_ARC_PRODUCT_ID` (all Vercel envs + `.env.local`). Code must fail with a clear error if unset when activating billing.
2. Stripe: ACH Direct Debit enabled; automatic collection emails (invoices + reminders) enabled — Stripe does dunning for invoice-collected subs, we build none of it.
3. Stripe webhook endpoint subscribed to `invoice.paid`, `invoice.payment_failed`, `checkout.session.completed` in addition to existing `customer.subscription.*`.
4. Sample-project seed content (project name, ~10 budget lines w/ typical cost codes, 2 commitments, 3–4 expenses, 1 draw, 1 invoice, daily logs, schedule items). Until provided, use realistic placeholder content for a Naples FL residential GC remodel (~$450k contract) — keep it in one seed-spec constant so swapping content is a one-file edit.

---

# Phase 1 — Two-stage provisioning (core)

## 1.1 Migration: subscriptions billing-activation columns

New file `supabase/migrations/<timestamp>_subscription_billing_activation.sql`:

```sql
alter table public.subscriptions
  add column if not exists checkout_url text,
  add column if not exists collection_method text
    check (collection_method in ('checkout', 'invoice')),
  add column if not exists net_days integer;
```

Do not apply to prod without owner approval; write the file regardless so the repo is source of truth.

## 1.2 `activateOrgBilling` service (`lib/services/billing.ts`)

New exported function — the single path for attaching money to an org, used both by the
provisioning sheet ("set price now") and the customers desk ("Activate billing" later).

```ts
export interface ActivateOrgBillingParams {
  orgId: string
  amountCents: number            // negotiated price, > 0
  interval: "month" | "year"
  collectionMethod: "checkout" | "invoice"   // card checkout vs ACH/emailed invoice
  netDays?: number               // invoice only; default 30
  actorUserId: string
}
export async function activateOrgBilling(params: ActivateOrgBillingParams): Promise<{
  checkoutUrl: string | null     // null for invoice collection
  planCode: string
}>
```

Behavior:
1. Load org (service client). Load latest subscription row for org. If subscription `status === "active"`, throw (caller action converts to `{ error }`).
2. **Create Stripe Price** under `process.env.STRIPE_ARC_PRODUCT_ID` (throw clear error if env
   missing): `unit_amount: amountCents, currency: "usd", recurring: { interval }`, plus
   `metadata: { org_id }` and `nickname: `<org-slug> — $X/<interval>``. Add a helper
   `createStripePrice(...)` in `lib/integrations/payments/stripe.ts` next to the existing helpers.
3. **Auto-create the plan row**: code `client-<org-slug>` (if taken, suffix `-2`, `-3`…),
   `pricing_model: "subscription"`, name `"<Org Name> — Custom"`, `amount_cents`, `interval`,
   `stripe_price_id`, `is_active: true`, metadata `{ package_type: "full_access", created_by }`.
   Then `ensureBillingFeatureCatalog()` and insert `plan_feature_limits` rows for
   `allBillingFeatureKeys()` (mirror what `createPlanAction` in `app/(app)/admin/plans/actions.ts`
   does for `full_access`). Finally `syncOrgEntitlementsFromPlan(orgId, planCode)`.
4. Ensure Stripe customer exists (reuse the logic in `createOrgSubscriptionCheckout`:
   existing `external_customer_id` or `createStripeCustomer` with `metadata: { org_id }`).
5. Branch on collection method:
   - **`checkout`**: create checkout session (existing `createStripeCheckoutSession`) with the new
     price, `metadata: { org_id, plan_code, actor_user_id }`, and `trialEnd` = the subscription's
     remaining `trial_ends_at` if in the future (card collected now, charged at trial end).
     Success/cancel URLs → `${getAppBaseUrl()}/settings?tab=billing`.
   - **`invoice`**: create the Stripe subscription directly via the SDK:
     `stripe.subscriptions.create({ customer, items: [{ price }], collection_method: "send_invoice", days_until_due: netDays ?? 30, trial_end: <remaining trial or omit>, metadata: { org_id, plan_code } })`.
     Stripe emails the invoice; no link to send. Add a `createStripeInvoiceSubscription` helper in
     the stripe integration file. The webhook's existing `customer.subscription.created` handling
     will sync it locally.
6. Update the local subscription row: `plan_code`, `external_customer_id`, `checkout_url`
   (or null), `collection_method`, `net_days`. If no subscription row exists (edge: license-model
   org being converted), insert one mirroring `provisionOrganization`'s shape.
7. `recordEvent` (`billing_activated`, payload: plan_code, amount_cents, interval,
   collection_method) + `recordAudit`.

**Refactor:** `createOrgSubscriptionCheckout` keeps working for pre-existing plans, but extract its
customer-ensure + session-create internals so `activateOrgBilling` reuses them rather than
duplicating. If after refactor `createOrgSubscriptionCheckout` has no remaining callers besides
`activateOrgBilling`, inline it and delete the export (check callers: currently
`app/(app)/platform/actions.ts:247`).

## 1.3 Provisioning sheet & action rework

`components/platform/provision-org-sheet.tsx` + `provisionPlatformOrgAction` in
`app/(app)/platform/actions.ts`:

- **Access section (always visible):** company name, slug (auto-derived from name, editable),
  owner full name, owner email, trial days (default **30** — also change the default in
  `resolveTrialDays` in `lib/services/provisioning.ts` from 7 to 30; keep clamp 1–60),
  team members (existing repeater), "Send invite emails" toggle (existing),
  **"Seed sample project" toggle — default ON** (Phase 3 wires it; in Phase 1 render it and pass it
  through, calling the seed service if Phase 3 is done, else omit the toggle until Phase 3. Prefer
  shipping Phase 1 without the toggle and adding it in Phase 3 — no dead UI).
- **"Set price now (deal closed)" section — collapsed by default** (Collapsible primitive): dollar
  amount input (whole dollars, convert to cents in the action), interval select (Monthly default /
  Annual), payment method radio (Card — send checkout link / ACH invoice — Stripe emails it),
  net-days input shown only for invoice (default 30).
- **Remove the plan picker entirely** from this sheet (`planCode` select and
  `listActiveSubscriptionPlans` wiring for it). Remove the `createCheckout` checkbox — checkout is
  implied by choosing Card in the price section.
- Action flow: `provisionOrganization(...)` → team invites (existing loop) → if price section
  filled, `activateOrgBilling(...)` → return state `{ message, checkoutUrl?, orgId, orgName, invitedCount }`.
  Sheet success view: shows the checkout URL with a copy button when present (this already exists —
  keep), and for invoice collection shows "Stripe will email the invoice to <billing email>."
- Zod schema: price fields optional but validated together (amount requires interval + method;
  refuse amount ≤ 0).

## 1.4 Consolidate entry points (delete the duplicates)

- Delete `app/(app)/admin/provision/` entirely (page.tsx + actions.ts).
- Delete `provisionCustomerAction` + `provisionCustomerSchema` from
  `app/(app)/admin/customers/actions.ts` and whatever UI in `components/admin/customers-table.tsx`
  / `app/(app)/admin/customers/page.tsx` invokes it.
- Any "New customer / Provision" buttons on `/admin` or `/admin/customers` become links to
  `/platform` (or open the platform sheet if it's importable there cleanly — links are fine).
- Grep for imports of the deleted actions and `admin/provision` route references; clean all.

## 1.5 Customers desk: Activate billing + payment link

`app/(app)/admin/customers/` (+ `components/admin/customers-table.tsx`):

- Each org row already shows subscription state; add row actions:
  - **Activate billing** (visible when latest subscription has no `plan_code` or status is
    `trialing`/locked-without-price): opens a small sheet/dialog with the same price fields as
    1.3's price section → calls a new `activateCustomerBillingAction` (zod-validated, permission
    `platform.billing.manage` or `billing.manage` via `requireAnyPermission` — match neighbors)
    → `activateOrgBilling`. On success with a checkout URL, surface it with copy button.
  - **Copy payment link** (visible when `checkout_url` set and status not active): copies stored
    `checkout_url`.
  - Keep existing **Extend trial** action untouched.
- Ensure the table's subscription query selects the new columns.

## Phase 1 acceptance criteria

- One provisioning door: `/platform` sheet. `/admin/provision` gone; grep proves no dangling refs.
- Trial-only provisioning creates zero Stripe objects and sends exactly one email (invite).
- Filling the price section (or later Activate billing) creates: Stripe price under the Arc
  product, `client-<slug>` plan row with full-access limits, Stripe customer w/ `org_id` metadata,
  and either a stored checkout URL or an invoice-collected Stripe subscription.
- Webhook flips the org to `active` after payment with no manual matching (verify metadata path in
  `upsertSubscriptionFromStripe` still hit).
- All new actions zod-validated, permission-checked, `recordEvent`/`recordAudit`, result objects.
- `pnpm lint` clean.

---

# Phase 2 — Trial lifecycle

## 2.1 Lock screen copy split

In `app/(app)/layout.tsx`'s locked branch (and the component it renders — follow
`getOrgAccessState()` consumption at ~line 53):

- Extend `getOrgAccessState()`'s return in `lib/services/access.ts` with `hasPrice: boolean`
  (latest subscription `plan_code != null`) and `checkoutUrl: string | null` when locked.
- Locked + no price → "Your trial has ended. We'll be in touch to get you set up." + contact
  mailto (put the support address in one constant; check for an existing support-email constant
  before adding). **No pay button.**
- Locked + price + `checkout_url` → "Your trial has ended — complete your subscription." with a
  button to the checkout URL.
- Locked for suspension/cancellation keeps current copy.
- Match existing locked-screen styling; verify dark mode.

## 2.2 Owner heads-up: trials ending, no price set

Extend the existing `app/api/jobs/follow-up-reminders/route.ts` cron (it already runs daily — do
NOT create a new route unless its shape truly doesn't fit; if a new route is unavoidable: GET
handler + `vercel.json` cron + `proxy.ts` PUBLIC_API_ROUTES, all three):

- Query: subscriptions `status = 'trialing'`, `plan_code is null`,
  `trial_ends_at between now() and now() + 5 days`.
- For each, email the platform owner (find the recipient the way other platform notifications do —
  check `lib/services/mailer.ts` and platform-notification precedent; fallback: env
  `PLATFORM_ALERTS_EMAIL`): "«Org» trial ends <date> — no price set. Activate billing: <link to /admin/customers>".
- Send once per org: `recordEvent` type `trial_ending_alert_sent` on first send; skip if an event
  of that type exists for the org's current `trial_ends_at` (store it in the payload).

## 2.3 In-app trial banner (client-facing)

Slim, calm bar under the app header for orgs where access state is `trialing` (render decision in
the server layout, data from the already-fetched `getOrgAccessState()` — no new client fetch):

- No price set: "Trial — X days left." Nothing else. No upgrade CTA (sales-led; the ask is human).
- Price set + pending `checkout_url`: "Trial — X days left · **Complete billing setup**" linking
  the checkout URL.
- Token colors only, muted (border + muted background), dismissible per session at most, dense
  height consistent with existing app chrome. Dark mode verified.

## Phase 2 acceptance criteria

- Expired no-price trial shows "we'll be in touch" (no dead-end pay button); expired priced trial
  shows working checkout button.
- Cron alert fires once per org per trial-end date; verified via `events`.
- Banner renders in both variants, both themes; absent for active/license orgs.

---

# Phase 3 — Sample project seeding

## 3.1 `lib/services/demo-seed.ts`

`export async function seedSampleProject(orgId: string, actorUserId: string): Promise<{ projectId: string }>`

- Content driven by a single exported `SAMPLE_PROJECT_SPEC` constant in the same file (so swapping
  the owner's real content later is a one-file edit). Placeholder content: Naples FL residential
  remodel, ~$450k fixed-price contract, ~10 budget lines with typical cost codes, 2 commitments
  (framing sub, plumbing sub), 3–4 expenses, 1 draw, 1 invoice, 3 daily-log entries, 6–8 schedule
  items spanning past + future weeks.
- **Create everything through existing service functions** (`lib/services/projects*`, budgets,
  commitments, expenses, draws, invoices, daily logs, schedule — grep for the create functions the
  respective workbench actions call), NOT raw table inserts, so ledgers/events/audit stay
  consistent. The one deviation allowed: suppress client-facing side effects (emails, portal
  notifications) — pass existing flags where available; where a service unavoidably emails, skip
  that entity rather than adding new flags.
- Mark the project `metadata.is_sample = true` (projects has metadata jsonb — verify via
  `docs/database-overview.md` / `list_tables`; if not, use the closest existing mechanism, e.g. a
  tag or name prefix + metadata on creation — do NOT add a schema column for this).
- Idempotency: if the org already has a project with `is_sample`, return it instead of reseeding.

## 3.2 Wire the toggle

- Provisioning sheet (1.3): "Seed sample project" switch, default ON. Action calls
  `seedSampleProject` after provisioning succeeds; seed failure must NOT fail provisioning —
  catch, log, include a warning in the returned message.

## 3.3 Delete sample project

- On the project (settings/danger-zone area — find where project deletion already lives) add
  "Remove sample project" visible only when `is_sample`: calls the existing project-delete service
  path (cascade through the same services). If full project deletion doesn't exist as a service,
  add `deleteSampleProject(orgId, projectId)` to `demo-seed.ts` that hard-guards on `is_sample`
  and deletes children via existing delete services in dependency order.

## Phase 3 acceptance criteria

- Provisioning with the toggle ON yields an org whose financials pages (budget, commitments,
  expenses, draws, invoices), daily logs, and schedule all show coherent sample data with no
  console errors and consistent ledger math.
- Reseeding is idempotent. Removal leaves zero orphan rows (spot-check children by project_id).
- No emails/portal notifications sent during seeding.

---

# Phase 4 — Polish

## 4.1 Stripe Billing Portal in Settings → Billing

- `createStripeBillingPortalSession(customerId, returnUrl)` already exists in
  `lib/integrations/payments/stripe.ts`. Add a "Manage billing" button in the settings billing tab
  (`app/(app)/settings/` — find the billing tab component) for orgs with `external_customer_id`:
  server action → portal session → redirect. Permission: org owner / `billing.manage`.
- Note: requires the Billing Portal to be configured once in the Stripe dashboard (human step —
  surface a clear error message if Stripe rejects for missing configuration).

## 4.2 (Deferred — separate gameplan) First-run onboarding checklist

Company logo, first project, invite team, connect QBO. Out of scope here; do not build.

---

# Cross-cutting verification (run after each phase)

1. `pnpm lint` clean.
2. Financial surfaces touched (Phase 3)? Run `pnpm test:financials`.
3. Manual flow test against prod-pointing dev is NOT allowed to create junk orgs freely — when a
   test org is needed, ask the owner first, use an obviously-named org (`ZZ-Test-...`), and delete
   it via `deleteOrganizationAction` when done.
4. Empty/loading/error states + dark mode on every new/edited view.
5. Grep for anything obsoleted (old actions, plan-picker imports, `/admin/provision` links) — must
   be zero hits.

# Explicit non-goals / do-nots

- No self-serve signup changes; signup stays invite-only.
- No pricing tiers, no public pricing page, no plan picker in any client-facing UI.
- No card collection during unpriced trials.
- No new dunning system — Stripe's invoice emails + existing `past_due` grace in
  `lib/services/access.ts` cover it.
- Don't rewrite `upsertSubscriptionFromStripe`, `getOrgAccessState`, or the webhook's idempotency
  scaffolding; extend minimally.
- Don't touch the `licenses` / license billing model beyond keeping it working.
