"use server"

import { revalidatePath } from "next/cache"

import { assertProjectBillingDateEditable } from "@/lib/services/billing-periods"
import { requireOrgContext } from "@/lib/services/context"
import {
  approveProjectExpense,
  approveTimeEntry,
  rejectProjectExpense,
  rejectTimeEntry,
  sendTimeEntryClientApprovalEmail,
  updateTimeEntry,
} from "@/lib/services/cost-plus"
import { updateVendorBillStatus } from "@/lib/services/vendor-bills"
import { getProjectFinancialSettings } from "@/lib/services/project-financial-setup"
import { APPROVAL_GATE_REASONS } from "@/lib/financials/approval-gates"

function revalidateProjectMoney(projectId: string) {
  revalidatePath(`/projects/${projectId}`)
  revalidatePath(`/projects/${projectId}/cost-inbox`)
  revalidatePath(`/projects/${projectId}/financials`)
  revalidatePath(`/projects/${projectId}/financials/review`)
  revalidatePath(`/projects/${projectId}/financials/budget`)
  revalidatePath(`/projects/${projectId}/financials/payables`)
  revalidatePath(`/projects/${projectId}/financials/receivables`)
  revalidatePath(`/projects/${projectId}/payables`)
  revalidatePath(`/projects/${projectId}/time`)
  revalidatePath(`/projects/${projectId}/expenses`)
}

export interface CategorizeTimeEntryInput {
  costCodeId?: string | null
  baseRateDollars?: number
  isBillable?: boolean
  isOvertime?: boolean
  otMultiplier?: number
}

async function assertInboxTimeEntryEditable(projectId: string, entryId: string) {
  const { supabase, orgId } = await requireOrgContext()
  const { data: entry, error } = await supabase
    .from("time_entries")
    .select("work_date")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("id", entryId)
    .maybeSingle()

  if (error) throw new Error(`Failed to validate billing period: ${error.message}`)
  await assertProjectBillingDateEditable({
    supabase,
    orgId,
    projectId,
    date: entry?.work_date ?? null,
    actionLabel: "This time entry",
  })
}

export async function categorizeInboxTimeEntryAction(
  projectId: string,
  entryId: string,
  input: CategorizeTimeEntryInput,
) {
  await assertInboxTimeEntryEditable(projectId, entryId)
  await updateTimeEntry(entryId, {
    costCodeId: input.costCodeId ?? null,
    baseRateCents:
      input.baseRateDollars !== undefined
        ? Math.round(Math.max(0, input.baseRateDollars) * 100)
        : undefined,
    isBillable: input.isBillable,
    isOvertime: input.isOvertime,
    otMultiplier: input.otMultiplier,
  })
  revalidateProjectMoney(projectId)
}

export async function categorizeAndApproveInboxTimeEntryAction(
  projectId: string,
  entryId: string,
  input: CategorizeTimeEntryInput,
) {
  await assertInboxTimeEntryEditable(projectId, entryId)
  await updateTimeEntry(entryId, {
    costCodeId: input.costCodeId ?? null,
    baseRateCents:
      input.baseRateDollars !== undefined
        ? Math.round(Math.max(0, input.baseRateDollars) * 100)
        : undefined,
    isBillable: input.isBillable,
    isOvertime: input.isOvertime,
    otMultiplier: input.otMultiplier,
  })
  await approveTimeEntry(entryId)
  revalidateProjectMoney(projectId)
}

export async function approveInboxTimeEntryAction(projectId: string, entryId: string, input?: CategorizeTimeEntryInput) {
  await assertInboxTimeEntryEditable(projectId, entryId)

  if (input) {
    await updateTimeEntry(entryId, {
      costCodeId: input.costCodeId ?? null,
      baseRateCents:
        input.baseRateDollars !== undefined
          ? Math.round(Math.max(0, input.baseRateDollars) * 100)
          : undefined,
      isBillable: input.isBillable,
      isOvertime: input.isOvertime,
      otMultiplier: input.otMultiplier,
    })
  }
  await approveTimeEntry(entryId)
  revalidateProjectMoney(projectId)
}

export async function rejectInboxTimeEntryAction(projectId: string, entryId: string) {
  await rejectTimeEntry(entryId, { rejectionReason: "Rejected from review queue" })
  revalidateProjectMoney(projectId)
}

export async function sendInboxTimeEntryClientApprovalAction(projectId: string, entryId: string) {
  const result = await sendTimeEntryClientApprovalEmail(entryId)
  revalidateProjectMoney(projectId)
  return result
}

export async function categorizeInboxExpenseAction(projectId: string, expenseId: string, costCodeId: string | null) {
  const { supabase, orgId } = await requireOrgContext()
  const { data: expense, error: expenseError } = await supabase
    .from("project_expenses")
    .select("expense_date")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("id", expenseId)
    .maybeSingle()

  if (expenseError) throw new Error(`Failed to validate billing period: ${expenseError.message}`)
  await assertProjectBillingDateEditable({
    supabase,
    orgId,
    projectId,
    date: expense?.expense_date ?? null,
    actionLabel: "This expense",
  })

  const { error } = await supabase
    .from("project_expenses")
    .update({ cost_code_id: costCodeId })
    .eq("org_id", orgId)
    .eq("id", expenseId)
    .eq("project_id", projectId)

  if (error) throw new Error(`Failed to update expense coding: ${error.message}`)
  revalidateProjectMoney(projectId)
}

export async function approveInboxExpenseAction(projectId: string, expenseId: string, input?: { costCodeId?: string | null }) {
  if (input && "costCodeId" in input) {
    await categorizeInboxExpenseAction(projectId, expenseId, input.costCodeId ?? null)
  }
  await approveProjectExpense(expenseId)
  revalidateProjectMoney(projectId)
}

export async function rejectInboxExpenseAction(projectId: string, expenseId: string) {
  await rejectProjectExpense(expenseId, { rejectionReason: "Rejected from review queue" })
  revalidateProjectMoney(projectId)
}

export async function approveInboxVendorBillAction(projectId: string, billId: string, input?: { costCodeId?: string | null }) {
  const { supabase, orgId } = await requireOrgContext()
  const { data: bill, error: billError } = await supabase
    .from("vendor_bills")
    .select("bill_date, due_date")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("id", billId)
    .maybeSingle()

  if (billError) throw new Error(`Failed to validate billing period: ${billError.message}`)
  const settings = await getProjectFinancialSettings({ supabase, orgId, projectId })
  const costCodesEnabled = settings?.cost_codes_enabled ?? true
  await assertProjectBillingDateEditable({
    supabase,
    orgId,
    projectId,
    date: bill?.bill_date ?? bill?.due_date ?? null,
    actionLabel: "This vendor bill",
  })

  const { data: billLines, error: billLinesError } = await supabase
    .from("bill_lines")
    .select("id, cost_code_id")
    .eq("org_id", orgId)
    .eq("bill_id", billId)

  if (billLinesError) throw new Error(`Failed to validate bill coding: ${billLinesError.message}`)
  if (costCodesEnabled && (billLines ?? []).length > 1 && input?.costCodeId) {
    throw new Error("Multi-line vendor bills must be coded line-by-line from Payables before approval")
  }
  if (costCodesEnabled && (billLines ?? []).length > 1 && (billLines ?? []).some((line) => !line.cost_code_id)) {
    throw new Error(APPROVAL_GATE_REASONS.vendorBillLineMissingCostCode)
  }
  await updateVendorBillStatus({
    billId,
    input: {
      status: "approved",
      cost_code_id: input?.costCodeId ?? undefined,
    },
  })
  revalidateProjectMoney(projectId)
}
