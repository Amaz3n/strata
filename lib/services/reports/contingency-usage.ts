import { getBudgetWithActuals } from "@/lib/services/budgets"
import { listBudgetTransfers, type BudgetTransfer } from "@/lib/services/budget-transfers"
import { requireOrgContext } from "@/lib/services/context"

export type ContingencyUsageSummary = {
  budget_line_id: string
  line_name: string
  cost_code: string | null
  starting_amount_cents: number
  transfers_in_cents: number
  draws_cents: number
  remaining_cents: number
  drawn_percent: number | null
  actual_cents: number
  draw_vs_actual_cents: number
}

export type ContingencyUsageEntry = {
  transfer_number: number
  date: string
  reason: string
  status: BudgetTransfer["status"]
  contingency_line: string
  amount_cents: number
  direction: "transfer_in" | "draw"
  counterparty_lines: string
  remaining_after_cents: number
}

export type ContingencyUsageReport = {
  generated_at: string
  summaries: ContingencyUsageSummary[]
  entries: ContingencyUsageEntry[]
}

export async function getContingencyUsageReport(projectId: string, orgId?: string): Promise<ContingencyUsageReport> {
  const context = await requireOrgContext(orgId)
  const [budgetData, transfers, { data: budget }] = await Promise.all([
    getBudgetWithActuals(projectId, context.orgId),
    listBudgetTransfers(projectId, context.orgId),
    context.supabase
      .from("budgets")
      .select("id, lines:budget_lines(id, description, amount_cents, metadata, cost_code_id, cost_code:cost_codes(code, name))")
      .eq("org_id", context.orgId)
      .eq("project_id", projectId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  const contingencyLines = (budget?.lines ?? []).filter((line) => {
    const metadata = line.metadata as Record<string, unknown> | null
    return metadata?.is_contingency === true
  })
  const approvedTransfers = transfers
    .filter((transfer) => transfer.status === "approved")
    .sort((a, b) => new Date(a.approved_at ?? a.created_at).getTime() - new Date(b.approved_at ?? b.created_at).getTime())
  const breakdown = (budgetData?.breakdown ?? []) as Array<{
    budget_line_id: string | null
    cost_code_id: string | null
    actual_cents: number
  }>

  const summaries = contingencyLines.map((line) => {
    const lineTransfers = approvedTransfers.flatMap((transfer) =>
      transfer.lines
        .filter((item) => item.budget_line_id === line.id)
        .map((item) => ({ transfer, amountCents: item.amount_cents })),
    )
    const startingAmount = Number(line.amount_cents ?? 0)
    const transfersIn = lineTransfers.reduce((sum, item) => sum + Math.max(0, item.amountCents), 0)
    const draws = lineTransfers.reduce((sum, item) => sum + Math.max(0, -item.amountCents), 0)
    const available = startingAmount + transfersIn
    const actual = breakdown
      .filter((row) => row.budget_line_id === line.id || (line.cost_code_id != null && row.cost_code_id === line.cost_code_id))
      .reduce((sum, row) => sum + Number(row.actual_cents ?? 0), 0)
    const costCode = Array.isArray(line.cost_code) ? line.cost_code[0] : line.cost_code
    return {
      budget_line_id: line.id,
      line_name: line.description,
      cost_code: costCode?.code ?? null,
      starting_amount_cents: startingAmount,
      transfers_in_cents: transfersIn,
      draws_cents: draws,
      remaining_cents: available - draws,
      drawn_percent: available > 0 ? Math.round((draws / available) * 10_000) / 100 : null,
      actual_cents: actual,
      draw_vs_actual_cents: draws - actual,
    }
  })

  const entries: ContingencyUsageEntry[] = []
  for (const summary of summaries) {
    let running = summary.starting_amount_cents
    for (const transfer of approvedTransfers) {
      const movement = transfer.lines.find((line) => line.budget_line_id === summary.budget_line_id)
      if (!movement) continue
      running += movement.amount_cents
      entries.push({
        transfer_number: transfer.transfer_number,
        date: transfer.approved_at ?? transfer.created_at,
        reason: transfer.reason,
        status: transfer.status,
        contingency_line: summary.line_name,
        amount_cents: movement.amount_cents,
        direction: movement.amount_cents >= 0 ? "transfer_in" : "draw",
        counterparty_lines: transfer.lines
          .filter((line) => line.budget_line_id !== summary.budget_line_id)
          .map((line) => line.budget_line?.description ?? "Budget line")
          .join("; "),
        remaining_after_cents: running,
      })
    }
  }

  return { generated_at: new Date().toISOString(), summaries, entries }
}
