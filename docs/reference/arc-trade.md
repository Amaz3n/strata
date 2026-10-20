# Arc Trade

Arc Trade is Arc for a specialty contractor — an electrician, plumber, framer or HVAC company with a few to a few dozen field employees whose customers are builders, GCs and homeowners. It runs the company's own jobs, crew time and payroll hours, quotes, receipts and customer billing, and connects to the builders who invite it onto their projects.

Where this doc and the code disagree, the code wins. `docs/plans/arc-trade/` is the live readiness tracker (intent, not truth) and is deleted only when every item there is accepted.

## What it is

Arc Trade is a **business profile**, not a posture and not a tier.

- **Profile** — `org_settings.settings.business_profile` = `{ kind: "builder" | "trade", specialty }`. A missing or invalid profile is a builder. The profile is the *shape* of the workspace: vocabulary, defaults, layout, which desks exist.
- **Plan** — `plans.code = "trade"` (Arc Trade) with its `plan_feature_limits`, written to `entitlements` by `syncOrgEntitlementsFromPlan`. The plan is the *gate* for paid features. Platform provisioning starts a trade company on it (`defaultPlanCode`).
- **Posture** is unchanged and independent: a trade's jobs are residential or commercial projects, `projects.property_type` still decides each job's posture, and `orgs.product_tier` only seeds the default for new jobs (`defaultTradeJobType`). A trade org may also hold commitments and payables of its own; nothing assumes it does not.
- Arc Trade reuses the project, schedule, time, billing, payables, directory, document, change-order and Books services. Neutral capabilities (pay periods, clock sessions, quote lines, overhead expenses) carry neutral names; only the trade domain keeps `trade` in its name.

## Choke points

Trade behavior routes only through these. Branching on `profile.kind` anywhere else is a defect.

| What | Where |
|---|---|
| Profile schema, `isTradeProfile()`, `businessBrand()`, `defaultTradeJobType()` | `lib/business-profile.ts` |
| Surface: profile + plan → what the workspace includes. Pure: `resolveWorkspaceSurface`, `permissionRefusal`, `filterSurfacePermissions`, `surfaceOffersRole`, `WORKSPACE_DESKS`, `WORKSPACE_PROJECT_TABS`, `surfaceAllowsPath`, `isTradeSurface` | `lib/workspace-surface.ts` |
| The one loader and the route guards: `loadWorkspaceSurface()`, `guardWorkspaceDesk()`, `guardProjectTab()`, `guardPayoutRailDesk()` | `lib/services/workspace-surface.ts` |
| Chrome: the surface reaches the sidebar, mobile nav, settings window and loading shells through `getAppChromeContext()` | `lib/services/app-chrome.ts` |
| Nouns: `terminology(posture, profile?)` overrides project→Job, owner→Customer, fee→Markup, vendor→Supplier, pipeline→Opportunities; `profileTerminology(profile)` for output with no posture in hand (emails, PDFs) | `lib/terminology.ts` |
| Receivables: `resolveReceivablesPolicy({ posture, profile, settingsMetadata })`, `resolveOrgReceivablesPolicy({ tier, profile })`; server loader `loadProjectReceivablesPolicy()` | `lib/receivables/policy.ts`, `lib/services/receivables-policy.ts` |
| Settings sections: `visibleSettingsSections(permissions, surface)` | `lib/settings/sections.ts` |
| Mobile catalog: modules filtered by `surfaceAllowsModule()`; Time is "Crew time"; `/api/mobile/v1/organizations` and `/session` return `business_profile`, `brand` and `terms` per org | `lib/mobile/workspace-catalog.ts`, `lib/mobile/auth.ts` |
| Project nav: trade job groups (`tradeGroups`) | `components/layout/project-nav-items.ts`, `components/layout/trade-nav-items.ts` |
| Lint: `PROFILE_BRANCH_RULE` fails any `<x>Profile.kind ==` comparison outside the two choke-point files | `.eslintrc.js` |

**The plan is the gate, the profile is the shape.** A trade company never runs land, communities, house plans, starts, sales, closings, design studio, purchasing or divisions, whatever its plan. Selections and Closeout & Warranty are plan features the trade plan omits (`TRADE_PLAN_FEATURES`). An org with no entitlement rows keeps its contract: a builder keeps every feature, a trade company gets the Arc Trade plan.

**Hide means guard.** `authorize()` and `authorizeMany()` refuse any permission the surface refuses (`deny_workspace_surface`, message names the plan: "Sales isn't part of Arc Trade."), so server actions, API routes and the mobile API refuse the same way, and the member's effective permission list is filtered to match. Builder-only desk pages and settings pages call `guardWorkspaceDesk()`; hidden project tabs call `guardProjectTab()`. Both send the member to `/?unavailable=<area>` and Today names the reason. A project module override (`project_module_overrides`) reopens a builder-only tab such as Bids for one job; a plan feature cannot be overridden per job. Payment runs and payment reconciliation are refused for a trade until its vendor payout rail is set up (`opensWithPayoutRail`).

## Plan and roles

Migration `20261025100000_arc_trade_plan_and_crew_roles.sql` seeds `plan_features`, the `trade` plan (placeholder price — set the real price and Stripe price id in Platform → Subscription plans), its limits, the `time.approve` permission, and two org roles. The role picker offers Foreman and Crew member and hides builder-only roles from a trade company (`surfaceOffersRole`).

| Role | Holds | Does not hold |
|---|---|---|
| Owner, Office admin | existing `org_owner`, `org_office_admin` | — |
| Foreman (`org_foreman`) | crew access plus `time.approve`, `schedule.edit`, `daily_log.approve`, `punch.close`, `drawing.markup`, `change_order.read`, `directory.read` | billing, payables |
| Crew member (`org_crew_member`) | `org.member`, `time.read/write`, `schedule.read`, daily logs, documents, drawing read, punch, messages | `project.read` — sees only jobs they are assigned to; no billing, payables or directory |

Time permissions (`lib/permission-catalog.ts`): `time.approve` approves and rejects entries (granted to every role that held `bill.approve`, which is still accepted); `time.manage` records or changes time for other workers; `time.close` closes pay periods and exports payroll hours (granted to `payroll.write` roles). A foreman needs project membership on a job to approve its time.

## Jobs and receivables

- **Creating a job.** The trade form (`components/trade/new-job.tsx`) asks who pays (builder/GC or homeowner), how the job bills (pay applications on a schedule of values, fixed-price invoices, or T&M), retainage held, payment terms, whether the office reviews before send, and whether the customer certifies pay applications. `tradeJobBilling()` (`lib/trade/workspace.ts`, pure) maps the answers to billing model, contract type, billing basis, retainage and receivables terms; `createTradeJob` (`lib/services/trade-workspace.ts`) passes them through `createProject`. The job's customer terms live on `project_financial_settings.metadata.receivables` (`read/writeJobReceivablesTerms`).
- **One policy from the profile.** A trade gets one receivables policy on any posture: customer label Builder (GC customer) or Customer, workspace "Customer receivables", approval `direct` or `required_review`, certification and terms from the job, retainage supported. Pay applications turn on from the job's billing basis (`resolveBillingProfile`), never from posture. A builder's policy is unchanged.
- **Pay applications to a GC.** Certification is the job's choice (`certifiesPayApplications`): either the owner certifies on the portal and certifying issues the invoice, or Send issues directly. `documentCustomerLabel` is frozen into the G702 snapshot and printed by both renderers (`lib/pdfs/pay-application-g702.tsx`, `components/financials/pay-application-document.tsx`); the trade's org is the Contractor.
- **Retainage the customer holds.** `ProjectBillingSummary.retainageRelease` (`lib/financials/retainage-release.ts`, pure) gives held retainage an expected release date from closeout substantial completion, then the job end date. AR aging reports `retainage_held_cents` as its own figure, never in a bucket or `total_open_cents`. Releasing retainage from the retainage ledger on a trade surface also prepares the unconditional final waiver (`createRetainageReleaseWaiver`, `lib/services/retainage.ts`); that step is driven by the ledger UI, not by the release service.
- **T&M.** Approving time creates an open billable cost directly (`upsertBillableCostFromTimeEntry`). Bill rate precedence: project override, contract rate schedule (person, then role), member bill rate, else $0 with `billing_rate_source` recorded. Bill costs and T&M tickets have no trade gate; T&M Tickets sit under Costs on T&M jobs.
- **Waivers, change orders, payments.** Outgoing waivers name the org as claimant and read "customer" on a trade surface; the Payables → Waivers register reads Supplier/Job. Change orders hide GMP fields for a trade and read Customer. Receive-payment, `/i` pay pages and Stripe connected accounts have no trade gate; Company setup links "Get paid online" to payout setup.
- **Job workbench.** `tradeGroups` nav: Overview, Schedule, Crew time, Daily logs, Photos, Documents, Billing, Costs, Change orders, Punch. RFIs, Submittals, Permits, Inspections, Drawings and Safety appear only by module override. The overview band (`components/trade/job-overview-band.tsx`) shows contract, billed, paid, retainage held and crew hours this week.

## Field time and payroll

All of it is org-scoped, bounded and permission-checked; rates never leave the server in timesheet DTOs.

- **Clock.** `lib/services/time-clock.ts`: `clockIn`, `switchClock`, `startBreak`/`endBreak`, `clockOut` over `time_clock_sessions` (one open session per worker). Clocking out writes hours less breaks as a *submitted* time entry through `createTimeEntry`, dated in the org's time zone (`lib/time/clock.ts`); a clock left running past 24h is capped and noted for the approver. A cost code is required when the job's budget carries cost codes. Own time needs `time.write`; anyone else's needs `time.manage`, enforced in the clock, `createTimeEntry` and `updateTimeEntry`. Web: Clock card on `/trade/crew?view=time`. Mobile: `/api/mobile/v1/time/clock/*`.
- **Timesheet and My hours.** `lib/services/timesheets.ts`: `getTimesheet({ period, projectId })`, `getMyHours()`; the grid is `buildTimesheetGrid` (`lib/time/timesheet.ts`, pure), one bounded query (cap 2000, truncation shown). Without `time.approve`/`time.manage`/`time.close` a person sees only their own time. Mobile: `GET /time/mine`.
- **Approval.** `approveTimeEntries`/`rejectTimeEntries` (bulk, ≤200, in work order so overtime counts correctly). Rejection needs a reason and shows as sent back in the worker's My hours; it is not emailed or pushed. Queue: `TimeApprovalQueue` on `/trade/crew` and the job's Crew time tab; mobile `GET /time/approvals`, `POST /time/approvals/approve|reject`. Approval posts job cost and billable cost through `propagateApprovalToLedger`.
- **Overtime.** The rule lives in `org_settings.settings.time_policy` (`lib/time/policy.ts`): weekly threshold (default 40), optional daily OT and double-time thresholds, automatic switch (on by default for a trade, off for a builder). `allocateOvertime` (`lib/time/overtime.ts`, pure) applies daily lines then the weekly line; approval splits an entry that crosses a line (`lib/services/time-overtime.ts`).
- **Rates.** `labor_rates` holds effective-dated cost rate, burden and bill rate per worker; `resolveLaborRate` (`lib/services/labor-rates.ts`) prices an entry at the rate in force on its work date. Edited in Team → member inspector → Rates (`members.manage`).
- **Pay periods and lock.** Weekly or every-two-weeks schedule from Company setup; periods are computed (`lib/time/pay-periods.ts`) and `pay_periods` records a close. `closePayPeriod` (`time.close`) refuses an unfinished period, one with time waiting, or one whose overtime drift would split an approved entry; it re-checks overtime, writes the summary, links the Books payroll import with the same dates, and locks approved entries (`status = locked`). A trigger makes locked entries immutable except billing state; new time cannot be dated into a closed period (the sub portal included). `correctLockedTimeEntry` reverses with negative hours and records the right hours as a new entry for approval.
- **Export.** `exportPayPeriod` (`time.close`, closed periods only): a generic CSV and a Gusto-shaped CSV, formula characters escaped, audited as `payroll_hours_export`. Payroll reconciliation stays the Books payroll variance workflow, which counts locked time as approved (`lib/services/books/payroll-labor-snapshot.ts`).

## Quoting and opportunities

An opportunity is a `prospects` row; there is no `trade_*` table. `lib/services/trade-quotes.ts` owns it.

- **Intake.** `createTradeOpportunity`, or `trackBuilderInvitation(grantId)`, which re-resolves a bid invitation against the member's verified builder identity and records `prospects.source_grant_id` (unique per org) so an invitation is tracked once. The desk lists untracked invitations with a Track button. Outcomes: Won, Lost (price, competitor, other) or Declined (`DECLINE_REASON_CODES`, stored as a lost deal).
- **Quote builder.** `lib/trade/quote.ts` (pure): labor (hours × rate from active rate-schedule classifications), material, equipment and other lines with markup %, optional add-ons and sections. Saved as the prospect's estimate (`saveTradeQuote` → `createEstimate`/`saveEstimateDraft`; `reviseTradeQuote` → `reviseEstimate`), so `quoteTotals` equals the stored estimate total. UI: `components/trade/quote-editor.tsx`, one workbench per opportunity (`trade-opportunity-room.tsx`). The builder deal room's bids, plans, pricing, proposal and files tabs are refused for a trade (`WORKSPACE_DESKS.deal_room`).
- **Send, follow up, convert.** `sendTradeQuote` goes through `sendEstimate` (the `/e` review link) and sets a follow-up three days out; follow-ups and price deadlines due within a week show on Today and the follow-up reminder cron emails the owner. Acceptance is the customer signing on `/e` or `recordQuoteAcceptance` (a yes by phone or email, audited). `startTradeJobFromQuote` creates the job through `createTradeJob` (accepted total including add-ons as contract value), links `projects.prospect_id`, marks the prospect won, and returns the existing job if started twice.
- **Stages.** `/pipeline` for a trade is `TradePipeline` (`components/trade/trade-pipeline.tsx`): Invited, Quoting, Sent, Won, Lost, sorted by due date, capped at 300 open plus 100 closed in the last 90 days (caps shown). Stage and next move come only from `quoteMove()` (`lib/trade/quote.ts`); never store or branch on a stage in a component. `dealMove()` (`lib/precon/deal-move.ts`) remains the builder's.

## Expenses for a small shop

- **A home for every expense.** A job, an overhead category (`lib/financials/overhead.ts`: fuel and vehicles, tools, shop supplies, meals and travel, software, insurance, rent, utilities, professional fees, other) or unsorted (reviewable, never approvable; DB guard `project_expenses_posted_has_home`). `lib/services/org-expenses.ts`: `createOrgExpense`, `assignExpenseHome` (optimistic `updated_at` guard; an approved expense voids the old job's cost entry and posts the new one; refuses split or cost-plus-billed expenses), `approveOrgExpense`/`rejectOrgExpense`. Desk: `/payables/expenses`.
- **Books.** The projector gives an overhead expense's cost line its category account (6200–6230, seeded for existing Books orgs by migration `20261028100000_overhead_expenses.sql`).
- **Capture.** `lib/mobile/expenses.ts` is the one create path: `/api/mobile/v1/expenses` (own recent expenses; POST with optional `project_id` or `overhead_category`, idempotent on `client_id`) and `/expenses/scan`, which suggests a job from the caller's clock sessions that day (`suggestJobFromClock`). Unsorted captures land in the office review queues.
- **Card-feed match.** An approved expense already credits the card or bank account. The banking inspector labels expense-backed match candidates and, when `capturedExpenseMatch` (`lib/services/books/banking-model.ts`, pure) finds exactly one same-amount expense in the match window, offers "Match to this expense"; categorizing instead asks to confirm it would record the cost twice. Matching posts nothing new and undo only unlinks. `loadUnmatchedCapturedExpenses` lists approved non-cash expenses of the last 90 days with no confirmed bank match (cap 200, shown).
- **Payables desk.** Payment runs and reconciliation stay closed until payout setup. Supplier bills forwarded to the bills inbox that no commitment routes are matched to a job by its distinctive name or street address, only when exactly one job matches (`lib/financials/bill-job-match.ts`, `metadata.routed_by = 'job_reference'`).

## Builder-to-trade network

Builder connections (`/trade/connections`) lists the live shared projects and bid invitations the signed-in person has already claimed. The match is the confirmed Arc login email against an active, verified external identity; company membership alone grants nothing. The list is personal, not company-wide. Opening a connection rechecks the specific grant and starts the existing portal session; the destination still enforces token, PIN, grant and permissions.

- **Linked jobs.** `linkBuilderProject` (`lib/services/project-connections.ts`; `project.manage` + `invoice.write`; re-resolves the grant against the verified identity) either creates a trade job (create mode) or attaches an existing unlinked one. The builder becomes the job's customer (company found by case-insensitive name or created with the client role; an existing different customer is kept and the member is told). The link is a `project_connections` row written with the service role, with name snapshots; a trigger moves its status with the grant (paused/active, revoked → ended). Ending a link never touches the job.
- **One receivable, two views.** `syncConnectedReceivable` (`lib/services/connected-receivables.ts`) is the only reader of a builder's bill on the sub's behalf. The outbox job `sync_connected_receivable` is enqueued by the `vendor_bills` trigger for portal-submitted bills matching an active link, and by linking. The first sync creates an issued invoice on the linked job (no email sent; invoice number is the sub's bill number unless taken) with `metadata.connected_receivable` carrying builder status and paid amount; a unique index makes it one invoice per bill. A builder payment records exactly the delta through `recordPayment` (idempotent `provider_payment_id`); a rejected bill voids the invoice; a total change before payment voids and reissues; a paid amount going down, or the total changing after payment, flags the invoice for review rather than rewriting money. The outbox processor is `app/api/jobs/process-outbox/route.ts`.
- **Compliance vault.** `lib/services/own-compliance.ts`: the company's own COI, W-9, license, bond and other documents in `own_compliance_documents` (one current per type; replacing supersedes and keeps history), uploaded from Company setup (`compliance.manage`). Share sends the current unexpired document to every builder with an active connection that asks for that type and does not already hold it, through the same copy path as the portal share (`copyDocumentIntoOrg`), so each builder receives an ordinary `pending_review` document against its own requirement; approval never travels. The daily compliance autopilot emits `own_compliance_document_expiring` at 30, 14, 3 days and expired, once per rung, to `compliance.manage` holders; the type is in `EMAIL_NOTIFICATION_TYPES`.

Migration `20261029100000_project_connections_and_own_compliance.sql` owns the schema for all three.

## Acceptance

Acceptance runs only on the isolated Books acceptance stack (`docs/books-acceptance-runner.md`), never in a customer org and never against production Supabase. There is no staging environment.

**Fixtures.** `scripts/books-acceptance/trade-seed.cjs` builds, once per kit and in a fresh organisation per run, "Voltline Electric (acceptance)": an electrical trade company provisioned through `provisionOrganization` (the `trade` plan and profile), an owner and four people in trade roles (Dana, office admin; Frank, foreman; Casey and Chris, crew members) with effective-dated labor rates, a GC customer (Harbor General Contractors and its contact) and a homeowner, and three jobs made through `createTradeJob` — a residential job for the GC billed by pay application at 10% retainage, a residential homeowner T&M job, and a commercial fixed-price job at 5%. The foreman is assigned to the GC and homeowner jobs and the crew to the homeowner job. `mobileCall` signs a seeded person in through GoTrue and calls the `/api/mobile/v1` route handlers as the app does.

**Scenarios.** Declared in `ARC_TRADE` in `scripts/books-acceptance/catalog.cjs`, each mapped to its checklist item; expected results are in `scripts/books-acceptance/expected/<ID>.json` and `scenarios/trade-*.cjs`. A trade scenario that is unbuilt or has open steps is reported, not failed, in an all-scenarios run.

| ID | Proves |
|---|---|
| TRADE-SETUP-01 | A trade org is provisioned on the trade plan; owner, office admin, foreman and crew member each sweep every route: trade desks load, builder desks, settings pages and project tabs refuse with a named reason, menus and settings hold no builder modules, crew see only assigned jobs. |
| TRADE-BILL-01 | A residential-posture job for a GC billed by schedule of values with 10% retainage: pay application submitted with its conditional progress waiver, certified on the portal, invoice issued, partial ACH, retainage shown as held, final release with the unconditional final waiver. |
| TRADE-TM-01 | A homeowner service job: two crew clock six hours each with cost codes, a supply receipt, a T&M ticket signed on `/t`, an invoice generated from costs and paid by card, labor and material posted to the job. |
| TRADE-TIME-01 | A two-week pay period: clock in and out across jobs, one entry crosses the weekly overtime line, a foreman approves in bulk without `bill.approve`, the period is locked and exported, and the Books payroll import reconciles to recognized labor. |
| TRADE-QUOTE-01 | A builder invitation is tracked as an opportunity with a due date, a quote is built from labor, material and markup, sent on `/e`, followed up, accepted and converted to a job carrying contract amount, customer and billing basis. |
| TRADE-EXP-01 | A fuel receipt captured on mobile with no job lands in overhead and matches a Books bank transaction; a supply-house receipt is reassigned to a job. |
| TRADE-NET-01 | A QA builder org invites the QA trade org; accepting creates a linked trade job; the sub's pay application submitted in the builder portal appears on the trade's billing book as the same receivable, once. |
| TRADE-IOS-01 | The mobile contract for a trade org: `/organizations` exposes profile, brand and terms (a builder org is unchanged), the workspace catalog omits builder modules per role and names Time "Crew time", clock in and out round-trip, and clocking in an unassigned job or another worker is refused. |

`TRADE-01` is a different scenario — the builder-side trade look-ahead and notices — and is not part of Arc Trade.

**Run one scenario** (stack bootstrap and `api.cjs` as in `docs/books-acceptance-runner.md`):

```sh
node scripts/books-acceptance/scenario-runner.cjs --container <acceptance container> \
  --api-url <loopback API, http://127.0.0.1:PORT> --scenario TRADE-SETUP-01 \
  --evidence-dir <new directory>
```

`--evidence-dir` must not exist. `--only name[,name]` runs named subcases while iterating (the rest report `SKIPPED`, so the run never reads `PASSED`); `--include-pending` includes pending subcases; `--all` runs every scenario. A scenario with an open subcase stays `INCOMPLETE` and exits non-zero.

## Verification

```sh
pnpm lint && npx tsc --noEmit   # tsc needs NODE_OPTIONS=--max-old-space-size=12288
```

Trade has no suite of its own; its tests run in these. `pnpm test:land` runs the four trade-specific files below (and the posture terminology file); the rest ride the suites named in the last column.

| Test file | Covers | Runs in |
|---|---|---|
| `tests/arc-trade.test.js` | the workspace surface (plan features, profile refusals, desks and project tabs, module overrides, payout-rail desks, the deal room, role picker and invite refusal), trade nav and settings, job form, crew conflicts and hours, builder project links, retainage-release waivers | `pnpm test:land` |
| `tests/trade-workspace.test.js` | the trade workspace services: job creation permissions and customer, billing answers, scheduling work, what the workspace reads for a member | `pnpm test:land` |
| `tests/trade-quotes.test.js` | opportunities, quote math, quote stages, invitation tracking, conversion | `pnpm test:land` |
| `tests/receivables-policy.test.js` | profile-keyed receivables policy | `pnpm test:land` |
| `tests/crew-time.test.js` | clock, timesheet grid, approval, overtime, pay periods, locking, correction, export | `pnpm test:financials` |
| `tests/org-expenses.test.js` | overhead and job-optional expenses, reassignment | `pnpm test:financials` |
| `tests/connected-receivables.test.js` | the mirrored invoice from a builder's bill | `pnpm test:financials` |
| `tests/compliance-system.test.js` | the compliance vault, share and expiry rungs | `pnpm test:financials` |
| `tests/billing-rate-schedules.test.js`, `tests/billable-ledger-rules.test.js`, `tests/payable-intake.test.js`, `tests/books-payroll-labor-snapshot.test.js`, `tests/pay-applications.test.js`, `tests/billing-model.test.js` | rate precedence, locked-entry billing state, bills-inbox job matching, payroll variance, pay-app wording, retainage release | `pnpm test:financials` |
| `tests/authorization-policy.test.js` | the decision policy, plus `authorize()` refusing a trade surface (`deny_workspace_surface` with its sentence), `getEffectiveOrgPermissions` filtering and `authorizeMany` | `pnpm test:auth` |
| `tests/product-posture-terminology.test.js` | `terminology()` with and without a profile, the pay application labels and certification copy, and the rendered portal invite, invoice, estimate, signature, payment-returned and remittance emails for a trade and a builder | `pnpm test:land` |
| `tests/mobile-time.test.js`, `tests/mobile-field.test.js`, `tests/mobile-auth.test.js`, `tests/mobile-workspace-catalog.test.js` | clock, approvals and My hours, receipt capture, profile and terms, the catalog | `pnpm test:mobile` |
| `tests/mobile-api-contract.test.js` | the OpenAPI contract (the `/time/*` routes are still in its `UNDOCUMENTED` set) | `pnpm test:mobile`, `pnpm test:phase-d` |
| `tests/books-banking.test.js` | expense-match candidates and undo-only-unlinks in the banking model | `pnpm test` only |

The `tests/trade-lookahead*`, `trade-notices*` and `trade-responses*` files belong to the builder-side trade coordination desk, not to Arc Trade. The database-backed paths that tests do not reach (invoice and void RPCs for a mirrored invoice, overhead guards, the locked-entry trigger) are covered only by the acceptance scenarios.

## Known limits

- **Lien rights deadlines are not built** (TR06-04). `docs/plans/lien-autopilot-gameplan.md` carries legal STOPs on per-state deadline rules; scope it there with a human-reviewed rule table. Supplier accounts and price tracking (TR05-05) are also unbuilt; purchasing is the builder price book and is not offered.
- **Schema.** The eight Arc Trade migrations (`20261025100000` through `20261031110000`: plan and roles, clock and pay periods, opportunity due dates, overhead expenses, project connections and own compliance, `post_retainage_release`, time-entry write fences, connected-receivable fences) are applied to production (2026-10-20).
- **Builder payments carry the bill's method.** A builder-reported payment records the method the builder's bill was paid by, or `other` when it is not one Arc knows, with provider `builder_portal`.
- **The mirror lags up to the outbox cadence** (about ten minutes). Only invoices mirror: the sub portal has no pay applications. Publish-link and adjustment actions are hidden for a mirrored invoice and refused by the server.
- **Linking is not atomic** with its check; a race falls to the partial unique indexes.
- **Time.** A sent-back entry is not emailed or pushed. `correctLockedTimeEntryAction` has no button yet. Out-of-order approval that needs a split blocks the close until the entry is sent back and re-approved. The Gusto columns are unconfirmed against Gusto's current hours-import template. A payroll import prepared after a period closed is matched by dates on the summary but not written to `pay_periods.books_payroll_import_id`. A future-dated raise updates the member's current-rate columns only when someone saves again after it starts. The clock card shows only in the Time view of `/trade/crew`. The `/time/*` mobile routes are not in the OpenAPI file.
- **Quotes.** The quote goes out through the estimate email and `/e` page, which still say "agreement" and offer the builder countersignature envelope. Starting a job does not draft a schedule of values from the quote lines. An unchanged sent quote cannot be resent, only revised. Invitations are tracked by a click, not on arrival.
- **Expenses.** Posting a card charge that matches a captured receipt is refused (row, bulk, bank rule) unless the inspector's confirm overrides it. Supply-house bill routing runs only for a trade company and needs a cue word beside a one-word job name; there is no field-level PO match. The job suggestion uses the receipt's UTC calendar day. A QuickBooks push of an overhead expense (no customer) is unverified against a QBO sandbox.
- **Jobs.** The Foreman needs project membership on each job (no `project.read` by design). The overview band reads the 50 most recent settled time entries and says when that may undercount. Signatures, Correspondence and Reports left the trade nav but are not guarded by URL. The online payment fee policy is platform-admin only (`/admin/payment-fees`).
- **Vocabulary.** `terminology()` covers project, owner, fee, vendor and pipeline; emails take the job noun from `profileTerminology()`, and TRADE-SETUP-01 renders the trade invite, invoice and estimate emails and the pay-application labels to prove no builder noun leaks. Supplier-side copy keeps "Vendor", and the G702 keeps the AIA "From (Contractor)".
- **Review lows** are listed in the tracker's `deferredBacklog` (TRADE-REVIEW-20261019).
- **iOS.** The app must adopt the profile/terms payload, the `/time/*` and `/expenses` routes (TRADE-IOS-01 tests the contract, not the client).
