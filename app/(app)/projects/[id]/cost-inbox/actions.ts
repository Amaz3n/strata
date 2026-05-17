"use server"

import { revalidatePath } from "next/cache"

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

function revalidateProjectMoney(projectId: string) {
  revalidatePath(`/projects/${projectId}`)
  revalidatePath(`/projects/${projectId}/cost-inbox`)
  revalidatePath(`/projects/${projectId}/financials`)
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
}

export async function categorizeInboxTimeEntryAction(
  projectId: string,
  entryId: string,
  input: CategorizeTimeEntryInput,
) {
  await updateTimeEntry(entryId, {
    costCodeId: input.costCodeId ?? null,
    baseRateCents:
      input.baseRateDollars !== undefined
        ? Math.round(Math.max(0, input.baseRateDollars) * 100)
        : undefined,
    isBillable: input.isBillable,
    isOvertime: input.isOvertime,
  })
  revalidateProjectMoney(projectId)
}

export async function categorizeAndApproveInboxTimeEntryAction(
  projectId: string,
  entryId: string,
  input: CategorizeTimeEntryInput,
) {
  await updateTimeEntry(entryId, {
    costCodeId: input.costCodeId ?? null,
    baseRateCents:
      input.baseRateDollars !== undefined
        ? Math.round(Math.max(0, input.baseRateDollars) * 100)
        : undefined,
    isBillable: input.isBillable,
    isOvertime: input.isOvertime,
  })
  await approveTimeEntry(entryId)
  revalidateProjectMoney(projectId)
}

export async function approveInboxTimeEntryAction(projectId: string, entryId: string, input?: CategorizeTimeEntryInput) {
  if (input) {
    await updateTimeEntry(entryId, {
      costCodeId: input.costCodeId ?? null,
      baseRateCents:
        input.baseRateDollars !== undefined
          ? Math.round(Math.max(0, input.baseRateDollars) * 100)
          : undefined,
      isBillable: input.isBillable,
      isOvertime: input.isOvertime,
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
  const { data: billLines, error: billLinesError } = await supabase
    .from("bill_lines")
    .select("id, cost_code_id")
    .eq("org_id", orgId)
    .eq("bill_id", billId)

  if (billLinesError) throw new Error(`Failed to validate bill coding: ${billLinesError.message}`)
  if ((billLines ?? []).length > 1 && input?.costCodeId) {
    throw new Error("Multi-line vendor bills must be coded line-by-line from Payables before approval")
  }
  if ((billLines ?? []).length > 1 && (billLines ?? []).some((line) => !line.cost_code_id)) {
    throw new Error("Every vendor bill line needs a cost code before approval")
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
