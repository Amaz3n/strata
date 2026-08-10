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
 * from. It also matches how the rest of the app already reads these states:
 * sending an invoice moves `draft | saved → sent`, and `draft` and `saved` are
 * the editable, still-deletable pair everywhere in `lib/services/invoices.ts`.
 * An invoice nobody has sent is not yet a receivable.
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
 * These are deliberately NOT the GL sets above, and the difference is the whole
 * reason they are written down here instead of being hand-typed at each push
 * site — which is how they came to exist in three places with no name and no
 * stated intent.
 *
 * The GL sets answer "has this reached Arc's ledger?". These answer "does this
 * belong in the customer's external accounting system?", and the external
 * system is where the customer's bookkeeper works. It is wider on purpose:
 * bookkeepers expect to see a transaction in QuickBooks as soon as it is real
 * enough to be worked, and Arc has been pushing on these boundaries to a live
 * QuickBooks file since before the GL existed. Narrowing them would silently
 * stop syncing transactions that a real customer's books already contain, which
 * is a far worse failure than the asymmetry.
 *
 * THE CONSEQUENCE, STATED PLAINLY: a `saved` invoice is accounts receivable in
 * QuickBooks and is *not* receivable in Arc's GL (`BILLED_INVOICE_STATUSES`
 * excludes `saved` because sending an invoice moves `draft | saved -> sent`).
 * Between saving and sending, Arc's AR and QuickBooks' AR disagree by that
 * invoice, and any Arc-vs-QuickBooks reconciliation report will show the gap.
 * That is a known, accepted divergence — not a bug to be "fixed" by editing one
 * of these lists in isolation. Changing either set changes what posts to a
 * customer's real books; it is a migration, not an edit.
 * ------------------------------------------------------------------------- */

/**
 * Invoice statuses that are pushed to the external accounting system.
 *
 * Wider than `BILLED_INVOICE_STATUSES` by `saved`. Callers additionally push any
 * invoice flagged `client_visible`, regardless of status — an invoice the client
 * can see is one the bookkeeper needs.
 */
export const SYNCABLE_INVOICE_STATUSES = ["saved", "sent", "partial", "paid", "overdue"] as const

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
