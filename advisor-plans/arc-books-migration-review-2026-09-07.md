# Arc Books migration review

Implementation scope: findings 01–22 from the September 7 audit. These 13 migrations were applied sequentially through Supabase MCP to production Arc (`gzlfiskfkvqgpzqldnwk`) on September 8, 2026, following explicit user confirmation of this production target. Every file matched the reviewed SHA-256 before application. Existing unrelated working-tree changes and migrations were preserved.

| Order | Migration | SHA-256 |
| --- | --- | --- |
| 1 | [20260908010036_books_bank_integrity.sql](/Users/agustinzenuto/Code/Arc/supabase/migrations/20260908010036_books_bank_integrity.sql) | `926d22c16a2c5f1ea550b58abf9f6dc2e810200306f1f6238d9fce6997d2e744` |
| 2 | [20260908011323_books_recurring_occurrences.sql](/Users/agustinzenuto/Code/Arc/supabase/migrations/20260908011323_books_recurring_occurrences.sql) | `5a57bc36f3be100d6bc9566f65a5e7222b03f9ba483d6736f29af63c0bad3267` |
| 3 | [20260908011851_books_fiscal_overhead.sql](/Users/agustinzenuto/Code/Arc/supabase/migrations/20260908011851_books_fiscal_overhead.sql) | `a2a7afec9b901d88ac25a500416d469122f7327e2cf747a327e27e3d4b8f1172` |
| 4 | [20260908012745_books_funding_accounts.sql](/Users/agustinzenuto/Code/Arc/supabase/migrations/20260908012745_books_funding_accounts.sql) | `ce4b54df79540467399b88cf15794db47a6b58f849e5a176399498982db81e17` |
| 5 | [20260908013633_books_settlement_reporting.sql](/Users/agustinzenuto/Code/Arc/supabase/migrations/20260908013633_books_settlement_reporting.sql) | `8095d608f3f686b13a230cba93c4ef8779b68b35deffb5ef6ce34d84a3db8479` |
| 6 | [20260908015013_books_clearing_support.sql](/Users/agustinzenuto/Code/Arc/supabase/migrations/20260908015013_books_clearing_support.sql) | `9a21a28820785f9316e924567c4adb64bfbafa98e61f01bbe978a6bd9f518de9` |
| 7 | [20260908015416_books_bank_cost_posting.sql](/Users/agustinzenuto/Code/Arc/supabase/migrations/20260908015416_books_bank_cost_posting.sql) | `57381e5fbd2f08aa4b9eaf2415a193ec2f5f8a767cbc6f8923ee0d8d1fa14c9b` |
| 8 | [20260908015826_books_payroll_settlements.sql](/Users/agustinzenuto/Code/Arc/supabase/migrations/20260908015826_books_payroll_settlements.sql) | `dcd668934eb3b9a688f7a03e296a9062ae6112af462f1d946f59ff1bdab5091c` |
| 9 | [20260908020733_books_owned_inventory.sql](/Users/agustinzenuto/Code/Arc/supabase/migrations/20260908020733_books_owned_inventory.sql) | `2e5e240f005f9604058582ca39ec49940a55b17c0a59bd15a38753f2fe296651` |
| 10 | [20260908021851_books_land_inventory.sql](/Users/agustinzenuto/Code/Arc/supabase/migrations/20260908021851_books_land_inventory.sql) | `b7a7034bebfdb519271dcfddfecd002e4043847b7b25d64aca73e40dd86ea416` |
| 11 | [20260908023052_books_warranty_accounting.sql](/Users/agustinzenuto/Code/Arc/supabase/migrations/20260908023052_books_warranty_accounting.sql) | `67828d9bedc18f21871c33d6af8225caeb198c69ec24d3be06ce19a799f2a33d` |
| 12 | [20260908024655_books_opening_continuity.sql](/Users/agustinzenuto/Code/Arc/supabase/migrations/20260908024655_books_opening_continuity.sql) | `967cf05cdf9949a3a9847b4109d8d48164eff401b90116e667c8d3c3ddb966a7` |
| 13 | [20260908031539_books_manual_payment_funding.sql](/Users/agustinzenuto/Code/Arc/supabase/migrations/20260908031539_books_manual_payment_funding.sql) | `cd5d8c5706ce17a4d96c245a796ad23904ea4a1a408387bf1fc946bbf6b95124` |

## Production application results

All 13 calls returned success; the remote migration ledger confirms the following versions. MCP assigned application timestamps, which differ from the local filenames. Future CLI synchronization must account for this mapping rather than replaying the files.

| Migration | Remote version |
| --- | --- |
| books_bank_integrity | 20260908115457 |
| books_recurring_occurrences | 20260908115513 |
| books_fiscal_overhead | 20260908115517 |
| books_funding_accounts | 20260908115524 |
| books_settlement_reporting | 20260908115530 |
| books_clearing_support | 20260908115536 |
| books_bank_cost_posting | 20260908115547 |
| books_payroll_settlements | 20260908115553 |
| books_owned_inventory | 20260908115558 |
| books_land_inventory | 20260908115603 |
| books_warranty_accounting | 20260908115617 |
| books_opening_continuity | 20260908115623 |
| books_manual_payment_funding | 20260908115628 |
| books_asset_capacity_execute_hardening | 20260908115817 |

The follow-up `20260908115801_books_asset_capacity_execute_hardening.sql` revokes default PUBLIC/anon/authenticated execution of the new trigger-only asset capacity helper and preserves service_role execution. It was created separately; the reviewed 13 files remain unchanged.

Read-only catalog verification confirmed all 42 expected functions, all added columns, all declared triggers enabled, RLS enabled on the altered tables, the bank inventory adapter, camelCase settlement readers, and approved warranty cost readers. Non-trigger Books RPCs and security-definer guards have service-only execution after the follow-up. Trigger-only invoker functions retain default grants; PostgreSQL restricts these to trigger invocation.

The security advisor also reported issues on objects outside these migrations: drawing sheet views, existing authorization helpers, mutable search paths, public extensions, and Auth password protection. These were not changed. See [Supabase security advisor remediation](https://supabase.com/docs/guides/database/database-linter?lint=0010_security_definer_view). Informational RLS-without-policy findings include service-managed Books tables; RLS remains enabled.

No production fixture transactions or application deployment were performed. Catalog checks establish installation, not full workflow or restore acceptance.

## Original application contract

- Review the existing migration ledger before applying this explicit set in chronological order. Do not use blanket `db push`: unrelated migrations are present in this workspace.
- Apply schema changes before enabling the new application code. Projector, opening, warranty and banking readers use the added columns and RPCs.
- Start in an isolated database with the current Arc schema. Run normal migrations and existing database checks there; the PGlite fixtures are narrower than the real schema.
- Keep scheduled jobs and external delivery disabled in the acceptance environment. Test records must not reach payment rails, customer notifications, or production storage.
- Production application required separate explicit approval, which the user subsequently provided before the MCP application recorded above.

## Local evidence

- `pnpm test:financials`: 818 passed.
- Final `pnpm lint` and `pnpm typecheck`: passed.
- Four focused suites (`arc-books`, `books-workflow-completeness`, `books-statement-correctness`, `books-export-continuity`): 108 passed.
- `scripts/test-books-bank-integrity.mjs`: bank matching/capacity, reconciliation equation, frozen evidence and reopen, reversal history matching, deposit batching, bank job costs, payroll settlement, recurrence, inventory stages, financed land, development allocation, eligible interest, warranty approval/recovery/reversal.
- `scripts/test-books-opening-continuity.mjs`: opening materialization for AR/AP/deposits/retainage/assets/debt, independent approvals, immutable reviewed economics, duplicate posting, real AR/AP payment RPCs, deposit application capacity, downstream reversal refusal and atomic unused-batch reversal.
- Both SQL runners use PGlite, real selected table/function definitions, minimal dependency fixtures and a journal-posting stub. They do not exercise all production triggers, RLS, extensions or concurrent sessions.
- `scripts/verify-books-export.cjs` validates the data bundle and copied supporting-file bytes offline. Tests cover serialization roundtrip, broken relationships, changed bytes and organization mismatch. A complete Arc database restore has not yet been performed.

## Acceptance gates still open

1. Apply the reviewed migrations to an isolated full Arc schema and run database permission/concurrency checks.
2. Complete authenticated residential, commercial and production workflows, including close/reopen/reclose, with all subledger tie-outs passing.
3. Restore a representative export into the isolated application schema, copy all supporting objects, run the offline verifier and ledger rebuild, and confirm operational open items and register balances.
4. Review authenticated UI acceptance before enabling the new application code; production schema application is complete.

## Supported boundaries

- Native Books is an organization ledger. Divisions and communities are analytical dimensions, not separate legal entities. Restricted-division roles are not granted implicit whole-ledger access.
- Existing historical facts keep their original dimension granularity until an economic revision. Reports show unassigned or project-level positions when a more specific contract cannot be established.
- Inventory capitalization requires explicit project adoption and ownership evidence. Existing costs are not silently recoded across closed periods.
- Standalone journal reversal is blocked for opening/inventory/warranty-owned events; the operational record and ledger must be corrected together. Warranty approval reversal and unused opening-batch reversal are explicit transactional workflows.
- Opening imports materialize residual open items, not the original system’s full transaction history. Existing linked records and downstream activity constrain batch reversal; corrections must use the affected subledger.
- Supporting file bytes are verified at export and listed in the manifest; they must be copied separately. Credentials and full tax identities are excluded and must be re-established during a controlled restore.
