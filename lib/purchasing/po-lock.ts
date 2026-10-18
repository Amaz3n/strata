/**
 * An approved purchase order is issued to its vendor and locked in place: its
 * money, scope and lines change only through a variance order, or by returning
 * the order to draft (which un-issues it; approving it again is a new issue the
 * vendor must answer). The database refuses a member's data-API write to a locked
 * order (tg_po_issued_lock); these rules are the same line, drawn early enough to
 * give a reason the person can act on.
 */

/** The statuses in which a purchase order has been issued. Mirrors po_status_is_issued(). */
export const PO_ISSUED_STATUSES = ["approved", "active", "complete", "completed"] as const

export const PO_LOCKED_MESSAGE =
  "This purchase order is approved and locked. Raise a variance order to change it, or return it to draft first."

export function isIssuedPurchaseOrder(commitmentType: string, status: string) {
  return commitmentType === "purchase_order" && (PO_ISSUED_STATUSES as readonly string[]).includes(status)
}

const blank = (value: string | null | undefined) => (value === undefined || value === null || value === "" ? null : value)

interface LockedTerms {
  title: string
  scope: string | null
  terms: string | null
  contract_number: string | null
  total_cents: number | null
  retainage_percent: number | null
  start_date: string | null
  end_date: string | null
}

/**
 * The locked fields an update asks to change. A field the update leaves out, or
 * sends back unchanged, is not a change (the edit dialog sends the whole form).
 */
export function lockedTermsChanged(
  existing: LockedTerms,
  update: Partial<Omit<LockedTerms, "retainage_percent" | "total_cents">> & { retainage_percent?: number | null; total_cents?: number },
): string[] {
  const changed: string[] = []
  if (update.title !== undefined && update.title !== existing.title) changed.push("title")
  if (update.scope !== undefined && blank(update.scope) !== blank(existing.scope)) changed.push("scope")
  if (update.terms !== undefined && blank(update.terms) !== blank(existing.terms)) changed.push("terms")
  if (update.contract_number !== undefined && blank(update.contract_number) !== blank(existing.contract_number)) changed.push("contract number")
  if (update.start_date !== undefined && blank(update.start_date) !== blank(existing.start_date)) changed.push("start date")
  if (update.end_date !== undefined && blank(update.end_date) !== blank(existing.end_date)) changed.push("end date")
  if (update.total_cents !== undefined && update.total_cents !== (existing.total_cents ?? 0)) changed.push("amount")
  if (update.retainage_percent !== undefined && Number(update.retainage_percent ?? 0) !== Number(existing.retainage_percent ?? 0)) changed.push("retainage")
  return changed
}
