/**
 * Deciding whether a payable Arc is about to create is one it already holds.
 *
 * Pure on purpose: this used to exist in three places that disagreed. The
 * interactive create path matched bill numbers case-insensitively and hard-
 * blocked; the email ingest path matched them case-sensitively, so `INV-1024`
 * and `inv-1024` were the same bill on one path and two bills on the other; the
 * auto-approval gate had a third variant. One implementation, one behaviour.
 *
 * The result is a SUSPICION, never a block. A vendor legitimately reissuing a
 * number should not be un-enterable — the caller warns and lets a human decide.
 */

export interface RecentBillForDuplicateCheck {
  billNumber: string
  companyId: string | null
  totalCents: number | null
  billDate: string | null
}

export interface DuplicateSuspicion {
  isSuspected: boolean
  reason?: string
}

/** Case, spacing and separator differences are not different invoice numbers. */
export function normalizeBillNumber(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "")
}

export function detectDuplicateSuspicion({
  billNumber,
  companyId,
  totalCents,
  billDate,
  recentBills,
}: {
  billNumber: string | null
  companyId: string | null
  totalCents: number | null
  billDate: string | null
  recentBills: RecentBillForDuplicateCheck[]
}): DuplicateSuspicion {
  if (billNumber?.trim()) {
    const normalized = normalizeBillNumber(billNumber)
    const hit = recentBills.find(
      (bill) =>
        normalizeBillNumber(bill.billNumber) === normalized &&
        // An unknown vendor on either side is not evidence of a different bill.
        (companyId === null || bill.companyId === null || bill.companyId === companyId),
    )
    if (hit) {
      return {
        isSuspected: true,
        reason: `Bill number ${billNumber.trim()} matches an existing payable${hit.billDate ? ` dated ${hit.billDate}` : ""}.`,
      }
    }
    return { isSuspected: false }
  }

  // The extractor legitimately returns null for documents that print no number,
  // and a duplicate with no number is exactly what the check above cannot see.
  if (totalCents === null || !billDate || !companyId) return { isSuspected: false }

  const hit = recentBills.find(
    (bill) => bill.companyId === companyId && bill.totalCents === totalCents && bill.billDate === billDate,
  )
  if (hit) {
    return {
      isSuspected: true,
      reason: `This vendor already has a payable for the same amount dated ${billDate}.`,
    }
  }

  return { isSuspected: false }
}
