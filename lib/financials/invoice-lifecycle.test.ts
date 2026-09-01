// @ts-expect-error bun test types are not part of this app tsconfig
import { describe, expect, it } from "bun:test"

import {
  accumulateArAging,
  agingBucketIndex,
  daysPastDueOn,
  daysUntilDueOn,
  deriveInvoiceDisplayStatus,
  emptyArAgingTotals,
  isEditableInvoiceStatus,
  isIssuedInvoiceStatus,
  isOpenArInvoiceStatus,
  normalizeInvoiceStatus,
  openBalanceCents,
  overdueDaysOf,
  summarizeArAging,
  OPEN_AR_INVOICE_STATUSES,
  INVOICE_LIFECYCLE_STATUSES,
} from "@/lib/financials/invoice-lifecycle"
import { BILLED_INVOICE_STATUSES, SYNCABLE_INVOICE_STATUSES } from "@/lib/financials/ledger-status"
import { getAgingBucket } from "@/lib/services/reports/aging"

/**
 * These run the lifecycle rather than grepping for it.
 *
 * The invoice suite was almost entirely `assert.match(source, /…/)`, which
 * proves a string exists in a file and nothing about what happens to money. Every
 * case below is one a real invoice reached: a draft with a stale due date, an
 * invoice paid down to zero whose stored status still says overdue, an aging
 * bucket landing on its boundary day.
 */

// A fixed "today" so a bucket boundary can't drift with the calendar.
const TODAY = new Date(2026, 7, 29) // 29 Aug 2026, local

describe("normalizeInvoiceStatus", () => {
  it("folds the retired `saved` state into draft", () => {
    expect(normalizeInvoiceStatus("saved")).toBe("draft")
    expect(normalizeInvoiceStatus("SAVED")).toBe("draft")
  })

  it("keeps every live lifecycle state", () => {
    for (const status of INVOICE_LIFECYCLE_STATUSES) {
      expect(normalizeInvoiceStatus(status)).toBe(status)
    }
  })

  it("treats nothing and nonsense as a draft rather than inventing a state", () => {
    expect(normalizeInvoiceStatus(null)).toBe("draft")
    expect(normalizeInvoiceStatus(undefined)).toBe("draft")
    expect(normalizeInvoiceStatus("in_the_post")).toBe("draft")
  })
})

describe("membership sets", () => {
  it("excludes drafts from open AR — nobody has billed them", () => {
    expect(isOpenArInvoiceStatus("draft")).toBe(false)
    expect(isOpenArInvoiceStatus("saved")).toBe(false)
    expect(isOpenArInvoiceStatus("sent")).toBe(true)
    expect(isOpenArInvoiceStatus("partial")).toBe(true)
    expect(isOpenArInvoiceStatus("overdue")).toBe(true)
    expect(isOpenArInvoiceStatus("paid")).toBe(false)
    expect(isOpenArInvoiceStatus("void")).toBe(false)
  })

  it("keeps open AR a strict subset of what has been billed", () => {
    for (const status of OPEN_AR_INVOICE_STATUSES) {
      expect(BILLED_INVOICE_STATUSES).toContain(status)
    }
    expect(BILLED_INVOICE_STATUSES).toContain("paid")
    expect(OPEN_AR_INVOICE_STATUSES).not.toContain("paid")
  })

  it("syncs exactly what has been billed — an unsent draft never reaches the customer's books", () => {
    expect([...SYNCABLE_INVOICE_STATUSES].sort()).toEqual([...BILLED_INVOICE_STATUSES].sort())
    expect(SYNCABLE_INVOICE_STATUSES as readonly string[]).not.toContain("saved")
    expect(SYNCABLE_INVOICE_STATUSES as readonly string[]).not.toContain("draft")
  })

  it("only a draft is editable, and only a non-draft is issued", () => {
    expect(isEditableInvoiceStatus("draft")).toBe(true)
    expect(isEditableInvoiceStatus("saved")).toBe(true)
    expect(isEditableInvoiceStatus("sent")).toBe(false)
    expect(isIssuedInvoiceStatus("draft")).toBe(false)
    expect(isIssuedInvoiceStatus("void")).toBe(false)
    expect(isIssuedInvoiceStatus("sent")).toBe(true)
    expect(isIssuedInvoiceStatus("paid")).toBe(true)
  })
})

describe("date-only arithmetic", () => {
  it("counts whole days past due from a calendar date", () => {
    expect(daysPastDueOn("2026-08-28", TODAY)).toBe(1)
    expect(daysPastDueOn("2026-08-29", TODAY)).toBe(0)
    expect(daysPastDueOn("2026-08-30", TODAY)).toBe(0)
    expect(daysPastDueOn("2026-07-30", TODAY)).toBe(30)
  })

  it("survives a daylight-saving boundary without gaining or losing a day", () => {
    // US DST ends 1 Nov 2026. A due date either side must still be a whole
    // number of days away — millisecond subtraction on local dates is not.
    const afterDst = new Date(2026, 10, 3) // 3 Nov 2026
    expect(daysPastDueOn("2026-10-30", afterDst)).toBe(4)
    expect(daysUntilDueOn("2026-11-10", afterDst)).toBe(7)
  })

  it("has no opinion about a missing or malformed due date", () => {
    expect(daysPastDueOn(null, TODAY)).toBe(0)
    expect(daysPastDueOn("", TODAY)).toBe(0)
    expect(daysPastDueOn("whenever", TODAY)).toBe(0)
    expect(daysUntilDueOn(null, TODAY)).toBeNull()
  })

  it("buckets on the ladder's edges, not near them", () => {
    expect(agingBucketIndex(0)).toBeNull()
    expect(agingBucketIndex(1)).toBe(0)
    expect(agingBucketIndex(30)).toBe(0)
    expect(agingBucketIndex(31)).toBe(1)
    expect(agingBucketIndex(60)).toBe(1)
    expect(agingBucketIndex(61)).toBe(2)
    expect(agingBucketIndex(90)).toBe(2)
    expect(agingBucketIndex(91)).toBe(3)
  })

  it("agrees with the AR aging report's ladder at every edge", () => {
    const names = ["1_30", "31_60", "61_90", "90_plus"] as const
    for (const days of [1, 30, 31, 60, 61, 90, 91, 400]) {
      const asOf = "2026-08-29"
      const due = new Date(Date.UTC(2026, 7, 29) - days * 86_400_000).toISOString().slice(0, 10)
      const report = getAgingBucket({ dueDate: due, asOf, isPaid: false })
      expect(report.bucket).toBe(names[agingBucketIndex(days)!])
    }
  })
})

describe("deriveInvoiceDisplayStatus", () => {
  it("never calls an unissued draft overdue, however old its due date", () => {
    // The bug this replaces: the table painted drafts red and wrote "412d past
    // due" on invoices nobody had ever asked anyone to pay.
    expect(
      deriveInvoiceDisplayStatus({ status: "draft", balanceCents: 500_00, dueDate: "2020-01-01" }, TODAY),
    ).toBe("draft")
    expect(
      deriveInvoiceDisplayStatus({ status: "saved", balanceCents: 500_00, dueDate: "2020-01-01" }, TODAY),
    ).toBe("draft")
    expect(overdueDaysOf({ status: "draft", balanceCents: 500_00, dueDate: "2020-01-01" }, TODAY)).toBe(0)
  })

  it("promotes a billed invoice past its due date with money still owed", () => {
    expect(
      deriveInvoiceDisplayStatus({ status: "sent", balanceCents: 100_00, dueDate: "2026-08-01" }, TODAY),
    ).toBe("overdue")
    expect(
      deriveInvoiceDisplayStatus({ status: "partial", balanceCents: 1, dueDate: "2026-08-01" }, TODAY),
    ).toBe("overdue")
  })

  it("demotes a stored `overdue` once the balance is settled", () => {
    // The late-fee job stamps `overdue`; a payment can land before the row is
    // rolled forward, and "overdue, $0.00 owing" is not a thing.
    expect(
      deriveInvoiceDisplayStatus({ status: "overdue", balanceCents: 0, dueDate: "2026-01-01" }, TODAY),
    ).toBe("sent")
  })

  it("leaves paid and void alone", () => {
    expect(deriveInvoiceDisplayStatus({ status: "paid", balanceCents: 0, dueDate: "2020-01-01" }, TODAY)).toBe("paid")
    expect(
      deriveInvoiceDisplayStatus({ status: "void", balanceCents: 900_00, dueDate: "2020-01-01" }, TODAY),
    ).toBe("void")
  })

  it("is not overdue on the due date itself", () => {
    expect(
      deriveInvoiceDisplayStatus({ status: "sent", balanceCents: 100_00, dueDate: "2026-08-29" }, TODAY),
    ).toBe("sent")
  })
})

describe("AR aging", () => {
  it("counts nothing for a draft, a void, or a settled invoice", () => {
    expect(openBalanceCents({ status: "draft", balanceCents: 900_00, dueDate: "2020-01-01" }, TODAY)).toBe(0)
    expect(openBalanceCents({ status: "void", balanceCents: 900_00, dueDate: "2020-01-01" }, TODAY)).toBe(0)
    expect(openBalanceCents({ status: "paid", balanceCents: 0, dueDate: "2020-01-01" }, TODAY)).toBe(0)
  })

  it("puts a current invoice in outstanding but not in overdue", () => {
    const totals = accumulateArAging(
      emptyArAgingTotals(),
      { status: "sent", balanceCents: 250_00, dueDate: "2026-09-15" },
      TODAY,
    )
    expect(totals.outstandingCents).toBe(250_00)
    expect(totals.overdueCents).toBe(0)
    expect(totals.buckets).toEqual([0, 0, 0, 0])
  })

  it("sums a whole book into the ladder", () => {
    const totals = summarizeArAging(
      [
        { status: "draft", balanceCents: 1_000_00, dueDate: "2020-01-01" }, // never billed
        { status: "sent", balanceCents: 100_00, dueDate: "2026-09-30" }, // current
        { status: "sent", balanceCents: 200_00, dueDate: "2026-08-20" }, // 9 days → 1–30
        { status: "partial", balanceCents: 300_00, dueDate: "2026-07-20" }, // 40 days → 31–60
        { status: "overdue", balanceCents: 400_00, dueDate: "2026-05-01" }, // 120 days → 90+
        { status: "paid", balanceCents: 0, dueDate: "2026-01-01" },
        { status: "void", balanceCents: 999_00, dueDate: "2026-01-01" },
      ],
      TODAY,
    )
    expect(totals.outstandingCents).toBe(1_000_00)
    expect(totals.overdueCents).toBe(900_00)
    expect(totals.buckets).toEqual([200_00, 300_00, 0, 400_00])
  })

  it("ignores a negative or zero balance rather than crediting the aging", () => {
    const totals = summarizeArAging(
      [
        { status: "sent", balanceCents: -50_00, dueDate: "2026-01-01" },
        { status: "sent", balanceCents: 0, dueDate: "2026-01-01" },
      ],
      TODAY,
    )
    expect(totals).toEqual(emptyArAgingTotals())
  })
})
