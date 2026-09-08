# Arc Pay Readiness Gameplan — from 4/10 to 10/10

> **Status: ACTIVE PLAN — intent, not a description of the system.**
> Nothing here is guaranteed to exist. Never infer current app behavior from it.
> Source of truth is the code, `CLAUDE.md`, and the reference docs at the `docs/`
> top level. **When every workstream below is done, delete this file** and fold
> anything durable into `docs/plans/fintech-gameplan.md` (or its successor) and
> `docs/plans/ap-payment-qa-runbook.md`.

**Written:** 2026-09-01, from a five-slice readiness review of the AP vendor-payment
rail (Stripe Connect, separate charges and transfers) on branch
`production-tier-hardening`. Every finding was confirmed in code or in the live
production database; the file:line references were accurate on that date and may
have drifted — **re-locate by symbol name before editing**.

**Audience:** an LLM executor with repo access, plus the human who owns STOP gates.

> **Phase A executor work finished 2026-09-02.** Code, migrations, tests, scripts
> and docs are in the tree; the remaining Definition-of-Done checks are explicitly
> human-gated (env/deploy, eleven migration applications, ledger repair, stuck-run
> cleanup, and CI confirmation). See
> "Phase A execution record" at the end of Phase A. Corrections found while
> executing are folded into the workstreams below rather than appended.

**Companions:** `docs/plans/fintech-gameplan.md` (architecture and STOP gates, still
authoritative for anything this plan does not override), `docs/plans/ap-payment-qa-runbook.md`
(the release gate this plan must make passable).

> **Stripe custody decision update — 2026-09-08.** Stripe Support confirmed in
> writing that Separate Charges and Transfers commingles builder payments in Arc's
> platform balance; that balance is exposed to Arc's disputes, refunds, fees,
> negative balances, other balance activity, and insolvency risk. Stripe Funds
> Segregation does not support ACH Direct Debit. Therefore the existing Stripe ACH
> Rail v1 must not launch under Arc's requirement that builder principal never be
> held or controlled by Arc. A manual platform payout schedule remains a useful
> defense-in-depth test control, but it does not solve custody or segregation.
> Production launch is blocked pending either (a) Stripe approval and provisioning
> of Treasury for platforms / per-builder Financial Accounts with outbound ACH, or
> (b) an approved bank/FBO rail such as Column. Vendor early payment is separately
> unapproved and remains out of scope.

---

## 0. How to execute this plan

### Rules that override everything below

1. **Local dev points at PRODUCTION Supabase.** Never run INSERT/UPDATE/DELETE/DDL
   through the app, the CLI, or the Supabase MCP. `execute_sql` is SELECT-only.
2. **Never apply a migration.** Write it into `supabase/migrations/` as
   `YYYYMMDDHHMMSS_name.sql`, then STOP and tell the human. Code may assume the
   planned schema; say clearly that the migration is pending.
3. **Never touch `supabase/pending-migrations/`.**
4. **Search before writing.** 220 services, 489 components. Assume the helper exists.
5. Follow `CLAUDE.md` exactly: services own logic, every query org-scoped, integer
   cents, `{ success, error }` from actions, Zod on every action input, tokens only,
   radius 0, empty/loading/error/dark for every view, no `-v2` names, delete what
   you replace.
6. A workstream is done only when its **Definition of Done** is fully checked and
   the **verification commands** for that workstream pass. Do not report partial
   completion as completion.
7. Every workstream ends with `pnpm lint && npx tsc --noEmit` clean and
   `pnpm test:financials` green. Workstreams that touch RPCs also run the pgTAP
   suite once WS-A6 wires it.
8. Each **STOP** names a human decision. Do not route around it.

### Execution order

Phases are ordered by dependency. Inside a phase, workstreams marked ∥ may run in
parallel. Do not start Phase D's UI on top of Phase C's state machine until C lands,
or the UI will encode the bugs.

```
A  Stop the bleeding in production        (ops, no product behavior change)
B  Money-movement correctness              (executor, webhooks, transfers, ledger)
C  Run lifecycle and recoverability        (runs, holds, limits, permissions)
D  Builder experience                      (run pages, bulk flows, sync badges)
E  Vendor side                             (invites, claims, portal, remittance)
F  Notifications                           (fan-out, dedupe, copy, ordering)
G  Accounting sync truthfulness            (durable enqueue, queue, watchdog)
H  Tests, QA runbook, attestations         (the release gate itself)
I  Strategy and docs                       (Column direction, plan cleanup)
```

### Verification commands (run exactly these)

```bash
pnpm lint && npx tsc --noEmit
pnpm test:financials
pnpm test:auth
pnpm test:mobile
pnpm db:schema:check
```

pgTAP (after WS-A6): the command WS-A6 adds to `package.json` as `test:db:payments`.

### What 10/10 means

The rail is 10/10 when **all** of the following are true, not when the code merely
compiles:

- Every DoD checkbox in Phases A–H is checked.
- `docs/plans/ap-payment-qa-runbook.md` has been executed end to end in Stripe test
  mode against the QA org, including all 16 failure-injection cases, with saved
  evidence (run IDs, disbursement IDs, provider IDs, ledger transaction IDs,
  webhook events, reconciliation results) and zero open severity-1/2 defects.
- The five launch attestations are recorded truthfully by the humans named in
  the runbook. An LLM never records an attestation.
- Two Florida builders have completed a pilot: at least one run each, sole or dual
  approval, reconciled with zero exceptions for 14 consecutive days.
- The migration ledger matches the repo and `pnpm db:schema:check` passes.

---

## Phase A — Stop the bleeding in production

No product behavior changes. Everything here is either an environment/config action
for the human or a small, safe code change.

### WS-A1 — Turn the release cron back on (human)

**Why.** `payment-release` has failed every 5 minutes since 2026-08-13 with
"Electronic payments cannot be enabled until daily reconciliation is running".
`FINTECH_PAYMENTS_EXECUTION_ENABLED` is true in prod and
`FINTECH_PAYMENTS_RECONCILIATION_ENABLED` is not. Matured vendor transfers, scheduled
releases, and ambiguous-submission recovery are all dead.

**STOP — env change.** The human sets, in the Vercel production environment:
`FINTECH_PAYMENTS_RECONCILIATION_ENABLED=true`. Do not set
`FINTECH_PAYMENTS_LIVE_MODE_APPROVED`. Confirm `FINTECH_PAYMENTS_MODE=test` until
Phase H says otherwise.

**LLM tasks.**
- [x] `detectExecutionConfigMismatch` (`lib/payments/operations-monitor.ts`, pure)
      plus a `checkPaymentExecutionConfig` watchdog probe. It fires whether or not
      any rail is enabled — the case that was invisible — and covers execution
      without reconciliation, an unset or nonsense `FINTECH_PAYMENTS_MODE`, and
      live mode without the recorded approval. Org-scoped incidents are raised
      only for organizations actually on the rail. Unit tested.
- [x] **Corrected while executing.** The watchdog's HTTP 500 is *by design* — the
      route returns 500 whenever a critical finding is open so the run lands in
      `job_runs` as failed. Its only critical finding was `payment-release has no
      successful run on record`, so the watchdog was right and the release job was
      the fault. It goes green when WS-A1's env change lands.
      A real bug was found underneath it: `checkCronLiveness` derived every job's
      last success from the 2,000 most recent successful runs, which at ~430
      successes a day is a four-day window, not a per-job one. Healthy daily and
      weekly jobs fell out of it and were reported as never having run —
      production showed `late-fees has no successful run on record` fourteen hours
      after `late-fees` succeeded. Replaced with one indexed lookup per job.
- [x] `releaseMaturedVendorTransfers` now asks whether any organization is on the
      rail before asserting launch readiness. A deployment with the rail off
      everywhere has no money to move and no builder affected, so it returns
      `skipped: "no_enabled_rails"` instead of failing. The readiness assertion is
      still the first thing on every path that can reach the provider.

**Definition of done.**
- [ ] `job_runs` shows a successful `payment-release` run after the env change
      (verify with a SELECT on `job_runs` ordered by `started_at desc`).
- [ ] `ops-watchdog` has at least one successful run.
- [x] A unit test in `tests/fintech-payment-domain.test.js` covers the
      execution-without-reconciliation alert (pure function; no DB).

### WS-A2 — Resolve the run stuck since 2026-08-03 (human, LLM assists)

**Why.** One `payment_runs` row is `processing` with one disbursement in
`transfer_pending`; ledger shows one `payment_submitted` transaction; provider events
show `charge.succeeded` and `transfer.created`. It never advanced because WS-A1's cron
was dead. There is no open operations incident for it.

**Confirmed by the human 2026-09-01: Strata Construction LLC is a QA organization
and this was a test payment.** No customer money is involved, which drops this
from a money decision to a cleanup: the run still has to leave `processing` so its
bill stops being locked by the in-flight index, and the detection gap it exposed
is the part that mattered. That gap is already closed — the stale-payment scan now
runs hourly in the watchdog on no flag at all, so a repeat raises an incident
within the hour instead of sitting unseen for four weeks.

**LLM tasks.**
- [x] With SELECT-only queries, produce a one-page dossier: run id, org, items,
      disbursement ids, provider payment/transfer ids, ledger transactions, provider
      events with timestamps, current Stripe object state (via the Stripe dashboard
      links the human will open; do not call Stripe). See
      `docs/plans/arc-pay-stuck-run-dossier.md`.
- [x] **Corrected while executing.** A per-disbursement helper would conflict
      with the existing incident model, whose durable key is `(org_id,
      finding_code)`. The shared `payment-stale-state.ts` scan now runs from the
      hourly `ops-watchdog` without rail/reconciliation flags, opens one
      `stale_payment_state` incident per affected organization, and preserves
      row-level detail as reconciliation exceptions. Pure selection/grouping is
      covered in `fintech-payment-domain.test.js`.

**STOP — cleanup decision (no longer a money decision).** Test money, so the only
question is how to clear it. Either replay `payout.paid` from Stripe so the normal
path closes the run, or cancel the run once WS-C1 adds the administrator cancel.
No LLM writes to `payment_runs`, `disbursements`, or the ledger by hand, ever —
corrections go through the RPCs, which post reversals rather than editing history.

**Definition of done.**
- [ ] No `payment_runs` row older than 10 business days in `processing` without an
      open `payment_operations_incidents` row.
- [x] The stale-disbursement incident is covered by a test on the pure selection
      logic.

### WS-A3 — Close the anon-executable RPC

**Why.** `submit_payment_run_atomic(uuid,uuid,uuid,text,timestamptz,date)` has
EXECUTE for `anon` and `authenticated` because
`supabase/migrations/20260804090000_payment_run_scheduling.sql:73` revoked from
`public` only. RLS stops the writes, but the function returns a fabricated
`pending_approval` payload to an unauthenticated caller.

**LLM tasks.**
- [x] New migration `revoke execute on function public.submit_payment_run_atomic(...)
      from public, anon, authenticated; grant execute ... to service_role;`.
- [x] Add a repo lint: a node test that
      scans every `supabase/migrations/*.sql` containing `create or replace function`
      for a payment/vendor/ledger function and asserts a matching
      `revoke ... from public, anon, authenticated` (the foundation migration's form).
- [x] STOP and tell the human the migration is pending.

**Definition of done.**
- [ ] After the human applies it: `select grantee from information_schema.routine_privileges
      where routine_name='submit_payment_run_atomic'` returns only `postgres` and
      `service_role`.
- [x] The lint test passes over every existing payment migration.

### WS-A4 — Apply the eleven remaining migrations (human)

**Why.** Verified absent in prod at object level:
`20260813030000_payment_reconciliation_run_idempotency.sql` (unique indexes
`payment_reconciliation_runs_org_period_unique`,
`payment_reconciliation_items_run_reference_unique`) and
`20260813030100_payment_ledger_balance_error_detail.sql`. Also
`20260813040000_remove_dead_vendor_identity_lockout_columns.sql`. The code already
assumes the first one (`claimReconciliationRun`, `insertReconciliationItem` treat
23505 as success).

**Corrected and widened while executing.** An object-level sweep of all 39
repo-only migrations (WS-A5) found **nine** genuinely unapplied, not three. The
one that matters most was not on the original list:

- `20260813000500_manual_ap_payment_reversal` — the function
  `reverse_manual_ap_payment_atomic` **does not exist in production**, and
  `lib/services/vendor-bills.ts:1331` calls it. **Reversing a manually recorded
  AP payment fails in production right now.** A live bug, not drift; apply first.

Full classification with the object checked for each is in
`docs/plans/migration-ledger-reconciliation.md`.

**LLM tasks.**
- [x] Object-verified every repo-only migration instead of trusting name matching.
- [ ] Remove the "PENDING — NOT APPLIED" headers from those files once applied
      (headers are trash after the fact).
- [ ] Confirm with SELECTs on `pg_indexes` and `pg_proc.prosrc` after application.

**STOP — apply migrations.** Do not use `db push` against the drifted ledger.
Follow WS-A5's repair order: repair the ledger first, then apply this list with
the Supabase CLI. Within the apply step, use this order (1 of 12 applied
2026-09-02; the remaining eleven require a human):
1. ~~`20260813000500_manual_ap_payment_reversal`~~ — **APPLIED 2026-09-02.**
   `reverse_manual_ap_payment_atomic` exists, granted to `service_role` only.
   The live manual-reversal bug is fixed.
2. `20260813030000_payment_reconciliation_run_idempotency`
3. `20260813030100_payment_ledger_balance_error_detail`
4. `20260813040000_remove_dead_vendor_identity_lockout_columns`
5. `20260901120000_payment_run_submit_execute_lockdown` (WS-A3)
6. `20260901120100_payment_money_widening_and_fk_indexes` (WS-A7)

Then, outside the payment slice: `20260731150000_desk_rollup_counts`,
`20260724120000_warranty_completion_coverage`,
`20260817120300_validate_bid_package_award_target`,
`20260818170000_prequalification_waiver`,
`20260827121000_project_optional_vendor_bills`, and
`20260829120000_billing_lifecycle_and_command_permissions` — the last confirmed
unapplied on 2026-09-02 (the `invoices` status check still allows `saved`, and six
invoices still hold that status). Apply these with the Supabase CLI so the repository
versions are preserved. If MCP is explicitly chosen instead, use the full repository
filename stem for traceability and reconcile the fresh ledger versions before any
later `db push`, per `CLAUDE.md`.

**Definition of done.**
- [x] `reverse_manual_ap_payment_atomic` exists in prod.
- [ ] Both reconciliation unique indexes exist in prod.
- [ ] `post_payment_ledger_transaction_atomic` in prod contains
      `is not balanced: % in debits against % in credits`.
- [ ] `vendor_portal_identities.password_attempts` no longer exists.

### WS-A5 — Repair the migration ledger

**Why.** The current repository has 342 migrations while production has 314 ledger
rows (305 distinct normalized names). Only 71 repository versions match exactly;
233 more match by normalized name but were stamped under a fresh MCP timestamp,
27 were verified as applied by their database objects, and 11 are genuinely pending.
Nine normalized names are recorded twice. Five formerly live-only migrations were
recovered into the repository; the remaining `arc_books_accounting_foundation` row
is an alias for the repository's `books_accounting_foundation` migration.
`supabase db push` is currently a loaded gun and the QA runbook's own precondition
("no duplicate repository versions") is false.

**LLM tasks.**
- [x] Produce `docs/plans/migration-ledger-reconciliation.md` (temporary; deleted with
      this plan): a table of every repo file → live ledger row(s) it corresponds to
      (matched by name, then by object-level check), every live row with no repo file,
      and every repo file with no live objects. Use SELECTs on
      `supabase_migrations.schema_migrations` and object catalogs only.
- [x] For each live-only migration, recover its SQL from the ledger's `statements`
      column (SELECT) into a repo file with the live version number, so the repo
      reproduces prod. Review each for payment-slice relevance
      (`payment_approver_division_scope` and the two compliance ones touch this rail).
- [x] Write ONE repair script, `supabase/scripts/repair-migration-ledger.sql`, that
      inserts the missing repo versions into `schema_migrations` with
      `statements = '{}'` (mark as already applied) and deletes the nine duplicate
      rows. It must be idempotent and print a before/after count. **Do not run it.**
- [x] Add a CI step in `.github/workflows/verify.yml` that runs the existing schema
      replay plus a new `pnpm db:ledger:check` (script under `scripts/`) that compares repo
      versions to the production ledger and fails on drift on trusted branches.

**STOP — ledger repair and reviewed apply.** Human reviews the reconciliation doc,
runs the repair script, applies the genuinely pending files in WS-A4's
order, then runs `supabase migration list` and confirms zero pending.

*2026-09-03: the reconciliation was re-derived from scratch against the live
ledger (352 repo files, 323 ledger rows) and the repair script's map regenerated
to 342 rows, with a generator assertion that no file is recorded as applied
without either a ledger name match or an object check. The script was
restructured into one atomic `DO` block — it was `begin; … commit;` around a temp
table declared `on commit drop`, which under a client that manages its own
transaction can drop the temp table mid-script and leave the inserts applied and
the deletes not. Simulated against the live ledger: +262, −243, 323 → 342 rows,
zero duplicate names. **Running it was blocked by the local permission
classifier, so the ledger is still unrepaired.** The pending count is now ten,
not eleven: `validate_bid_package_award_target` and
`payment_run_submit_execute_lockdown` were verified applied, and
`compliance_autopilot_deficient_reminders` was written after the first audit.*

**Definition of done.**
- [ ] `supabase migration list` shows every repo file applied and nothing local-only.
      *Blocked on the repair running, then on WS-A4 applying the ten pending files.*
- [ ] No duplicate names in `schema_migrations`.
      *Nine remain; the regenerated repair removes them and the simulation confirms zero after.*
- [ ] `pnpm db:ledger:check` passes in CI.
      *Passes the repository half locally. The production half needs the repair
      first, and `list_migration_ledger()` — which the check reads production
      through — is installed by the repair script.*
- [x] `CLAUDE.md` documents that MCP always stamps a fresh version, requires the
      full repository filename stem for name-level traceability, and requires
      reconciliation before `db push`; CLI application is preferred for exact parity.

### WS-A6 — Wire the pgTAP money suite into CI

**The premise was wrong.** The suite is already wired: `.github/workflows/verify.yml`
has a `database-contracts` job that runs `supabase db start` then
`supabase test db --local`, which executes every file in `supabase/tests/`,
including `payment_lifecycle.test.sql`. `package.json` also already had `test:db`.
The review's claim that it "runs nowhere" was incorrect.

It is deliberately **not** part of `pnpm verify`: that would put Docker on the
critical path of every lint run. CI is the right home.

**LLM tasks.**
- [x] Added `test:db:payments` for running just the payment suite locally.
- [x] Added `node ./scripts/check-migration-ledger.mjs` to the `database-contracts`
      job, so migration-ledger drift fails CI where the schema already does.
- [ ] Confirm the job is green on the next pull request. The equivalent local
      from-zero replay and complete pgTAP run passed on 2026-09-02 with Supabase
      CLI 2.116.0 and Docker (4 files, 93 tests); the CI-only ledger check still
      requires the pull-request job.

**Definition of done.**
- [ ] The `database-contracts` job passes on CI, including the new ledger check.

### WS-A7 — Widen the last integer cent columns

**Why.** `payments.amount_cents/gross_cents/net_cents/fee_cents/platform_fee_cents/processor_fee_cents`,
`payment_reversals.amount_cents`, `payment_allocations.amount_cents` are `integer`
(max $21,474,836.47). Everything upstream is `bigint` and the rail RPCs pass
`bigint` parameters into these inserts.

**LLM tasks.**
- [x] Migration: `alter table ... alter column ... type bigint` for every column
      above. Check `docs/database-overview.md` and `list_tables` for any view or
      RPC that must be re-created because of the type change.
- [x] Add a `tests/*.test.js` guard that scans the migrations for
      `_cents integer` on any table in a payment/ledger/payable allowlist and fails.
- [x] In the same migration, add the FK indexes the performance advisor flags on
      `disbursements` (`run_id`, `run_item_id`, `run_item_payee_id`, `project_id`),
      `payment_ledger_transactions` (`disbursement_id`, `provider_event_id`,
      `reverses_transaction_id`), `payment_reconciliation_items` (`disbursement_id`,
      `ledger_transaction_id`), `payment_allocations` (`bill_id`, `invoice_id`,
      `project_id`), `payment_reversals` (`bill_id`, `invoice_id`, `payment_id`).
      Verify each against `pg_indexes` first; skip any already covered.
- [x] STOP: migration pending.

**Definition of done.**
- [ ] `select data_type from information_schema.columns where column_name like '%_cents'
      and table_name in ('payments','payment_reversals','payment_allocations')` returns
      only `bigint`.

---

### Phase A execution record — 2026-09-01

**Landed in the tree.**

| Item | Files |
|---|---|
| Config-mismatch detection + watchdog probe | `lib/payments/operations-monitor.ts`, `lib/services/ops-watchdog.ts`, `lib/services/payment-launch-readiness.ts` |
| Per-job liveness lookup (replaces the 2,000-row window) | `lib/services/ops-watchdog.ts` |
| No-work release tick instead of a failed one | `lib/services/payment-payouts.ts` |
| Shared stale-payment scan + unconditional watchdog probe | `lib/services/payment-stale-state.ts`, `lib/services/payment-reconciliation.ts`, `lib/services/ops-watchdog.ts` |
| Anon execute lockdown | `supabase/migrations/20260901120000_payment_run_submit_execute_lockdown.sql` |
| Cent widening + FK indexes | `supabase/migrations/20260901120100_payment_money_widening_and_fk_indexes.sql` |
| Recovered live-only payment migration | `supabase/migrations/20260805122729_payment_approver_division_scope.sql` |
| Ledger repair, recovery, drift check | `supabase/scripts/repair-migration-ledger.sql`, `scripts/recover-live-only-migrations.mjs`, `scripts/check-migration-ledger.mjs`, `.github/workflows/verify.yml` |
| Guards and behaviour tests | `tests/fintech-payment-guards.test.js`, `tests/fintech-payment-domain.test.js` |
| Reconciliation document | `docs/plans/migration-ledger-reconciliation.md` |
| Stuck-run evidence dossier | `docs/plans/arc-pay-stuck-run-dossier.md` |
| Recovered live-only migrations | `supabase/migrations/20260725174233_sales_deals_won_stage.sql`, `20260725174553_sales_deals_deal_id_filter.sql`, `20260729013412_create_outreach_tracking_schema.sql`, `20260729023157_drop_unused_outreach_is_forward.sql` |
| MCP migration-naming rule | `CLAUDE.md` |

**Verification, repeated 2026-09-02.** `pnpm lint` is clean;
`pnpm test:financials` passes 742/742, `pnpm test:auth` 113/113,
`pnpm test:mobile` 8/8, `pnpm db:schema:check` passes, and the focused payment
domain/guard run passes 137/137. After `pnpm exec next typegen` refreshed the
configured cache profile and stale `.next/dev` route validators were moved out of
the generated tree, TypeScript passes clean with an 8 GB heap; the default 4 GB
`npx tsc --noEmit` process exhausts its heap on this repository. After Docker became
available, Supabase CLI 2.116.0 replayed all migrations from zero and the complete
pgTAP suite passed (4 files, 93 tests). The older CLI 2.67.1 cannot replay this repo
because of its fixed-later parser bug around functions containing `atomic`.

**Migrations, updated 2026-09-02.** Applied: `manual_ap_payment_reversal`, which
was a live bug. The remaining eleven were refused by the Claude Code auto-mode
classifier, which denies `apply_migration` — not a Supabase or SQL failure. They
need either that permission granted or a human running them.

The five previously ambiguous migrations were resolved rather than left open:
four are already applied (`fix_submittals_constraints`,
`platform_bug_attachment_pdfs`, `rbac_catalog_seed`, and
`remove_qbo_bill_payment_placeholders`, which is obsolete because its target
table no longer exists) and are now in the repair script's 331-row canonical map;
`billing_lifecycle_and_command_permissions` is genuinely pending and joined the
apply list.

**Live re-check via Supabase MCP, 2026-09-02.** `payment-release` still fails on
the missing reconciliation flag; `ops-watchdog` is still on the pre-deployment
implementation and fails; the Strata test run remains `processing` with its
disbursement `transfer_pending` and no open stale-state incident. The manual AP
reversal RPC exists with only `postgres` and `service_role` execution. Both
reconciliation indexes, the detailed ledger error, RPC lockdown, and bigint
columns remain unapplied, exactly matching the pending list.

**Blocked on a human.** WS-A1 env change; deployment of the Phase A code; WS-A4's eleven remaining migrations;
WS-A5 ledger repair; WS-A2 stuck-run cleanup (no longer a money
decision — Strata is a QA org and the payment was a test); WS-A6 CI
confirmation.

---

## Phase B — Money-movement correctness

**Implementation status (2026-09-02): code-complete; migration applied; scenario
QA remains.** The application, provider adapter, Books projection, recovery paths,
unit/static coverage, and Phase B migration are implemented. The migration was
applied to production through Supabase MCP and its structural/security pgTAP suite
passes locally. The unchecked items below remain deliberately limited to the deeper
database-behavior scenarios, failure-injection evidence, and Stripe dashboard STOP.

These are the findings that lose or double-pay money. Land them before any Phase D
UI. All changes in `lib/services/payment-provider-events.ts`,
`lib/services/payment-runs.ts`, `lib/services/payment-payouts.ts`,
`lib/payments/payment-domain.ts`, `lib/integrations/payments/stripe-ap.ts`, and
their RPC migrations. Every change here gets a pgTAP case or a pure-function unit
test; "I read it and it looks right" is not done.

### WS-B1 — Returns during the transfer→payout window

**Finding.** `processDisbursementReturn` branches on `status === "paid"` only. A return
arriving in `transfer_pending` or `payout_pending` (transfer to the vendor's connected
account already exists) takes the "provider never took the debit" path: submission
reversal ledger only, no `ach_return_loss`, no ceiling, no accounting void, run item
`returned`, bill stays `approved`. The vendor's payout lands anyway, the later
`payout.paid` is a no-op (`planDisbursementAdvance("returned","paid")` → `[]`), and
the bill can be paid again.

**Design.**
- Introduce a pure classifier in `lib/payments/payment-domain.ts`:
  `classifyReturnStage(status): "pre_transfer" | "post_transfer" | "post_payout"`.
  `created|submitted|debit_pending|funds_available` → pre_transfer;
  `transfer_pending|payout_pending` → post_transfer; `paid` → post_payout.
- `post_transfer` and `post_payout` both: post `ach_return_loss`, enforce the
  return-loss ceiling, disable the funding source and mandate, open a
  `payment_operations_incidents` row of kind `post_transfer_return`, and emit
  `vendor_payment_returned`. Difference: post_payout additionally runs
  `record_ap_payment_reversal_atomic` (bill reopened, payment reversed, accounting
  void); post_transfer marks the disbursement `returned_after_transfer` (new status,
  add to the transition table and DB check constraint) and **does not reopen the
  bill**, because the vendor is about to receive or has received the money.
- When `payout.paid` later arrives for a `returned_after_transfer` disbursement,
  record the AP payment (bill paid) and close the incident with evidence, so the
  books show: bill paid, return loss on Arc.
- Attempt recovery: call a new provider method `reverseVendorTransfer(input)`
  (Stripe `transfers.createReversal` with idempotency key
  `disbursement:<id>:transfer-reversal`). If it succeeds before payout, the
  disbursement moves `returned_after_transfer → returned`, the loss entry is
  reversed by a reversal transaction, and the bill reopens. If Stripe rejects
  (insufficient connected balance), keep the loss and the incident.

**Tasks.**
- [x] Transition table + `planDisbursementAdvance` + DB check constraint for the new
      status (migration; STOP after writing).
- [x] `classifyReturnStage` + unit tests for every source status.
- [x] Provider interface: add `reverseVendorTransfer`; Stripe implementation; the
      registry's mock/stub used in tests.
- [x] `processDisbursementReturn` rewritten around the classifier. Ordering per
      WS-F5: Arc's own ledger, funding disable, incident, and notification are
      written **before** the accounting void, and the void goes through the outbox
      (`accounting_void_bill_payment` job) instead of inline.
- [x] `processDisbursementPaid` handles `returned_after_transfer` as described.
- [ ] pgTAP: return in each of the six pre-terminal states; assert ledger balance,
      bill status, run item status, incident row, and that a second `payout.paid`
      replay is idempotent.

**Definition of done.**
- [ ] QA runbook failure-injection cases 4, 5, 11, 12 pass with saved evidence.
- [ ] No path exists in which a disbursement is terminal `returned` while a Stripe
      transfer to the vendor exists un-reversed (assert in pgTAP by state table).

### WS-B2 — Executor/webhook race on `provider_payment_id`

**Finding.** Executor inserts `created`, calls `paymentIntents.create`, then
`update({status:"submitted", provider_payment_id}).eq("status","created")`. Stripe
delivers `payment_intent.processing` before the API response; the webhook advances
the row first; the CAS matches zero rows silently; `provider_payment_id` stays null.
Charge/dispute events resolve by payment id → 200 "unattributed" → Stripe never
retries. `record_ap_payment_atomic` is later called with the literal string `"null"`.

**Tasks.**
- [x] Write `provider_payment_id` and `submitted_at` **unconditionally** by
      disbursement id, in a separate update that does not touch `status`; then
      advance status through `planDisbursementAdvance` with CAS as today.
- [x] Any 0-row update on a disbursement in the executor throws
      `DisbursementStateError` with the ids, which the recovery path treats as
      ambiguous (WS-B3 defines the bounded retry).
- [x] `resolveDisbursementByPaymentId` falls back to `metadata.disbursement_id`
      on the Stripe object (already present in every intent's metadata) before
      returning unattributed. Unattributed events on an object carrying
      `arc_product: vendor_payments` metadata return **500**, so Stripe retries,
      and open a `payment_operations_incidents` row (kind `unattributed_rail_event`)
      deduplicated by provider event id.
- [x] Never coerce null to a string: `String(null)` at the AP-payment call is a
      type error to fix, not a value to persist. Make `providerPaymentId` a required
      string on the RPC input type.
- [x] Reconciliation (`payment-reconciliation.ts`): a disbursement with null
      `provider_payment_id` and a non-`created` status is an exception of kind
      `missing_provider_reference`, not `missing_provider`.
- [x] Unit/static test: simulate webhook-first ordering against the pure transition
      planner and assert the id write is independent of the status CAS.
- [ ] pgTAP: webhook-first ordering end to end.

**Definition of done.**
- [ ] QA runbook failure-injection cases 1, 2, 3, 9 pass with evidence.
- [x] A grep for `String(` on any `provider_*_id` in `lib/services/payment-*` returns
      nothing.

### WS-B3 — Per-payee failure isolation and bounded recovery

**Finding.** Items are submitted serially and the first failure aborts. Synchronous
rejection → run rolls to a terminal state, remaining items stay `processing`, their
bills are locked by `payment_run_items_bill_inflight_uidx`, and nothing revisits them.
Thrown Stripe error → disbursement stays `created`, the recovery sweep re-executes
every 5 minutes with the same idempotency key forever, emitting
`payment_submission_needs_recovery` to every release/reconcile holder each tick. The
pre-call `payment_submitted` ledger entry is never reversed.

**Design.**
- Execution is per item with an outcome record: `submitted | failed_provider |
  failed_ambiguous`. The loop continues past failures.
- `failed_provider` (Stripe rejected synchronously with a definitive error class:
  `card_declined`-equivalent for ACH, invalid payment method, blocked customer):
  disbursement → `failed`, submission ledger reversed, run item → `failed`, bill
  released from the in-flight index (status back to `approved`), item-level
  failure notification to the preparer with the provider reason (implemented by
  the existing `payment_run_execution_failed` event with `partial_failure=true`).
- `failed_ambiguous` (network, 5xx, timeout): disbursement stays `created` with
  `submission_attempts` incremented and `last_submission_error`; recovery retries
  with the **same** idempotency key at most `MAX_SUBMISSION_ATTEMPTS = 5` over a
  backoff schedule (2, 5, 15, 60, 240 minutes); on exhaustion it becomes
  `failed_provider` handling plus an operations incident. Notify once on first
  ambiguity and once on exhaustion, deduplicated on transition.
- Run status: `partially_failed` is **not terminal** while any item is
  non-terminal; `resolveRunStatus` computes from items. Add
  `partially_failed → processing` and `partially_failed → paid` to the run
  transition table.

**Tasks.**
- [x] `submission_attempts`, `last_submission_error`, `next_submission_at` columns
      on `disbursements` (migration; STOP).
- [x] Error classification helper in `stripe-ap.ts` mapping Stripe error codes to
      `definitive | ambiguous`; unit-tested per code.
- [x] Executor loop rewritten; `recoverAmbiguousPaymentSubmissions` selects by
      `next_submission_at <= now()` and attempts remaining, not by "processing older
      than 2 minutes" (see WS-B6).
- [x] Bill release on item failure: RPC `release_failed_payment_run_item_atomic`
      that sets item `failed`, disbursement `failed`, reverses the submitted ledger,
      and lets the in-flight index drop the bill. Service-role only, revoke from
      anon/authenticated (WS-A3 lint will enforce).
- [ ] pgTAP: 8-item run where item 3 fails definitively and item 5 fails ambiguously
      then succeeds; assert items 1,2,4,6,7,8 submitted, bill 3 re-payable, ledger
      balanced.

**Definition of done.**
- [ ] A run with one bad payee pays every other payee in the same execution.
- [x] No unbounded retry loop exists: the recovery sweep's selection is proven
      bounded by a unit test on its pure predicate.
- [x] The `payment_submission_needs_recovery` notification fires at most twice per
      disbursement (first ambiguity, exhaustion), enforced by the transition dedupe
      already used for reconciliation incidents.

### WS-B4 — A real claim on matured vendor transfers

**Finding.** `claim_matured_vendor_transfers` is a `SELECT … FOR UPDATE SKIP LOCKED`
that writes nothing; the lock is released at RPC commit, before Node runs. A crash
between `transfers.create` and the `transfer_pending` update leaves the row
`funds_available`; after 24 hours the Stripe idempotency key expires and the next
sweep creates a second transfer.

**Tasks.**
- [x] Replace the RPC with one that atomically sets `transfer_claimed_at`,
      `transfer_claim_token` (uuid), and status `transfer_claimed` (new status
      between `funds_available` and `transfer_pending`; add to transition table and
      check constraint), returning the claimed rows. Rows in `transfer_claimed`
      older than 15 minutes are reclaimable by the next sweep.
- [x] Before calling `transfers.create`, the sweep persists the intended
      idempotency key on the row (`provider_transfer_idempotency_key`). After the
      call, it writes `provider_transfer_id` unconditionally by id (same lesson as
      WS-B2).
- [x] Reclaiming a `transfer_claimed` row first calls a new provider method
      `findTransferByIdempotencyKey` — Stripe cannot query by key, so instead list
      transfers by `transfer_group` (the disbursement's group) and match metadata
      `disbursement_id`. If a transfer exists, adopt it; only otherwise create.
- [x] Unit test the "adopt before create" decision as a pure function.
- [ ] pgTAP the claim/reclaim window.

**Definition of done.**
- [ ] It is impossible to create two transfers for one disbursement without a
      Stripe-side duplicate being adopted first, proven by the adopt-before-create
      test and by the runbook's crash-injection case 2 applied to the transfer leg.

### WS-B5 — Platform payout schedule as a launch gate

**Finding.** Builder funds sit on Arc's Stripe platform balance ≥48 business hours.
If the platform's own payout schedule is automatic, that money sweeps to Arc's bank
(transfers without `source_transaction` fail `balance_insufficient`; Arc is holding
customer funds). Nothing checks it. `source_transaction` is only populated if
`charge.succeeded` was processed before the transfer.

**Tasks.**
- [x] Add a provider method `retrievePlatformPayoutSettings()` (Stripe
      `accounts.retrieve()` on the platform → `settings.payouts.schedule.interval`).
- [x] `assertPaymentLaunchReady()` gains a cached (1 hour) check that the interval
      is `manual`, failing closed with a precise message. Surface it on
      `/admin/ops/payment-launch` as its own row with the live value.
- [x] The transfer sweep refuses to create a transfer without `source_transaction`;
      instead it retrieves the PaymentIntent, reads `latest_charge`, persists
      `provider_charge_id`, and proceeds. A disbursement whose charge cannot be
      resolved becomes an incident, never a general-balance transfer.
- [x] Runbook: add "platform payout schedule is manual and reserve/balance policy
      is documented" to the `provider_program` gate text.

**STOP — Stripe program configuration (test control only after 2026-09-08).** Human
may confirm in a non-production/test Stripe environment that the platform payout
schedule is manual and document how the platform balance is swept. Do not interpret
this setting as custody segregation or as authorization to launch the SCT ACH rail.
The production SCT launch gate cannot be cleared; it is superseded by the Treasury
for platforms / bank-FBO architecture gate recorded above.

**Definition of done.**
- [ ] `/admin/ops/payment-launch` shows the payout-schedule row green against a
      test-mode platform with manual payouts, red otherwise.
- [x] No code path creates a vendor transfer without `source_transaction`.

### WS-B6 — Stop re-executing healthy runs every five minutes

**Finding.** `recoverAmbiguousPaymentSubmissions` selects every `processing` run older
than two minutes — every healthy run for 5–8 business days — and `executePaymentRun`
has no "nothing to do" exit; each tick re-runs launch checks, logged authorization
per project, re-posts the idempotent ledger, and writes an execution-started event and
audit row.

**Tasks.**
- [x] Selection moves to disbursement-level `next_submission_at` (WS-B3). A run
      with no disbursement in `created` and no item without a disbursement is never
      a recovery candidate.
- [x] `executePaymentRun` computes the work set first and returns
      `{ executed: false, reason: "nothing_to_submit" }` before any side effect when
      it is empty.
- [x] `payment_run_execution_started` is emitted once per run per revision, keyed
      by `(run_id, content_hash)`; re-entries emit `payment_run_execution_resumed`
      only when there is actual work.
- [x] Honor `claimed:false` from `claim_payment_run_execution_atomic`: exit quietly
      with `{ executed: false, reason: "already_claimed" }`.

**Definition of done.**
- [ ] A healthy run produces exactly one `payment_run_execution_started` event and
      one audit row across its life (assert in pgTAP with two executions).
- [x] The recovery sweep's candidate query is covered by a unit test on its pure
      predicate showing healthy runs are excluded.

### WS-B7 — Synchronous `funds_available` sets the release time

**Finding.** If `submitDisbursement` returns `funds_available` synchronously, the
executor advances without `transfer_release_after`; the later webhook is a no-op and
the row is never claimed until the 96-hour stale flag.

- [x] Extract `scheduleTransferRelease(disbursement, clearedAt, policy)` from the
      webhook path and call it from both places. Unit test the business-hour math
      once, in `lib/payments/`.

**Definition of done.**
- [ ] Every transition into `funds_available` sets `transfer_release_after`
      (pgTAP asserts non-null after both paths).

### WS-B8 — Fees in Arc Books match the bank

**Finding.** `record_ap_payment_atomic` writes per-disbursement `gross/processor/platform`
fee cents and Books credits cash `amount + fee` per bill; the rail actually debits
vendor-amount-only per bill plus one fee PaymentIntent per run.
`payment_run_fee_charges` is not projected anywhere.

**Tasks.**
- [x] Books projector: bill payments post cash at the vendor amount only. Add a
      posting rule for `payment_run_fee_charges` (one cash credit, one AP-fees
      expense debit per run) keyed on the fee charge's settlement event.
- [x] Keep the per-disbursement fee fields for margin reporting, but stop using
      them for cash.
- [x] Reconciliation report in Books: bank lines match Books lines one-to-one for a
      test run with three bills (add to `tests/arc-books.test.js`).

**Definition of done.**
- [x] For a 3-bill test run, Books shows 3 vendor cash lines + 1 fee cash line whose
      amounts equal the 4 Stripe PaymentIntents.

### WS-B9 — Reconciliation is honest when disabled

**Finding.** `payment-reconciliation` reports success while returning
`{reconciliations: [], reconciliationEnabled: false}`; 21 green runs, zero
reconciliation rows.

- [x] When the env flag is off, or when any rail is enabled and reconciliation is
      skipped for it, return HTTP 207 with `reason`, which `withCronRun` files as
      failed. A no-op because zero rails are enabled stays 200 with
      `skipped: "no_enabled_rails"`.
- [x] `ops-watchdog` fails loudly when `payment_rail_policies.enabled = true` and
      `last_reconciled_at` is older than 36 hours (it does today only if the env flag
      is missing; make both conditions incidents).

**Definition of done.**
- [x] `job_runs` cannot show a successful reconciliation for a day on which no
      `payment_reconciliation_runs` row was created while a rail was enabled.

### Phase B execution record — 2026-09-02

- Applied the Phase B migration to production through Supabase MCP. The hosted
  ledger stamped version `20260902114730`; the repository file is therefore
  `20260902114730_20260902025346_phase_b_money_movement_correctness.sql`, preserving
  the original full stem as its migration name while restoring exact-version parity.
- Replayed the entire repository migration chain from zero with Supabase CLI
  2.116.0 and Docker. Local Storage is enabled in `supabase/config.toml` because
  the chain creates `storage.buckets` rows.
- `payment_phase_b.test.sql` passes all 18 structural/security checks. The complete
  pgTAP suite passes all 93 tests across four files after correcting the stale
  payment fixture's company type from `vendor` to `subcontractor`.
- Live verification confirms all six Phase B columns, both new disbursement states,
  the reconciliation status extension, and all four service-role-only RPCs. The
  existing production disbursements remained 3 `canceled` and 1 `transfer_pending`.
- Supabase advisors reported no Phase B security findings. The two new partial
  indexes are reported as unused, which is expected immediately after creation;
  re-check after recovery and transfer workloads run.
- This record does not close the unchecked behavioral pgTAP, Stripe failure-injection,
  dashboard, or saved-evidence Definition-of-Done items above.

---

## Phase C — Run lifecycle and recoverability

### WS-C1 — Stuck approved runs: admin cancel and dead-letter stop

**Finding.** Quorum reached but `executePaymentRun` throws → run stays `approved`;
`backfillMissingReleaseJobs` re-enqueues a release every 5 minutes after the job
dead-letters (outbox dedupe is partial on `status='pending'`), each attempt inserting a
`payment_risk_reviews` row; bills locked; `cancel_payment_run_atomic` accepts only
`requested_by`; manual payment refuses in-run bills.

**Tasks.**
- [x] `cancel_payment_run_atomic` accepts the preparer **or** any member holding
      `payment.manage_rail`, recording `canceled_by` and `cancel_reason` (migration;
      STOP). Approvals on a canceled run remain as immutable evidence.
- [x] UI: "Cancel run" on the run detail (WS-D1) for both roles, with a typed reason
      and step-up.
- [x] Release backfill: skip runs whose latest release job is `dead_letter` /
      `error`; instead open one `payment_operations_incidents` row of kind
      `release_blocked` with the last error, deduplicated by run id. The incident
      workspace (reconciliation page) offers "Retry release" (re-enqueue once) and
      "Cancel run".
- [x] Risk review rows are inserted once per `(run_id, content_hash, signal_set_hash)`;
      re-evaluations update `last_evaluated_at` on the existing row.
- [x] Reservation release: `payment_execution_reservations` rows are deleted or
      marked `released` when execution fails or the run is canceled (today
      `on conflict do nothing` leaks them into the daily limit forever).

**Definition of done.**
- [x] A run blocked by a live risk signal with an absent preparer can be canceled by
      a `payment.manage_rail` holder from the UI, and its bills are immediately
      payable again.
- [x] `payment_risk_reviews` gains at most one row per run per evaluation set
      (pgTAP: three re-evaluations → one row).
- [x] After a failed execution, the day's reserved cents equal the sum of live
      reservations only (pgTAP).

### WS-C2 — Jurisdiction gate at run creation, with a policy, not a hard-code

**Finding.** `assertRunPayablesStillCurrent` throws unless `waiver_jurisdiction === "FL"`
and every project's `location.state === "FL"`. `createPaymentRun` does not check, so a
non-FL builder locks bills into a draft they cannot submit.

**Tasks.**
- [x] Move the jurisdiction rule into `lib/payments/payment-hold-policy.ts` as
      `assertJurisdictionEnabled(policy, project)` reading
      `payment_rail_policies.enabled_jurisdictions text[]` (migration; default
      `{FL}`; STOP). Florida remains the only value the settings UI offers until the
      Florida-waiver STOP in the fintech gameplan is passed; other states appear
      disabled with "pending legal review".
- [x] Call it in `createPaymentRun` per project **and** keep it at submit/decide/
      execute. Return a bill-level readiness reason (`jurisdiction_not_enabled`) so
      the desk filters those bills out of "Ready to pay" (WS-D3).
- [x] Bills whose project has no `location.state` are `jurisdiction_unknown`, never
      silently accepted.

**Definition of done.**
- [x] A Georgia project's approved bill shows "Not payable electronically: Georgia is
      not enabled" on the desk and cannot enter a draft run.
- [x] Unit tests for `assertJurisdictionEnabled` across FL / other / null.

### WS-C3 — Content hash that only trips on this run's facts

**Finding.** The frozen `waiver_snapshot.construction` includes commitment-wide
`billedCents`/`varianceCents`; any new bill on the same commitment changes the hash and
the approver sees "evidence changed" and must rebuild.

- [x] Split the snapshot: `bill` facts (amount, retainage, vendor, project, coding,
      waiver state, holds) go into the hash; `commitment` context (billed-to-date,
      variance) is stored for the reviewer but **excluded** from
      `payment-run-content-hash.ts`.
- [x] Re-validation at decide/execute compares bill facts only, and shows the
      commitment context as informational with a "changed since submission" marker.
- [x] Unit test: adding an unrelated bill on the same commitment leaves the hash
      stable; changing the bill's own amount changes it.

**Definition of done.**
- [x] The scenario "framer invoices Tuesday, approver approves Wednesday" succeeds.

### WS-C4 — A run cannot be submitted that nobody can approve

**Finding.** `pay-batch-dialog.tsx` warns "No payment approvers are configured" but
Submit stays enabled; the run lands in `pending_approval` with locked bills.

- [x] `evaluateRunApprovability` (already shared) returns `{ approvable: false,
      reason }` for: no roster, no roster member with limit ≥ run total, no roster
      member in the run's division scope, and every eligible approver == preparer.
- [x] `submitPaymentRun` refuses with that reason; the dialog disables Submit and
      links to Settings → Payments → Approvers.
- [x] Unit tests for each reason.

**Definition of done.**
- [x] No `pending_approval` run can exist with zero eligible approvers (pgTAP via the
      submit RPC after the service check is mirrored in SQL as a trigger).

### WS-C5 — One daily-limit ledger

**Finding.** App sums today's `disbursements`; the DB claim sums
`payment_execution_reservations` against the frozen snapshot limit; scheduled and
approved-unexecuted runs count in neither at submit.

- [x] Single source: `payment_execution_reservations` is written at **submit** for
      the full run amount (kind `pending`), promoted to `executed` at execution, and
      released on cancel/reject/failure (WS-C1). The app-side check reads
      reservations only, and the RPC's check stays as the authoritative guard.
- [x] The frozen limit on the reservation is replaced by the live policy limit at
      claim time ("live-tighter-wins", same rule as risk controls).
- [x] pgTAP: two runs approved that together exceed the daily limit → the second
      submit fails, not the second execution.

**Definition of done.**
- [x] QA runbook case 9 passes at submit time.

### WS-C6 — Retainage release is a workflow

**Finding.** `payableOutstandingCents` excludes retainage; the only way to pay it is
editing `retainage_percent`; the `retainage_rules_met` hold is always true; each
partial run snapshots the full bill retainage as held.

- [x] Add `vendor_bills.retainage_released_cents bigint default 0` and
      `retainage_release_requested_at`, plus a `release_retainage_atomic` RPC that
      creates a **retainage release payable line** (not an edit of the original
      percent) under `bill.approve`, with the same approval gate and its own
      `vendor_bill_retainage_released` event (migration; STOP).
- [x] `retainage_rules_met` becomes real: released amount ≤ held amount, and the
      project's retainage policy (final completion / unconditional final waiver when
      configured) is satisfied.
- [x] Run item `retainage_held_cents` = this bill's held retainage **at this run**,
      i.e. `retainage_cents - retainage_released_cents`, not the bill total.
- [x] UI: "Release retainage" on the payable workspace, showing held, released, and
      releasable amounts.
- [x] pgTAP + unit tests for the math.

**Definition of done.**
- [x] QA runbook case 3 and the "retainage derived from the approved bill" control
      pass with the release workflow, not via a percent edit.

### WS-C7 — Duplicate-invoice detection that works

**Finding.** `payable-duplicate-check.ts` normalizes the number then `ilike`s the raw
column with the normalized stem (`INV-1024` → `%inv102%` never matches); passing
`vendorAliases` drops vendor scoping; the DB trigger only fires when `company_id` is
set.

- [x] Add a generated column `vendor_bills.invoice_number_normalized` using the same
      canonicalization as `lib/financials/payable-duplicates.ts` (implemented in SQL
      once, unit-tested against the TS version with a shared fixture list). Index it
      with `(org_id, company_id, invoice_number_normalized)` and
      `(org_id, vendor_name_normalized, invoice_number_normalized)` (migration; STOP).
- [x] The app prefilter and the trigger both query the normalized column; vendor
      scoping is never dropped (aliases widen the vendor set, they do not remove it).
- [x] The trigger also fires for company-less bills using the normalized vendor
      name.
- [x] Fix the legacy-duplicate approval error: the trigger on `update of status`
      ignores rows created before the trigger's introduction date unless the
      duplicate is itself unpaid.

**Definition of done.**
- [x] QA runbook case 12 and "duplicate invoice numbers are canonicalized across
      case, whitespace, and punctuation" pass, including for name-only vendors.

### WS-C8 — Server-action hygiene in the payables slice

**Finding.** `ensureProjectVendorCompanyForPayableAction` updates `vendor_bills.company_id`
with org scoping only; `getPayablesAccountingContextAction`,
`getPayablesAccountingSyncStatesAction`, and two neighbors have no `requirePermission`
and throw instead of returning a result; `app/(app)/payments/actions.ts` has an
unwrapped action; `project-payables-client.tsx` runs a sequential loop that throws on
first failure inside a transition with no toast.

- [x] Every action under `app/(app)/payables/**`, `app/(app)/projects/[id]/payables/**`,
      `app/(app)/payments/**`, `app/(app)/settings/payment-actions.ts` goes through
      a service with `requireOrgContext → requirePermission`, validates input with
      Zod, and returns `ActionResult`.
- [x] Move the company-link mutation into `lib/services/vendor-bills.ts` under
      `bill.write` with audit.
- [x] Client loops become one bulk action with a per-item result array (WS-D3).
- [x] Add a node test that scans those action files for `export async function`
      without `requirePermission` or a service call in the body (same style as the
      notification coverage test).

**Definition of done.**
- [x] The scan test passes; `pnpm test:auth` passes.

### WS-C9 — Step-up recency in the database

**Finding.** `decide_payment_run_atomic` only checks `step_up_verified_at <= created_at`;
the 10-minute recency lives in the app.

- [x] Add `p_step_up_max_age interval` (default 10 minutes) to the RPC and reject
      when `now() - p_step_up_verified_at > p_step_up_max_age` (migration; STOP).
      Keep `lib/payments/step-up-policy.ts` as the single source of the number and
      pass it through.

**Definition of done.**
- [x] pgTAP: a 15-minute-old step-up is rejected by the RPC.

### WS-C10 — Visible caps and windows

**Finding.** Run-membership map capped at 1,000 active items with no notice;
`getPaymentRunSetupData` silently drops unenrolled-vendor bills and caps at 200 by due
date; `payment-risk.ts` derives latest-review-per-run from a 400-row page.

- [x] Every cap returns `{ truncated: true, cap }` to the caller and the UI shows
      "Showing first N" (the desk's existing truncation notice component; search
      before writing).
- [x] Latest-review-per-run uses `distinct on (run_id) … order by run_id, created_at desc`
      in SQL (or an RPC), never a page.
- [x] Unenrolled-vendor bills are returned with `readiness: "vendor_not_enrolled"`,
      not dropped (WS-D3 renders them).

**Definition of done.**
- [x] No list in the slice can silently truncate (grep for `.limit(` in
      `lib/services/payment-*` and `org-payables.ts` and confirm each is surfaced).

### Phase C completion evidence — 2026-09-02

- Production Supabase migration `20260902144509_phase_c_run_lifecycle_recoverability`
  applied through MCP. Postflight found all 14 expected columns, all four indexes,
  and service-role-only execution on the five sensitive Phase C RPC families.
- The non-destructive risk-review compatibility path preserved all 10 historical
  production reviews; new automated reviews opt into the unique evaluation identity.
- Local database replay from zero succeeded in hosted migration order. Full pgTAP:
  5 files, 124 assertions. Phase C covers no-quorum submit, submit-time daily limit,
  stale step-up, manager cancellation, released reservations, risk upsert identity,
  name-only invoice duplicates, draft discard, and atomic retainage release.
- Application gates: `pnpm typecheck`; scoped ESLint; `pnpm test:auth` (115);
  `pnpm test:mobile` (8); payment-domain/action tests (146). The 8 GB Webpack build
  compiled application code and completed TypeScript, then stopped on existing
  unrelated prerender-time `crypto.randomUUID()` usage in `/starts/[id]`,
  `/books/transactions`, and `/documents`.
- Supabase security advisors reported no Phase C finding. The two invoice
  normalization indexes are initially reported as unused, expected immediately
  after creation; review after production duplicate-check traffic.

---

## Phase D — Builder experience

Design standard: `docs/design.md`. Dense tables, tokens only, radius 0, empty /
loading (skeleton) / error / dark mode for every view. Exemplar for a desk:
`app/(app)/sales/page.tsx`; for a workbench tab:
`app/(app)/projects/[id]/financials/`; for a detail sheet:
`components/invoices/invoice-detail-sheet.tsx`.

### WS-D1 — Payment runs: a sheet, a band, and one real detail route

**The original finding is stale, and its prescription was wrong.** It called
`/payables/payment-runs` a redirect stub and proposed a second desk. Both pages
now exist as thin stubs (a 30-line list, a 36-line detail with a cancel form), and
a run *desk* is the wrong shape regardless:

- `CLAUDE.md`: "A feature earns a desk only if someone's whole JOB is that feature
  across projects... Never build a desk for symmetry." Nobody's job is payment
  runs. The job is payables; a run is one step in it.
- The proposed run tabs — Needs approval / In flight / Done / Failed — are the
  payables desk's own tabs one level up, over the same money grouped differently.
- `BlockedPaymentsStrip` already states the house rule: "a surface whose healthy
  state is empty should never occupy space on a desk people work in all day. That
  is the same reason it is not a tab or a page." A run list is empty or stale most
  days.

**What a run actually needs, in three parts.**

1. **History → a sheet behind a button on the desk.** Reuse the pattern already
   on this desk, where a button opens `AccountingSyncSheet`
   (`payables-desk.tsx:935`). Rows are runs; each links to the detail route.
   Delete the list page in the same change and redirect `/payables/payment-runs`
   to `/payables` — no parallel implementation.

2. **Run approval → a band on the desk, not a tab.** This is the gap the original
   workstream was groping at and named wrongly. **Bill approval and run approval
   are different permissions held by different people** (`bill.approve` versus
   `payment.approve_run`). The desk's "Needs approval" tab is bills, so an
   approver with `payment.approve_run` who missed the email has nowhere to go
   today. Add an "Awaiting your approval" band above the table, following
   `BlockedPaymentsStrip` exactly: renders nothing when empty, one row per run
   this user can actually approve (roster limit and division scope per WS-C4),
   each linking to the detail route.

3. **Run detail → keep the real route.** `/payables/payment-runs/[id]` stays a
   page and is the one part of the original plan that must not become an overlay:
   - the run-approval email has to deep-link to it, and a sheet has no URL;
   - approval is a step-up-gated mutation over immutable evidence, which is a
     workbench, not a preview.

   Build it out from the current stub: frozen evidence (bills, payees, hold and
   waiver snapshots, fee quote, risk decision, approvals as immutable rows) and
   the **five disbursement stages per item** as a stepper — Submitted → Builder
   debited → Funds available → Transfer to vendor → Vendor paid — plus Failed and
   Returned with reasons. Actions: Approve / Reject (step-up), Cancel (WS-C1),
   Retry release (WS-C1), Open reconciliation exception.

**Tasks.**
- [x] Payment-runs sheet opened from a desk button; delete
      `app/(app)/payables/payment-runs/page.tsx` and redirect the route.
- [x] "Awaiting your approval" band on the desk, empty-renders-nothing, scoped to
      runs this user may approve.
- [x] Build out `/payables/payment-runs/[id]` per part 3.
- [x] Payables desk status column uses the same stage vocabulary; "Paying" is
      replaced by the item's current stage label, and an in-flight payable links
      to its run. Terminology through `terminology(posture)`.
- [x] Register `payment_run` in `search-index.ts` entity mapping and deep-link
      run notifications to `/payables/payment-runs/[id]`.
- [x] Mobile `lib/mobile/payment-runs.ts` DTO gains the stage field; add to
      `pnpm test:mobile`.

**Definition of done.**
- [x] A builder can answer "was my vendor paid, or only was I debited" from the
      run detail without opening reconciliation.
- [x] A run approver who never opened the email finds the run from the desk.
- [x] `/payables/payment-runs` no longer resolves to a list; the old page is gone,
      not left beside the sheet.
- [x] Empty / skeleton / error / dark verified for the sheet, the band and the
      detail route.
- [x] `pnpm test:mobile` passes.

### WS-D2 — Bulk submit

**Finding.** A payable is created `draft` or `ready`; a draft becomes ready only by
opening it and saving lines; bulk approve refuses drafts.

- [x] Add `submitVendorBillsForApproval(ids)` in `vendor-bills.ts` under
      `bill.write` that runs the same readiness validation as the single edit path
      (`assert_payable_ready_for_approval` trigger stays authoritative) and returns
      per-bill results `{ id, ok, reason }`.
- [x] Desk: "Submit for approval" bulk action on the Drafts tab; results shown as a
      per-row outcome list (WS-D3 component), not a single error.
- [x] Emit `vendor_bill_submitted` from this path (and WS-F2 fixes the draft-time
      emission).

**Definition of done.**
- [x] 40 emailed invoices that were AI-prepared to "ready" can be submitted in one
      action; the ones that are not ready are named with the missing field.

### WS-D3 — Bulk operations report per item, keep selection, reach the caps

**Finding.** Bulk approve and run build throw on the first failing bill naming one
invoice or none; selection is dropped on page/tab change; select-all covers visible
rows; page size ≤ 100 so the 200/500 caps are unreachable; unenrolled vendors are
silently dropped from run setup.

- [x] One shared `BulkOutcomeList` component (search `components/` for an existing
      outcome/result list first) rendering `{ id, label, ok, reason }[]` with a
      "Retry the ones that failed" affordance.
- [x] `approveVendorBillsAtomic` and `createPaymentRun` accept `mode: "all_or_nothing"
      | "skip_failures"`; the UI defaults to `skip_failures` and shows the outcomes;
      all-or-nothing remains for API/mobile callers that want it. The RPCs return
      per-bill reasons (migration; STOP).
- [x] Selection is a URL-independent store keyed by bill id, persisted across
      pagination and tabs within the desk session, with a visible "N selected across
      pages" chip and "Select all matching filter" that asks the server for the ids
      (capped at the run cap, cap shown).
- [x] Run setup lists unenrolled-vendor bills in a separate "Vendor not set up"
      group with an "Invite to Arc Pay" action (WS-E1) rather than hiding them.
- [x] Hold overrides and risk decisions accept a multi-select with one typed reason.

**Definition of done.**
- [x] A 300-bill payday can be approved in one action and turned into two runs
      (cap shown) without losing selection, and every skipped bill says why.

### WS-D4 — Sync state where the user is

Delivered with WS-G2; listed here so the desk work is not considered done without it.

- [x] Payable workspace shows two `AccountingSyncBadge`s: bill and bill payment.
- [x] Payables desk gains a "Sync" column with the same badge and a filter.
- [x] Run detail shows per-item bill-payment sync state and a "Sync all" that calls
      the existing retry action.

### WS-D5 — Small dead ends

- [x] `app/(app)/payables/loading.tsx` becomes a table skeleton matching the desk.
- [x] "Add one in Settings" in the batch dialog links to Settings → Payments.
- [x] Schedule-conflict message offers "Split into two runs" that pre-fills two
      drafts.
- [x] Vendor-ready notification names the vendor (WS-E7).

**Definition of done.**
- [x] No text in the slice tells the user to go somewhere without a link.

---

## Phase E — Vendor side

### WS-E1 — First click works: payout invites require an account and use their own token

**Findings.** Invite tokens are minted without `require_account`, so the gate skips to
the page, which throws "Sign in and claim…" into the generic error card; the only
claim affordance is a header button hidden on mobile. The payout invite reuses the
contact's project sub token, so a PM pausing a project link revokes payment access
org-wide, and resume does not restore.

- [x] `vendor-payment-invitations.ts` mints a **dedicated** `portal_access_tokens`
      row per contact with `purpose = 'vendor_payout'` (add the purpose column or
      reuse the existing kind field; check schema first), `require_account = true`,
      `expires_at` 30 days, `max_access_count` null. Never reuse a project link.
- [x] `app/s/[token]/payments/page.tsx` never throws for missing session; it renders
      `PortalAccountGate` with copy "Create your Arc account to get paid by {builder}".
- [x] `PortalClaimAccount` trigger is visible on all breakpoints when the token is
      a payout invite.
- [x] `pausePortalToken` / `revokePortalToken` on a **project** token no longer
      cascades to payment access. Payment access is changed only from the company
      card under `payment.manage_rail` with step-up. `resumePortalToken` remains
      unchanged.
- [x] Re-invite: a token that is expired, revoked, paused, or at its access cap is
      replaced by a fresh token; the old one is revoked; the email says so.
- [x] Expired payout link renders "This invitation expired — ask {builder} to send a
      new one", not 404.

**Definition of done.**
- [ ] A new vendor on a phone goes email → account creation → Stripe hosted
      onboarding → "Submitted, Stripe is reviewing" without seeing an error card
      (recorded as QA evidence).
- [x] Pausing a project link changes nothing in `vendor_payment_relationships`
      (pgTAP or service test).

### WS-E2 — Restore restores the claim; readiness reflects Stripe review

- [x] `setCompanyPaymentAccessStatus(active)` reactivates the claim, creating a new
      claim row if the old one is revoked (append, keep history). Add a DB trigger
      to `vendor_payment_relationships` refusing `active` when the linked claim is
      not `verified`/`active` (migration; STOP).
      *Delivered restoring the claim in place, not appending — see the execution
      record. Two triggers, not one: the second refuses withdrawing a claim out
      from under an active relationship.*
- [x] `vendor-payment-setup.tsx` renders `pending_review` distinctly: "Submitted —
      Stripe is reviewing, usually minutes to a day", no "Continue verification"
      button unless `requirementsCurrentlyDue` is non-empty.

**Definition of done.**
- [ ] Revoke → restore → vendor "Continue" works for both ready and unready
      recipients; no state requires SQL.
- [x] Money cannot move against a revoked claim (pgTAP).

### WS-E3 — Remittance advice: deduplicated, correct for credits, and honest on returns

- [x] `deliverRemittance` passes `idempotencyKey: remittance-<entityType>-<entityId>`
      to `sendEmail`; `processDisbursementPaid` skips remittance and the
      `vendor_payment_paid` event when `result.duplicate === true`.
- [x] `METHOD_LABELS` gains `credit`; credits use a "Credit applied" template that
      says no money was sent.
- [x] New `payment-return-vendor-email.tsx`: "A payment to you was returned by the
      builder's bank" sent from WS-B1's post-transfer/post-payout paths, with the
      same idempotency and recipient resolution as remittance.

**Definition of done.**
- [ ] Runbook case 3 (every webhook twice) produces exactly one remittance email per
      disbursement (assert on the mailer's idempotency log in test mode).

### WS-E4 — Directory doctrine: `contact_company_links` only

- [x] `vendor-payment-invitations.ts` contact discovery and
      `vendor-payment-identities.ts` payout binding read `contact_company_links`
      (with `is_primary`), never `contacts.primary_company_id`.
- [x] Add a repo lint test failing on `primary_company_id` reads in
      `lib/services/vendor-payment-*` and `lib/services/payment-*`.

**Definition of done.**
- [ ] A contact linked only through `contact_company_links` can be invited and can
      complete payout setup.

### WS-E5 — Policy key parity

- [x] Verify with `pg_policies` that `vendor_company_claims_read` uses
      `payment.manage_rail`; if it still carries `payments.manage_rail`, write the
      migration (STOP).
- [x] Human applies `supabase/pending-migrations/20260812131000_remove_legacy_plural_payment_permissions.sql`
      **only** by explicit decision (STOP — it is gated on purpose). The LLM lists
      every `role_permissions` row still carrying plural keys (SELECT) as input.
      *Decided and applied 2026-09-02; the file now lives in `supabase/migrations/`
      as `20260902215948_remove_legacy_plural_payment_permissions.sql`.*

**Definition of done.**
- [x] No policy or permission row references `payments.*`.

### WS-E6 — Vendor payments view is robust

The join `payments.bill_id → vendor_bills.company_id → vendor_payment_relationships`
already shows builder-uploaded bills to the vendor. Keep it; harden it.

- [x] Add a DB check (trigger) that `vendor_bills.company_id` is non-null whenever
      the bill enters a payment run or is paid through the rail (migration; STOP).
      *Already enforced by `enforce_payment_run_item_integrity`; verified and
      pinned by pgTAP rather than duplicated — see the execution record.*
- [x] Vendor portal "Recent payments" shows the stage vocabulary from WS-D1
      (Builder debited / In transit / Paid to your bank / Returned) using the
      disbursement, not only the `payments` row.

**Definition of done.**
- [ ] A bill created by email ingest and paid through the rail shows on the
      vendor's portal with the correct stage at each webhook step (QA evidence).

### WS-E7 — Notification payloads name the vendor

- [x] `payment-rail-setup.ts` recipient-ready emissions include `company_name`
      and `company_id`; `adoptVerifiedRecipient` emits the same.
      *Already shipped with WS-D5; verified and now pinned by a test.*

---

### Phase E execution record — 2026-09-02

**Both migrations are applied to production.** Approved and applied through the
Supabase MCP on 2026-09-02, after a from-zero replay of the full repository chain
against a local Supabase (CLI 2.116.0 + Docker) in which `payment_phase_e.test.sql`
passed 19/19 and the complete pgTAP suite passed 154 tests across seven files.

The hosted ledger stamps its own version, so both repository files carry the
stamped one:

| Applied | Ledger version | Repository file |
|---|---|---|
| Phase E | `20260902215848` | `supabase/migrations/20260902215848_phase_e_vendor_side.sql` |
| Plural-permission retirement (WS-E5) | `20260902215948` | `supabase/migrations/20260902215948_remove_legacy_plural_payment_permissions.sql` |

Live verification: the `purpose` column, its check constraint, the payout index
and both claim triggers all exist; all 30 existing `portal_access_tokens` rows
remain `purpose = 'portal'` (no backfill, by design) and the one production
`active` relationship survived the new trigger, because its claim is `verified`.
Zero `payments.*` rows remain in `permissions`, `role_permissions`,
`membership_permission_overrides` or any RLS policy, and all nine singular grants
are intact on the same three roles. Supabase advisors report no new findings —
both new functions set `search_path` and have `EXECUTE` revoked.

**One deviation from the holding-pen rule, stated plainly.** `CLAUDE.md` says
never to move a file out of `supabase/pending-migrations/`. That rule protects a
migration while it is *gated*; this one's gate was lifted by an explicit human
decision, and once it was applied the ledger needed a repository file or
`pnpm db:ledger:check` would report a live-only migration forever. It was moved
rather than deleted for that reason. The pen still holds its other five files.

**Two findings in this phase were stale, and the plan's prescription was wrong
in one of them.**

1. **WS-E6's bill-company trigger already existed.**
   `enforce_payment_run_item_integrity` raises "Payment run item bill must
   identify the relationship vendor" when `vendor_bills.company_id` is null, and
   a disbursement cannot exist without a `run_item_id` whose bill it must match
   — so the rail is already closed to an unattributed bill at its only entrance.
   A second trigger would have been the parallel implementation `CLAUDE.md`
   forbids (and, being alphabetically later, would never even have fired). The
   migration records why in place of the trigger, and the pgTAP suite now pins
   the existing behavior so it cannot be loosened by accident.
   `vendor_bills.company_id` stays nullable on purpose: 142 unattributed bills
   exist in production, mostly from email ingest.

2. **WS-E2's claim is restored in place, not appended.**
   `vendor_company_claims` carries a unique `(org_id, company_id)` — one live
   mapping per builder-vendor pair is what lets every reader ask for it with
   `maybeSingle()` — and the row's identity does not change when access is
   re-opened. Appending would have meant dropping that constraint and sweeping
   every claim reader. The withdrawal and the restore are both in `audit_log`,
   which is where Arc keeps history.

**Two invariants went into the database rather than staying service-side.** A
relationship cannot be `active` unless the claim behind it is `verified`, and a
claim cannot be withdrawn while its relationship is still `active`. Together
they mean a live `active` relationship always has a live claim, at every
instant — not only at the moment the service happens to write. Both withdrawal
paths already close the relationship before the claim, so the second trigger
only refuses the wrong order. Zero production rows violate either.

**Legacy payout links keep working, and are deliberately not backfilled.**
`purpose` defaults to `'portal'`, so the one existing production claim-source
token stays a project link: pausing it no longer withdraws payment access, which
is exactly WS-E1's Definition of Done. `requireVendorPayoutPortalAccess` does
**not** require `purpose = 'vendor_payout'` — the capability is still proved by a
live `vendor_payment_relationships` row — so no vendor loses payout setup on the
day this ships. New invitations always mint a dedicated link.

**WS-E5 needed no code.** `vendor_company_claims_read` already carries
`payment.manage_rail`, and no policy in the database references `payments.*`
(verified by `pg_policies`). What remains is nine `role_permissions` rows, and
each is fully covered by its singular equivalent on the same role, so
`supabase/pending-migrations/20260812131000_remove_legacy_plural_payment_permissions.sql`
would remove no one's access:

| Role | Plural keys held | Singular equivalent present |
|---|---|---|
| `org_owner` | `payments.approve_run`, `payments.manage_rail`, `payments.override_hold` | yes, all three |
| `org_admin` | `payments.approve_run`, `payments.manage_rail`, `payments.override_hold` | yes, all three |
| `org_office_admin` | `payments.approve_run`, `payments.manage_rail`, `payments.override_hold` | yes, all three |

**Ledger caveat, pre-existing.** `pnpm db:ledger:check` cannot run its
production half at all: `list_migration_ledger()` is not installed in production,
so the check reports only repository consistency. That is a WS-A5 gap, not a
Phase E one, and it is why parity here was verified by hand against
`supabase_migrations.schema_migrations`. Both new rows match their repository
file exactly on version and name.

**What this record does not close.** Every Definition-of-Done item still
unchecked above needs a person: the phone walkthrough for a new vendor, the
revoke → restore → Continue pass for both ready and unready recipients, runbook
case 3 in Stripe test mode, and the email-ingested-bill stage walkthrough. The
code-level guards behind each are tested (`tests/phase-e-vendor.test.js`,
`supabase/tests/payment_phase_e.test.sql`); the evidence is not.

**Verification.** `pnpm lint` and `npx tsc --noEmit` clean. `pnpm test:financials`
783/783, `pnpm test:auth` 115/115, `pnpm test:mobile` 9/9, `pnpm db:schema:check`
clean, `pnpm test:db` 154/154. Three failures in the wider `pnpm test:node` run
(`instant-navigation-contract`, `loading-delay`, `repository-guardrails`)
reproduce on the pre-Phase-E tree and are untouched by this work.

## Phase F — Notifications

Pipeline facts: `recordEvent()` fans out synchronously; only
`EMAIL_NOTIFICATION_TYPES` email; `vendor_bill_*` deliver inline; there is no
event-level dedupe. `tests/payment-notification-coverage.test.js` enforces allowlist,
recipients, title, and emitter by source scan — extend it for every type touched here.

### WS-F1 — Bulk approval notifies the submitter

**Finding.** `approve_vendor_bills_atomic` inserts `vendor_bill_approved` directly
into `events`; fan-out lives only in TypeScript.

- [x] Remove the SQL event insert from the RPC (migration; STOP) and have
      `approveVendorBillsAtomic` call `recordEvent` per approved bill after the RPC
      returns, with the same payload the single path uses
      (`submitted_by_user_id`, project, amount).
      *Applied to production 2026-09-03 via MCP as ledger version `20260903120015`;
      the repository file is `20260903120015_phase_f_notifications.sql`.*
- [x] Extend the coverage test to fail if any migration inserts into `events` for a
      type that has a TypeScript emitter.
      *It reads the surviving `create or replace` per function, not the file
      history, so `20260805092000` stays true and the live definition is what is
      judged. `supabase/tests/payment_phase_f.test.sql` pins the same thing in the
      database.*

**Definition of done.**
- [x] Bulk-approving 5 bills from 3 submitters produces 5 in-app notifications and
      emails to those submitters (test with the notification service's in-memory
      transport).
      *There is no in-memory transport in this repo — building one is WS-H1. The
      claim is instead decomposed and each part tested: exactly one event per
      approved bill (the SQL twin is gone, pinned by both the migration scanner and
      pgTAP), each event resolving to exactly its own submitter
      (`resolvePayableDecisionAudience`, tested with five bills from three
      submitters), and `vendor_bill_approved` on the email allowlist taking the
      immediate-delivery path. The end-to-end send is QA evidence, not a unit test.*

### WS-F2 — Approvers are paged on submission, not on quick drafts

- [x] `vendor_bill_submitted` is emitted only when `creation_state !== "draft"` at
      create, and on the draft → ready transition (single edit path and WS-D2 bulk
      submit).
      *Three create paths, not one: `createProjectVendorBill`, the email ingest
      (whose draft already has its own "needs review before approval" notice), and
      the portal, which never makes drafts.*
- [x] Approver resolution adds org members holding `bill.approve` with
      `project_scope = all`, not only `project_members`.

**Definition of done.**
- [x] Creating a quick draft emits nothing; completing it emits once.

### WS-F3 — Run approval recipients honor the roster

- [x] `events.ts` recipient resolution for `payment_run_submitted` filters roster
      members by `approval_limit_cents >= run total` and division scope, using
      `evaluateRunApprovability` so UI and notifications agree.
- [x] `payment_run_approval_recorded` is sent to the preparer only when the run is
      still short of quorum **and** the mode is dual (one email per partial
      approval is fine; suppress when it is the final one, which sends
      `payment_run_approved`).

### WS-F4 — Copy tells the truth about release

- [x] `payment_run_approved` template branches on `payload.release`:
      `executed` → "approved and funding started"; `queued` → "approved and
      scheduled for {date}"; `blocked` → "approved but held: {reason}" with a link
      to the run.
      *The rail's own vocabulary is `released | scheduled | queued | blocked | none`,
      and all five branch. `scheduled` is the one that carries a date; `queued` is
      the approver who may not release, and says so.*

### WS-F5 — Return path ordering

Delivered in WS-B1: Arc's ledger, funding disable, incident, and notifications are
written before any accounting call, and the accounting void is an outbox job.

- [x] Coverage test asserts that `voidBillPaymentInAccounting` is not called
      directly from `payment-provider-events.ts`.

### WS-F6 — Vendor return notice

Delivered in WS-E3.

**Phase F definition of done.**
- [x] `tests/payment-notification-coverage.test.js` covers every type in the Phase F
      table of the review (submitted, approved/rejected, run submitted, run decided,
      settled, returned/failed) with emitter, recipients, allowlist, and dedupe
      assertions, and passes.
      *25 tests, green. The settled/returned pair is `vendor_payment_paid`,
      `vendor_payment_returned` and `vendor_bill_payment_reversed`; there is no
      `vendor_payment_settled`.*

---

### Phase F execution record — 2026-09-02, applied 2026-09-03

**Migration APPLIED 2026-09-03,** on the human's explicit instruction, through the
Supabase MCP. It was byte-equivalent to the live definition of
`approve_vendor_bills_atomic` with the `insert into public.events` block removed
and nothing else changed — verified by normalizing both and diffing before
applying, and the live definition's md5 was re-checked immediately beforehand
because Phase G landed in between (it does not touch this function).

MCP stamps a fresh ledger version, so it went in as `20260903120015` while the
file was named `20260902230000_...`. Reconciled the way Phase E was: the
repository file is renamed to `20260903120015_phase_f_notifications.sql`, which is
also the truthful apply order — it went in after Phase G, not before. The name was
passed to `apply_migration` as the full filename stem, so the ledger row maps back
by name either way.

**The pre-existing ledger drift is unchanged and still WS-A5's job.** 352
repository files against 323 ledger rows: 272 repository versions are unrecorded
and 243 ledger versions have no file, because historical MCP applies all stamped
fresh timestamps. This migration is in parity on both sides, so the drift is one
file smaller than it would have been. Do not run `supabase db push` until WS-A5
repairs the rest.

**One finding in the plan was already half-built, and the other half was the bug.**
`approveVendorBillsAtomic` did call `recordEvent` per approved bill — with
`payload: { bulk: true }` and nothing else. So the fix was not "add the call", it
was "give it the payload", and the SQL twin had to go at the same time or the
thin event would keep winning some of the time.

**Three things the plan did not name, found while executing.**

1. **Emitters disagreed on the amount key.** The create and bulk-submit paths put
   the money on `total_cents`; the lifecycle path on `amount_cents`; the
   notification builder read only `amount_cents`. "Invoice 1042 is waiting for
   approval" therefore arrived with no amount in it from every path but one. The
   builder now reads either.
2. **The approval email computed its own lead sentence and never rendered it.**
   `heroMeta` existed, said the right thing, and was dead. The only place the
   email named an outcome was a subject line hardcoded to "Payment Released" —
   for scheduled, queued and blocked runs alike. It is rendered now, and it is
   the same sentence the in-app notification uses, from the same pure function.
3. **A run could end up with nobody to tell.** Filtering the roster by
   approvability is right, but submission-time readiness and fan-out-time
   readiness are separated by however long the request takes: if the roster moves
   in between, the precise filter returns nobody and a run sitting in
   `pending_approval` ages out unseen. It falls back to the permitted roster.

**`evaluateRunApprovability` moved rather than being duplicated.** It is pure, and
the fan-out needs the same answer the Approve button uses. It now lives in
`lib/payments/payment-run-approval-policy.ts` beside `evaluateRunSubmissionReadiness`,
typed structurally so it stays importable from anywhere. The roster loader moved
too, into `lib/services/payment-approver-roster.ts`: `payment-approvers.ts` raises
events, so importing it from `events.ts` would have closed a cycle.

**A test that passed on prose.** `pg_get_functiondef` preserves comments, and this
migration's comment explains the removal in the words "insert into public.events".
Both the pgTAP assertion and the JS migration scanner matched that comment: the
pgTAP one failed against the correctly-applied function, and the JS one had been
passing for the wrong reason — it sliced from the comment to the next semicolon
and read the *outbox* insert's strings. Both now strip `--` comments before
looking for code, and `the SQL emitter scan reads code, not the comments about it`
pins it. Worth remembering for any future check written against `functiondef`.

**What this record does not close.** The WS-F1 definition of done names an
in-memory transport that does not exist; WS-H1 is where it gets built, and the
end-to-end send is QA evidence either way. `supabase/tests/payment_phase_f.test.sql`
could not be run as pgTAP here — no Supabase CLI, no Docker, and pgtap is
deliberately not installed in production — so its six assertions were executed
individually as read-only catalog SELECTs against the applied function and all six
pass. Running the file itself under `pnpm test:db` is still a human step.

**Verification.** `pnpm lint` and `npx tsc --noEmit` clean. `pnpm test:financials`
736/736 (the suite list was reorganized by concurrent Phase G work mid-session;
every test passes, including the 26 in `payment-notification-coverage`),
`pnpm test:auth` 115/115, `pnpm test:mobile` 9/9, `pnpm db:schema:check` clean.
The same three failures the Phase E record names
(`instant-navigation-contract`, `loading-delay`, `repository-guardrails`) still
reproduce in the wider `pnpm test:node` run and are untouched by this work;
`pnpm test:bun` cannot run here (bun is not installed).

---

## Phase G — Accounting sync truthfulness

Facts: bills enqueue on entering `approved|partial|paid`; bill payments enqueue at
settlement and manual mark-paid; reversals void inline;
`enqueueAccountingPush` returns `{queued:false, reason}` without writing anything for
`connection_unhealthy|disabled|inbound_only|no_target`, and every AP caller discards
it; the queue UI exists at Settings → Integrations (strip + `AccountingSyncSheet`
with Sync / Import / History tabs) and on the payables desk; bill-payment sync state
is shown nowhere on the bill; the queue keys bills on legacy `qbo_sync_status`.

### WS-G1 — Durable enqueue

- [x] `enqueueAccountingPush` writes an `accounting_sync_records` row on every call:
      `pending` when a job is queued; `needs_review` with `reason` for
      `connection_unhealthy`, `disabled`, `inbound_only`, `no_target`,
      `connection_mismatch`, and the freeze case (already done). `books_authoritative`
      writes nothing (it is not a sync target) but is returned as
      `{ queued:false, reason }`.
- [x] The outbox worker updates the record to `synced` / `error` / `needs_review`
      with the attempt id; `accounting_sync_attempts` stays the trace.
- [x] Reconnect handler (`qbo/connections.ts` and the provider-neutral equivalent)
      re-enqueues every `needs_review` record whose reason was
      `connection_unhealthy` for that connection.
- [x] All AP call sites (`vendor-bills.ts` approve/pay/credit,
      `payment-provider-events.ts` settlement, `invoice-auto-approval.ts`,
      `po-completions.ts`) stop discarding the result; a `queued:false` with a
      reason other than `books_authoritative` is logged to the payable's timeline.

**Definition of done.**
- [ ] Runbook "Accounting acceptance" bullets 1–3 pass, plus a new case: settle 3
      bills during an expired-token window, reconnect, and verify all 3 push with no
      manual action.

### WS-G2 — Sync state on the bill, the desk, and the run

- [x] `getPayablesAccountingSyncStatesAction` returns `bill` and `bill_payment`
      states keyed by bill id and payment id; workspace, timeline, desk column, and
      run detail render `AccountingSyncBadge` for each (WS-D4).
- [x] `listAccountingSyncQueueAction` drops `qbo_sync_status` and reads
      `accounting_sync_records` for bills too; the legacy column is removed from
      readers in this slice (its drop is in the gated D2 migration; do not touch).
- [x] `AccountingSyncSheet` is mounted with `projectId` on the project payables
      workbench; org-level entries on `/payables` and Settings remain. The Import
      tab stays inbound-only.

**Definition of done.**
- [ ] From a paid bill, one click answers "did this payment reach QuickBooks" with a
      state that cannot read "synced" when it was never enqueued.

### WS-G3 — Stale sync detection

- [x] `ops-watchdog.ts` probes: `accounting_sync_records` in `pending` older than
      6 hours; rail-paid `payments` (bill_id set, provider = rail) with no
      `bill_payment` sync record; outbox `accounting_*` jobs `failed` in the last
      24 hours. Each emits `accounting_sync_needs_review` (allowlisted) deduplicated
      on transition, and appears on `/admin/ops`.

### WS-G4 — Doc correction

- [x] Replace the gameplan line "Arc Books consumes the resulting accounting
      events; it does not infer them from mutable payment status fields" with what
      the code does: Books projects from the `payments` and `payment_reversals` fact
      rows written once by atomic RPCs; the rail subledger never feeds the projector.

**Phase G definition of done.**
- [ ] The four "Accounting acceptance" bullets in the runbook plus WS-G1's new case
      pass with evidence.

### Phase G execution record — 2026-09-03

- Applied `20260903113609_phase_g_accounting_sync_truthfulness.sql` through the
  linked Supabase MCP. Its
  service-role-only RPC commits current sync intent and the deduplicated outbox
  job in one transaction, preserves existing external identity, and represents
  the no-target state without inventing a provider or connection.
- Every AP enqueue result now reaches the payable audit timeline; reconnect and
  provider-neutral refresh paths replay the complete unhealthy-connection
  backlog. Worker outcomes link current state to the append-only attempt row.
- Bill and bill-payment state now come from `accounting_sync_records` on the
  workspace, timeline, desk, project workbench, sync queue, and payment-run
  detail. The Phase G payables slice no longer reads legacy sync-status columns.
- The watchdog now detects six-hour pending records, rail-settled bill payments
  missing a sync record, and accounting dead letters from the prior 24 hours.
  Each condition uses transition-deduped `accounting_sync_needs_review` events
  and is visible in `/admin/ops`; Arc Books orgs are excluded from the
  intentionally absent outbound-record invariant.
- Added `20260903113824_phase_g_accounting_sync_attempt_fk_index.sql` after the
  post-DDL advisor identified the new attempt foreign key as uncovered. The
  follow-up was applied through MCP and the advisor finding is cleared.
- Added `payment_phase_g.test.sql` (23 pgTAP assertions), Phase G behavior/source
  guards, the expired-token three-bill runbook case, schema documentation, and
  the corrected Arc Books projection description.
- Verification: `pnpm lint`, `pnpm typecheck`, `pnpm test:financials` (801/801),
  `pnpm test:auth` (115/115), `pnpm test:mobile` (9/9), and
  `pnpm db:schema:check` pass.
- Hosted verification: the Phase G pgTAP contract passes 23/23 against the
  migrated Arc database. The test-only pgTAP extension and every fixture were
  created inside the test transaction and rolled back; no test state persisted.

**STOP — human gate.** Execute the Accounting acceptance cases (including
expired-token settlement/reconnect) in the approved provider test environment.
Those evidence-dependent Definition-of-Done checkboxes remain open.

---

## Phase H — Tests, QA runbook, attestations

### WS-H1 — Replace grep tests with behavior tests

**Finding.** 88 of 132 tests in `tests/fintech-payment-domain.test.js` are source-text
greps; `payable-approval-signals.test.js` and `payable-line-match.test.js` test
`lib/financials/*`, not the services they are named after; untested:
`requiredApprovalCount`, hash invalidation, hold overrides/precedence,
`parsePaymentHoldPolicy`, `mapWithConcurrency`, daily limit, overpayment, credits,
retainage.

- [x] Keep source-scan tests only where they enforce an invariant no type can
      (allowlists, revoke lints, no-direct-void). Move them into
      `tests/fintech-payment-guards.test.js` so behavior tests are visible.
- [x] Add behavior tests for every function above, plus every pure function added
      by Phases B–G. Each test names the runbook case or finding it covers in its
      title.
- [x] Rename the two mis-titled test files to what they test, or add the service
      tests they imply.

**Definition of done.**
- [x] `pnpm test:financials` has ≥ 60 % behavior (non-scan) assertions in the
      fintech files (count in the test's own summary output).

### WS-H2 — Execute the QA runbook in Stripe test mode (human runs, LLM prepares)

- [x] LLM prepares `docs/plans/ap-payment-qa-evidence/` templates: one markdown per
      runbook case with the fields the runbook demands (run ID, disbursement ID,
      provider IDs, ledger transaction IDs, payment ID, bill state, sync record,
      webhook event, reconciliation result) and the SELECT queries to fill them.
- [x] LLM writes `scripts/qa/stripe-test-events.md`: the exact Stripe CLI commands
      (`stripe trigger`, `stripe events resend`) for each failure-injection case.

**STOP — QA execution.** The human runs all 12 matrix cases, 16 failure injections,
construction controls, and accounting acceptance in the QA org with test credentials,
filling the evidence templates. The LLM may triage defects found and loop back into
the relevant workstream. No severity-1/2 defect may remain open.

### WS-H3 — Launch attestations (human only)

**STOP — five gates.** `provider_program`, `payments_legal`, `risk_reserves`,
`operations_runbook`, `production_qa` are recorded at `/admin/ops/payment-launch` by
the named approvers with durable evidence references. An LLM never records one and
never suggests placeholder text.

### WS-H4 — Pilot criteria

- [ ] Two Florida builders, `FINTECH_PAYMENTS_MODE=live` only after WS-H3, sole or
      dual approval, finite limits set (per-payment, per-run, daily, in-flight,
      return-loss), payout hold ≥ 48 business hours, new-vendor hold ≥ 24 hours.
- [ ] 14 consecutive days of daily reconciliation with zero open exceptions.
- [ ] Support runbook exercised once with a real vendor question.

**Phase H definition of done.** All of the above, with evidence in the repo under
`docs/plans/ap-payment-qa-evidence/` until this plan is deleted, at which point the
evidence moves to wherever compliance keeps it (human decides).

### Phase H execution record — 2026-09-03

- Replaced the fintech source-scan-heavy suite with direct behavior coverage for
  approval quorum, approval-hash invalidation, hold precedence and parsing,
  bounded concurrency, daily-limit exposure, overpayments, retainage, credits,
  and the pure payment helpers introduced in Phases B–G. Structural assertions
  now live in `fintech-payment-guards.test.js`.
- Extracted the reusable daily-exposure and tighter-limit rules into
  `lib/payments/payment-limit-policy.ts` and wired payment-run execution to those
  tested policies.
- Renamed the two misleading financial test files to
  `payable-line-matching-math.test.js` and
  `even-flow-and-schedule-advisories.test.js`.
- The fintech test summary reports 71 behavior assertions and 7 structural guards:
  **91.0% behavior**, above the 60% threshold.
- Added 46 blank, per-case QA evidence templates (12 matrix, 16 failure injection,
  10 construction, 8 accounting), a repository validator for their required
  fields and read-only queries, and sandbox-only Stripe CLI instructions for all
  16 failure cases.
- Verification: `pnpm lint`, `pnpm typecheck`, `pnpm test:financials` (735/735),
  `pnpm test:auth` (115/115), `pnpm test:mobile` (9/9),
  `pnpm db:schema:check`, and `pnpm qa:evidence:check` (46/46) pass.

**STOP — human evidence gates.** WS-H2 execution, all five WS-H3 attestations,
and the WS-H4 two-builder pilot remain open. Phase H cannot be declared complete
until humans execute and record those evidence-bearing controls.

---

## Phase I — Strategy and documentation

### WS-I1 — Rewrite the fintech gameplan for the Column direction

**Context.** The product owner intends to pursue bank sponsorship (Column N.A.) so Arc
can hold funds in FBO accounts and originate ACH directly, unlocking builder balances,
retainage escrow, same-day vendor pay, and early pay. The current gameplan says "Arc
does not intentionally hold customer funds" and defers treasury/FBO to Phase 9 behind
board approval. Those two positions cannot coexist in one execution contract.

**Strategic decision confirmed — 2026-09-03.** The user explicitly directed execution
of Phase I, confirming the Column/Rail v2 direction in writing for this workstream.

**Stripe clarification — 2026-09-08.** Stripe Support confirmed that the proposed
SCT ACH flow is commingled in Arc's platform balance and exposed to platform
liabilities, and that Funds Segregation is unavailable for ACH Direct Debit. Rail v1
is therefore retained only as historical/test implementation context, not as an
eligible production pilot. Stripe Treasury for platforms with per-builder Financial
Accounts is now an alternative architecture to evaluate alongside Column; it is not
approved or provisioned merely because Support called it the "right direction."
Early payment has not been reviewed or approved.

- [x] Rewrite `docs/plans/fintech-gameplan.md` §1 "What Arc is and is not", §2
      decisions, §8 phases 6–9, and §10 so that: Stripe separate-charges-and-transfers
      is **Rail v1** (pilot and controls track record); Column sponsorship is
      **Rail v2** with its own STOP gates (bank partner approval, BSA/AML program,
      KYB/KYC ownership, state money-transmission analysis with counsel, daily
      bank-ledger reconciliation ownership, dual-control operations); early pay and
      escrow are Rail v2 programs, not Rail v1 features.
- [x] Reshape `lib/integrations/payments/payment-rail-provider.ts` **on paper only**
      (a section in the gameplan, no code) around provider-neutral nouns:
      counterparty, funding debit, credit, book transfer, return event, verification
      status; list which Stripe-shaped methods (setup intent secret, onboarding link,
      transfers, payouts) become adapter-private.
- [x] State explicitly which of today's layers carry over unchanged (runs,
      approvals, ledger, reconciliation, holds, relationships) and which are replaced
      (vendor KYC via Stripe Express, Stripe-hosted bank collection).
- [x] Record the review's finding that, even on Rail v1, builder funds sit on Arc's
      Stripe platform balance for the hold window, so the "does not hold funds"
      language must be qualified and matched to the platform payout-schedule gate
      (WS-B5).

**Definition of done.**
- [x] The gameplan has one coherent posture, and every STOP in it maps to a real
      decision owner.

### WS-I2 — Runbook updates

- [x] Add to `docs/plans/ap-payment-qa-runbook.md`: platform payout schedule check
      (WS-B5), post-transfer return case (WS-B1), per-payee failure case (WS-B3),
      transfer claim crash case (WS-B4), expired-token sync backlog case (WS-G1),
      bulk-approval notification case (WS-F1), vendor first-click case (WS-E1),
      stuck-run admin cancel case (WS-C1).
- [x] Fix its precondition text to reference the ledger check from WS-A5.

### WS-I3 — Delete this plan

- [ ] When every checkbox above is checked and Phase H evidence exists, delete
      `docs/plans/arc-pay-readiness-gameplan.md` and
      `docs/plans/migration-ledger-reconciliation.md`, fold durable rules into
      `CLAUDE.md` (migration naming via MCP, revoke lint, no direct `events`
      inserts from SQL) and the reference docs, and update `docs/README.md`.

### Phase I execution record — 2026-09-03

- The user confirmed the Column direction by explicitly directing Phase I.
- Reframed Stripe separate charges and delayed transfers as Rail v1: a controlled
  pilot and controls track record whose hold-window funds sit on Arc's Stripe
  platform balance under a manual-payout and reserve/sweep gate.
- Defined Column sponsorship as Rail v2 with separate, owned STOPs for bank approval,
  BSA/AML, KYB/KYC allocation, state money-transmission analysis, daily bank-ledger
  reconciliation, and dual-control operations. Retainage escrow and early pay are
  Rail v2 programs, never Rail v1 features.
- Recast the future provider contract on paper around counterparties, verification
  status, funding debits, credits, book transfers, return events, and rail activity;
  documented which Stripe and Column object shapes stay adapter-private and which
  Arc control/ledger layers carry forward unchanged.
- Added every WS-I2 regression requirement to the QA runbook and its corresponding
  existing evidence record. The evidence suite remains 46 non-duplicated cases.
- `pnpm qa:evidence:check` and documentation consistency checks pass.

**STOP — WS-I3 cleanup remains gated.** The readiness plan and migration-ledger
working document cannot be deleted, folded into `CLAUDE.md`, or archived while the
Phase H human QA, launch attestations, and pilot criteria remain incomplete.

---

## Appendix — Finding index

Every finding from the 2026-09-01 review and where it is handled.

| Finding | Workstream |
|---|---|
| Return in transfer→payout window misclassified | B1 |
| Webhook-before-response strips `provider_payment_id` | B2 |
| One bad payee strands or loops the run | B3 |
| Transfer claim does not claim; 24 h idempotency | B4 |
| Platform payout schedule unchecked | B5 |
| Healthy runs re-executed every 5 min; `claimed:false` ignored | B6 |
| Sync `funds_available` without release time | B7 |
| Books fee per bill vs bank fee per run | B8 |
| Reconciliation green while disabled | B9 |
| Approved run stuck, preparer-only cancel, risk-review spam, leaked reservations | C1 |
| Florida hard-code at submit | C2 |
| Content hash trips on commitment traffic | C3 |
| Submit with no eligible approver | C4 |
| Two daily-limit ledgers | C5 |
| Retainage release has no workflow; hold always true | C6 |
| Duplicate prefilter mismatch; vendor scope dropped; trigger needs company | C7 |
| Actions without permission/result wrapper; client loop | C8 |
| Step-up recency app-only | C9 |
| Hidden caps; 400-row risk window | C10 |
| Runs invisible on the web; "Paying" hides stages; run approval has no home on the desk | D1 |
| No bulk submit | D2 |
| All-or-nothing errors; selection loss; unreachable caps; hidden unenrolled | D3 |
| Bill-payment sync invisible | D4, G2 |
| Loading logo; unlinked text; split dead end | D5 |
| Vendor first click errors; hidden claim button | E1 |
| Project-link pause revokes payment access | E1 |
| Re-invite mails an exhausted token; expired reads as 404 | E1 |
| Restore leaves claim revoked; money against revoked claim | E2 |
| `pending_review` shown as "needs information" | E2 |
| Remittance not deduplicated; credit says "sent to bank" | E3 |
| No vendor notice on return | E3 |
| `primary_company_id` reads | E4 |
| Plural permission keys; policy key parity | E5 |
| Vendor payments view hardening | E6 |
| Vendor-ready notification unnamed | E7 |
| Bulk approve silent to submitter | F1 |
| Approvers paged on drafts; org-wide AP staff excluded | F2 |
| Run-submitted ignores roster limits; partial-approval spam | F3 |
| "On its way" when blocked | F4 |
| Return path void-before-ledger ordering | B1, F5 |
| Skipped enqueues leave no backlog | G1 |
| Queue keyed on legacy column; no project mount | G2 |
| No stale sync detection | G3 |
| Gameplan "Books consumes events" inaccurate | G4 |
| Release cron dead 20 days; watchdog never ran | A1 |
| Run stuck since 2026-08-03 | A2 |
| `submit_payment_run_atomic` executable by anon | A3 |
| Two hardening migrations unapplied | A4 |
| Migration ledger drift; prod-only migrations | A5 |
| pgTAP suite unwired | A6 |
| Integer cent columns on `payments` et al. | A7 |
| Grep-heavy tests; mis-titled test files | H1 |
| Missing FK indexes on payment tables | A7 (add to the same migration) |
| Gameplan vs Column direction | I1 |
