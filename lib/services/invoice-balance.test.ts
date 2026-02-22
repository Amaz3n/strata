// @ts-expect-error bun test types are not part of this app tsconfig
import { describe, expect, it } from "bun:test"

import { deriveInvoiceLifecycleStatus } from "@/lib/services/invoice-balance"

describe("deriveInvoiceLifecycleStatus", () => {
  it("keeps saved invoices unsent when there are no payments", () => {
    const status = deriveInvoiceLifecycleStatus({
      currentStatus: "saved",
      totalCents: 125000,
      balanceCents: 125000,
      paidCents: 0,
      dueDate: "2026-12-01",
      clientVisible: false,
      sentAt: null,
    })

    expect(status).toBe("saved")
  })

  it("keeps draft invoices unsent when there are no payments", () => {
    const status = deriveInvoiceLifecycleStatus({
      currentStatus: "draft",
      totalCents: 25000,
      balanceCents: 25000,
      paidCents: 0,
      dueDate: "2026-12-01",
      clientVisible: false,
      sentAt: null,
    })

    expect(status).toBe("draft")
  })

  it("marks sent invoices overdue when due date is in the past with balance due", () => {
    const status = deriveInvoiceLifecycleStatus({
      currentStatus: "sent",
      totalCents: 100000,
      balanceCents: 100000,
      paidCents: 0,
      dueDate: "2000-01-01",
      clientVisible: true,
      sentAt: "2026-02-20T00:00:00.000Z",
    })

    expect(status).toBe("overdue")
  })

  it("marks invoices partial when there is a non-zero payment and remaining balance", () => {
    const status = deriveInvoiceLifecycleStatus({
      currentStatus: "sent",
      totalCents: 100000,
      balanceCents: 40000,
      paidCents: 60000,
      dueDate: "2026-12-01",
      clientVisible: true,
      sentAt: "2026-02-20T00:00:00.000Z",
    })

    expect(status).toBe("partial")
  })

  it("marks invoices paid when balance reaches zero", () => {
    const status = deriveInvoiceLifecycleStatus({
      currentStatus: "sent",
      totalCents: 100000,
      balanceCents: 0,
      paidCents: 100000,
      dueDate: "2026-12-01",
      clientVisible: true,
      sentAt: "2026-02-20T00:00:00.000Z",
    })

    expect(status).toBe("paid")
  })
})
