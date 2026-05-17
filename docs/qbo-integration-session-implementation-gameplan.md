# QBO Integration Session Implementation Gameplan

Last updated: 2026-05-17

This document summarizes all QBO integration changes implemented in this session. It is written for an LLM or engineer who needs to continue the work without replaying the conversation.

## North Star

Arc should feel like a construction-first financial operating system that communicates cleanly with QuickBooks Online.

The implementation direction chosen in this session:

- Do not require QBO Projects support for now because it requires paid Intuit API access.
- Use QBO Customers/Jobs-style mapping as the practical free-tier compatible project separation mechanism.
- Make Expenses and Payables the primary places where users categorize transactions with QBO accounts.
- Sync construction financial workflows to the correct QBO transaction types:
  - Paid company-card/bank expenses -> QBO `Purchase`.
  - Unpaid vendor/sub expenses -> QBO `Bill`.
  - Vendor bill payments -> QBO `BillPayment`.
  - Customer invoices -> QBO `Invoice`.
  - Customer payments -> QBO `Payment`.
- Treat QBO as a two-way accounting system, but protect locked/approved Arc records from silent destructive overwrites by marking conflicts as `needs_review`.

## Major User Decisions

- Purchase order support is explicitly deferred.
- A separate review queue is explicitly deferred.
- For now, categorization/review belongs on the Expenses page and Payables detail sheet, not Inbox.
- The app should not pay for QBO Silver/Premium API access yet.
- QBO Projects API support should be treated as a future paid-tier enhancement, not the current integration foundation.

## Database Changes

Migration added:

- `/supabase/migrations/20260516120000_qbo_expense_ap_sync.sql`

### `project_expenses`

Added QBO sync/accounting fields:

- `qbo_id`
- `qbo_synced_at`
- `qbo_sync_status`
- `qbo_transaction_type`
- `qbo_expense_account_id`
- `qbo_expense_account_name`
- `qbo_payment_account_id`
- `qbo_payment_account_name`
- `qbo_ap_account_id`
- `qbo_ap_account_name`
- `qbo_vendor_id`
- `qbo_vendor_name`
- `qbo_sync_error`

Added indexes:

- `project_expenses_qbo_sync_idx`
- `project_expenses_qbo_id_idx`

### `vendor_bills`

Added QBO sync/accounting fields:

- `qbo_id`
- `qbo_synced_at`
- `qbo_sync_status`
- `qbo_expense_account_id`
- `qbo_expense_account_name`
- `qbo_ap_account_id`
- `qbo_ap_account_name`
- `qbo_vendor_id`
- `qbo_vendor_name`
- `qbo_sync_error`

Added indexes:

- `vendor_bills_qbo_sync_idx`
- `vendor_bills_qbo_id_idx`

### `qbo_sync_records`

Expanded allowed `entity_type` values to include:

- `vendor`
- `vendor_bill`
- `project_expense`
- `purchase`
- `bill`
- `bill_payment`
- `purchase_order`
- `vendor_credit`
- `account`

## QBO API Client Expansion

Primary file:

- `/lib/integrations/accounting/qbo-api.ts`

Added API coverage for:

- Listing QBO customers.
- Listing QBO vendors.
- Finding/creating vendors.
- Listing expense/category accounts.
- Listing payment accounts.
- Listing Accounts Payable accounts.
- Creating/updating QBO `Purchase`.
- Creating/updating QBO `Bill`.
- Creating QBO `BillPayment`.
- Fetching QBO `Purchase`, `Bill`, and `BillPayment`.
- Change Data Capture via QBO CDC API.
- Uploading attachments to arbitrary QBO entities.
- Uploading invoice PDFs through the generalized attachment path.
- Formatting QBO addresses.

Important types added:

- `QBOAccountRef`
- `QBOCustomerOption`
- `QBOVendorOption`

## QBO Connection Settings

Primary files:

- `/lib/services/qbo-connection.ts`
- `/app/(app)/settings/integrations/actions.ts`
- `/components/integrations/qbo-connection-card.tsx`

Expanded connection settings with:

- `default_expense_account_id`
- `default_payment_account_id`
- `default_credit_card_account_id`
- `default_ap_account_id`
- `project_mapping_mode`

Added setup/accounting context action:

- `getQBOAccountingSetupAction()`

The QBO integration settings UI now loads and lets users configure default:

- Income account.
- Expense/category account.
- Payment account.
- Credit card account.
- AP account.
- Project mapping mode.

Note: `project_mapping_mode` has UI for customer/sub-customer style mapping, but the current implemented sync behavior is customer/job-style mapping through QBO Customer records. True QBO Projects API support remains deferred.

## Expense Sync

Primary files:

- `/app/(app)/projects/[id]/expenses/actions.ts`
- `/components/expenses/expense-form.tsx`
- `/components/expenses/expenses-client.tsx`
- `/lib/services/qbo-sync.ts`
- `/lib/services/cost-plus.ts`
- `/app/api/qbo/process-outbox/route.ts`

### Expense Form

Added QBO categorization controls:

- Transaction type:
  - `purchase`
  - `bill`
- QBO expense/category account.
- QBO payment account for paid purchases.
- QBO AP account for unpaid bills.

The form uses QBO defaults when available.

### Expense List

Added:

- QBO sync status badges.
- Manual “Sync to QuickBooks” row action for approved, unsynced expenses.

### Expense Server Actions

Added:

- `getExpenseAccountingContextAction()`
- `syncProjectExpenseToQBOAction()`

### Expense Sync Behavior

Added:

- `syncProjectExpenseToQBO(expenseId, orgId)`
- `enqueueProjectExpenseSync(expenseId, orgId)`
- `syncProjectExpenseReceiptAttachmentToQBO(...)`

Behavior:

- If transaction type is `purchase`, creates/updates QBO `Purchase`.
- If transaction type is `bill`, creates/updates QBO `Bill`.
- Requires a QBO expense/category account.
- Requires a QBO payment account for `Purchase`.
- Creates or matches a QBO vendor.
- Maps Arc project to a QBO Customer for job/project financial separation.
- Attaches the receipt file to the QBO transaction when available.
- Marks records `needs_review` when required QBO coding is missing.
- Marks records `error` with `qbo_sync_error` when QBO sync fails.

Approved cost-plus expenses now enqueue QBO sync through the outbox.

## Vendor Bill / Payables Sync

Primary files:

- `/lib/services/vendor-bills.ts`
- `/lib/validation/vendor-bills.ts`
- `/app/(app)/projects/[id]/payables/actions.ts`
- `/components/payables/project-payables-client.tsx`
- `/components/payables/payables-explorer.tsx`
- `/lib/services/qbo-sync.ts`
- `/app/api/qbo/process-outbox/route.ts`

### Vendor Bill Model

`VendorBillSummary` now includes:

- QBO sync id/status/error fields.
- QBO expense/category account fields.
- QBO AP account fields.
- QBO vendor id/name fields.
- Per-line QBO expense/category account metadata.

### Vendor Bill Validation

`vendorBillStatusUpdateSchema` now accepts:

- Top-level QBO expense/category account.
- Top-level QBO AP account.
- Top-level QBO vendor mapping.
- Per-line QBO expense/category account metadata.

### Payables UI

The Payables table now shows:

- QBO sync status.
- Manual “Sync to QuickBooks” action.

The Payables detail sheet now includes:

- QBO Vendor selector.
- QBO expense/category account selector.
- QBO AP account selector.
- QBO status badge.
- “Open in QuickBooks” deep link when synced.

### Vendor Bill Sync Behavior

Added:

- `syncVendorBillToQBO(billId, orgId)`
- `enqueueVendorBillSync(billId, orgId)`
- `syncVendorBillAttachmentToQBO(...)`

Behavior:

- Approved vendor bills enqueue QBO sync.
- Creates/updates QBO `Bill`.
- Uses explicit QBO vendor mapping if selected.
- Falls back to vendor name matching/creation.
- Uses explicit QBO expense/category account.
- Uses QBO AP account when configured.
- Maps Arc project to QBO Customer for job/project separation.
- Sends bill lines as QBO account-based expense lines.
- Uses line-level QBO account metadata when available, otherwise bill-level category.
- Attaches the bill file to the QBO `Bill` when available.
- Marks missing QBO category as `needs_review`.
- Writes sync failures to `qbo_sync_error`.

## Bill Payment Sync

Primary files:

- `/lib/services/vendor-bills.ts`
- `/lib/services/qbo-sync.ts`
- `/app/api/qbo/process-outbox/route.ts`

Added:

- `syncBillPaymentToQBO(paymentId, orgId)`
- `enqueueBillPaymentSync(paymentId, orgId)`

Behavior:

- When Arc records a vendor bill payment, a QBO BillPayment sync job is enqueued if QBO payment sync is enabled.
- If the related QBO Bill does not exist yet, Arc first attempts to sync the vendor bill to QBO.
- Creates QBO `BillPayment` linked to the QBO `Bill`.
- Uses the default QBO payment account from connection settings unless a payment-level account is provided.

## Invoice Sync Enhancements

Primary files:

- `/app/(app)/invoices/actions.ts`
- `/lib/validation/invoices.ts`
- `/lib/services/invoices.ts`
- `/components/invoices/invoice-composer-sheet.tsx`
- `/lib/services/qbo-sync.ts`

### Invoice Composer

Added QBO customer support:

- Invoice composer context loads QBO customers.
- Bill To dropdown includes QBO customers.
- Selected QBO customer is stored in invoice metadata:
  - `qbo_customer_id`
  - `qbo_customer_name`

### Invoice Sync

Updated `syncInvoiceToQBO`:

- If invoice metadata has `qbo_customer_id`, sync uses that exact QBO customer.
- Otherwise, it falls back to existing customer name matching/creation.

This avoids accidental duplicate customers when the builder already has contacts/customers in QBO.

## Outbox Processing

Primary file:

- `/app/api/qbo/process-outbox/route.ts`

Added job types:

- `qbo_sync_project_expense`
- `qbo_sync_vendor_bill`
- `qbo_sync_bill_payment`

The outbox processor now:

- Recovers stale QBO jobs.
- Claims QBO invoice/payment/expense/vendor bill/bill payment jobs.
- Calls the correct sync function by job type.
- Retries failures with backoff.

## Retry / Diagnostics

Primary files:

- `/lib/services/qbo-sync.ts`
- `/lib/services/qbo-connection.ts`

`retryFailedQBOSyncJobs(orgId)` now includes:

- Failed invoices.
- Failed payments.
- Failed project expenses.
- Failed vendor bills.
- Failed outbox jobs for all QBO job types.

QBO connection diagnostics now include:

- Project expense sync jobs.
- Vendor bill sync jobs.
- Bill payment sync jobs.

## Webhook Processing / Two-Way Sync

Primary file:

- `/app/api/qbo/process-webhooks/route.ts`

Added inbound reconciliation for:

- QBO `Purchase` -> mapped Arc project expense.
- QBO `Bill` -> mapped Arc vendor bill first, then mapped Arc project expense fallback.
- QBO `BillPayment` -> mapped Arc vendor bill payment/status.

### Conflict Philosophy

If QBO changes a transaction that maps to an approved/locked/paid Arc-side financial record, Arc should not silently mutate important construction financial data.

Instead:

- Mark local record `qbo_sync_status = needs_review`.
- Store a human-readable explanation in `qbo_sync_error`.
- Preserve the local record for an explicit user decision later.

Examples:

- QBO deletes a linked expense/bill.
- QBO changes the amount on an approved expense.
- QBO changes the amount on an approved/partial/paid vendor bill.

## CDC Processing

Primary files:

- `/app/api/qbo/process-cdc/route.ts`
- `/vercel.json`

Added a cron-backed QBO CDC processor.

CDC scans:

- `Invoice`
- `Payment`
- `Purchase`
- `Bill`
- `BillPayment`

Behavior:

- For each active QBO connection, calls QBO Change Data Capture.
- Inserts synthetic rows into `qbo_webhook_events`.
- Lets the existing webhook processor reconcile changes.
- Maintains `settings.qbo_cdc_last_synced_at`.
- Uses a 5-minute overlap window to avoid missing changes near cursor boundaries.

Cron added:

- `/api/qbo/process-cdc`
- Schedule: `30 3 * * *`

## Attachment Sync

Primary file:

- `/lib/services/qbo-sync.ts`

Attachment support added for:

- Invoice PDFs -> QBO `Invoice`.
- Expense receipts -> QBO `Purchase` or `Bill`.
- Vendor bill files -> QBO `Bill`.

Metadata tracks already-synced file ids to avoid duplicate attachment uploads.

## Deep Links

Primary UI additions:

- Payables detail sheet links synced vendor bills to:
  - `https://qbo.intuit.com/app/bill?txnId=<qbo_id>`

Existing and future work should use the same pattern for:

- Invoices.
- Expenses/Purchases.
- Payments.
- Customers.
- Vendors.

## Current Supported Flow Matrix

| Arc action | QBO result | Status |
| --- | --- | --- |
| Create/approve paid project expense | QBO `Purchase` | Implemented |
| Create/approve unpaid expense | QBO `Bill` | Implemented |
| Create/approve vendor payable | QBO `Bill` | Implemented |
| Record vendor bill payment | QBO `BillPayment` | Implemented |
| Create/send invoice | QBO `Invoice` | Implemented |
| Record customer payment | QBO `Payment` | Existing/enhanced |
| Select invoice customer from QBO | Uses QBO Customer | Implemented |
| Categorize expenses with QBO accounts | QBO Account refs | Implemented |
| Categorize vendor bills with QBO accounts | QBO Account refs | Implemented |
| Match vendor bills to QBO vendors | QBO Vendor refs | Implemented |
| Attach receipts/bills/invoice PDFs | QBO Attachables | Implemented |
| QBO webhook inbound sync | Local reconcile/conflict | Implemented |
| QBO CDC polling | Synthetic webhook events | Implemented |
| QBO Projects API | Native QBO Project entity | Deferred |
| Purchase Orders | QBO PO support | Deferred |
| Dedicated review queue | UI workflow | Deferred |

## Important Deferred Work

Do not confuse these with implemented features:

- Native QBO Projects API support remains deferred because it requires paid Intuit API access.
- Purchase order support remains deferred by user request.
- A standalone review queue remains deferred by user request.
- Full conflict resolution UI is not implemented yet; records are marked `needs_review` and surfaced through sync badges/errors.
- QBO deep links are currently explicit on payables; other surfaces should adopt the same pattern.
- Sub-customer/customer hierarchy mapping may need a sharper product decision.

## Known Verification State

Commands run:

```bash
npm run lint -- --quiet
```

Result:

- Passed.

Targeted TypeScript check:

```bash
npx tsc --noEmit --pretty false 2>&1 | rg "qbo|expense|cost-plus|process-outbox|process-webhooks|process-cdc|invoice-composer|integrations/actions|vendor-bills|payables"
```

Result:

- No QBO/payables/expenses/invoice touched-area errors.

Full TypeScript status:

```bash
npx tsc --noEmit --pretty false
```

Result:

- Fails on pre-existing unrelated messages/portal typing issues:
  - Missing `@/lib/services/conversations`.
  - Missing/incorrect portal message types.
  - `can_message` portal permission type mismatches.

## How To Continue Safely

Recommended next LLM prompt:

> Continue the QBO integration from `docs/qbo-integration-session-implementation-gameplan.md`. Do not add purchase order support yet. Do not build a separate review queue yet. First verify the migration applies cleanly and then add a compact QBO sync health surface that shows expenses, invoices, vendor bills, and payments needing review.

Recommended next engineering steps:

1. Run Supabase migration locally/staging.
2. Test QBO sandbox flows end-to-end:
   - Expense -> Purchase.
   - Expense -> Bill.
   - Vendor bill -> Bill.
   - Vendor payment -> BillPayment.
   - Invoice with explicit QBO customer -> Invoice.
   - CDC/webhook inbound amount changes -> `needs_review`.
3. Add conflict resolution UI on existing Expenses/Payables pages before creating a new review queue.
4. Add QBO deep links to invoices, expenses, and payments.
5. Add user-facing sync health/diagnostics in the QBO settings card.
6. Decide whether `project_mapping_mode = sub_customer` should be implemented or removed until ready.

