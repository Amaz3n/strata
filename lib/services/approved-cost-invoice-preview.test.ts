// @ts-expect-error bun test types are not part of this app tsconfig
import { describe, expect, it } from "bun:test"

import { buildApprovedCostInvoicePreview } from "@/lib/services/invoices"

describe("buildApprovedCostInvoicePreview", () => {
  it("preserves billable cost links and reconciles line totals", () => {
    const preview = buildApprovedCostInvoicePreview({
      projectId: "project-1",
      title: "Approved costs",
      issueDate: "2026-05-15",
      dueDate: "2026-06-14",
      totals: {
        subtotal_cents: 36000,
        tax_cents: 0,
        total_cents: 36000,
      },
      lines: [
        {
          description: "Framing",
          quantity: 1,
          unit: "LS",
          unit_cost_cents: 36000,
          cost_cents: 30000,
          markup_cents: 6000,
          markup_percent: 20,
          billable_cost_ids: ["cost-1", "cost-2"],
        },
      ],
    })

    expect(preview.totals.cost_cents).toBe(30000)
    expect(preview.totals.markup_cents).toBe(6000)
    expect(preview.totals.billable_cents).toBe(36000)
    expect(preview.lines[0].billable_cost_ids).toEqual(["cost-1", "cost-2"])
  })
})
