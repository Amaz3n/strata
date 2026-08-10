"use server"

import { actionError, type ActionResult } from "@/lib/action-result"
import {
  assessPayableApprovalSignals,
  type PayableApprovalSignalsResult,
} from "@/lib/services/payable-approval-signals"

/**
 * Compute the approval-time signals for the one payable an approver has open:
 * the even-flow price comparison against sibling lots of the same house plan,
 * and the crosscheck of the bill's date against the project schedule.
 *
 * Advisory by contract. The result is recorded on the payable and rendered
 * beside its allocation. It never changes the payable's status, never blocks a
 * payment, and never creates a hold — an approver reads it and decides.
 *
 * Deliberately not revalidating: the caller renders the returned assessment
 * directly, so refreshing the whole payables desk to surface a cached advisory
 * would cost far more than it is worth.
 */
export async function assessPayableApprovalSignalsAction(
  billId: string,
  options: { force?: boolean } = {},
): Promise<ActionResult<PayableApprovalSignalsResult>> {
  try {
    return { success: true, data: await assessPayableApprovalSignals(billId, { force: options.force }) }
  } catch (error) {
    return actionError(error, "Unable to check this payable against the plan and the schedule.")
  }
}
