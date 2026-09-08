import "server-only"

import { z } from "zod"

import { payableOutstandingCents } from "@/lib/financials/payables-rules"
import { recordAudit } from "@/lib/services/audit"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * Releasing retainage held on a subcontractor's bill.
 *
 * `retainage_cents` is subtracted from a bill's payable balance forever, so the
 * only way to pay a sub their held retainage used to be editing that number down
 * on the original bill — mutating accounting evidence to achieve a payment, in a
 * system built specifically to stop that.
 *
 * Release creates its own payable instead. It flows through the normal approval,
 * hold and payment path like any other bill, and the original keeps saying what
 * it always said: this much was billed, this much was held.
 */

const releaseRetainageSchema = z.object({
  bill_id: z.string().uuid(),
  /** Partial release is normal — retainage often comes off in stages. */
  amount_cents: z.number().int().positive().optional(),
  reason: z.string().trim().max(500).optional(),
})

export type ReleaseRetainageInput = z.infer<typeof releaseRetainageSchema>

/** Create a pending retainage payable. Approval and accepted conditional coverage are checked before payment. */
export async function releaseRetainage(
  input: ReleaseRetainageInput,
  orgId?: string,
) {
  const parsed = releaseRetainageSchema.parse(input)
  const context = await requireOrgContext(orgId)
  const supabase = createServiceSupabaseClient()

  const { data: bill, error } = await supabase
    .from("vendor_bills")
    .select(
      "id,org_id,project_id,company_id,commitment_id,bill_number,currency,retainage_cents,retainage_released_cents,status,accounting_coding",
    )
    .eq("org_id", context.orgId)
    .eq("id", parsed.bill_id)
    .maybeSingle()
  if (error || !bill) throw new Error("Vendor bill was not found")
  await requireAuthorization({
    permission: "bill.write",
    userId: context.userId,
    orgId: context.orgId,
    projectId: bill.project_id,
    supabase: context.supabase,
    logDecision: true,
    resourceType: "vendor_bill",
    resourceId: bill.id,
  })

  const heldCents = Number(bill.retainage_cents ?? 0)
  const alreadyReleasedCents = Number(bill.retainage_released_cents ?? 0)
  const releasableCents = heldCents - alreadyReleasedCents
  if (releasableCents <= 0)
    throw new Error("This payable has no retainage left to release")
  const amountCents = parsed.amount_cents ?? releasableCents
  if (amountCents > releasableCents) {
    throw new Error(
      `Only ${releasableCents} cents of retainage remain held on this payable`,
    )
  }

  const requestedAt = new Date().toISOString()
  const { data: atomicRelease, error: atomicError } = await supabase.rpc(
    "release_retainage_atomic",
    {
      p_org_id: context.orgId,
      p_bill_id: bill.id,
      p_actor_id: context.userId,
      p_amount_cents: amountCents,
      p_require_final_waiver: false,
      p_requested_at: requestedAt,
    },
  )
  if (atomicError || !atomicRelease || typeof atomicRelease !== "object") {
    throw new Error(
      `Unable to create the retainage release payable: ${atomicError?.message ?? "Atomic release returned no result"}`,
    )
  }
  const releaseBillId = Reflect.get(atomicRelease, "release_bill_id")
  if (typeof releaseBillId !== "string")
    throw new Error("Atomic retainage release returned no payable id")
  await recordAudit({
    orgId: context.orgId,
    actorId: context.userId,
    action: "insert",
    entityType: "vendor_bill",
    entityId: releaseBillId,
    after: {
      source: "retainage_release",
      parent_bill_id: bill.id,
      amount_cents: amountCents,
      reason: parsed.reason??null,
    },
  })
  return {
    releaseBillId,
    amountCents,
    remainingHeldCents: releasableCents - amountCents,
  }
}

export { payableOutstandingCents }
