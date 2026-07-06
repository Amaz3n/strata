// @ts-expect-error bun test types are not part of this app tsconfig
import { describe, expect, it } from "bun:test"

import { buildInvoiceDraft } from "@/lib/services/cost-plus"
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

  it("preserves a 0% line-level markup override in invoice draft lines", () => {
    const preview = buildInvoiceDraft({
      projectId: "project-1",
      groupBy: "detail",
      costs: [
        {
          id: "cost-1",
          org_id: "org-1",
          project_id: "project-1",
          source_type: "project_expense",
          source_id: "expense-1",
          occurred_on: "2026-05-15",
          description: "Override expense",
          cost_cents: 12500,
          markup_percent_resolved: 0,
          markup_cents: 0,
          billable_cents: 12500,
          is_billable: true,
          status: "open",
          metadata: { markup_source: "line" },
        },
      ],
    })

    expect(preview.lines[0].markup_percent).toBe(0)
    expect(preview.lines[0].markup_cents).toBe(0)
    expect(preview.lines[0].billable_cents).toBe(12500)
  })

  it("presents markup as one separate builder fee line", () => {
    const preview = buildInvoiceDraft({
      projectId: "project-1",
      groupBy: "cost_code",
      feePresentation: "separate_total",
      costs: [
        {
          id: "cost-1",
          org_id: "org-1",
          project_id: "project-1",
          cost_code_id: "code-1",
          cost_code_code: "06100",
          cost_code_name: "Rough carpentry",
          source_type: "project_expense",
          source_id: "expense-1",
          occurred_on: "2026-05-15",
          description: "Lumber",
          cost_cents: 10000,
          markup_percent_resolved: 20,
          markup_cents: 2000,
          billable_cents: 12000,
          is_billable: true,
          status: "open",
        },
      ],
    })

    expect(preview.lines).toHaveLength(2)
    expect(preview.lines[0].billable_cost_ids).toEqual(["cost-1"])
    expect(preview.lines[0].billable_cents).toBe(10000)
    expect(preview.lines[0].markup_cents).toBe(0)
    expect(preview.lines[1].unit).toBe("fee")
    expect(preview.lines[1].billable_cost_ids).toEqual([])
    expect(preview.lines[1].markup_cents).toBe(2000)
    expect(preview.totals.markup_cents).toBe(2000)
    expect(preview.totals.billable_cents).toBe(12000)
  })

  it("presents markup as separate fee lines by cost code", () => {
    const preview = buildInvoiceDraft({
      projectId: "project-1",
      groupBy: "cost_code",
      feePresentation: "separate_by_code",
      costs: [
        {
          id: "cost-1",
          org_id: "org-1",
          project_id: "project-1",
          cost_code_id: "code-1",
          cost_code_code: "06100",
          cost_code_name: "Rough carpentry",
          source_type: "project_expense",
          source_id: "expense-1",
          occurred_on: "2026-05-15",
          description: "Lumber",
          cost_cents: 10000,
          markup_percent_resolved: 20,
          markup_cents: 2000,
          billable_cents: 12000,
          is_billable: true,
          status: "open",
        },
        {
          id: "cost-2",
          org_id: "org-1",
          project_id: "project-1",
          cost_code_id: "code-2",
          cost_code_code: "09200",
          cost_code_name: "Drywall",
          source_type: "project_expense",
          source_id: "expense-2",
          occurred_on: "2026-05-16",
          description: "Board",
          cost_cents: 5000,
          markup_percent_resolved: 10,
          markup_cents: 500,
          billable_cents: 5500,
          is_billable: true,
          status: "open",
        },
      ],
    })

    const feeLines = preview.lines.filter((line) => line.unit === "fee")
    expect(feeLines).toHaveLength(2)
    expect(feeLines.map((line) => line.billable_cents).sort((a, b) => a - b)).toEqual([500, 2000])
    expect(preview.totals.cost_cents).toBe(15000)
    expect(preview.totals.markup_cents).toBe(2500)
    expect(preview.totals.billable_cents).toBe(17500)
  })
})
