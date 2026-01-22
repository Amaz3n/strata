# Subscriptions + Trials + Access Control (Gameplan)
**Last updated:** 2026-01-17  
**Owner:** Strata platform (you)

## Why this doc exists
We want builders to be able to **subscribe self-serve in-app**, while maintaining an **owner-controlled admin provisioning flow**. This doc is a staged plan to implement:
- In-app subscription checkout (Settings → Billing)
- Trial periods (created at provisioning) that automatically lock access if not subscribed
- Access revocation on cancellation / non-payment
- Operational tooling + safety rails (webhooks, idempotency, observability)

This is written to be **LLM-optimized**: clear stages, explicit acceptance criteria, and edge cases called out.

---

## 0) Current-state review (repo + DB)

### What exists in the app today
- **Admin UI**
  - `/admin` and subpages exist (customers, plans, analytics, audit, support).
  - `/admin/customers` includes a “Provision Customer” sheet, but provisioning logic is currently a stub:
    - `components/admin/customers-table.tsx` → `handleProvision()` is `TODO` and just `console.log` + reload.
  - There is a “Create Organization” link in the org switcher to `/admin/provision`, but **that route does not exist** in the current `app/(app)/admin` tree:
    - `components/layout/org-switcher.tsx` links to `/admin/provision`.
  - There is a `ProvisionOrgForm` component referencing `@/app/(app)/admin/provision/actions`, but the file path is missing:
    - `components/admin/provision-form.tsx` imports `provisionOrgAction` from a non-existent file path.
- **Builder-facing Settings → Billing**
  - `components/settings/settings-window.tsx` has a Billing tab that **only displays** plan/subscription details (no CTA to subscribe, no cancel/manage portal, no plan selection).
  - Billing data comes from `lib/services/orgs.ts:getOrgBilling()`, guarded by `billing.manage`.
- **Stripe integration**
  - There is a Stripe webhook endpoint: `app/api/webhooks/stripe/route.ts`.
  - It currently maps Stripe events for **invoice payments** only (`payment_intent.succeeded`, etc.) via `lib/integrations/payments/stripe.ts`.
  - There is **no** Stripe subscription/checkout/billing-portal integration yet.
- **Auth + permissions**
  - Auth middleware only checks “logged in”, not billing/subscription. (`middleware.ts`)
  - RBAC is implemented via `lib/services/permissions.ts` + `lib/auth/guards.ts`.
  - There is **no application-level enforcement** that ties org access to subscription/trial status.

### What exists in the DB today (Supabase)
Key tables already exist (from live introspection):
- `plans`
- `subscriptions` (with `status`, `current_period_end`, `trial_ends_at`, `cancel_at`, `external_customer_id`, `external_subscription_id`)
- `entitlements`, `plan_features`, `plan_feature_limits` (foundation for plan-based gating)
- `orgs` includes `status` and `billing_model`

> Note: `supabase/schema.sql` and live DB introspection differ on some nullability defaults for `subscriptions`. Treat **live schema + migrations** as source of truth; reconcile schema artifacts as part of cleanup.

---

## 1) Design decisions (lock these in early)

### 1.1 Source of truth
- **Stripe is source of truth for payment state** (active, trialing, past_due, canceled).
- DB stores a cached, queryable representation in `subscriptions` per org.

### 1.2 Trial strategy
Use **Stripe subscription trials** (not only app-side timers):
- When a builder starts a trial, we create a Stripe subscription with `trial_end`.
- Stripe transitions `trialing → active` automatically.
- If they cancel before conversion or fail payment, Stripe transitions accordingly and webhooks keep DB in sync.

Why: avoids building your own billing scheduler and reduces edge-case drift.

### 1.3 Access gating strategy
Introduce an **org access state machine** derived from:
- `orgs.status` (manual hard stop: suspended/inactive)
- latest `subscriptions.status` + dates (`trial_ends_at`, `current_period_end`, `cancel_at`)

We want “lockout” that is:
- **Hard** for core app features (projects, uploads, etc.)
- **Soft** for billing remediation routes (Settings → Billing) so users can fix it

### 1.4 Single provisioning path
You currently have multiple partially overlapping entry points (customers sheet, missing `/admin/provision`, missing action import). Pick one:
- **Option A (recommended):** Make `/admin/customers` provisioning real (server action), remove the dead `/admin/provision` link.
- **Option B:** Implement `/admin/provision` as the canonical provisioning screen and have `/admin/customers` open it.

---

## 2) Data model mapping (Stripe ↔ DB)

### 2.1 Plans
We need a durable mapping between your `plans.code` and Stripe pricing:
- Add `stripe_price_id` to `plans.metadata` (or a dedicated column).
  - Recommended: dedicated column if you expect to query/filter by it.
  - Acceptable now: store in `metadata.stripe_price_id`.

### 2.2 Subscriptions (DB)
For each org keep a latest subscription record:
- `subscriptions.external_customer_id` = Stripe customer id
- `subscriptions.external_subscription_id` = Stripe subscription id
- `subscriptions.status` = Stripe subscription status mapped into your enum (`trialing|active|past_due|canceled`)
- `subscriptions.current_period_start/end`, `trial_ends_at`, `cancel_at` = copied from Stripe

### 2.3 Idempotency
Stripe webhooks are at-least-once. Ensure updates are idempotent:
- Upsert/Update by `external_subscription_id`
- Handle out-of-order events by checking `event.created` timestamps and/or Stripe object `current_period_end` monotonicity.

---

## 3) Stage-by-stage implementation plan

### Stage 1 — Make provisioning coherent (admin)
**Goal:** one working way to create an org and start a trial subscription record.

**Work:**
- Decide canonical provisioning route (Option A vs B above).
- Implement provisioning server action that:
  - Creates org row (`orgs`)
  - Creates initial membership(s) for the primary contact (org owner/admin)
  - Creates or initializes a `subscriptions` row as **trialing**:
    - `trial_ends_at = now() + trial_days`
    - `status = 'trialing'`
    - `plan_code = <default plan>`
  - Writes an audit log entry (`audit_log`) for “provisioned org”
- Fix/remove broken references:
  - `components/layout/org-switcher.tsx` link to missing `/admin/provision`
  - `components/admin/provision-form.tsx` broken import path

**Acceptance criteria:**
- From admin UI, you can provision an org + owner user + trial subscription row exists.
- No dead links to missing admin pages.

---

### Stage 2 — Add subscription checkout (Settings → Billing)
**Goal:** builders can subscribe self-serve.

**UX requirements:**
- Billing tab shows:
  - current status (trialing/active/past_due/canceled)
  - trial end date if relevant
  - plan details
- If not subscribed (trialing or canceled):
  - show **“Subscribe”** CTA
  - show plan selection (at least 1 default plan, ideally 2–3)
- If active:
  - show **“Manage billing”** CTA (Stripe customer portal)
  - show next renewal date

**Backend requirements:**
- Create server-side actions/endpoints to:
  - create Stripe customer if missing
  - create Stripe Checkout Session (mode: subscription)
  - create Stripe Billing Portal session
- Ensure session URLs return the user to Settings → Billing on success/cancel.

**Implementation notes:**
- Store Stripe IDs in DB (`subscriptions.external_customer_id`, etc.)
- Do **not** trust client input for `org_id`, `plan_code`—derive from auth org context and server-validated plan list.

**Acceptance criteria:**
- A builder can click Subscribe → complete checkout → returns to app → Billing status becomes active (after webhook).

---

### Stage 3 — Expand Stripe webhook support (subscriptions)
**Goal:** keep DB subscription state consistent with Stripe.

**Add webhook handling for (minimum):**
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed` (optional for UX)
- `checkout.session.completed` (optional; helpful to link session to org/user)

**Processing requirements:**
- Verify signatures (already done)
- Idempotent DB updates (upsert by `external_subscription_id`)
- Log errors with enough context (org, subscription id, event id)

**Acceptance criteria:**
- Subscriptions table reflects Stripe lifecycle changes within minutes of events.

---

### Stage 4 — Enforce access gating (trial expiry, cancellation, past due)
**Goal:** org access matches billing state.

**Create a single policy function in code:**
- `getOrgAccessState(orgId)` returning:
  - `active` | `trialing` | `past_due` | `canceled` | `locked` (derived)
  - include reason + relevant dates

**Enforcement points (recommended):**
- Centralized guard used by page layouts / server actions, not middleware:
  - Keep middleware lightweight (`middleware.ts` already indicates this).
- Apply guard to:
  - `app/(app)/layout.tsx` (or a shared layout wrapper) to redirect locked orgs
  - critical write actions (create project/upload/etc.) to prevent bypass

**Lockout rules (proposal):**
- If `orgs.status in ('suspended','inactive')` → **locked**
- Else if latest subscription:
  - `active` → allow
  - `trialing` AND `trial_ends_at > now()` → allow (show banner)
  - `trialing` AND `trial_ends_at <= now()` → locked (allow Billing + Support only)
  - `past_due` → allow for X-day grace, then locked (choose X = 3–7)
  - `canceled` → locked after `current_period_end` (or immediately if no period)

**UX:**
- Add a dedicated route like `/billing/locked` explaining state + CTA to Billing.

**Acceptance criteria:**
- Expired trial org cannot use the app except to subscribe.
- Canceling subscription eventually revokes access per policy.

---

### Stage 5 — Admin tools for overrides + support
**Goal:** you (owner) can handle edge cases without DB surgery.

**Admin capabilities:**
- Extend trial end date
- Grant complimentary access (set status active without Stripe) for a period
- Force lock/unlock org
- See billing timeline / recent webhook events (optional but huge for debugging)

**DB support:**
- Either:
  - use `orgs.status` for manual lock
  - or add `orgs.access_override` JSON (e.g., `{ mode: 'comp', until: ... }`)

**Acceptance criteria:**
- You can rescue an account that is stuck in `past_due` or needs an extended trial.

---

### Stage 6 — Entitlements + plan-based feature gating (optional but aligned)
**Goal:** plans actually control product access, not just “paid/unpaid.”

**Approach:**
- Fill `plan_features` + `plan_feature_limits`
- Create derived `entitlements` rows on subscription change
- Enforce at feature boundaries (e.g., number of projects, storage, seats)

**Acceptance criteria:**
- Plan changes immediately update what the org can do.

---

## 4) Edge cases & pitfalls checklist (don’t skip)

- **Webhook retries/out-of-order:** must be idempotent and resilient.
- **Multi-org users:** subscription gating must be per active org (cookie org_id).
- **Platform admin bypass:** ensure platform admin can access locked orgs for support.
- **RLS vs service role:** billing webhooks should use service role; user actions should be least-privileged.
- **Trial conversions:** if trial exists in Stripe, don’t double-implement trial timers elsewhere.
- **Cancellation timing:** cancel-at-period-end vs immediate cancellation.
- **Past due:** decide whether to block immediately or provide grace.
- **UI refresh:** Billing page should poll/revalidate after checkout return (or just reload with `force-dynamic` + refetch).
- **Schema drift:** reconcile `supabase/schema.sql` vs live schema so dev/prod match.

---

## 5) Implementation artifacts (what files we expect to touch)

**Admin**
- `components/admin/customers-table.tsx` (replace `handleProvision` stub)
- `components/admin/customer-sheet.tsx` (optional: add admin billing actions)
- `components/layout/org-switcher.tsx` (fix `/admin/provision` link)

**Billing UI**
- `components/settings/settings-window.tsx` (add CTA + plan selection + portal link)
- `app/(app)/settings/actions.ts` (add actions for checkout/portal sessions)

**Stripe**
- `lib/integrations/payments/stripe.ts` (add checkout + portal + subscription mapping)
- `app/api/webhooks/stripe/route.ts` (handle subscription events)

**Access gating**
- `lib/auth/context.ts` and/or new `lib/auth/access.ts` (org access state)
- A new route like `app/(app)/billing/locked/page.tsx` (lockout UX)

**DB**
- Migrations to add:
  - plan ↔ stripe mapping (`stripe_price_id`)
  - optional: access override fields, grace period fields, audit helpers

---

## 6) Definition of Done (end-to-end)
- A builder can start trial (provisioned or self-serve), use the app, and subscribe from Settings.
- Trial expiry locks access (except billing remediation).
- Canceling subscription removes access according to policy.
- Admin can override trial/access safely.
- Webhooks are idempotent and observable (logs + audit trail).

