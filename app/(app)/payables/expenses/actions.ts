"use server";

import { revalidatePath } from "next/cache";

import { runAction } from "@/lib/action-result";
import {
  approveOrgExpense,
  assignExpenseHome,
  createOrgExpense,
  rejectOrgExpense,
} from "@/lib/services/org-expenses";
import { DUPLICATE_EXPENSE_ERROR_PREFIX } from "@/lib/services/cost-plus";
import { orgExpenseCreateSchema } from "@/lib/validation/org-expenses";

/** The desk, plus the workbench and the financials of every job the change touched. */
function revalidateExpenses(...projectIds: Array<string | null | undefined>) {
  revalidatePath("/payables/expenses");
  for (const projectId of new Set(projectIds)) {
    if (!projectId) continue;
    revalidatePath(`/projects/${projectId}/expenses`);
    revalidatePath(`/projects/${projectId}/financials`);
  }
}

const DUPLICATE_EXPENSE_CODE = "DUPLICATE_EXPENSE";

/**
 * Creates an expense from a JSON `payload` field and an optional `receipt`
 * file. A possible duplicate comes back with `code: "DUPLICATE_EXPENSE"` so the
 * form can offer "Save anyway".
 */
export async function createOrgExpenseAction(formData: FormData) {
  const result = await runAction(async () => {
    const raw = formData.get("payload");
    if (typeof raw !== "string") throw new Error("The expense was not sent.");
    const payload: unknown = JSON.parse(raw);
    const input = orgExpenseCreateSchema.parse(payload);
    const receipt = formData.get("receipt");
    const created = await createOrgExpense(input, receipt instanceof File && receipt.size > 0 ? receipt : null);
    revalidateExpenses(input.project_id);
    return created;
  });
  if (!result.success && result.error.includes(DUPLICATE_EXPENSE_ERROR_PREFIX))
    return {
      success: false as const,
      error: result.error.split(DUPLICATE_EXPENSE_ERROR_PREFIX).pop()?.trim() ?? result.error,
      code: DUPLICATE_EXPENSE_CODE,
    };
  return result;
}

/** `previousProjectId` is the job the expense leaves, so its pages refresh too. */
export async function assignExpenseHomeAction(input: unknown, previousProjectId: string | null = null) {
  return runAction(async () => {
    const result = await assignExpenseHome(input);
    const next = typeof input === "object" && input !== null && "project_id" in input ? input.project_id : null;
    revalidateExpenses(previousProjectId, typeof next === "string" ? next : null);
    return result;
  });
}

export async function approveOrgExpenseAction(input: unknown, projectId: string | null = null) {
  return runAction(async () => {
    const result = await approveOrgExpense(input);
    revalidateExpenses(projectId);
    return result;
  });
}

export async function rejectOrgExpenseAction(input: unknown, projectId: string | null = null) {
  return runAction(async () => {
    const result = await rejectOrgExpense(input);
    revalidateExpenses(projectId);
    return result;
  });
}
