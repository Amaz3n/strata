import type { SupabaseClient } from "@supabase/supabase-js"

import {
  summarizeJobCostEntriesByCostCode,
  type JobCostActualByCostCode,
  type JobCostGroupBy,
} from "@/lib/financials/job-cost-rules"
import { resolveGmpClassificationForCostSource, type GmpClassification } from "@/lib/financials/gmp-classification"
import { calculateTimeEntryCostCents } from "@/lib/financials/job-cost-calculations"
import { requireOrgContext } from "@/lib/services/context"

export type { JobCostActualByCostCode } from "@/lib/financials/job-cost-rules"

export type JobCostSourceType =
  | "vendor_bill_line"
  | "project_expense"
  | "project_expense_line"
  | "time_entry"
  | "manual_adjustment"

export interface JobCostEntry {
  id: string
  org_id: string
  project_id: string
  cost_code_id?: string | null
  budget_line_id?: string | null
  source_type: JobCostSourceType
  source_id: string
  incurred_on: string
  cost_cents: number
  status: "pending" | "approved" | "posted" | "voided"
  is_billable: boolean
  gmp_classification?: GmpClassification | null
  billable_cost_id?: string | null
  invoice_id?: string | null
  metadata?: Record<string, any>
}

function toDateOnly(value?: string | null) {
  if (!value) return new Date().toISOString().slice(0, 10)
  return value.slice(0, 10)
}

export { calculateTimeEntryCostCents }


async function findBillableCostForSource(args: {
  supabase: SupabaseClient
  orgId: string
  sourceType: Exclude<JobCostSourceType, "manual_adjustment">
  sourceId: string
}) {
  const { data, error } = await args.supabase
    .from("billable_costs")
    .select("id, is_billable, invoice_id, status, gmp_classification")
    .eq("org_id", args.orgId)
    .eq("source_type", args.sourceType)
    .eq("source_id", args.sourceId)
    .neq("status", "voided")
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load billable-cost link: ${error.message}`)
  }

  return data
}

async function upsertJobCostEntry(
  supabase: SupabaseClient,
  payload: {
    org_id: string
    project_id: string
    cost_code_id?: string | null
    budget_line_id?: string | null
    source_type: JobCostSourceType
    source_id: string
    incurred_on: string
    cost_cents: number
    status?: "pending" | "approved" | "posted" | "voided"
    is_billable?: boolean
    gmp_classification?: GmpClassification | null
    billable_cost_id?: string | null
    invoice_id?: string | null
    metadata?: Record<string, any>
  },
) {
  if (!payload.project_id) throw new Error("Job-cost entry is missing project context")
  if (!payload.source_id) throw new Error("Job-cost entry is missing source id")
  if (!Number.isFinite(payload.cost_cents)) throw new Error("Job-cost entry cost is invalid")

  const row = {
    ...payload,
    cost_code_id: payload.cost_code_id ?? null,
    budget_line_id: payload.budget_line_id ?? null,
    incurred_on: toDateOnly(payload.incurred_on),
    cost_cents: Math.round(payload.cost_cents),
    status: payload.status ?? "posted",
    is_billable: payload.is_billable ?? false,
    gmp_classification: payload.gmp_classification ?? "inside_gmp",
    billable_cost_id: payload.billable_cost_id ?? null,
    invoice_id: payload.invoice_id ?? null,
    metadata: payload.metadata ?? {},
  }

  const { data, error } = await supabase
    .from("job_cost_entries")
    .upsert(row, { onConflict: "org_id,source_type,source_id" })
    .select("*")
    .single()

  if (error || !data) {
    throw new Error(`Failed to post job-cost actual: ${error?.message}`)
  }

  return data as JobCostEntry
}

export async function postJobCostEntryFromBillLine(args: { billLineId: string; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(args.orgId)
  const { data: line, error } = await supabase
    .from("bill_lines")
    .select(`
      id, org_id, bill_id, project_id, cost_code_id, budget_line_id, description, quantity, unit_cost_cents, metadata,
      bill:vendor_bills(id, org_id, project_id, bill_number, bill_date, status, approved_at, created_at)
    `)
    .eq("org_id", resolvedOrgId)
    .eq("id", args.billLineId)
    .maybeSingle()

  if (error || !line) throw new Error("Bill line not found")
  const bill = (line as any).bill
  // A bill line can be allocated to a different project than the bill's primary
  // (multi-project bills); fall back to the bill's project when the line is untagged.
  const lineProjectId = (line as any).project_id ?? bill?.project_id
  if (!lineProjectId) throw new Error("Bill line is missing project context")
  if (!["approved", "partial", "paid"].includes(String(bill.status))) {
    throw new Error("Vendor bill must be approved before it posts to job cost")
  }

  const billable = await findBillableCostForSource({
    supabase,
    orgId: resolvedOrgId,
    sourceType: "vendor_bill_line",
    sourceId: line.id,
  })

  const costCents = Math.round(Number(line.unit_cost_cents ?? 0) * Number(line.quantity ?? 1))
  const gmpClassification =
    billable?.gmp_classification ??
    (await resolveGmpClassificationForCostSource({
      supabase,
      orgId: resolvedOrgId,
      projectId: lineProjectId,
      budgetLineId: (line as any).budget_line_id ?? null,
      costCodeId: line.cost_code_id ?? null,
    }))
  return upsertJobCostEntry(supabase, {
    org_id: resolvedOrgId,
    project_id: lineProjectId,
    cost_code_id: line.cost_code_id ?? null,
    budget_line_id: (line as any).budget_line_id ?? null,
    source_type: "vendor_bill_line",
    source_id: line.id,
    incurred_on: bill.bill_date ?? bill.approved_at ?? bill.created_at,
    cost_cents: costCents,
    is_billable: Boolean(billable?.id && billable.is_billable !== false && billable.status !== "excluded"),
    gmp_classification: gmpClassification,
    billable_cost_id: billable?.id ?? null,
    invoice_id: billable?.invoice_id ?? null,
    metadata: {
      ...(line.metadata ?? {}),
      gmp_classification: gmpClassification,
      source_label: "vendor_bill_line",
      bill_id: bill.id,
      bill_number: bill.bill_number ?? null,
      bill_status: bill.status,
      description: line.description ?? null,
    },
  })
}

export async function postJobCostEntryFromProjectExpense(args: { expenseId: string; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(args.orgId)
  const { data: expense, error } = await supabase
    .from("project_expenses")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", args.expenseId)
    .maybeSingle()

  if (error || !expense) throw new Error("Expense not found")
  if (!["approved", "locked"].includes(String(expense.status))) {
    throw new Error("Expense must be approved before it posts to job cost")
  }

  const billable = await findBillableCostForSource({
    supabase,
    orgId: resolvedOrgId,
    sourceType: "project_expense",
    sourceId: expense.id,
  })
  const gmpClassification =
    billable?.gmp_classification ??
    (await resolveGmpClassificationForCostSource({
      supabase,
      orgId: resolvedOrgId,
      projectId: expense.project_id,
      budgetLineId: expense.budget_line_id ?? null,
      costCodeId: expense.cost_code_id ?? null,
    }))

  return upsertJobCostEntry(supabase, {
    org_id: resolvedOrgId,
    project_id: expense.project_id,
    cost_code_id: expense.cost_code_id ?? null,
    budget_line_id: expense.budget_line_id ?? null,
    source_type: "project_expense",
    source_id: expense.id,
    incurred_on: expense.expense_date,
    cost_cents: Number(expense.amount_cents ?? 0) + Number(expense.tax_cents ?? 0),
    is_billable: Boolean(billable?.id && billable.is_billable !== false && billable.status !== "excluded"),
    gmp_classification: gmpClassification,
    billable_cost_id: expense.billable_cost_id ?? billable?.id ?? null,
    invoice_id: billable?.invoice_id ?? null,
    metadata: {
      ...(expense.metadata ?? {}),
      gmp_classification: gmpClassification,
      source_label: "project_expense",
      expense_status: expense.status,
      description: expense.description ?? expense.vendor_name_text ?? null,
      vendor_company_id: expense.vendor_company_id ?? null,
      vendor_name_text: expense.vendor_name_text ?? null,
      receipt_file_id: expense.receipt_file_id ?? null,
    },
  })
}

export async function postJobCostEntryFromExpenseLine(args: { expenseLineId: string; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(args.orgId)
  const { data: line, error } = await supabase
    .from("project_expense_lines")
    .select(`
      id, org_id, expense_id, project_id, cost_code_id, budget_line_id, description, amount_cents, metadata,
      expense:project_expenses(id, org_id, project_id, expense_date, status, vendor_company_id, vendor_name_text, receipt_file_id)
    `)
    .eq("org_id", resolvedOrgId)
    .eq("id", args.expenseLineId)
    .maybeSingle()

  if (error || !line) throw new Error("Expense split not found")
  const expense = (line as any).expense
  // A split can post to a different project than the expense's primary (cross-project
  // allocation); fall back to the expense's project when the line is untagged.
  const lineProjectId = (line as any).project_id ?? expense?.project_id
  if (!lineProjectId) throw new Error("Expense split is missing project context")
  if (!["approved", "locked"].includes(String(expense?.status))) {
    throw new Error("Expense must be approved before it posts to job cost")
  }

  const billable = await findBillableCostForSource({
    supabase,
    orgId: resolvedOrgId,
    sourceType: "project_expense_line",
    sourceId: line.id,
  })
  const gmpClassification =
    billable?.gmp_classification ??
    (await resolveGmpClassificationForCostSource({
      supabase,
      orgId: resolvedOrgId,
      projectId: lineProjectId,
      budgetLineId: (line as any).budget_line_id ?? null,
      costCodeId: line.cost_code_id ?? null,
    }))

  return upsertJobCostEntry(supabase, {
    org_id: resolvedOrgId,
    project_id: lineProjectId,
    cost_code_id: line.cost_code_id ?? null,
    budget_line_id: (line as any).budget_line_id ?? null,
    source_type: "project_expense_line",
    source_id: line.id,
    incurred_on: expense.expense_date,
    cost_cents: Number(line.amount_cents ?? 0),
    is_billable: Boolean(billable?.id && billable.is_billable !== false && billable.status !== "excluded"),
    gmp_classification: gmpClassification,
    billable_cost_id: billable?.id ?? null,
    invoice_id: billable?.invoice_id ?? null,
    metadata: {
      ...(line.metadata ?? {}),
      gmp_classification: gmpClassification,
      source_label: "project_expense_line",
      expense_id: expense.id,
      expense_status: expense.status,
      description: line.description ?? expense.description ?? expense.vendor_name_text ?? null,
      vendor_company_id: expense.vendor_company_id ?? null,
      vendor_name_text: expense.vendor_name_text ?? null,
      receipt_file_id: expense.receipt_file_id ?? null,
    },
  })
}

export async function postJobCostEntryFromTimeEntry(args: { timeEntryId: string; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(args.orgId)
  const { data: entry, error } = await supabase
    .from("time_entries")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", args.timeEntryId)
    .maybeSingle()

  if (error || !entry) throw new Error("Time entry not found")
  if (!["pm_approved", "client_approved", "locked"].includes(String(entry.status))) {
    throw new Error("Time entry must be approved before it posts to job cost")
  }

  const billable = await findBillableCostForSource({
    supabase,
    orgId: resolvedOrgId,
    sourceType: "time_entry",
    sourceId: entry.id,
  })
  const gmpClassification =
    billable?.gmp_classification ??
    (await resolveGmpClassificationForCostSource({
      supabase,
      orgId: resolvedOrgId,
      projectId: entry.project_id,
      budgetLineId: entry.budget_line_id ?? null,
      costCodeId: entry.cost_code_id ?? null,
    }))

  return upsertJobCostEntry(supabase, {
    org_id: resolvedOrgId,
    project_id: entry.project_id,
    cost_code_id: entry.cost_code_id ?? null,
    budget_line_id: entry.budget_line_id ?? null,
    source_type: "time_entry",
    source_id: entry.id,
    incurred_on: entry.work_date,
    cost_cents: calculateTimeEntryCostCents(entry),
    is_billable: Boolean(billable?.id && billable.is_billable !== false && billable.status !== "excluded"),
    gmp_classification: gmpClassification,
    billable_cost_id: entry.billable_cost_id ?? billable?.id ?? null,
    invoice_id: billable?.invoice_id ?? null,
    metadata: {
      ...(entry.metadata ?? {}),
      gmp_classification: gmpClassification,
      source_label: "time_entry",
      time_entry_status: entry.status,
      worker_user_id: entry.worker_user_id ?? null,
      worker_company_id: entry.worker_company_id ?? null,
      worker_name: entry.worker_name ?? null,
      hours: entry.hours ?? null,
      base_rate_cents: entry.base_rate_cents ?? null,
      burden_multiplier: entry.burden_multiplier ?? null,
      is_overtime: entry.is_overtime ?? false,
      ot_multiplier: entry.ot_multiplier ?? 1.5,
    },
  })
}

export async function postJobCostActualsForVendorBill(args: { billId: string; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(args.orgId)
  const { data: lines, error } = await supabase
    .from("bill_lines")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("bill_id", args.billId)

  if (error) throw new Error(`Failed to load bill lines for job cost: ${error.message}`)

  for (const line of lines ?? []) {
    await postJobCostEntryFromBillLine({ billLineId: line.id, orgId: resolvedOrgId })
  }
}

export async function voidJobCostEntriesForVendorBill(args: { billId: string; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(args.orgId)
  const { data: lines, error } = await supabase
    .from("bill_lines")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("bill_id", args.billId)

  if (error) throw new Error(`Failed to load bill lines for job-cost void: ${error.message}`)
  const lineIds = (lines ?? []).map((line) => line.id).filter(Boolean)
  if (lineIds.length === 0) return

  const { error: updateError } = await supabase
    .from("job_cost_entries")
    .update({ status: "voided" })
    .eq("org_id", resolvedOrgId)
    .eq("source_type", "vendor_bill_line")
    .in("source_id", lineIds)

  if (updateError) throw new Error(`Failed to void job-cost entries: ${updateError.message}`)
}

export async function voidJobCostEntryForSource(args: {
  sourceType: Exclude<JobCostSourceType, "manual_adjustment">
  sourceId: string
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(args.orgId)
  const { error } = await supabase
    .from("job_cost_entries")
    .update({ status: "voided" })
    .eq("org_id", resolvedOrgId)
    .eq("source_type", args.sourceType)
    .eq("source_id", args.sourceId)

  if (error) throw new Error(`Failed to void job-cost entry: ${error.message}`)
}

export async function getProjectJobCostActualsByCostCode({
  projectId,
  orgId,
  supabase: providedSupabase,
  groupBy = "cost_code",
}: {
  projectId: string
  orgId?: string
  supabase?: SupabaseClient
  groupBy?: JobCostGroupBy
}): Promise<JobCostActualByCostCode[]> {
  const context = providedSupabase ? { supabase: providedSupabase, orgId: orgId as string } : await requireOrgContext(orgId)
  if (!context.orgId) throw new Error("Organization is required to load job-cost actuals")
  const { supabase, orgId: resolvedOrgId } = context
  const { data, error } = await supabase
    .from("job_cost_entries")
    .select("org_id, cost_code_id, budget_line_id, source_type, source_id, cost_cents, status, is_billable, cost_code:cost_codes(cost_type), budget_line:budget_lines(cost_type, cost_code:cost_codes(cost_type))")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .eq("status", "posted")

  if (error) {
    throw new Error(`Failed to load job-cost actuals: ${error.message}`)
  }

  const enriched = (data ?? []).map((row) => {
    const costCode = Array.isArray(row.cost_code) ? row.cost_code[0] : row.cost_code
    const budgetLine = Array.isArray(row.budget_line) ? row.budget_line[0] : row.budget_line
    const budgetLineCostCode = Array.isArray(budgetLine?.cost_code)
      ? budgetLine.cost_code[0]
      : budgetLine?.cost_code
    return {
      ...row,
      cost_type: budgetLine?.cost_type ?? costCode?.cost_type ?? budgetLineCostCode?.cost_type ?? null,
    }
  })

  return summarizeJobCostEntriesByCostCode(enriched, groupBy)
}
