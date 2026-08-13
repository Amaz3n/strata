"use server"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordExtractionCorrection } from "@/lib/services/vendor-extraction-memory"
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
import {
  cancelPaymentRun,
  getPaymentRunSetupData,
  submitPaymentRun,
} from "@/lib/services/payment-runs"
import type { PaymentApprovalRouting } from "@/lib/services/payment-approvers"
import type { ProviderSettlementWindow } from "@/lib/payments/settlement-estimate"
import type { ApFeePolicy } from "@/lib/payments/fee-engine"
import { decidePaymentRiskReview, type DecidePaymentRiskInput } from "@/lib/services/payment-risk"
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
} from "@/lib/services/document-extraction"
import { getVendorPayableProfile, type VendorPayableProfile } from "@/lib/services/companies"
import type { PaymentHoldOverrideInput } from "@/lib/validation/payment-holds"
import type { BudgetLineOption } from "@/lib/types"

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
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

/**
 * Override one blocking payment hold on a payable, with a written reason.
 * Requires `payment.override_hold`; the override is recorded as immutable
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

/**
 * The vendor's standing with this org, for the card that replaces the vendor
 * picker once a vendor is on the payable. Never blocks bill entry: a vendor the
 * viewer has no history permission for reads as a vendor with no history.
 */
export async function getPayableVendorProfileAction(
  companyId: string,
): Promise<ActionResult<VendorPayableProfile | null>> {
  try {
    return { success: true, data: await getVendorPayableProfile(companyId) }
  } catch (error) {
    return actionError(error)
  }
}

/**
 * What the desk needs to turn a selection into a payment run: which bank the
 * debit comes from, who it routes to for approval, and how the fees price.
 *
 * Deliberately lighter than `getPaymentRunSetupData` — the desk already has the
 * bills, so it never needs the eligible-bill list that surface computed.
 */
export interface PayableBatchEligibleBill {
  id: string
  /**
   * The early-pay discount still available on this bill, if any — computed by
   * `getPaymentRunSetupData` so the preparer sees the money before choosing to
   * pay, not after. Advisory in the UI; the destination and amounts are
   * resolved server-side when the run is prepared.
   */
  discount: { byDate: string; amountCents: number; netAmountCents: number } | null
}

export async function getPayableBatchSetupAction(): Promise<
  ActionResult<{
    fundingSources: Array<{ id: string; label: string; isDefault: boolean }>
    routing: PaymentApprovalRouting
    requiredApprovals: number
    requesterMayApprove: boolean
    settlementWindow: ProviderSettlementWindow
    feePolicy: ApFeePolicy
    eligibleBills: PayableBatchEligibleBill[]
  }>
> {
  try {
    const setup = await getPaymentRunSetupData()
    return {
      success: true,
      data: {
        fundingSources: setup.fundingSources,
        routing: setup.routing,
        requiredApprovals: setup.requiredApprovals,
        requesterMayApprove: setup.requesterMayApprove,
        settlementWindow: setup.settlementWindow,
        feePolicy: setup.feePolicy,
        eligibleBills: setup.eligibleBills.map((entry) => ({ id: entry.id, discount: entry.discount })),
      },
    }
  } catch (error) {
    return actionError(error)
  }
}

/** Freeze a prepared run and send it to its approvers. */
export async function submitPayableBatchAction(
  input: { run_id: string; scheduled_for?: string | null },
): Promise<ActionResult<{ id: string; status: string }>> {
  try {
    const data = await submitPaymentRun({
      run_id: input.run_id,
      scheduled_for: input.scheduled_for ?? null,
    })
    revalidatePath("/payables")
    return { success: true, data: { id: data.id, status: data.status } }
  } catch (error) {
    return actionError(error)
  }
}

/** Discard a prepared run the preparer backed out of, so its bills free up again. */
export async function discardPayableBatchAction(runId: string): Promise<ActionResult<{ id: string }>> {
  try {
    await cancelPaymentRun(runId)
    revalidatePath("/payables")
    return { success: true, data: { id: runId } }
  } catch (error) {
    return actionError(error)
  }
}

/** Clear or confirm an automated risk block. Requires step-up; the preparer cannot decide their own. */
export async function decidePaymentRiskReviewAction(
  input: DecidePaymentRiskInput,
): Promise<ActionResult<{ id: string; decision: string }>> {
  try {
    const data = await decidePaymentRiskReview(input)
    revalidatePath("/payables")
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

/**
 * Record how a human corrected a scanned invoice, so the next one from this
 * vendor reads better. Fire-and-forget from the create sheet: a failure here
 * must never affect the payable that was just created.
 */
export async function recordExtractionCorrectionAction(input: {
  companyId: string
  read: { billNumber: string | null; totalDollars: number | null; lineCount: number }
  corrected: { billNumber: string | null; totalDollars: number | null; lineCount: number }
}): Promise<ActionResult<{ recorded: true }>> {
  try {
    const { orgId } = await requireOrgContext()
    await recordExtractionCorrection({
      supabase: createServiceSupabaseClient(),
      orgId,
      companyId: input.companyId,
      read: input.read,
      corrected: input.corrected,
    })
    return { success: true, data: { recorded: true } }
  } catch (error) {
    console.warn("[PayableExtraction] Could not record correction", error)
    return { success: true, data: { recorded: true } }
  }
}
