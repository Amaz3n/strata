# Arc Books sole-ledger release

**Current implementation status (2026-10-04): the October Books expansion remains
in progress.** Reviewed payroll posting now preserves original native labor
ownership: changing consumed wage/cost inputs or reversing their original labor
journal requires a coordinated correction. Notes, approved time status changes,
invoice links and harmless projection refreshes remain available in construction
workflows. Operational ownership exposes source IDs through existing source
permissions; provider registers, salary amounts and review evidence remain private.

Initial payroll drafts now include a private, paginated supporting-version picker
and explicit journal allocation or exclusion decisions in Project Time Payroll.
Signed claims identify the worker allocation, prior event and both original journal
lines. Preview verifies original retained document bytes and rejects incompatible
accounts, directions and ownership; preparation pins that proof and creates only
an unapproved attribution draft. Browser acceptance covers exclusions, a rejected
claim, preparation and parent-withdrawal cascade with financial records unchanged.
Saved attribution now has bounded private history, exact selected/permanent links,
original decisions/claims/document versions, independent review and withdrawal.
Reload recovers retained decisions and blocks conflicting preparation; confirmed
approval retries recover the original reviewer intent through later changes or
withdrawal. Viewing history requires frozen integrity proof without current blobs.
Scoped browser acceptance covers lost prepare/review/withdraw responses, explicit
replacement and parent withdrawal while retaining prior reviews and financials.
Private supporting PDF uploads and the complete initial monetary workflow remain
unfinished. Full authenticated application, current full-schema, concurrency,
live storage and restore acceptance of this slice remain pending.
Current scoped SQL and browser fixtures do not prove full-schema replay or live
R2 privacy and retention. The full Books implementation goal remains active.

The replacement-register correction preview reads the retained corrected document
version, verifies its bytes and controls, and compares the full corrected register
with the latest proven monetary register in the original posting lineage. It produces signed GL and project-cost changes
without reconciling native labor again, changing customer billing or inferring cash
payments/refunds. Project reallocations keep both cost legs. Worker overpayments,
new liability movements, changed budget/billing scopes and tax changes require
review. Corrected provider sources now retain immutable documentary revisions,
original version/worker/column mappings, original account classification, preparer
and independent source review/withdrawal history. SQL validates provider and
allocation controls and protects original documents. Same-intent retry recovers
the source after a lost response without needing storage. Private SQL now
independently reconstructs provider-only correction journals from the proven
original register and reviewed corrected source, including exact-cent withholding
shares and both sides of project/worker/account reallocations. Scoped PostgreSQL
tests compare the complete ordered journal with the application preview, including
wage decreases, changed withholding, split allocations, inventory and overhead.
The calculation writes no money. Source review does not approve a journal or post
a correction. Correction preflight now independently derives project costs and
worker liabilities in SQL, captures current budget/GMP/billing/chart/calendar and
complete liability-journal evidence, and holds source/calendar fences inside the
caller transaction. It preserves unresolved allocation, cost-plus, tax, settlement
and overpayment decisions. The authorized service compares SQL arithmetic and
dependencies with the application planner, rejects changed evidence, and reports
that preflight locks have expired. Scoped tests cover rollback and advisory lock
release; genuine multiple-session contention remains unverified. A service-role
regression also fixes unnecessary row locks on immutable posting receipts, without
granting receipt update privileges; source preparation/review and preflight now
execute under the private service ACL. Separate correction posting proposals now
persist the independently computed complete source, journal, project-cost,
liability and construction context with immutable preparation and monetary review
history. Review requires a different actor from every preparer, rechecks original
provider bytes and current dependencies, and cannot clear unresolved business or
accounting decisions. Source withdrawal withdraws unposted proposals while keeping
their original review. Confirmed retries recover after lost preparation/review
responses and retain historical approvals without claiming current readiness.
The first reviewed replacement-register correction now posts its adjusting journal,
accounting fact, signed project costs and immutable receipt in one transaction.
Current source, accounting calendar and construction evidence are rechecked inside
the money transaction, including at receipt insertion. An injected cost failure or
late evidence change rolls every write back. Posted corrections cannot be
withdrawn, independently voided or reversed only in the GL. Exact committed retries
verify actual money and recover without provider storage, including after later
calendar, budget or chart changes. Job-cost detail labels the correction and links
back to the project's time workflow.

Sequential monetary corrections now use the latest actually posted corrected
register, independent of documentary source revision numbers. Each reviewed
proposal binds the predecessor receipt, its source/digest and the next monetary
sequence; signed project-cost and liability deltas compare that actual baseline
with the new register. Remaining unpaid payroll uses the original reviewed payment
position plus all actual corrections. A partially reduced unpaid balance can post;
amounts requiring employee/provider recovery remain blocked. Project costs inherit
the latest actually posted placement, while original native time and customer
billing stay intact. Proved prior correction journals are attributed to this
history; other settlements still require separate review. Later correction dates
cannot precede the latest actual monetary journal.

The money transaction claims a proposal's posted receipt and releases its active
reservation only with deferred proof of the exact actual journal, fact, signed
costs and immutable receipt. Both money and this claim roll back on failure.
Missing, branched, cyclic or mismatched monetary history is rejected. Historical
retries prove the specific original chain prefix without treating later payroll
corrections as stale evidence. Original schema-16 first receipts are preserved and
can acquire their proved reservation during migration or an explicit recovery
plan; neither process invents a new money posting.

New/reallocated budget and GMP decisions, cost-plus and protected customer billing
decisions, tax and overpayment recovery, supplemental/voided runs and native time
correction remain unfinished. These are private service operations; integrated
payroll review/post/status screens remain unfinished.

New correction approvals now capture version-two commercial context: the current
project status, financial setup, contracts and closings, alongside budget and
native billing evidence. Completed or cancelled projects and closed homes require
explicit late-cost and customer-settlement decisions. Missing financial setup,
ambiguous active contracts or a current billing policy outside the supported T&M
preservation path block review. Changing any captured contract or closing evidence
after review invalidates new posting. Project/settings/contract/closing writers
participate in the source fence, including newly inserted rows. A closing inserted
during cost writes rolls the whole correction back. Earlier posted approvals retain
their original evidence and retry behavior; earlier unposted approvals need fresh
commercial review. Scoped PostgreSQL and archive regressions verify these controls;
the remaining billing, settlement and late-cost resolution workflows remain unfinished.

New or reallocated cost legs now support explicit budget/GMP placement decisions
within the immutable monetary proposal. Each decision identifies the exact worker,
allocation, project, cost code, account and provider component, selects a scoped
budget line or explicitly unbudgeted placement, specifies GMP classification and
preserved T&M billing, and records an explanation. SQL and the application each
require complete, unique choices for all affected legs. The independent monetary
reviewer approves those choices with the provider evidence and signed amounts.
The selected budget rows become frozen dependencies and are revalidated under
transaction fences before posting. Late changes roll back all monetary writes;
future corrections inherit the actual posted placement. Historical retries retain
the original decision after later budget changes. This resolves placement for the
supported T&M preservation path; it does not resolve cost-plus billing, closed-home
settlements, tax corrections or liability recovery, and the integrated review UI
remains unfinished.

Project Time and the financial Cost Inbox now link authorized accountants to a
project payroll-correction workspace. It lists existing corrected registers, shows
full provider controls and worker allocations, and reviews both sides of
cross-project signed costs. Source review, explicit placement preview, immutable
monetary preparation, independent review, posting and withdrawal use the actual
private services and scoped server actions. Changed evidence disables review and
posting; posted history remains readable after later budget/project changes.
Operative amounts preserve exact cents. Job-cost correction rows deep-link to the
specific source. Salary evidence requires whole-organization accounting access
before any private snapshot read, including direct links and action calls.
A real Chromium fixture exercises the actual component with Arc styles, server
actions, services, retained CSV bytes and scoped production SQL, including retry
after an unreadable response following preparation. Authentication and transport
are explicit fixtures; this is not full-schema or live application acceptance.
Project register lists now use a private keyset page of at most 50 sources, with
an explicit older-register control. A dedicated MVCC read captures the complete
proof for selected payroll roots and their native sources instead of exporting
unrelated invoices, payables, banking, tax, warranty and recovery records. Exact
source/proposal actions use the same project-scoped read. Original-project and
prior destination-project access both retain the complete cross-project register.
Organization-wide payroll liability movements and all selected-root correction
ancestry remain present because dropping them would weaken settlement and
historical proof. Empty pages avoid loading that history. Current monetary
preflight/import/posting services still use broader snapshots; replacing those
reads and scaling long payroll/liability histories remain unfinished.
Corrected-register upload/mapping, scalable provider processing and remaining
correction decisions still need implementation.

Provider-document privacy now has a separate storage foundation. Migration
`20261004055553_books_private_payroll_documents.sql` restricts retained payroll
files, versions and file links from ordinary authenticated document queries,
protects file identities, and marks newly prepared provider sources private.
Generic preview, cached-preview and signed-download routes reject these files.
The payroll review workspace links to an accountant-only download that stages and
verifies original version bytes before returning them. Archive preparation applies
the same private metadata without changing the original archive or accounting proof.

New upload preparation reserves immutable file/version identities and signs a
five-minute create-only PUT into `R2_PAYROLL_BUCKET`. Finalization verifies the
original actor, organization, exact byte length and SHA-256. Identical retries
recover the existing object; changed bytes or identities cannot overwrite it.
Project Time now includes the private original-upload and provider-column mapping
screen. Its server inspection verifies every source column, row kind, consistent
provider/run/dates, unique employee references, exact-cent amounts, employee gross
versus net/deductions, independent control totals and funding before displaying
provider totals. Mapping edits clear the displayed verification. Upload retries
retain the original identities and verify create-only storage conflicts.
Initial construction/overhead allocation, native labor reconciliation and unapproved
draft preparation are now available below the verified worker/labor selection.
The complete provider review and posting flow remains unfinished.
The intake and existing correction Chromium fixtures exercise actual components,
actions, services and scoped SQL with explicit authentication/transport/storage
fixtures. Desktop/mobile layout and retry are verified locally. Live storage and
full application/full-schema acceptance remain pending.

The intake now matches provider references to explicit native workers and shows
the verified original labor available for allocation. A private service-only
invoker directory returns at most 50 distinct workers per keyset page, retaining
historical memberships and returning no profile rates. Its literal name/email
search and membership deduplication are SQL-tested. Whole-organization accounting
permission and project scope precede directory and labor reads.
The same native-labor selector powers initial reconciliation and this read: it
checks approved time, original job costs, frozen wage/burden decomposition,
classification, journal completeness and posting freshness. Missing or changed
evidence fails rather than creating an empty, apparently unrecognized population.
The screen identifies labor already included in an actual payroll posting;
mapping changes and source retries clear the previous labor preview.
No allocation, draft or money is created by this discovery step. These worker
reads still use the broader accounting snapshot for labor/ownership proof;
replacing it with a complete scoped capture remains necessary for large ledgers.
Deploy `20261004064206_books_payroll_worker_directory.sql` before enabling the
directory actions. This migration has only scoped SQL acceptance here, not current
full-schema or live-application acceptance.

Initial allocation now requires an explicit project or overhead choice, cost code,
active cost account and exact-cent gross, employer taxes and benefits for every
provider employee. Capitalized project WIP is available alongside expense and COGS
accounts; WIP cannot be assigned to overhead. Original labor must match the worker
and allocation dimensions and cannot be selected in two rows. Full provider totals
can be copied only by an explicit action; the server rejects incomplete or excess
allocations. Labor already consumed by another register blocks both allocation
preview and direct preparation.

Reconciliation rebuilds provider bytes, native labor, construction impacts and
liability history on the server. Preparing an unapproved draft requires the exact
preview evidence digest; changed proof fails before the preparation RPC. An exact
retry still recovers an already committed draft before attempting fresh source
reads. Browser acceptance exercises a lost reply after successful preparation and
verifies that retry returns the same single draft. Preview and preparation leave
journals, job costs, posted facts, time, billables and actual payroll postings
unchanged. Drafts do not reserve native labor ownership; posting must still enforce
its atomic ownership controls.

Initial draft discovery, frozen-evidence detail, persistent links, separate source
review and withdrawal are now integrated into Project Time. Construction
placement/billing decisions, liability attribution, monetary proposal, posting
and posted-register status retrieval remain necessary to complete this flow.
The current UI prepares a draft but does not represent it as approved or ready to
post. Initial reads still capture broader accounting populations. Provider
adapters and large-ledger capture remain pending, as do current full-schema,
live private-storage and full-application acceptance.

The private draft workspace returns at most 50 retained, unposted imports per
prepared-time/UUID keyset page. Project allocations appear on every affected
project; registers consisting entirely of organization overhead are shared across
project workspaces under whole-organization accounting permission. Posted parents
are excluded. Exact draft links fetch older rows independently of the first page.
The prepared-draft link selects an affected project even when all allocations were
moved away from the intake project. Original preparation/review/withdrawal notes,
provider control amounts, construction dimensions and native wage/burden proof
remain visible after refresh. List and detail validate original frozen accounting
digests before exposing them; the client receives compact review data rather than
raw workflow source tables. Metadata labels are scoped to selected dimensions.

Separate source review invokes the existing fresh-provider/native/workflow evidence
checks and cannot self-review. Withdrawal retains history and uses the original
atomic transition and dependent-proposal withdrawal controls. These actions do not
post journals, job costs, time or billables. The browser scenario uses actual
private upload, preparation, review and withdrawal SQL, with explicit authentication,
transport and R2 fixtures, and verifies refresh and a second accountant identity.
Deploy `20261004073018_books_payroll_draft_workspace.sql` before enabling these
reads. Its dedicated ten full-schema pgTAP assertions are prepared but unexecuted;
scoped SQL pagination/authorization tests do not prove full-schema acceptance.
Large source registers and organization liability histories still require additional
scaling and current full-application acceptance. Current posting decisions remain
separate controls and reviewed source does not mean ready to post.

Payment-attribution supporting documents now receive the same payroll privacy
rules as provider registers. Migration
`20261004074806_books_private_payroll_payment_documents.sql` backfills every retained
payment-review proof, including withdrawn history, and atomically marks supporting
files private when a new review is prepared. Ordinary document, version and link
queries lose access; file identity and sharing guards preserve the retained source.
The storage classifier also checks original paths directly from frozen payment
proofs, in addition to current files and versions. The proof-path lookup is indexed.

Restore preparation includes supporting payment documents in its recorded privacy
changes, preserving the original archive, versions, paths, checksums and attribution
and ledger rows. Scoped tests exercise actual preparation SQL, backfill, RLS,
service classification, immutable identity/sharing restrictions and a populated
versioned archive. Six dedicated full-schema pgTAP assertions are prepared but
unexecuted. This migration and recovery behavior protect application access;
existing external public copies, cached bytes and previously issued URLs still
require an actual relocation/revocation audit. General payment-document upload,
selection and signed-source review must still be integrated into the payroll flow.

Initial draft details now expose the retained organization liability journals and
every original debit/credit line, with signed wage/deduction movements and frozen
versus captured-chart classification. They explicitly do not claim a register's
unpaid balance. No org-wide balance, journal date or payroll tag automatically
assigns a movement to a worker or allocation. The client receives only the compact
journal/line review fields, not original workflow source tables.

Payment-attribution preview now validates the current provider/native/workflow
proof, every supporting version and original document bytes before rebuilding the
signed claim evidence. Project actions require whole-organization accounting and
enabled-module access, project relationship and an exact preview evidence digest
for new preparation. The preparation RPC cannot be reached with a mismatched pin.
Committed identical requests recover before fresh-source/blob reads; immutable
project relationship checks remain available after posting or withdrawal so the
project wrapper does not break that retry contract. Preview does not reserve line
capacity, approve attribution or post money; SQL preparation still independently
checks global source-line reservations.

The evidence display and backend preview/pinned preparation are implemented, but
the supporting-document picker/upload, signed-claim entry, saved-attribution detail,
independent attribution review/withdrawal and monetary proposal/posting controls
still need their integrated UI and full-application acceptance. Supporting-byte
preview tests invoke the actual streamed SHA-256/size verifier with explicit
transport/auth/blob fixtures; they do not prove live R2
or full schema. Current construction placement and calendar gates remain enforced
by posting services and are not resolved by viewing these movements.

Deploy the privacy migration before the application changes: storage classification
fails closed if its RPC is unavailable. Configure a separate `R2_PAYROLL_BUCKET`
with public custom domains and `r2.dev` access disabled, and allow the application
origin's PUT requests with Content-Type, If-None-Match and Cache-Control headers.
Keep R2 credentials server-side. Cloudflare documents the
[conditional PUT API](https://developers.cloudflare.com/r2/api/s3/api/),
[presigned uploads](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) and
[public bucket settings](https://developers.cloudflare.com/r2/buckets/public-buckets/).
No bucket was created or its remote privacy/CORS configuration verified here.
Existing legacy public/CDN objects and cached or previously issued links require
an explicit relocation, revocation and access audit; application restrictions
alone do not remove those copies. Do not claim legacy storage privacy or complete
16 MiB browser-to-R2 upload acceptance until those drills pass.

Tax changes require provider correction evidence and the applicable filing review;
the preview does not calculate payroll taxes or transmit returns. The IRS describes
separate adjusted-return procedures and restrictions for correcting employment
taxes, so a changed register alone is not treated as a refund authorization.
[IRS: Correcting employment taxes](https://www.irs.gov/businesses/small-businesses-self-employed/correcting-employment-taxes).

Export schema 17 includes native ownership, corrective money receipts, corrected provider source history and
frozen corrective monetary proposals, with original CSV replay and separate
recovery proof. Context hashes normalize equivalent numeric scales across HTTP
transport and restoration; canonical proposal/context text preserves reproducible
hashes. Scoped restoration compares every archived table, restores review/withdrawal
history, reenables guards and proves historical retry after current budget/billing
changes. Monetary predecessor/sequence and posted-proposal claims are verified
alongside actual money. Legacy schema 16 recovery derives a posted proposal claim
only from its independently verified original correction receipt, while retaining
the original archive. Older schema 14 archives may omit the new proposal table. Older schema 12 posted-payroll archives
can produce explicit recovery mappings only when the frozen wage basis and actual
original fact, journal and receipt still agree. Generated columns are omitted from
insertion plans and retain archived values for integrity comparison; regenerated
database values must be compared after insertion. Scoped PostgreSQL tests verify
posting rollback, role permissions, archive checks and restored retries. The new
migrations have not been applied to application databases. Full-schema and multiple
session acceptance, coordinated corrected/supplemental payroll, integrated review
and posting screens, and real builder/independent CPA acceptance remain required.

**Historical controlled-release implementation baseline (2026-08-12).**

**Production schema status: applied 2026-08-12 ET (2026-08-13 UTC).** Arc Books
must not be presented as the official ledger for an organization until the
remaining database-test, restore, real-data, and organization cutover gates below
have completed.

## Supported sole-ledger boundary

After the activation gates pass, Arc Books can be the only accounting ledger for a
US construction builder that operates one legal entity, in USD, on accrual basis.
Banking, card/ACH processing, payroll calculation, and tax transmission may remain
specialized external *rails*; they do not own a second general ledger. Their final
accounting entries and control balances live in Arc.

This release is not a fit for consolidated multi-entity reporting, foreign
currency, manufacturing inventory, or an employer that expects its accounting
product to calculate payroll or transmit tax forms itself. Those are explicit
product boundaries, not hidden fallback dependencies on QuickBooks.

## Builder journey

### 1. Establish the workspace

An authorized administrator enables Books, assigns accountants and a read-only
reviewer, confirms the functional currency and policy, creates accounting periods,
reviews the governed chart, configures tax jurisdictions, and maps every bank/card
account to its GL control account.

There are two activation routes:

- **Greenfield:** attest to a zero or posted opening position, prove there is no
  active external accounting connection, resolve drafts and unmapped banks, and
  atomically make Arc official.
- **Existing books:** import and dual-approve opening balances, run the rebuild and
  reconciliation controls in shadow mode, enter parallel close, compare three
  clean closes spanning a quarter using imported/provider trial balances, obtain
  independent approval, then perform governed cutover.

No manual database edit is part of either route.

### 2. Run daily accounting

- Payables enter once, carry project/cost-code/use-tax coding, follow approval and
  lien-waiver controls, and reach AP, job cost, 1099 totals, and payment runs.
- Receivables, pay applications, retainage, revenue basis, receipts, credits, and
  reversals flow into AR and contract accounting without duplicate journal entry.
- Earnest money remains a customer-deposit liability until it is applied or
  refunded. Application cannot cross customer/project or exceed the available
  deposit.
- Customer receipts land in **1010 Undeposited funds** net of withheld fees. The
  actual grouped bank deposit clears 1010 from the bank tray, so bank cash changes
  only when settlement appears at the bank.
- Field labor and approved costs feed the job-cost subledger; the GL derives from
  the same grain. Accrued purchase use tax is allocated by deterministic
  largest-remainder math, so job profitability, cost-plus billing, and GL control
  stay equal to the cent.
- Loans and fixed assets use immutable registers. Draws, payments, interest,
  acquisition, depreciation, and disposal post the register event and journal in
  one transaction.
- Hand-authored adjustments are proposals. Another user with adjustment authority
  must approve or reject; the maker cannot self-approve.

### 3. Reconcile and close

The banking tray matches existing cash lines or posts a categorized bank entry.
Manual statement files are accepted when a feed is unavailable. A period cannot
close while bank transactions are unresolved, bank/card statements are not closed,
journals or proposals are pending, clearing balances remain, projection/rebuild
findings are open, tax coding is missing, depreciation is missing, or GL controls
do not tie to AR, AP, job cost, retainage, customer deposits, debt, fixed assets,
and accumulated depreciation.

WIP/POC is captured through period end and revenue recognition is posted from that
as-of evidence. Statements and the close digest are produced only after the gates
pass. Reopen and year-end close remain governed and auditable.

### 4. Tax, reporting, and continuity

The Accountant workspace exposes jurisdiction summaries, filing evidence, W-9/TIN
exceptions, and accountant packages. Complete taxpayer IDs are created or rotated
inside Supabase Vault by service-only RPC; application data and logs retain only
last-four and verification state.

Complete exports include the journal, facts, subledgers, bank history, registers,
tax evidence, close state, mappings, operational sources, audit log, and a checksum
manifest for supporting files. Application exports deliberately exclude complete
taxpayer IDs and provider credentials. Same-project/PITR restores preserve Vault;
manual cross-project restores must also move the Supabase Vault root key under the
documented privileged procedure.

## Applied production migration train

Applied to the Arc production project through Supabase MCP in the reviewed order:

1. `20260812120508_harden_payable_payment_lifecycle.sql`
2. `20260812120755_books_release_hardening.sql`
3. `20260812124629_normalize_payment_permission_domain.sql`
4. `20260812145420_books_reviewer_role.sql`
5. `20260812145621_finish_ap_launch_readiness.sql`
6. `20260812145624_receivables_foundation.sql`
7. `20260812150201_books_sole_ledger_operations.sql`
8. `20260812152631_receivables_books_tax_hardening.sql`
9. `20260812152902_receivables_atomic_revisions.sql`
10. `20260813011630_books_post_apply_advisor_hardening.sql`
11. `20260813011809_books_receivables_table_privilege_lockdown.sql`

The sole-ledger migration enables Supabase Vault, creates the operational
registers, and installs service-only atomic functions. It must be security-reviewed
with particular attention to function grants, RLS, Vault privileges, and the
maker-checker boundary.

## Mandatory activation gates

- Reapply the complete migration train to an isolated database and run all pgTAP
  suites, including `books_release_hardening.test.sql` and
  `books_sole_ledger_operations.test.sql`. The production project does not have
  pgTAP installed, and a test-only extension was not added to production.
- Run schema lint/advisors and verify every new RPC remains revoked from `public`,
  `anon`, and `authenticated` unless explicitly designed otherwise.
- Seed a representative builder and exercise invoice → receipt → grouped bank
  deposit, bill → approval → payment → bank match, customer deposit → application
  and refund, loan activity, fixed-asset lifecycle, use tax, maker-checker journal,
  period close/reopen, and year-end close.
- Prove the full rebuild produces the same fact/journal hashes and all blocking
  control tie-outs are zero.
- Generate a complete export, restore it into an isolated organization/project,
  verify supporting-file checksums, run the rebuild drill, and confirm Vault
  identities remain readable through the approved privileged path.
- Confirm production cron authentication and monitoring, bank-feed webhook
  verification, payment reconciliation alerts, database backups/PITR, and an
  incident owner.
- Obtain opening-balance/cutover approval from the builder and their accounting
  professional. Record their support-boundary acceptance and first-close owner.
- Only then execute greenfield launch or parallel cutover and mark Arc the official
  ledger.

## Earlier rollout evidence

The following historical checkpoint does not cover the current payroll migrations
or establish completion of the October Books expansion. Current evidence and
remaining requirements are recorded in `books-implementation-progress.json`,
`books-full-schema-acceptance.json` and `books-restore-runbook.json`.

- TypeScript: `tsc --noEmit` passes.
- Repository-wide lint passes.
- Financial regression: **512 tests pass**.
- Full Node suite passes.
- Bun library suite: **20 tests pass**.
- Arc Books focused suite passes, including the new settlement, deposit, tax,
  register, Vault, and role controls.

The complete production migration train was applied through Supabase MCP with
explicit user authorization. Metadata verification confirmed all 11 migration
records, all 12 new tables with RLS, validated constraints, Vault availability,
service-only mutation privileges, and no enabled payment policy with missing risk
limits. pgTAP tests remain for an isolated database because Docker is unavailable
locally and pgTAP is not installed in production. No build/dev server was started.

The final privilege audit also moved invoice create/update, commercial approval,
void/revision, and delivery-state writes behind the service boundary after their
application permission checks. Their database functions are revoked from
`public`, `anon`, and `authenticated`.

## Completion program

The original full Books goal follows
`advisor-plans/013-arc-books-completion-to-100.md` and its companion checklist.
All applicable package definitions and G1–G7 govern completion, including native
legal entities, intercompany/consolidation, actual licensed-CPA review and real
builder parallel closes. Local or single-entity fixture acceptance cannot close
the full goal. The current goal remains active.

## Release decision

The current October Books expansion is not yet verified for a sole-ledger release.
Payroll import/setup and remaining billing, settlement, tax, inventory, legal-entity
and acceptance workflows still require implementation or verification. No organization should be represented as live
on Arc as its official ledger until its remaining activation drills, approvals,
and greenfield/parallel cutover have completed. This distinction must remain
visible in sales, onboarding, and support communication.
