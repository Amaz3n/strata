# Banking workspace

Banking lives at `/books/banking`, under the expandable Books sidebar. Books itself remains the accounting hub. The former Banking tab is removed. Existing account mapping, imports, reconciliation, deposits, payroll tools, bank rules and Plaid connection controls are available through **Manage banking**; reconciliation deep links open that sheet with the selected account. The Banking header is a breadcrumb only, and the transaction table fills the available viewport.

## Review flow

- Account shelf with review counts, persisted account/status selection, server search, date/direction/receipt filters and numbered 50-row pagination. Page controls stay bounded at the first and last page and disappear when there are no rows. Review begins from the account and transaction rows; there is no separate **Start review** button or **Ready on this page** filter.
- Transaction dates are displayed as `MM/DD/YYYY` from date-only values, so the calendar day does not shift with the viewer's timezone. The selected vendor is shown inline with the transaction and uses its own logo when available; a manually selected directory vendor without a matching logo falls back to initials or a generic mark. Bank accounts use their available institution skin and fall back cleanly when branding is missing.
- Inline category/project editing saves a draft. Posting is explicit. Pending bank transactions cannot be posted.
- Office and overhead spending can be allocated without a project. Project cost codes are cleared when a line is moved to overhead, and direct cost categories still require a project and matching cost code when applicable.
- The transaction inspector opens beside the table on wide screens and as a sheet on smaller screens. Expand it for full-screen review, skip, or post and advance. `/` focuses search; Ctrl/Cmd+Enter posts and advances while reviewing.
- Vendor selection/creation, memo, category, project, cost code, amount/percentage splits, receipt preview and activity history share the same draft in both views. Receipt thumbnails load from the private file URL; while asynchronous extraction is pending, the preview can show the file icon. The drop or paste target remains available while the transaction is being coded.
- Selection supports ranges, bulk coding, posting, matching and exclusion. Similar-transaction selection is deliberately conservative: same account, direction, merchant, description and amount. Bulk operations act on loaded rows.
- Suggested matches retain alternatives for review. Manual matching supports partial amounts and multiple ledger lines. The candidate inspector currently shows up to 500 recent eligible cash lines.
- Remembering a single-line merchant coding creates a reviewable bank rule. Rules can be paused or enabled; they do not automatically post.
- Existing ledger matches remain the first posting path. Otherwise, coding suggestions use field-level priority: a saved manual vendor or category wins, then a learned rule, then a persisted AI suggestion. Rule suggestions use a brain icon; AI suggestions use violet sparkles with an **AI suggestion** tooltip. Sync batches uncoded transactions through the centralized AI route and stores completed suggestions or abstentions so later syncs do not rescan them.

## Receipts

Users can add a receipt from a transaction by dropping a file, pasting a file, or choosing an upload. The independent receipt endpoint allows users to continue coding while extraction runs. PDF and supported images are limited to 20 MB each. Files remain in private Arc storage and use the existing expense receipt extraction service. There is no receipt-inbox sheet or batch-upload workspace UI.

Extraction failure retains the uploaded file. Uploading or attaching a receipt never creates a second expense. “Requested outside Arc” records a status only; it sends no message. Receipt email forwarding, automatic requests, and automatic posting are not included.

## Plaid sandbox setup

Configure these deployment-wide environment variables before connecting a test institution: `PLAID_CLIENT_ID`, `PLAID_SECRET` (the Plaid sandbox secret), `PLAID_ENV=sandbox`, the existing `TOKEN_ENCRYPTION_KEY`, and `NEXT_PUBLIC_APP_URL`. The client and secret are required by the provider. The encryption key must decode to 32 bytes; keep the existing key and do not rotate it while bank-feed tokens are stored. Set `NEXT_PUBLIC_APP_URL` to the public HTTPS application URL so webhooks resolve to `/api/webhooks/plaid`.

Sandbox setup is deployment-wide, not organization-level. In the selected testing organization, enable Books and grant Books reconcile permission, then connect Plaid and map each returned bank account to its ledger control account before posting. The provider exchanges the Link public token, stores the access token encrypted, and syncs with Plaid's `/transactions/sync` cursor flow; Arc does not use a refresh endpoint for manual sync.

For Plaid Sandbox, use username `user_good` and password `pass_good` when Link asks for credentials ([Plaid Sandbox](https://plaid.com/docs/sandbox/)). For transaction-update testing, use the dynamic test user `user_transactions_dynamic` with any nonempty password and the non-OAuth First Platypus Bank institution; Plaid's [Transactions testing guide](https://plaid.com/docs/transactions/) describes updates generated through `/transactions/refresh`, which is a Plaid test control and is separate from Arc Sync.

No actual Plaid sandbox connection was performed for this documentation update.

## Accounting and access

`20260913222918_banking_workspace.sql` adds draft/receipt tables, two workspace views and the atomic mutation RPC. It was applied to the connected Arc Supabase project during implementation. New tables have RLS enabled and are accessible only through the authorized server service. Browser roles cannot execute the posting RPC or directly read the new tables.

Mutations check organization ownership and optimistic versions. Posting uses the existing journal engine and cash match validation, requires balanced splits, writes direct costs to the job-cost ledger and rejects closed periods, reconciled transactions and unsupported currency conversion. Undo reverses entries created by this workspace and voids their job costs. Undo of a match to a preexisting journal only unlinks the match. Legacy bank categorizations require their ledger reversal rather than silently creating a duplicate expense.

Read access requires Books read permission; edits require Books reconcile permission. Existing file upload and directory creation permissions also apply. Books exports use schema version 3; version 2 exports remain accepted without the new tables.

## Verification

Run the focused application tests:

```sh
node --test tests/books-banking.test.js tests/books-workflow-completeness.test.js tests/arc-books.test.js tests/books-export-continuity.test.js
pnpm typecheck
pnpm build
```

`scripts/test-banking-workspace.mjs` runs real posting, reversal, matching and workspace SQL against an isolated PGlite database with a minimal surrounding schema. Install `@electric-sql/pglite` outside the repository and set `ARC_PGLITE_MODULE` to its ESM entry, or make that package available to Node. It verifies draft isolation, balanced splits, job costs, stale versions, duplicate posting, organization boundaries, undo/repost, exclusions, remembered rules, partial/grouped matches, currency and closed-period guards, and browser-role denial.

Initial implementation verification covered the actual empty organization and populated local fixtures for inline draft editing, inspector expansion, splits and post-and-advance. It passed the focused tests, isolated SQL harness, focused ESLint, TypeScript check and production build.

The focused application command above covers the current Banking model, export compatibility, workflow completeness and Books accounting regression suite. It does not create or post company transactions. No browser verification was run for this documentation and test pass. A real institution connection and live receipt extraction still require verification with user-provided accounts and documents.
