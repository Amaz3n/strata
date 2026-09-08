"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import { requireOrgContext } from "@/lib/services/context"
import { createSubtierWaiverRequirement } from "@/lib/services/lien-waivers"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { requireAuthorization } from "@/lib/services/authorization"
import type { WaiverKind } from "@/lib/lien-waivers/coverage"
import { requirePermission } from "@/lib/services/permissions"

export interface CreateSubtierRequirementInput {
  projectId: string
  commitmentId: string
  throughCompanyId: string
  claimantCompanyName: string
  periodEnd: string
  amountCents: number
  waiverType: WaiverKind
}

export async function createSubtierRequirementAction(
  input: CreateSubtierRequirementInput,
): Promise<ActionResult<{ id: string }>> {
  try {
    const result = await createSubtierWaiverRequirement({
      project_id: input.projectId,
      commitment_id: input.commitmentId,
      through_company_id: input.throughCompanyId,
      claimant_company_name: input.claimantCompanyName,
      period_end: input.periodEnd,
      amount_cents: input.amountCents,
      waiver_type: input.waiverType,
    })
    revalidatePath(`/projects/${input.projectId}/financials/payables/waivers`)
    return { success: true, data: { id: result.id } }
  } catch (error) {
    return actionError(error, "Could not add claimant")
  }
}

const chaseSchema = z.object({
  projectId: z.string().uuid(),
  billIds: z.array(z.string().uuid()).min(1).max(100),
})

/**
 * Queue the waiver chase email for one or more payables.
 *
 * The chase itself is `sendVendorBillWaiverChase`, run by the outbox worker.
 * Enqueuing rather than calling it inline is deliberate: the same job type,
 * dedupe key and retry behaviour the automatic chase already uses, so a manual
 * nudge cannot double-send alongside the policy-driven one.
 */
export async function chaseWaiversAction(
  input: z.input<typeof chaseSchema>,
): Promise<ActionResult<{ queued: number; skipped: number }>> {
  try {
    const parsed = chaseSchema.parse(input)
    const { supabase, orgId, userId } = await requireOrgContext()
    await requirePermission("bill.write", { supabase, orgId, userId })

    await requireAuthorization({
      supabase,
      orgId,
      userId,
      permission: "bill.write",
      projectId: parsed.projectId,
      resourceType: "project",
      resourceId: parsed.projectId,
    })
    const { data: bills, error } = await supabase
      .from("vendor_bills")
      .select("id")
      .eq("org_id", orgId)
      .eq("project_id", parsed.projectId)
      .in("id", parsed.billIds)
    if (error)
      throw new Error(`Could not load the payables to chase: ${error.message}`)
    const found = (bills ?? []).map((bill) => bill.id as string)
    if (found.length === 0)
      throw new Error("None of those payables belong to this project")

    const results = await Promise.all(
      found.map((billId) =>
        enqueueOutboxJob({
          orgId,
          jobType: "chase_vendor_bill_waiver",
          payload: { bill_id: billId, project_id: parsed.projectId },
          dedupeByPayloadKeys: ["bill_id"],
        }),
      ),
    )
    const queued = results.filter((result) => result.enqueued).length
    if (queued === 0)
      throw new Error("A waiver request is already queued for these payables")

    revalidatePath(`/projects/${parsed.projectId}/financials/payables/waivers`)
    return { success: true, data: { queued, skipped: found.length - queued } }
  } catch (error) {
    return actionError(error, "Could not send the waiver request")
  }
}
