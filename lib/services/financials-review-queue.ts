import type { SupabaseClient } from "@supabase/supabase-js"

import { getProjectFinancialSetupStatusForProject } from "@/lib/services/project-financial-setup"
import { listProjectBillingPeriods, type ProjectBillingPeriod } from "@/lib/services/billing-periods"
import { listCostCodes } from "@/lib/services/cost-codes"
import { listCostPlusTabData } from "@/lib/services/cost-plus"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { listVendorBillsForProject } from "@/lib/services/vendor-bills"

export type FinancialsReviewQueueData = Awaited<ReturnType<typeof loadFinancialsReviewQueueData>>

export async function loadFinancialsReviewQueueData(projectId: string) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requireAuthorization({
    permission: "invoice.read",
    userId,
    orgId,
    projectId,
    supabase,
    logDecision: true,
    resourceType: "financials_review_queue",
  })

  const [setupResult, periodsResult, costPlusResult, vendorBillsResult, costCodesResult, billableCostsResult] = await Promise.allSettled([
    getProjectFinancialSetupStatusForProject(projectId, orgId),
    listProjectBillingPeriods(projectId, orgId),
    listCostPlusTabData(projectId),
    listVendorBillsForProject(projectId),
    listCostCodes(),
    listReviewQueueBillableCosts({ supabase, orgId, projectId }),
  ])

  const errors = [
    resultError("Financial setup", setupResult),
    resultError("Billing periods", periodsResult),
    resultError("Cost-plus ledger", costPlusResult),
    resultError("Vendor bills", vendorBillsResult),
    resultError("Cost codes", costCodesResult),
    resultError("Ready costs", billableCostsResult),
  ].filter(Boolean) as string[]

  const setup = setupResult.status === "fulfilled" ? setupResult.value : null
  if (setup?.billingModel === "fixed_price") {
    const costCodes = costCodesResult.status === "fulfilled" ? costCodesResult.value : []
    const costCodesEnabled = setup.settings?.cost_codes_enabled ?? true
    return {
      timeEntries: [],
      expenses: [],
      vendorBills: [],
      openCosts: [],
      billingPeriods: [],
      costCodes: costCodesEnabled ? costCodes : [],
      costCodesEnabled,
      errors,
    }
  }

  const costPlusData =
    costPlusResult.status === "fulfilled"
      ? costPlusResult.value
      : { billableCosts: [], timeEntries: [], expenses: [], gmpSnapshot: null }
  const vendorBills = vendorBillsResult.status === "fulfilled" ? vendorBillsResult.value : []
  const costCodes = costCodesResult.status === "fulfilled" ? costCodesResult.value : []
  const billingPeriods = periodsResult.status === "fulfilled" ? periodsResult.value : []
  const billableCosts = billableCostsResult.status === "fulfilled" ? billableCostsResult.value : []
  const settings = setup?.settings ?? null
  const costCodesEnabled = settings?.cost_codes_enabled ?? true

  return {
    timeEntries: (costPlusData.timeEntries ?? [])
      .filter((entry: any) => ["submitted", "pm_approved"].includes(entry.status))
      .map((entry: any) =>
        annotateReviewRow({
          row: entry,
          date: entry.work_date,
          baseState:
            entry.status === "pm_approved"
              ? "awaiting-client-approval"
              : Number(entry.base_rate_cents ?? 0) <= 0 || (costCodesEnabled && !entry.cost_code_id)
                ? "blocked"
                : "needs-review",
          periods: billingPeriods,
          blockingReasons: [
            Number(entry.base_rate_cents ?? 0) <= 0 ? "Set a labor rate before approval." : null,
            costCodesEnabled && !entry.cost_code_id ? "Choose a cost code." : null,
            settings?.proof_required && (!Array.isArray(entry.attached_file_ids) || entry.attached_file_ids.length === 0)
              ? "Attach time backup before billing."
              : null,
          ],
          proofComplete: Array.isArray(entry.attached_file_ids) && entry.attached_file_ids.length > 0,
          paidEligible: true,
        }),
      ),
    expenses: (costPlusData.expenses ?? [])
      .filter((expense: any) => ["draft", "submitted"].includes(expense.status))
      .map((expense: any) =>
        annotateReviewRow({
          row: expense,
          date: expense.expense_date,
          baseState: expense.status === "draft" || (costCodesEnabled && !expense.cost_code_id) || !expense.receipt_file_id ? "blocked" : "needs-review",
          periods: billingPeriods,
          blockingReasons: [
            expense.status === "draft" ? "Submit expense before approval." : null,
            costCodesEnabled && !expense.cost_code_id ? "Choose a cost code." : null,
            settings?.proof_required && !expense.receipt_file_id ? "Attach receipt proof before billing." : null,
          ],
          proofComplete: Boolean(expense.receipt_file_id),
          paidEligible: true,
        }),
      ),
    vendorBills: vendorBills
      .filter((bill) => bill.status === "pending")
      .map((bill) => {
        const actualLines = bill.actual_lines ?? []
        const isCoded = !costCodesEnabled || (actualLines.length > 0 && actualLines.every((line: any) => Boolean(line.cost_code_id)))
        const isPaid = Number((bill as any).paid_cents ?? 0) >= Number(bill.total_cents ?? 0) && Number(bill.total_cents ?? 0) > 0
        return annotateReviewRow({
          row: bill,
          date: bill.bill_date ?? bill.due_date,
          baseState: isCoded ? "needs-review" : "blocked",
          periods: billingPeriods,
          blockingReasons: [
            costCodesEnabled && !isCoded ? "Every vendor bill line needs a cost code." : null,
            settings?.proof_required && !(bill as any).file_id ? "Attach vendor bill proof before billing." : null,
            settings?.paid_costs_required && !isPaid ? "Mark vendor bill paid before owner billing." : null,
          ],
          proofComplete: Boolean((bill as any).file_id),
          paidEligible: !settings?.paid_costs_required || isPaid,
        })
      }),
    openCosts: billableCosts.map((cost: any) =>
      annotateReviewRow({
        row: cost,
        date: cost.occurred_on,
        baseState: cost.status === "billed" ? "billed" : cost.queue_state ?? "ready-to-invoice",
        periods: billingPeriods,
        blockingReasons: cost.blocking_reasons ?? [],
        proofComplete: cost.proof_complete ?? true,
        paidEligible: cost.paid_eligible ?? true,
      }),
    ),
    billingPeriods,
    costCodes: costCodesEnabled ? costCodes : [],
    costCodesEnabled,
    errors,
  }
}

async function listReviewQueueBillableCosts({
  supabase,
  orgId,
  projectId,
}: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
}) {
  const since = new Date()
  since.setDate(since.getDate() - 45)

  const { data, error } = await supabase
    .from("billable_costs")
    .select("*, cost_code:cost_codes(code, name), invoice:invoices(id, invoice_number, status, issue_date, total_cents)")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .in("status", ["open", "billed"])
    .eq("is_billable", true)
    .order("occurred_on", { ascending: false })

  if (error) throw new Error(`Failed to load ready costs: ${error.message}`)
  const rows = (data ?? []).filter((row: any) => row.status === "open" || String(row.billed_at ?? row.updated_at ?? "") >= since.toISOString())
  return enrichBillableCostEligibility({ supabase, orgId, costs: rows })
}

async function enrichBillableCostEligibility({
  supabase,
  orgId,
  costs,
}: {
  supabase: SupabaseClient
  orgId: string
  costs: any[]
}) {
  const vendorBillLineIds = costs.filter((cost) => cost.source_type === "vendor_bill_line").map((cost) => cost.source_id)
  const expenseIds = costs.filter((cost) => cost.source_type === "project_expense").map((cost) => cost.source_id)
  const timeEntryIds = costs.filter((cost) => cost.source_type === "time_entry").map((cost) => cost.source_id)

  const [billLinesResult, expensesResult, timeEntriesResult] = await Promise.all([
    vendorBillLineIds.length
      ? supabase
          .from("bill_lines")
          .select("id, bill:vendor_bills(id, status, file_id, paid_cents, total_cents)")
          .eq("org_id", orgId)
          .in("id", vendorBillLineIds)
      : Promise.resolve({ data: [], error: null }),
    expenseIds.length
      ? supabase.from("project_expenses").select("id, status, receipt_file_id").eq("org_id", orgId).in("id", expenseIds)
      : Promise.resolve({ data: [], error: null }),
    timeEntryIds.length
      ? supabase.from("time_entries").select("id, status, attached_file_ids").eq("org_id", orgId).in("id", timeEntryIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (billLinesResult.error) throw new Error(`Failed to load vendor bill proof: ${billLinesResult.error.message}`)
  if (expensesResult.error) throw new Error(`Failed to load expense proof: ${expensesResult.error.message}`)
  if (timeEntriesResult.error) throw new Error(`Failed to load time proof: ${timeEntriesResult.error.message}`)

  const sourceFacts = new Map<string, { proof_complete: boolean; paid_eligible: boolean; source_status?: string | null }>()
  for (const row of billLinesResult.data ?? []) {
    const bill = Array.isArray((row as any).bill) ? (row as any).bill[0] : (row as any).bill
    const totalCents = Number(bill?.total_cents ?? 0)
    sourceFacts.set(`vendor_bill_line:${row.id}`, {
      proof_complete: Boolean(bill?.file_id),
      paid_eligible: bill?.status === "paid" || (totalCents > 0 && Number(bill?.paid_cents ?? 0) >= totalCents),
      source_status: bill?.status ?? null,
    })
  }
  for (const row of expensesResult.data ?? []) {
    sourceFacts.set(`project_expense:${row.id}`, {
      proof_complete: Boolean(row.receipt_file_id),
      paid_eligible: true,
      source_status: row.status ?? null,
    })
  }
  for (const row of timeEntriesResult.data ?? []) {
    sourceFacts.set(`time_entry:${row.id}`, {
      proof_complete: Array.isArray(row.attached_file_ids) && row.attached_file_ids.length > 0,
      paid_eligible: true,
      source_status: row.status ?? null,
    })
  }

  return costs.map((cost) => {
    const facts = sourceFacts.get(`${cost.source_type}:${cost.source_id}`)
    return {
      ...cost,
      cost_code_code: cost.cost_code?.code ?? null,
      cost_code_name: cost.cost_code?.name ?? null,
      recent_invoice: cost.invoice ?? null,
      proof_complete: facts?.proof_complete ?? true,
      paid_eligible: facts?.paid_eligible ?? true,
      source_status: facts?.source_status ?? null,
      queue_state: cost.status === "billed" ? "billed" : "ready-to-invoice",
      blocking_reasons: [],
    }
  })
}

function annotateReviewRow({
  row,
  date,
  baseState,
  periods,
  blockingReasons,
  proofComplete,
  paidEligible,
}: {
  row: any
  date?: string | null
  baseState: "needs-review" | "blocked" | "awaiting-client-approval" | "ready-to-invoice" | "billed"
  periods: ProjectBillingPeriod[]
  blockingReasons: Array<string | null | undefined>
  proofComplete: boolean
  paidEligible: boolean
}) {
  const period = date ? periods.find((item) => item.period_start <= date && item.period_end >= date) : null
  const nextOpenPeriod = date
    ? periods
        .filter((item) => ["open", "reviewing", "reopened"].includes(item.status) && item.period_end > date)
        .sort((a, b) => a.period_start.localeCompare(b.period_start))[0] ?? null
    : null
  const closedPeriod = period && ["closed", "invoiced"].includes(period.status) ? period : null
  const canCarryLateCostForward = Boolean(closedPeriod && nextOpenPeriod && baseState === "ready-to-invoice")
  const reasons = blockingReasons.filter(Boolean) as string[]
  if (closedPeriod && baseState !== "billed" && !canCarryLateCostForward) {
    reasons.push(`Cost date is in ${closedPeriod.status} billing period ${closedPeriod.name}.`)
  }

  return {
    ...row,
    queue_state: reasons.length > 0 && baseState !== "billed" ? "blocked" : baseState,
    blocking_reasons: reasons,
    proof_complete: proofComplete,
    paid_eligible: paidEligible,
    billing_period_id: period?.id ?? row.billing_period_id ?? null,
    billing_period_name: period?.name ?? null,
    billing_period_status: period?.status ?? null,
    late_to_billing_period_id: closedPeriod ? nextOpenPeriod?.id ?? null : row.late_to_billing_period_id ?? null,
    late_to_billing_period_name: closedPeriod ? nextOpenPeriod?.name ?? null : null,
  }
}

function resultError(label: string, result: PromiseSettledResult<unknown>) {
  if (result.status === "fulfilled") return null
  const message = result.reason instanceof Error ? result.reason.message : String(result.reason ?? "Unknown error")
  return `${label}: ${message}`
}
