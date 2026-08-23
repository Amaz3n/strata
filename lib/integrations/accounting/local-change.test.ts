// @ts-expect-error bun test types are not part of this app tsconfig
import { describe, expect, it } from "bun:test"

import {
  LOCAL_FINGERPRINT_KEY,
  arcChangedSinceSync,
  computeLocalFingerprint,
  fingerprintedEntityTypes,
  storedLocalFingerprint,
} from "@/lib/integrations/accounting/local-change"

const legacyBill = {
  total_cents: 125_000,
  bill_date: "2026-02-01",
  due_date: "2026-03-01",
  qbo_vendor_id: "v-77",
  qbo_expense_account_id: "acct-12",
}

const codedBill = {
  total_cents: 125_000,
  bill_date: "2026-02-01",
  due_date: "2026-03-01",
  accounting_coding: {
    counterparty: { id: "v-77", name: "Gulf Coast Drywall" },
    expense_account: { id: "acct-12", name: "Job Materials" },
  },
}

describe("computeLocalFingerprint", () => {
  it("hashes the same values identically whether they come from accounting_coding or the legacy columns", () => {
    // This is the D2 column-drop guard: hashing the legacy qbo_* columns
    // directly would have flipped every fingerprint the day they drop and
    // routed the entire QuickBooks change feed to needs_review.
    for (const entityType of ["bill", "vendor_credit"]) {
      expect(computeLocalFingerprint(entityType, codedBill)).toBe(computeLocalFingerprint(entityType, legacyBill))
    }
  })

  it("prefers accounting_coding over a legacy column that disagrees", () => {
    const dualWritten = { ...codedBill, qbo_vendor_id: "stale-vendor", qbo_expense_account_id: "stale-account" }
    const legacyOnlyStale = { ...legacyBill, qbo_vendor_id: "stale-vendor", qbo_expense_account_id: "stale-account" }
    expect(computeLocalFingerprint("bill", dualWritten)).toBe(computeLocalFingerprint("bill", codedBill))
    expect(computeLocalFingerprint("bill", dualWritten)).not.toBe(computeLocalFingerprint("bill", legacyOnlyStale))
  })

  it("falls back to the legacy column when accounting_coding carries no id", () => {
    const partial = { ...legacyBill, accounting_coding: { counterparty: { name: "No id here" }, expense_account: null } }
    expect(computeLocalFingerprint("bill", partial)).toBe(computeLocalFingerprint("bill", legacyBill))
  })

  it("matches the same expense whichever source supplied the references", () => {
    const legacyExpense = {
      amount_cents: 4_200,
      tax_cents: 300,
      expense_date: "2026-02-05",
      qbo_vendor_id: "v-1",
      qbo_expense_account_id: "a-1",
    }
    const codedExpense = {
      amount_cents: 4_200,
      tax_cents: 300,
      expense_date: "2026-02-05",
      accounting_coding: { counterparty: { id: "v-1" }, expense_account: { id: "a-1" } },
    }
    expect(computeLocalFingerprint("project_expense", codedExpense)).toBe(computeLocalFingerprint("project_expense", legacyExpense))
  })

  it("is stable for the same row and moves when a material value moves", () => {
    const first = computeLocalFingerprint("bill", codedBill)
    expect(computeLocalFingerprint("bill", { ...codedBill })).toBe(first)
    expect(computeLocalFingerprint("bill", { ...codedBill, total_cents: 125_001 })).not.toBe(first)
    expect(computeLocalFingerprint("bill", { ...codedBill, due_date: "2026-03-02" })).not.toBe(first)
    expect(
      computeLocalFingerprint("bill", {
        ...codedBill,
        accounting_coding: { ...codedBill.accounting_coding, counterparty: { id: "v-78" } },
      }),
    ).not.toBe(first)
  })

  it("ignores columns nobody's conflict check compares", () => {
    const first = computeLocalFingerprint("bill", codedBill)
    expect(computeLocalFingerprint("bill", { ...codedBill, updated_at: "2026-02-09T00:00:00Z", memo: "anything" })).toBe(first)
  })

  it("treats a missing column as null rather than changing the answer for everyone", () => {
    // A narrowed select must not silently invent a conflict.
    expect(computeLocalFingerprint("invoice", { subtotal_cents: 100, tax_cents: 0, total_cents: 100 })).toBe(
      computeLocalFingerprint("invoice", { subtotal_cents: 100, tax_cents: 0, total_cents: 100, balance_due_cents: null }),
    )
  })

  it("covers vendor credits, which push through the vendor_bills table", () => {
    expect(fingerprintedEntityTypes()).toContain("vendor_credit")
    expect(computeLocalFingerprint("vendor_credit", codedBill)).toBeTruthy()
  })

  it("declares a definition for every entity Arc pushes", () => {
    expect(fingerprintedEntityTypes().sort()).toEqual(["bill", "invoice", "project_expense", "vendor_credit"])
  })

  it("returns null for an unknown entity type or a missing row", () => {
    expect(computeLocalFingerprint("payment", codedBill)).toBeNull()
    expect(computeLocalFingerprint("estimate", codedBill)).toBeNull()
    expect(computeLocalFingerprint("bill", null)).toBeNull()
    expect(computeLocalFingerprint("bill", undefined)).toBeNull()
  })
})

describe("storedLocalFingerprint", () => {
  it("reads the fingerprint off sync-record metadata", () => {
    expect(storedLocalFingerprint({ [LOCAL_FINGERPRINT_KEY]: "abc123" })).toBe("abc123")
  })

  it("returns null for metadata that has never been stamped", () => {
    expect(storedLocalFingerprint(null)).toBeNull()
    expect(storedLocalFingerprint({})).toBeNull()
    expect(storedLocalFingerprint("not-an-object")).toBeNull()
    expect(storedLocalFingerprint({ [LOCAL_FINGERPRINT_KEY]: "" })).toBeNull()
    expect(storedLocalFingerprint({ [LOCAL_FINGERPRINT_KEY]: 42 })).toBeNull()
  })
})

describe("arcChangedSinceSync", () => {
  it("reports a change only when two fingerprints actually differ", () => {
    expect(arcChangedSinceSync({ storedFingerprint: "a", currentFingerprint: "b" })).toBe(true)
    expect(arcChangedSinceSync({ storedFingerprint: "a", currentFingerprint: "a" })).toBe(false)
  })

  it("answers no when either fingerprint is missing", () => {
    // Absence of evidence may not be manufactured into a conflict — rows
    // predating the fingerprint, and entity types without a definition.
    expect(arcChangedSinceSync({ storedFingerprint: null, currentFingerprint: "b" })).toBe(false)
    expect(arcChangedSinceSync({ storedFingerprint: "a", currentFingerprint: null })).toBe(false)
    expect(arcChangedSinceSync({ storedFingerprint: null, currentFingerprint: null })).toBe(false)
  })
})
