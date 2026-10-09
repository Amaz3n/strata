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
   must pass.
4. Owner approval of the list. Then, in the deploy window: run the reviewed
   `supabase/scripts/repair-migration-ledger.sql` once (records applied
   migrations under their repository versions), apply the list with the Supabase
   CLI so versions are preserved, deploy the code, run `pnpm db:ledger:check`.
5. After the deploy: confirm the scheduled jobs ran (job runs page) and open
   `/books/close` for each Books organization.

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
| Acceptance-run keys: the acceptance bucket and Plaid sandbox | GitHub secrets `BOOKS_ACCEPTANCE_R2_*`, `BOOKS_ACCEPTANCE_PLAID_CLIENT_ID`, `BOOKS_ACCEPTANCE_PLAID_SANDBOX_SECRET`; locally, owner-only key files passed with `--storage-env` / `--plaid-env` | Replace the secret; the nightly run reports the affected scenario blocked until then |
| Taxpayer IDs (vendors and payer companies) | Supabase Vault, never in exports | Re-enter from W-9s / the company's EIN letter; the 1099 filing file refuses until the payer EIN is present |
| Bank feeds (Plaid) | A secret reference on each feed connection (`bank_feed_connections.secret_ref`), never archived | Reconnect from `/books/banking`; restored copies always start disconnected |
| Connected accounting system (QuickBooks) | OAuth tokens on the accounting connection, server-only, never archived | Reconnect from `/settings/integrations` |
| Filing partner | The builder's account with the partner | Prepare and approve the package in Arc, download the import file, file at the partner |
