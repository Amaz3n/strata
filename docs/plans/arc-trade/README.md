# Arc Trade — Readiness Gameplan

> **Status: PLAN (intent, not truth).** Nothing here is guaranteed to exist.
> Companion checklist: `completion-checklist.json` in this folder, checked by
> `node scripts/qa/production-readiness.mjs --checklist docs/plans/arc-trade/completion-checklist.json`.
> When this plan ships, fold what is durable into `docs/reference/arc-trade.md`
> and `CLAUDE.md`, then delete this folder.

> **Audience:** an LLM executing agent. Read `CLAUDE.md`, `docs/reference/arc-trade.md`
> and `docs/reference/pipeline.md` first. The Arc Books and Arc Production readiness
> rules apply here unchanged: one category at a time, one build → one review → one fix
> round, verification by golden scenarios on the isolated acceptance stack, never in a
> customer org.

## 1. Mission

Arc Trade is Arc for specialty contractors: the electrician, plumber, framer or
HVAC company with 3–40 field employees whose customers are builders, GCs and
homeowners. It is a **business profile** (`org_settings.settings.business_profile.kind
= "trade"`), not a posture: a trade's jobs are residential or commercial projects, and
the project is still the unit of posture.

Why it matters beyond the subscription: every builder on Arc already invites its
subs into token portals. A sub that runs its own company on Arc turns those
invitations into a network, and a GC-side pay application that lands on the sub's
books with no re-entry is something no incumbent (Buildertrend, Procore, Jobber,
ServiceTitan, QuickBooks Time) can offer, because none of them hold both sides in one
schema.

**What a trade needs from Arc, in priority order:**

1. Get paid: bill a GC by schedule of values or a homeowner by T&M, track retainage
   the customer holds, send the waiver with the invoice, see what is outstanding.
2. Know what labor cost: field hours per job and cost code, approved by the
   foreman, locked by pay period, exported to payroll, posted to the job and to Books.
3. Win the next job: quote fast, follow up, convert.
4. Keep receipts straight: materials, fuel and tools, with or without a job.
5. See only what matters: a clean workspace at a trade price.

## 2. Where it stands (audit, 2026-10-19)

Arc Trade is a **navigation skin**. ~1,000 lines of trade UI (Today, Schedule &
crew, New job, Builder connections, Company setup) sit on unchanged services.

| Area | Finding |
|---|---|
| Gating | Only the sidebar changes. Every builder route loads if typed. Settings, the mobile catalog and the iOS API do not know the org is a trade. Project tabs hide bids/selections/decisions/closing in nav only. |
| Packaging | `plans` → `entitlements` are written on subscription sync and **never read** anywhere. `business_profile` is linked to neither plan nor tier. |
| Time | Entries have cost code, per-worker cost rate + burden, OT/DT, generated cost, flow to job cost and T&M billing. Missing: clock in/out, breaks, pay periods and lock, weekly grid, foreman approval (approval needs `bill.approve`), OT rules, payroll export. Books payroll is import-only. |
| Receivables | Customer = `projects.client_id`; composer, pay link, card/ACH, partial payments, AR aging, retainage ledger, T&M from costs, signed T&M tickets, outgoing waivers all work for a sub. **Billing shape is resolved from posture, not profile**: a residential trade job gets homeowner draws and no SOV; a commercial one gets forced internal review and "Owner" labels. Jobs are created with 0% retainage and no billing basis. |
| Payables | Full AP desk exists. Every expense needs a job; no overhead bucket; no card-feed matching; payment-run ceremony too heavy for a small shop. |
| Opportunities | The builder deal room with a new label: Bids tab solicits subs, firmness meter, plan takeoff, "Start building". No ITB intake, quote, won/lost. Estimates exist but are kept out of nav. |
| Books | Fits as-is. Hours should feed payroll; today payroll only flows in. |
| Network | Builder-portal submissions and the trade's own invoice are separate records; a sub on Arc billing a builder on Arc double-enters. |

## 3. Rules specific to this plan

- **Profile, not posture, and never inline.** Trade behavior routes through ONE
  helper (the business profile from `lib/services/business-profile.ts`, exposed
  once in the app chrome context) and the existing choke points: `terminology()`,
  `project-nav-items.ts`, `lib/settings/sections.ts`, `lib/mobile/workspace-catalog.ts`,
  and a new profile-aware branch of `lib/receivables/policy.ts`. Writing
  `profile.kind === "trade"` in a component is a defect.
- **Hide = guard.** Anything hidden from trade nav gets a route guard that redirects
  with a named reason (mirror the production `/pipeline → /sales` redirect). Nav-only
  hiding is not done.
- **The plan is the gate; the profile is the shape.** `plans.code = "trade"` with
  `plan_feature_limits` decides what is enabled; the profile decides vocabulary,
  defaults and layout. One helper reads entitlements; nothing else does.
- **No `trade_*` tables for neutral capabilities.** Pay periods, clock events, quote
  lines and overhead expenses help builders too. Only things that ARE the trade
  domain (builder connections, ITB intake) keep the name.
- **Reuse before building.** Time entries, T&M tickets, estimates, pay applications,
  waivers, retainage, AR aging, Books payroll import, mobile receipt scan — all exist.
  Extend, do not fork.
- **Mixed is still the design case.** A trade org may also act as a small GC on one
  job (a plumber who subs out excavation). Nothing may assume a trade never has
  commitments or payables of its own.

## 4. Workstreams and sequencing

Run in this order. Each is one category in the Books cadence.

| ID | Workstream | Why this position |
|---|---|---|
| TR01 | Profile with teeth (gating, settings, mobile, plan) | Prerequisite for a clean experience and for selling a cheaper plan. Mostly plumbing. |
| TR02 | Jobs and receivables for trades | Getting paid is the first promise. Fixes the posture-vs-profile fault. |
| TR03 | Field time and payroll | Second promise; largest new build (clock, periods, foreman approval, export). |
| TR04 | Trade quoting | Replaces the builder deal room for trades. |
| TR05 | Expenses for small shops | Overhead bucket, job-optional capture, card-feed matching. |
| TR06 | Builder-to-trade network | The moat: invitation → linked job, mirrored receivables, compliance vault. |
| TR07 | Readiness | QA org fixtures, golden scenarios, docs, terminology sweep. Runs alongside every category and closes last. |

Items, criteria, weights and dependencies are in `completion-checklist.json`.

## 5. Golden scenarios (acceptance stack, QA org only)

| ID | Scenario |
|---|---|
| TRADE-SETUP-01 | Provision an electrical trade org on the trade plan. Owner, office admin, foreman and crew member each sweep every route: trade desks load, builder desks redirect with a reason, settings and iOS catalog show no builder modules. |
| TRADE-BILL-01 | Residential-posture job for a GC customer billed by SOV with 10% retainage held: pay app #1 submitted with conditional progress waiver → GC certifies on portal → invoice issued → partial ACH → retainage shows as held receivable → final pay app releases retainage with unconditional final waiver. |
| TRADE-TM-01 | Homeowner service job: two crew clock 6h each with cost codes, a $340 supply receipt, T&M ticket signed on `/t`, invoice generated, paid by card, labor and material posted to the job. |
| TRADE-TIME-01 | Two-week pay period: crew clock in/out across three jobs, one entry crosses the weekly OT threshold and is auto-flagged, foreman approves in bulk (no `bill.approve`), admin locks the period, exports the payroll CSV, imports the provider register into Books payroll and it reconciles to recognized labor. |
| TRADE-QUOTE-01 | Builder invitation appears as an ITB with a due date; quote built from labor, material and markup; sent via `/e`; follow-up logged; accepted; converted to a job carrying contract amount, customer and billing basis. |
| TRADE-EXP-01 | Fuel receipt captured on mobile with no job → lands in overhead → later matched to a Books bank transaction; a supply-house receipt is reassigned to a job. |
| TRADE-NET-01 | A QA builder org on Arc invites the QA trade org; accepting creates a linked trade job; the sub's pay app submitted in the builder portal appears on the trade's billing book as the same receivable, once. |
| TRADE-IOS-01 | `pnpm test:mobile` contract: `/organizations` exposes the profile, the workspace catalog omits builder modules for a trade org, clock in/out endpoints round-trip. |

## 6. Done means

- `node scripts/qa/production-readiness.mjs --checklist docs/plans/arc-trade/completion-checklist.json` reports zero errors and every mandatory item `accepted`.
- All eight scenarios have current passing runs.
- `docs/reference/arc-trade.md` describes what shipped; `CLAUDE.md` names the trade profile as a fourth choke point; this folder is deleted.
