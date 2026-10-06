# Legacy ownership inventory

The native entity registry does not assign ownership to the existing ledger.
Before preparing a reviewed ownership proposal, retain a complete current schema 19
archive and produce its exact population inventory:

```sh
node scripts/prepare-books-ownership-inventory.cjs \
  /path/to/complete-books.json.gz /path/to/new-private-inventory.json \
  ORGANIZATION_UUID 2026-09-30
```

The offline command verifies the archive's existing journal, relationship,
entity, payroll and original-document contracts before creating output. It
requires every current export table, rejects unknown tables and never loads
environment files or connects to a database. Output is created exclusively with
mode 0600; an existing review receipt cannot be overwritten. Plain JSON and gzip
archives are supported.

The receipt pins the entire archive, every table population and each original row
by ID and hash. It does not copy monetary values, salary details, tax identifiers
or document bytes into the inventory. Audit-log IDs remain exact positive decimal
strings, including values above JavaScript's safe-integer limit. The pending
`20261004180803` capture migration converts row identities to strings in SQL
before JSON transport; original database column types and values remain intact.

Accounting cutoff records the intended review date. No rows are omitted by date,
status or a current project assignment: undated, future, reversed, retired and
unposted retained evidence still belongs in the review. A subsequent exact
archive comparison detects additions, removals and edits, including checksummed
source changes and archive ordering changes. The original receipt remains intact.

This offline receipt is an **UNREVIEWED preparation inventory**, with no entity
assignments or ledger-activation approval. It covers the current export populations,
not every table in Arc. A hash proves unchanged evidence; it does not prove the
proposed legal owner or complete business meaning.

## Durable assignment preparation and review

Pending migration `20261004181652` and the legacy entity ownership service add
immutable preparation and independent review. An active entity preparer selects
the current independently reviewed identity, accounting cutoff and original
supporting document versions, explains the basis and explicitly confirms that the
retained legacy history belongs to this one entity. Ambiguous shared history
requires explicit split/correction work; the single-entity confirmation cannot
be omitted or replaced by a provider label.

The server streams the selected original document bytes against their retained
version metadata before preparation, compares the resulting metadata with the
frozen SQL receipt, and verifies the prepared originals again before a new
approval. A distinct active entity reviewer approves the original proposal. Both
organization Books permission and explicit entity access are required; full
retained evidence additionally requires Books export permission and access to
every included entity. Browser roles cannot read or write these tables/RPCs.

SQL captures the retained accounting-export population in one snapshot, excluding
its own proposal/review tables to prevent recursive history and self-induced
staleness. It records the exact original JSON text, SHA-256, capture time and
PostgreSQL visibility snapshot. The existing typed company tax-ID and funding
provider-handle redactions also apply inside this text. This is not a claim that
unstructured notes, audit payloads or original PDFs have complete privacy
classification; that remains part of B06's unfinished work.

New approval rejects changed retained data, original document metadata, reviewed
entity identity or reviewed predecessor. Source-table SHARE locks and an active
membership fence remain held through transaction end. Review retains its own
recheck time/visibility and the exact approved population hash. Native contention,
deadlock and throughput acceptance remain pending; a scalable ownership/write
fence must replace broad population locking before ledger activation. Retained
JSON text currently has a 256 MiB preparation limit and does not satisfy the
program's larger capacity target.

Exact committed retries preserve original receipts after later changes. The detail
read reports whether the **database population** is still current and always
returns `approvedForLedgerActivation: false`. That freshness flag does not prove
current storage availability. Missing/corrupt original objects fail verification
for a new approval; committed review retries do not reapprove new money or depend
on a later object read.

Schema 19 captures both history tables. Its verifier checks original-text hashes,
source identities/table populations, entity/profile/access/document closure,
microsecond authorization time, separate reviewer and nonbranching predecessor
history. Existing original-document verification still checks retained bytes.
Restoration supplies explicitly reviewed organization/actor dependencies and
preserves the original proposal text, IDs and authority; older archives receive
empty history tables, never invented approvals.

The pending entity workspace at `/books/entities` exposes entity creation, active
member access grants, legal identity preparation and independent review, and
retained ownership proposals. Its private readers paginate 25 summaries or
original document versions per page. Identity administration does not require
export permission; inspecting complete ownership evidence requires Books export
permission and explicit read access to every included entity. The page retains
selected original version names across searches, enforces the 50-version limit,
and removes setup forms when refreshed access fails. It displays all prepared
identity fields and ownership basis, source counts, selected original provenance,
and database freshness before independent review. Full captured populations stay
on the server. Request IDs persist for retries within the mounted form and clear
after confirmed success; persisted proposal lists support discovery after reload.
Cold browser recovery and authenticated interaction acceptance remain unverified.

Each retained original now has a download link. The server checks Books read/export
and current entity access, resolves the selected version from frozen proposal
evidence, verifies exact size and SHA-256 while staging private bytes on disk,
and rechecks current Books/entity authority before returning them. Changes to a
current file pointer or live version metadata cannot replace the approved original.
Downloads use private no-store attachment responses; corrupt/missing originals
return a sanitized failure without storage details. Temporary staging is removed
on completion, cancellation or verification/access failure. This is a verified
download path, not an in-app document preview or authenticated browser acceptance.

Provider-routing evidence outside the export, explicit source/control ownership, ledger
writer/reader enforcement and balance/population conservation before cutover
remain unfinished. Approval
of this intent does not relabel sources, accounts, journals or periods, activate a
second ledger, or grant permission to rewrite posted history.

The command currently inherits the existing in-memory archive verifier. It does
not meet Plan 013's large-archive streaming/capacity target. Native full-schema,
authenticated workflow, populated company upgrade and complete recovery acceptance
remain required. The local bigint regression executes actual capture SQL and
restores exact decimal identities into a PostgreSQL-compatible bigint target; it
is not a complete native recovery drill.
