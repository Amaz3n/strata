/**
 * The one definition of which source records have reached the ledger.
 *
 * A control tie-out compares a GL account against the subledger that produced
 * it, so the status set the projector posts from and the status set a subledger
 * sums over cannot be allowed to differ — if they do, the control fails forever
 * and no arithmetic fix will close it.
 *
 * They did differ. Before this module there were three answers for AR:
 * `projector.ts` posted `sent | partial | paid | overdue`, the `ar_control`
 * tie-out excluded only `draft` and `void` (so it counted `saved`), and
 * `reports/ar-aging.ts` excluded only `void` (so it counted `draft` *and*
 * `saved`). A single saved invoice therefore sat in the AR subledger and in the
 * aging report while contributing nothing to `1100`, which made `ar_control` —
 * and with it every period close — impossible to pass. The same gap hit
 * `retainage_receivable_control`, because retainage attached to a saved invoice
 * counted as held while its invoice never posted to `1110`.
 *
 * The projector's set wins, because it is the one the GL is actually built
 * from. It also matches how the rest of the app reads these states: issuing an
 * invoice moves it `draft → sent`, and `draft` is the editable, still-deletable
 * state. An invoice nobody has sent is not yet a receivable. (`saved` has since
 * been folded into `draft` — see lib/financials/invoice-lifecycle.ts.)
 */

/**
 * Invoice statuses that count as billed to the customer — and therefore as
 * accounts receivable, as POC billings, and as projectable facts. The only
 * definition of "billed".
 */
export const BILLED_INVOICE_STATUSES = ["sent", "partial", "paid", "overdue"] as const

/**
 * Vendor-bill statuses that count as an incurred payable — and therefore as
 * accounts payable, as job cost, and as projectable facts. `pending` is awaiting
 * approval and `rejected` will never be paid; neither is money owed.
 */
export const PAYABLE_VENDOR_BILL_STATUSES = ["approved", "partial", "paid"] as const

export type BilledInvoiceStatus = (typeof BILLED_INVOICE_STATUSES)[number]
export type PayableVendorBillStatus = (typeof PAYABLE_VENDOR_BILL_STATUSES)[number]

const PAYABLE_VENDOR_BILL_STATUS_SET: ReadonlySet<string> = new Set(PAYABLE_VENDOR_BILL_STATUSES)

/**
 * Membership test for the GL payable set, for the callers that hold a loose
 * `string` (a database row, a webhook payload) rather than a typed status.
 */
export function isPayableVendorBillStatus(status: string | null | undefined): boolean {
  return PAYABLE_VENDOR_BILL_STATUS_SET.has(String(status ?? "").toLowerCase())
}

/* ------------------------------------------------------------------------- *
 * The outbound accounting-sync sets.
 *
 * These are deliberately NOT the same question as the GL sets above, and the
 * difference is why they are written down here instead of being hand-typed at
 * each push site — which is how they came to exist in three places with no name
 * and no stated intent.
 *
 * The GL sets answer "has this reached Arc's ledger?". These answer "does this
 * belong in the customer's external accounting system?" — the file their
 * bookkeeper actually works in. For vendor bills that is still wider than the GL
 * set on purpose: bookkeepers expect an approved bill to appear in QuickBooks
 * before it is paid.
 *
 * For invoices the two sets are now identical, and that is a deliberate change.
 * They used to differ by the `saved` status, which meant a never-sent draft was
 * accounts receivable in the customer's QuickBooks while being nothing at all in
 * Arc — and because the invoice composer autosaved every keystroke into `saved`,
 * abandoned drafts landed in a real customer's books. `saved` has been removed
 * from the lifecycle entirely (see lib/financials/invoice-lifecycle.ts); an
 * invoice now syncs once it is issued. Callers additionally push any invoice
 * flagged `client_visible`, regardless of status — an invoice the client can see
 * is one the bookkeeper needs — and re-push anything already linked to an
 * external record so corrections still flow.
 *
 * Narrowing this set only stops NEW pushes; it never removes anything from a
 * customer's books, and already-synced invoices keep re-pushing on change.
 * Widening it is a migration, not an edit.
 * ------------------------------------------------------------------------- */

/**
 * Invoice statuses that are pushed to the external accounting system: the
 * issued set, matching `BILLED_INVOICE_STATUSES`.
 */
export const SYNCABLE_INVOICE_STATUSES = ["sent", "partial", "paid", "overdue"] as const

/**
 * Vendor-bill statuses that are pushed to the external accounting system.
 *
 * Currently identical in value to `PAYABLE_VENDOR_BILL_STATUSES`, and still a
 * separate name: the two answer different questions and are free to diverge.
 * Callers additionally re-push a bill of ANY status whose accounting coding
 * changed while it is already linked to an external record, so that recoding an
 * imported or still-pending bill flows the new account back.
 */
export const SYNCABLE_VENDOR_BILL_STATUSES = ["approved", "partial", "paid"] as const

const SYNCABLE_INVOICE_STATUS_SET: ReadonlySet<string> = new Set(SYNCABLE_INVOICE_STATUSES)
const SYNCABLE_VENDOR_BILL_STATUS_SET: ReadonlySet<string> = new Set(SYNCABLE_VENDOR_BILL_STATUSES)

/** Case-insensitive membership, so push sites never re-normalize by hand. */
export function isSyncableInvoiceStatus(status: string | null | undefined): boolean {
  return SYNCABLE_INVOICE_STATUS_SET.has(String(status ?? "").toLowerCase())
}

export function isSyncableVendorBillStatus(status: string | null | undefined): boolean {
  return SYNCABLE_VENDOR_BILL_STATUS_SET.has(String(status ?? "").toLowerCase())
}
