# Arc Books: operations runbook

How to run Arc Books for a builder: who owns what, what runs by itself, how to
deploy, bring a builder on, close a month, repair the ledger and recover. Each
step names the screen or command; the reference docs hold the rules
(`books-capabilities.md` is the index). Every procedure here is exercised by a
golden scenario on the isolated acceptance stack (`books-acceptance-runner.md`).

## Ownership

| Area | Owner | Does |
|---|---|---|
| Deploys, migrations, scheduled jobs, storage and secrets | Arc operator (Agustin) | Runs the deploy procedure below; watches job health; holds the production keys |
| A builder's monthly books | The builder's bookkeeper (`books.adjust`, `books.close`) | Posts, reconciles, clears close blockers, closes |
| Independent review | A second member (accountant or Books reviewer role) | Approves journals, WIP, allocations, workpapers and 1099 packages prepared by someone else |
| Tax filing | The builder's CPA and filing partner | Files 1099s from the approved package, files tax returns |
| Payroll | The builder's payroll provider | Runs payroll; Arc receives the summary (see Month end) |

## What runs by itself

| Job | When | What it does | When it fails |
|---|---|---|---|
| `books-projection` | Every 10 min | Posts new and changed source documents | Each document's posting status shows the failure and its cure |
| `books-maintenance` | Daily 05:15 UTC | Full posting repair pass, recurring postings, the ledger proof (narrowed nightly, full weekly), fails stranded archives | Failures become close findings with their cure; capacity limits (a company not reached) stay on the close page and never alert the builder |
| `accounting-reconciliation` | Daily 04:45 UTC | Ties the ledger to subledgers, banks, payments and the connected system | Findings on `/books/close` |
| `process-outbox` | Every 10 min | Background work: bill-approval postings, archives, notifications, search | Ops watchdog; a stuck job shows its last error |
| `bank-feed-sync` | Every 15 min | Pulls bank feed transactions | Import the statement by hand (`/books/banking`), then reconnect the feed |
| `ops-watchdog` | Hourly | Flags jobs that stopped running | Job runs page |

Each is in `CRON_JOBS` (`lib/services/job-runs.ts`), mirrors `vercel.json`, and
is a public API route.

## Deploying database changes

Production schema changes go out in **one window with the code deploy**, never
ahead of it: the running app is written for the schema it shipped with.

1. List what production needs: `pnpm db:pending` (live once
   `list_migration_ledger()` exists; until then pass `--ledger` with a read-only
   export of `supabase_migrations.schema_migrations`). The list is in order and
   never includes `supabase/pending-migrations/`.
2. Make sure every listed file is committed and reviewed; a file another
   workstream is still editing is not ready.
3. Rehearse: bootstrap the acceptance stack from the production baseline and
   apply the list (`scripts/books-acceptance/upgrade.cjs`), then run
   `scenario-runner --all --storage-env <key file>`. All first-client scenarios
   must pass. Then compare the upgraded schema and grants (`pg_dump
   --schema-only`) with a fresh replay of every migration; they must be
   identical. Production applies the list after everything it already has, so a
   file dated before an applied migration runs later there than in a fresh
   replay and can replace a newer definition (`20261009020000_deploy_order_parity`).
   Migrations no environment has applied may be consolidated before a deploy, and
   the fresh replay must then match the one from before; an applied migration
   never changes.
4. Owner approval of the list. Then, in the deploy window: run the reviewed
   `supabase/scripts/repair-migration-ledger.sql` once (records applied
   migrations under their repository versions), apply the list with the Supabase
   CLI so versions are preserved, deploy the code, run `pnpm db:ledger:check`.
5. After the deploy: confirm the scheduled jobs ran (job runs page) and open
   `/books/close` for each Books organization.

## Rebaselining

Once production has applied every migration in `supabase/migrations/`, they can
be replaced by one baseline, so a fresh database is built from one file and the
production ledger holds one row. Do it right after a deploy, with no other
migration work in flight (tests that load migration files by name read them
from `supabase/migrations-history/` through `tests/support/migration-sql.js`).

1. **Dump production's schema** (read-only, no data): `supabase db dump --linked
   -f prod-schema.sql`. Production is the truth: the comparison on 2026-10-09
   found objects no migration created (the outreach role and policies, a QBO
   legacy archive table, four storage buckets and their policies), an applied
   migration edited afterwards (the photo list), and functions applied without
   their comments.
2. **Dump the seeded rows from a replay**, never from production (customer
   data): bootstrap the acceptance stack from `supabase/migrations/`, then
   `supabase db dump --db-url <replay> --data-only -f seed.sql`.
3. **Read what dumps leave out**: run `scripts/production-baseline/extras.sql`
   against production and save its JSON.
4. **Build**: `node scripts/production-baseline/build.cjs --schema prod-schema.sql
   --data seed.sql --extras extras.json --out
   supabase/migrations/<version>_production_baseline.sql`, with a version before
   every remaining file; move the replaced files to `supabase/migrations-history/`.
5. **Prove it**: replay the baseline alone and compare
   `scripts/production-baseline/fingerprint.sql` with production's output. Every
   row must match except the storage triggers Supabase manages. Also check
   function grants: a CLI dump restored without the builder's cleared default
   privileges makes service-only functions executable by `anon`. Then run
   SCHEMA-01, `ci.cjs` and the node suites.
6. **Swap the ledger** (owner-approved, one transaction): delete production's
   `supabase_migrations.schema_migrations` rows for the replaced files and insert
   the baseline's version, after saving a read-only export of the old ledger as
   evidence. `pnpm db:ledger:check` must then pass.

## Bringing a builder on

- **New company, no history** (`/books/cutover`): create the first period, make
  sure no outside accounting system is connected, launch with a zero opening and
  the exact attestation. GREEN-01.
- **Existing builder** (`/books/opening-balances`, then `/books/cutover`): import
  the cutover trial balance as one opening batch with every open invoice and
  bill, retainage, uncleared bank item, loan, asset, owned lot (`land`) and spec
  home (`home_inventory`) as its own line; the owner and an accountant both
  approve; post. Reconcile each bank to its cutover statement, let the connected
  system sync, then promote to parallel — refused until the banks are reconciled,
  the connection is current and the ledger proof passes. MIG-01.
- **More than one company** (`/books/entities`): add each company, assign jobs
  and bank accounts to their owners, and open each company with its own batch.
  ENTITY-01.

## Month end

Run the close checklist on `/books/close`. Each blocker links to its cure:

| Blocker | Cure |
|---|---|
| All journals posted / proposals reviewed | `/books/ledger`: post drafts; a different member reviews proposals |
| Bank and card accounts reconciled / transactions matched | `/books/banking`: import or sync the statement, match, reconcile |
| Accounting reconciliation issues resolved | The findings listed on `/books/close`, each with its cure and source; resolve, or explain with a reason |
| WIP and POC reviewed | Prepare the WIP review on the close page; a second member approves |
| Revenue policies reviewed | `/books/revenue-policies` |
| Job cost, AR or AP does not tie | **Run ledger proof** on the blocker: every entry that differs from its source is listed under the reconciliation findings with the cure (see Ledger repair). A hand journal that names a job on a job-cost account blocks here by design: reverse it and move the cost with a cost allocation |
| Land, completed homes, warranty, impairment | `/books/close` evidence lists the lot or home; warranty at `/warranty/accounting` |
| Intercompany does not agree | `/books/entities` shows both sides of each pair |
| Customer deposits / debt / assets / depreciation | `/billing/deposits`, `/books/assets` |
| Clearing and undeposited funds | Support each balance on the close page (explanation, settlement date, evidence) |
| Tax jurisdictions / W-9s | `/settings/accounting/taxes` |
| Bills coded / waiver holds / retainage released | `/payables` |
| Records pushed to the external system (parallel) | `/settings/integrations` |

Payroll: post the provider's summary as a journal to the payroll expense pool,
then move each crew's cost to its jobs with a reviewed cost allocation
(`/books/cost-allocations`). Close the month once every blocker passes; the
close saves each company's statements. Reopening records the reason and keeps
the earlier close on record. CLOSE-01, YEAR-01.

## Ledger repair

The ledger proof rebuilds every posting from its source and compares. It runs
nightly (narrowed) and weekly (full), and on demand from a failing job cost, AR
or AP blocker. Each difference becomes a close finding linking to the entry:

- **Entry differs from its source** or **entry has no source**: open the entry
  (`/books/ledger?entry=…`), reverse it with the reason.
- **Source posting lost or reversed**: nothing to reverse.

Then let posting run (or wait for the next 10-minute run): each source posts
again from its unchanged record. Run the proof again; it passes, the findings
resolve themselves, and the controls tie. Never edit ledger rows. RESTORE-01
`proof-repair-and-close`.

## Recovery

Archives (`/books/exports`, built in the background) hold every Books table and
supporting document with checksums, never secrets. To recover a company,
follow `books-restore.md`: verify the archive offline, preflight against the
target (it names every blocker and every taxpayer ID Vault must supply), plan
with explicit identity mappings, load into an empty isolated organization, put
documents back at their manifest paths, then compare checksums and run the
ledger proof and close checklist before giving anyone access.

**Incident drill** (quarterly, on the acceptance stack): RESTORE-01 and
STORE-01 with `--storage-env`. A closed group is archived, lost and restored;
every table, saved statement and document returns identical; the next month is
billed, collected, reconciled and closed.

## Secrets and outside dependencies

Named here, never their values. Production values live in Vercel and Supabase;
the operator holds access.

| What | Where | If lost or rotated |
|---|---|---|
| Supabase service role, `CRON_SECRET` | Vercel environment | Rotate in Supabase / Vercel; jobs resume on the next run |
| R2 storage keys | Vercel (`R2_*`); the acceptance bucket's key only in the operator's local key file | Create a new key scoped to the bucket in Cloudflare; old links stop working |
| Acceptance-run keys: the acceptance bucket, Plaid and TaxBandits sandboxes | GitHub secrets `BOOKS_ACCEPTANCE_R2_*`, `BOOKS_ACCEPTANCE_PLAID_CLIENT_ID`, `BOOKS_ACCEPTANCE_PLAID_SANDBOX_SECRET`, `BOOKS_ACCEPTANCE_TAXBANDITS_*`; locally, owner-only key files passed with `--storage-env` / `--plaid-env` / `--taxbandits-env` | Replace the secret; the nightly run reports the affected scenario blocked until then |
| Taxpayer IDs (vendors and payer companies) | Supabase Vault, never in exports | Re-enter from W-9s / the company's EIN letter; the 1099 filing file refuses until the payer EIN is present |
| Bank feeds (Plaid) | A secret reference on each feed connection (`bank_feed_connections.secret_ref`), never archived | Reconnect from `/books/banking`; restored copies always start disconnected |
| Connected accounting system (QuickBooks) | OAuth tokens on the accounting connection, server-only, never archived | Reconnect from `/settings/integrations` |
| Filing partner (TaxBandits) | `TAXBANDITS_ENV`, `TAXBANDITS_CLIENT_ID`, `TAXBANDITS_CLIENT_SECRET`, `TAXBANDITS_USER_TOKEN` in Vercel (sandbox keys never in production) | Without them, File with TaxBandits is hidden: download the import file and record the submission by hand |

## Production builders (acceptance)

The same isolated stack, runner and browser harness rehearse a production builder.
Nothing here ever points at production data: a run builds its own organisation on the
acceptance stack and the kit refuses any other container.

**What exists**

| Piece | Where | What it is |
|---|---|---|
| Production seed | `scripts/books-acceptance/production-seed.cjs` | A builder with Books launched and a member for every production role (land, sales, starts, purchasing, superintendent, warranty, design studio): one division, one community of 20 lots (`PRODUCTION_SEED_LOTS` scales it), a first land tranche bought in Books, two released plans with elevations, takeoffs and a schedule, a price book, a priced option catalog with a cutoff group, and the community's offering. Every step goes through the service as the role that owns it; the places it cannot (file storage, an unsold lot's plan pin) are written directly and commented as such |
| Browser journey `production` | `browser-seed.cjs --journey production` | The seed plus a home at each stage: lot 1 sold, built, closed and in warranty; lot 2 a spec home released with no buyer; lot 3 sold with its start package ready; lot 4 reserved; lot 5 on hold; a walk-in. Writes each role's sign-in to `browser-users.json` |
| LOT-01 | `scenarios/lot-01.cjs`, `expected/LOT-01.json` | A presold home from land takedown to warranty with the books tied out the way HOME-01 ties them (below) |
| Production sweep | `journeys/production-sweep.spec.ts`, `journeys/sweep.ts` | Every signed-in page as the owner; the production desks and a home's tabs as each role, at desktop width (mobile web is out of scope; field use is the iOS app) |

**LOT-01.** Land is bought in Books and the takedown closes; the consultant holds and
reserves the lot with a $20,000 deposit; the agreement is quoted ($433,100), executed
and the lead is won; the buyer's design choices pass their cutoff; the starts desk
clears the gates and releases (schedule, five purchase orders, budget, land moved into
the house); the trades are billed against their orders; the home completes, closes
(revenue $433,100, cost of sales by component, deposit applied, four home controls tie)
and enrols in warranty. Each role is also checked at its boundary (a land manager
cannot hold a lot, a superintendent or a consultant cannot release). The arithmetic of
every reviewed number is derived in the expected file and bound to the fixtures by a
unit test (`tests/books-acceptance-scenarios.test.js`).

```sh
# stack as in books-acceptance-runner.md (bootstrap, then api.cjs --auth)
node scripts/books-acceptance/scenario-runner.cjs --container <db container> \
  --api-url http://127.0.0.1:<port> --scenario LOT-01 --evidence-dir NEW_DIR
#   --only name[,name]   run named subcases;  --include-pending   also run the open ones
node scripts/books-acceptance/browser-seed.cjs --workspace W --journey production
BOOKS_ACCEPTANCE_WORKSPACE=W PRODUCTION_SWEEP_ROLES=owner,sales \
  npx playwright test -c scripts/books-acceptance/playwright.production.config.ts
node scripts/books-acceptance/sweep-report.cjs --workspace W --errors
```

A run takes about a minute for the scenario and nine seconds for the seed. The release
and the closing run for real; two harness limits are named in the code: the plan-set
PDF copy and the signing packet need file storage, so without `--storage-env` the
drawings step of the release is settled directly and the agreement is executed through
the service the envelope handler calls. Both are listed as open subcases that need
`--storage-env`.

**Reading the result.** A production scenario with open steps is `INCOMPLETE`, and an
all-scenarios run reports it ("open by design") without failing; a failed step fails
the run. Open subcases are the explicit pending list: each is either waiting on storage
or on a product defect, with the defect and its source in the expected file. The defect
checks are written; `--include-pending` runs them and a step reports `PASSED` the day
its defect is fixed, at which point its `status` line is removed from the expected file
and its entry from `OPEN_SUBCASES` in `catalog.cjs`.

**The sweep.** A page is `clean`, `refused` (an authorization refusal was the only thing
it said), `errors` (an exception, a console error, a 5xx, a crash screen, or a person's
own desk refused) or `skipped` (it needs a record the seed does not create). A finding
that does not come back on a second load is counted as a flaky first load, not an error.
Reports are `W/production-sweep-<role>-desktop.json`. Each role's own desk is the one
named in `docs/production-org-playbook.md`.

**Defects these runs found** (open subcases in `expected/LOT-01.json` carry D1–D4, D7, D10, D11; the rest came from the sweep and are not yet checks):
D12 the production Home (`/`, `/my-houses`) fails for every role: `production_home_stat_rollup` is executable only by `service_role` but `lib/services/production-home.ts` calls it with the user's client. D13 the Offering tab cannot list plans to offer: `listOfferablePlans` (since replaced by the searched `searchOfferablePlans`) filtered `house_plans.is_archived`, which does not exist. D14 `app/(app)/sales/[dealId]/page.tsx` gives four siblings the same React key. D15 `DndContext` has no `id` in `components/starts/launch-lane.tsx` and `components/documents/unified-documents-layout.tsx` (hydration mismatch). D2 shows in the browser as the purchasing manager's own desk refusing (`Missing permission: org.member`). D4 shows as the Inventory and Warranty tabs of a sold home crashing ("contracts that earn revenue differently"). D5 release leaves schedule items and lots out of search ("Starts worker cannot enqueue this job family"). D6 the sample-community schedule uses `offset_days` where the schedule reads `start_offset_days`. D8 `pay_on_po_enabled` has no writer. D9 nothing pins a plan to an unsold lot, so a spec home cannot be started from the app.
