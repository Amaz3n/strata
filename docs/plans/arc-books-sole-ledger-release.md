# Arc Books sole-ledger release

**Implementation status (2026-08-12): code-complete for controlled release.**

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

## Verification evidence in this workspace

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

## Release decision

The application code and production schema now support Arc as the sole accounting
ledger within the boundary above. No organization should be represented as live
on Arc as its official ledger until its remaining activation drills, approvals,
and greenfield/parallel cutover have completed. This distinction must remain
visible in sales, onboarding, and support communication.
