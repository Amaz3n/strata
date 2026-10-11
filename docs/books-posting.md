# Books posting

How source documents become journal entries in Arc Books, how a person can see
where each one stands, and how the ledger is proven to match its sources. Read
before changing `lib/services/books/projector.ts`, `posting-status.ts`,
`rebuild.ts` or the projection SQL.

## Runs

The projector turns each qualifying source (vendor bill, invoice, retainage
release, payment, fee charge, expense, reversal, credit memo, labor) into an
immutable **fact** and a posted **journal entry**, and records a **receipt**
(`books_projection_receipts`) saying which revision of the source that journal
reflects.

- **Ordinary run** — `/api/jobs/books-projection`, every 10 minutes. Reads only
  what changed (below) and posts it.
- **Nightly pass** — `/api/jobs/books-maintenance`, `full: true`. Reads every
  source, re-posts anything whose economics changed without an announcement, and
  retires sources that no longer qualify. Unchanged sources cost no database call.
- **Chosen sources** — `projectJournal(orgId, { sourceKeys })`, used by flows
  that must post one document now (a home closing). Reads exactly those rows.

A source revision posts once. A fact is written only when the economics change;
an unchanged source whose journal still stands is skipped without a call, and
only its receipt moves forward to the newer revision.

## What an ordinary run reads

Each company saves, per source family, the latest `updated_at` it read and when
its read began (`books_projection_progress`). The next run reads:

- every row **strictly after** the family's cursor;
- reaching back to **five minutes before the previous run began**, when that is
  earlier than the cursor. `updated_at` is the writing transaction's start time,
  so a write that commits after a newer one has been posted carries a timestamp
  behind the cursor; it was in flight while that run read. Writes running longer
  than five minutes are left to the nightly pass;
- every source with an open `projection_failed` finding, by id, so a transient
  failure heals on the next run even after the cursor has passed it.

Rows are paged by id (keyset), never by offset, and job cost, retainage and
deposit-invoice status are read only for the documents being posted. A run's
work therefore follows what changed: on 1,200 posted bills an idle run reads 73
rows and a one-bill change 81 (CAP-01).

Inputs that live outside a source row touch that row when they change
(job-cost lines, project billing settings, contracts, funding mappings, chart
accounts, retainage, the payment behind a reversal), so the source re-posts on
the next ordinary run. A contract whose effective date arrives changes its
project's revenue basis with no edit; the first ordinary run after that date
touches the project's sources.

**Reporting tags stay as posted** (decided October 6, with B07). A project's
division, community and lot are recorded on each entry when it posts. Moving the
project later restates nothing: when the tags are a document's only difference
from its posted fact, the posted tags are kept and the document is unchanged. A
new document, or a real revision of an old one, posts with the current tags.
Reports that need today's structure look the project up when they run.

## Companies and time

Both cron routes give the projection a time budget inside `maxDuration` and run
companies least recently completed first. A company the run does not reach, or
whose run stops, gets an open finding on the company itself
(`books_projection_run`), which holds its month-end close; its next completed run
resolves it. One company's failure never stops the companies after it.

## Deleting a posted document

The database refuses to delete a bill, invoice, expense or payment while a posted
journal points at it (`books_guard_posted_source_delete`); `deleteVendorBill`
refuses first, before any cleanup. Return the document to pending or void it;
once the next ordinary run has reversed its journal it deletes normally.

## Where a document stands

`getBooksPostingStatus` answers for one document from its receipt and open
findings, never from its workflow status:

| State | Meaning |
|---|---|
| posted | A journal stands for this revision. Links to the entry (`/books/ledger?entry=<id>`). |
| pending | The document changed after its receipt; the next run will post it. |
| blocked | Its period is closed. Shows the cure and links to Books. |
| failed | Posting failed. Shows the error and links to Books. |
| reversed | The document no longer qualifies and its journal was reversed. |

Project documents follow the project's permissions (`invoice.read` for
receivables, `bill.read` otherwise); documents with no project need `books.read`.
A company without the Arc ledger gets no status.

## Proving the ledger

- **Full rebuild drill** (`runLedgerRebuildDrillForOrg`) rebuilds every fact's
  journal from the fact and compares it with the posted entry, then scans for
  operational journals with no fact behind them. The database stamps each posted
  line with its account's classification at posting; the comparison sets that
  stamp aside.
- **Narrowed proof** (`proveProjectedSources`) does the same for chosen sources,
  or for everything whose row, fact or journal changed since a time, and also
  finds what the drill cannot: a qualifying source with no fact
  (`missing_fact`), a source changed behind its fact (`stale_fact`), a superseded
  or retired source whose journal still stands. It shares the drill's journal
  comparison, so the two agree on every fact both read.
- **Nightly schedule** (`runScheduledLedgerRebuildDrills`): the narrowed proof of
  what changed since each company's last proof, and the full drill when the last
  one is a week old, least recently proven first, within the maintenance budget.
  Damage written around the application's timestamps is the weekly drill's job.

- **What the proof compares.** Each current fact against the entry standing for
  it. A reversed entry stands in only for a fact a later revision superseded; a
  current fact whose entry was reversed and not replaced is `missing_journal`,
  because its source is off the books.
- **Repairing what it finds** (RESTORE-01 `proof-repair-and-close`). With the
  bookkeeper's own tools, never by editing rows: reverse the entry that no longer
  matches its source (`journal_divergence`) or has no source
  (`unexpected_journal`) with the reason, then run the projection. A source whose
  entry was reversed or lost (`missing_journal`) is posted again from its
  unchanged fact; the reversed entry keeps the original posting key, so the
  repost takes `<key>:repost:N`, which the proof reads as the same entry. The
  proof then passes, the controls tie, and the month closes.

## Month-end review reads

The close checklist and the as-of statements read ledger totals, job-cost
totals, clearing positions and which jobs carry cost from database functions
(`books_ledger_balances`, `books_job_cost_subledger_by_project`,
`books_account_positions`, `books_projects_with_posted_cost`), not every line
since the company began. The AP and AP-retainage tie-outs read each payable bill
once. Reports over a window (P&L, general ledger) still load that window's entries.
