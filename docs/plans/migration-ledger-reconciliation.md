# Migration ledger reconciliation — repo vs production

> **Status: WORKING DOCUMENT (WS-A5).** Temporary. Delete it together with
> `docs/plans/arc-pay-readiness-gameplan.md` once the repair has run and
> `pnpm db:ledger:check` passes against production.

**Re-measured 2026-09-05**, read-only, against production. The 2026-09-01 figures
below were re-derived from scratch rather than trusted, because Phases E, F and G
were applied in between.

**Repository:** 359 migration files. **Ledger:** 330 rows, 321 distinct
normalized names, 9 still duplicated.

| | Files |
|---|---|
| Exact version + name parity | 81 |
| Applied, recorded under a fresh MCP version | 239 |
| No ledger name match, verified applied at the object level | 29 |
| **Genuinely pending** | **10** |
| Total | 359 |

Every one of the 29 was re-verified in production on 2026-09-03 by checking its
own object, not by trusting the earlier pass. The repair script's map is
generated from this split and asserts that no file is recorded as applied without
either a ledger name match or an object check.

## The problem in one paragraph

Migrations applied through the Supabase MCP are recorded under a **fresh
timestamp**, not the repository file's own version. The changes land, but the
ledger's version numbers match no file on disk, so `supabase migration list`
reports the file as unapplied forever. At the first audit, 290 of 326 repository
versions were absent from the ledger for this reason. Nine migrations were additionally applied twice
on 2026-08-13, leaving duplicate names. In this state `supabase db push` would
try to replay hundreds of already-applied migrations against production, and the
QA runbook's precondition ("the migration ledger contains no duplicate repository
versions") is false.

The repair script contains the canonical version/name table for all 342
known-applied files; that table is the executable, reviewable per-file mapping.

**Two files moved out of section A on 2026-09-03.**
`20260817120300_validate_bid_package_award_target` is applied — both
`bid_packages` constraints are `convalidated` and no row carries a project and a
prospect together. `20260901120000_payment_run_submit_execute_lockdown` is
applied — `submit_payment_run_atomic` now carries only
`postgres=X, service_role=X`, so the anon exposure WS-A3 found is closed.

**One nearly moved out and should not have.** A first check read
`invoices` constraints with `conname like '%status_check%' limit 1`, which
matched `invoices_approval_status_check` and reported
`20260829120000_billing_lifecycle_and_command_permissions` as applied. The real
`invoices_status_check` still permits `saved`, and six invoices still hold that
status. Name-pattern checks with `limit 1` are not object verification.

## A. Genuinely NOT applied (10 files)

Verified absent at the object level. These are real schema changes that have
never reached production. Apply them normally, reviewed, one at a time. **Do not
record them in the repair script** — that would tell the tooling a change shipped
when it has not.

| Migration | Verified by | Consequence today |
|---|---|---|
| `20260813030000_payment_reconciliation_run_idempotency` | both unique indexes absent | A retried or concurrent reconcile duplicates runs and exception items for one period. |
| `20260813030100_payment_ledger_balance_error_detail` | `post_payment_ledger_transaction_atomic` body lacks the new message | Cosmetic, but proves the prod ledger RPC is not the repo's version. |
| `20260813040000_remove_dead_vendor_identity_lockout_columns` | `vendor_portal_identities.password_attempts` still present | Dead columns survive. |
| `20260731150000_desk_rollup_counts` | table `desk_rollup_counts` absent | Outside the payment slice. |
| `20260724120000_warranty_completion_coverage` | `closeout_packages.substantial_completion_date` absent | Outside the payment slice. |
| `20260818170000_prequalification_waiver` | waiver columns absent, status check has no `waived` | Outside the payment slice. |
| `20260827121000_project_optional_vendor_bills` | `vendor_bills.project_id` is still `not null` | Outside the payment slice. |
| `20260829120000_billing_lifecycle_and_command_permissions` | invoice status check still permits `saved` | Outside the payment slice; six live invoices still use the old status. |
| `20260901120100_payment_money_widening_and_fk_indexes` | `payments.amount_cents` is still `integer`; FK indexes absent | Removes the AP amount ceiling ($21,474,836.47) and hot-path FK gaps. |
| `20260902141500_compliance_autopilot_deficient_reminders` | `compliance_autopilot_deliveries_reminder_kind_check` has no `deficient` | Written after the first audit. A vendor whose certificate is on file but short of the required limit is never chased. |

`20260813000500_manual_ap_payment_reversal` was genuinely pending during the
first audit and was applied on 2026-09-02. The repair map records it under its
canonical repository version and removes the MCP-stamped version.

## B. Applied, recorded under a different version (233 files)

These have a production ledger row with the same normalized name, which is the
database's own record that the migration ran, but the MCP-generated version does
not match the repository version. The canonical mapping is the 331-row temporary
table in `supabase/scripts/repair-migration-ledger.sql`; the repair inserts each
repository version with empty statements and removes its stamped copy.

## C. Applied at the object level despite no ledger-name match (29 files)

These were the ambiguous set requiring an object-level check. The repair map
includes them because the relevant table, column, function, constraint, bucket,
or permission exists in production. Twenty-three were resolved in the first
pass, and all of them re-verified on 2026-09-03:

`accounting_sync_attempts`, `add_project_cost_code_toggle`,
`backlog_report_spec_and_closing_fix`, `bid_management_workflow`,
`books_accounting_foundation` (ledger name `arc_books_accounting_foundation`),
`books_balance_trigger_row_type_fix`, `compliance_documents_metadata`,
`compliance_system_hardening`, `directory_relationship_labels_by_tier`,
`directory_write_permission_grants`, `drop_plaintext_tokens`,
`invoice_lines_budget_line_linkage`, `photo_records`, `platform_bugs`,
`po_completion_line_overlap_guard`, `po_generation_serialization`,
`precon_phase_e_estimate_execution`, `prequalification_program`,
`price_agreement_import_key_unique`, `project_excluded_from_reporting`,
`search_overhaul`, `vendor_bill_duplicate_trigger_and_waiver_vocab_cleanup`,
`warranty_operations_hardening`.

Five final cases were resolved on 2026-09-02 by checking each migration's
specific effect, and two more moved here from section A on 2026-09-03. The
applied and obsolete files are in the 342-row repair map; the one that is still
pending stays in section A.

| Migration | Verdict | Evidence |
|---|---|---|
| `20260605023000_fix_submittals_constraints` | **Applied** — record it | `submittals_status_check` in production matches the file's array exactly. |
| `20260611120000_remove_qbo_bill_payment_placeholders` | **Obsolete** — record it | Its target table `qbo_sync_records` no longer exists; the accounting abstraction dropped it. Attempting to apply this would error. |
| `20260701160000_platform_bug_attachment_pdfs` | **Applied** — record it | The `platform-bug-attachments` bucket already allows `{image/*,application/pdf}`. |
| `20260708120500_rbac_catalog_seed` | **Applied** — record it | Seeded keys are present (`bill.approve` among them), and the file is fully `on conflict` guarded regardless. |
| `20260829120000_billing_lifecycle_and_command_permissions` | **NOT applied** — apply it | The `invoices` status check still permits `saved`, and six invoices still hold that status. The migration migrates them to `draft` and tightens the constraint. Re-confirmed 2026-09-03. |
| `20260817120300_validate_bid_package_award_target` | **Applied** — record it | `bid_packages_award_target_context` and `bid_packages_parent_context` are both `convalidated`, and no row carries a project and a prospect at once. |
| `20260901120000_payment_run_submit_execute_lockdown` | **Applied** — record it | `submit_payment_run_atomic` ACL is `postgres=X/postgres, service_role=X/postgres`; neither `anon` nor `authenticated` holds EXECUTE. |

## D. Applied in production, recovered into the repository (5)

Recovered from the ledger's stored statements, so the repo can reproduce prod.

| Ledger version | Name | Status |
|---|---|---|
| `20260805122729` | `payment_approver_division_scope` | **Recovered in this change** — adds `payment_run_approvers.division_id` and its indexes. Payment slice, which is why it was done first. |
| `20260725174233` | `sales_deals_won_stage` | **Recovered in this change.** |
| `20260725174553` | `sales_deals_deal_id_filter` | **Recovered in this change.** |
| `20260729013412` | `create_outreach_tracking_schema` | **Recovered in this change.** |
| `20260729023157` | `drop_unused_outreach_is_forward` | **Recovered in this change.** |

The only remaining live-only normalized name is
`arc_books_accounting_foundation`; it is an alias for the repository's
`books_accounting_foundation`. The repair deletes the alias after inserting the
canonical repository version.

## E. Duplicated names in the ledger (9)

Applied twice on 2026-08-13, in two passes minutes apart. The schema reflects
them once. The repair deletes the later row of each pair.

`harden_payable_payment_lifecycle`, `books_release_hardening`,
`normalize_payment_permission_domain`, `books_reviewer_role`,
`finish_ap_launch_readiness`, `receivables_foundation`,
`books_sole_ledger_operations`, `receivables_books_tax_hardening`,
`receivables_atomic_revisions`.

## Repair order

1. Read this document, especially sections A and C.
2. Run `supabase/scripts/repair-migration-ledger.sql` against production. It
   records all 349 known-applied canonical versions, removes their stamped copies
   and the books alias, de-duplicates section E, and then installs
   `list_migration_ledger()`. It is idempotent, prints before/after counts, and
   aborts if an expected version or duplicate remains.

   Simulated against the live ledger on 2026-09-05: **+268 inserted, −249
   removed (248 superseded + the books alias), 330 → 349 rows, 0 duplicated
   names, 0 map versions missing, 0 rows left outside the map.** Every removed
   row is superseded by a canonical row for the same migration name, and the
   repository holds the SQL for all of them, so nothing unrecoverable is dropped.
3. Confirm the five recovered files from section D remain in the repository.
4. Apply only section A (ten files), reviewed, with the Supabase CLI so
   repository versions are preserved. This is WS-A4, not WS-A5.
5. `supabase migration list` should now show nothing unexpected, and
   `pnpm db:ledger:check` should pass with credentials loaded.

## Preventing recurrence

- `pnpm db:ledger:check` runs in the `database-contracts` CI job and fails on
  duplicate names or versions in the repository, and on exact version drift on
  trusted branches where production credentials are available.
- **`CLAUDE.md` now records the MCP limitation truthfully:** MCP always stamps a
  fresh ledger version. The full repository filename stem preserves a mapping by
  name, but a CLI application or explicit ledger reconciliation is still needed
  for exact version parity. The manual reversal confirms this: it is recorded at
  version `20260902021352` under name
  `20260813000500_manual_ap_payment_reversal`.
