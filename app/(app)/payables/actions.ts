"use server"

import { revalidatePath } from "next/cache"

import { getProjectCostCodesEnabled } from "@/lib/financials/cost-codes-enabled"
import {
  decidePayableApproval,
  getPayableApprovalDetail,
  preparePayableApproval,
  type PayableApprovalDetail,
  type PayableApprovalOutcome,
  type PreparedPayableApproval,
  type PreparePayableApprovalInput,
} from "@/lib/services/payable-approvals"
import type { DecidePaymentRunInput } from "@/lib/validation/fintech-payments"
import { actionError, type ActionResult } from "@/lib/action-result"
import { listProjectBudgetLines } from "@/lib/services/budgets"
import { requireOrgContext } from "@/lib/services/context"
import {
  evaluateHolds,
  overridePaymentHold,
} from "@/lib/services/payment-holds"
import type { PaymentHoldEvaluation } from "@/lib/services/payment-holds"
import {
  extractPayableInvoiceFromFile,
  type ExtractedPayableInvoice,
} from "@/lib/services/receipt-extraction"
import type { PaymentHoldOverrideInput } from "@/lib/validation/payment-holds"
import type { BudgetLineOption } from "@/lib/types"
import { deletePayableView, savePayableView, type SavedPayableView } from "@/lib/services/payable-views"

export interface OrgPayableContext {
  projectId: string
  costCodesEnabled: boolean
  budgetLines: BudgetLineOption[]
  holds: PaymentHoldEvaluation | null
}

/**
 * The project-shaped context the payables workspace needs for one payable.
 *
 * The org desk lists every project's bills, and cost-code mode, budget lines and
 * payment holds are all per project or per bill — far too much to load for the
 * whole desk up front. It is fetched when a payable is actually opened.
 */
export async function getOrgPayableContextAction(
  projectId: string,
  billId: string,
): Promise<ActionResult<OrgPayableContext>> {
  try {
    const { supabase, orgId } = await requireOrgContext()
    const [costCodesEnabled, budgetLines, holds] = await Promise.all([
      getProjectCostCodesEnabled(supabase, orgId, projectId),
      listProjectBudgetLines(projectId, orgId).catch(() => []),
      // Holds need payment.release; readers without it still get to see the payable.
      evaluateHolds(billId, orgId).catch(() => null),
    ])
    return {
      success: true,
      data: { projectId, costCodesEnabled, budgetLines, holds },
    }
  } catch (error) {
    return actionError(error)
  }
}

/**
 * Prepare a payable's payment for approval: approve the bill's coding, resolve
 * the vendor's verified destination, and draft the run so the preparer reviews
 * real frozen amounts before submitting.
 */
export async function preparePayableApprovalAction(
  input: PreparePayableApprovalInput,
): Promise<ActionResult<PreparedPayableApproval>> {
  try {
    const data = await preparePayableApproval(input)
    revalidatePath("/payables")
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

/** What an approver needs to decide a payable's payment, or null if none is pending. */
export async function getPayableApprovalDetailAction(
  billId: string,
): Promise<ActionResult<PayableApprovalDetail | null>> {
  try {
    return { success: true, data: await getPayableApprovalDetail(billId) }
  } catch (error) {
    return actionError(error)
  }
}

/** Approve or reject a payable's payment; a fully approved run releases immediately. */
export async function decidePayableApprovalAction(
  input: DecidePaymentRunInput,
): Promise<ActionResult<PayableApprovalOutcome>> {
  try {
    const data = await decidePayableApproval(input)
    revalidatePath("/payables")
    revalidatePath("/payables/payment-runs")
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

/**
 * Override one blocking payment hold on a payable, with a written reason.
 * Requires `payments.override_hold`; the override is recorded as immutable
 * audit evidence and the refreshed hold evaluation comes back for the UI.
 */
export async function overridePaymentHoldAction(
  input: PaymentHoldOverrideInput,
): Promise<ActionResult<PaymentHoldEvaluation>> {
  try {
    return { success: true, data: await overridePaymentHold(input) }
  } catch (error) {
    return actionError(error)
  }
}

export async function savePayableViewAction(input: { id?: string; name: string; projectId?: string; filters: unknown; isDefault?: boolean }): Promise<ActionResult<SavedPayableView>> {
  try {
    const data = await savePayableView(input)
    revalidatePath("/payables")
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

export async function deletePayableViewAction(id: string): Promise<ActionResult<{ deleted: true }>> {
  try {
    await deletePayableView(id)
    revalidatePath("/payables")
    return { success: true, data: { deleted: true } }
  } catch (error) {
    return actionError(error)
  }
}

export type PayableInvoiceExtractionResult =
  | { ok: true; data: ExtractedPayableInvoice }
  | { ok: false; error: string }

/**
 * Read a vendor invoice with vision so the form arrives filled in.
 *
 * Deliberately org-scoped and not project-scoped: reading an invoice tells you
 * nothing about which project it belongs to, and on the org desk the project is
 * the one field the human still has to answer. Extraction never needed the
 * project, so asking for one only ever prevented scanning before you had picked.
 *
 * A failed scan is returned as data, not thrown: the sheet stays open on the
 * file the user just chose so they can type the fields in themselves.
 */
export async function extractPayableInvoiceAction(
  formData: FormData,
): Promise<ActionResult<PayableInvoiceExtractionResult>> {
  try {
    const { orgId } = await requireOrgContext()
    const invoice = formData.get("invoice")
    if (!(invoice instanceof File)) {
      return { success: true, data: { ok: false, error: "Choose an invoice to scan" } }
    }
    const data = await extractPayableInvoiceFromFile(invoice, { orgId })
    return { success: true, data: { ok: true, data } }
  } catch (error) {
    console.warn("[PayableExtraction] Scan failed", error)
    return {
      success: true,
      data: { ok: false, error: error instanceof Error ? error.message : "Could not scan invoice" },
    }
  }
}
