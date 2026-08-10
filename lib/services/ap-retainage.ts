import "server-only"

import { z } from "zod"

import { payableOutstandingCents } from "@/lib/financials/payables-rules"
import { recordAudit } from "@/lib/services/audit"
import { requireAuthorization } from "@/lib/services/authorization"
import { getComplianceRules } from "@/lib/services/compliance"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
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

export interface RetainageHolding {
  billId: string
  billNumber: string | null
  companyId: string | null
  companyName: string | null
  projectId: string
  retainageHeldCents: number
  retainageReleasedCents: number
  releasableCents: number
  /** Final unconditional waiver on file, which policy may require before release. */
  finalWaiverOnFile: boolean
}

/** Everything still holding retainage, so it can be released rather than forgotten. */
export async function listRetainageHoldings(projectId?: string, orgId?: string): Promise<RetainageHolding[]> {
  const context = await requireOrgContext(orgId)
  const supabase = createServiceSupabaseClient()
  let query = supabase
    .from("vendor_bills")
    .select("id,bill_number,company_id,project_id,retainage_cents,retainage_released_cents,company:companies(name)")
    .eq("org_id", context.orgId)
    .gt("retainage_cents", 0)
    .neq("status", "rejected")
    .limit(500)
  if (projectId) query = query.eq("project_id", projectId)
  const { data, error } = await query
  if (error) throw new Error(`Unable to load retainage holdings: ${error.message}`)

  const rows = data ?? []
  const billIds = rows.map((row) => row.id)
  const { data: waivers } = billIds.length > 0
    ? await supabase.from("lien_waivers").select("bill_id").eq("org_id", context.orgId).eq("waiver_type", "final").eq("status", "signed").in("bill_id", billIds)
    : { data: [] }
  const finalWaiverBillIds = new Set((waivers ?? []).map((row) => row.bill_id))

  return rows.flatMap((row) => {
    const held = Number(row.retainage_cents ?? 0)
    const released = Number(row.retainage_released_cents ?? 0)
    const releasable = held - released
    if (releasable <= 0) return []
    const company = Array.isArray(row.company) ? row.company[0] : row.company
    return [{
      billId: row.id,
      billNumber: row.bill_number,
      companyId: row.company_id,
      companyName: company?.name ?? null,
      projectId: row.project_id,
      retainageHeldCents: held,
      retainageReleasedCents: released,
      releasableCents: releasable,
      finalWaiverOnFile: finalWaiverBillIds.has(row.id),
    }]
  })
}

/**
 * Create the payable that releases held retainage.
 *
 * Gated on a signed final waiver when the org requires lien waivers at all —
 * releasing retainage is the last money a sub sees, and it is the last leverage
 * the builder has to get the unconditional final waiver that closes lien rights.
 */
export async function releaseRetainage(input: ReleaseRetainageInput, orgId?: string) {
  const parsed = releaseRetainageSchema.parse(input)
  const context = await requireOrgContext(orgId)
  const supabase = createServiceSupabaseClient()

  const { data: bill, error } = await supabase
    .from("vendor_bills")
    .select("id,org_id,project_id,company_id,commitment_id,bill_number,currency,retainage_cents,retainage_released_cents,status")
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
  if (releasableCents <= 0) throw new Error("This payable has no retainage left to release")
  const amountCents = parsed.amount_cents ?? releasableCents
  if (amountCents > releasableCents) {
    throw new Error(`Only ${releasableCents} cents of retainage remain held on this payable`)
  }

  const rules = await getComplianceRules(context.orgId)
  if (rules.require_lien_waiver) {
    const { data: finalWaiver } = await supabase
      .from("lien_waivers")
      .select("id")
      .eq("org_id", context.orgId)
      .eq("bill_id", bill.id)
      .eq("waiver_type", "final")
      .eq("status", "signed")
      .maybeSingle()
    if (!finalWaiver) {
      throw new Error("A signed final lien waiver is required before releasing retainage")
    }
  }

  // A new payable, not an edit. It carries its own number, its own approval and
  // its own hold evaluation, and points back at what it releases.
  const { data: releaseBill, error: insertError } = await supabase
    .from("vendor_bills")
    .insert({
      org_id: context.orgId,
      project_id: bill.project_id,
      company_id: bill.company_id,
      commitment_id: bill.commitment_id,
      bill_number: bill.bill_number ? `${bill.bill_number}-RET` : null,
      status: "pending",
      bill_date: new Date().toISOString().slice(0, 10),
      total_cents: amountCents,
      currency: bill.currency ?? "usd",
      retainage_cents: 0,
      metadata: {
        source: "retainage_release",
        parent_bill_id: bill.id,
        reason: parsed.reason ?? null,
      },
    })
    .select("id")
    .single()
  if (insertError || !releaseBill) throw new Error(`Unable to create the retainage release payable: ${insertError?.message}`)

  // Guarded rather than recomputed: the original's retainage_cents is evidence
  // and never moves, so this counter is what stops the same held amount being
  // released twice.
  const { error: markError } = await supabase
    .from("vendor_bills")
    .update({ retainage_released_cents: alreadyReleasedCents + amountCents })
    .eq("org_id", context.orgId)
    .eq("id", bill.id)
    .eq("retainage_released_cents", alreadyReleasedCents)
  if (markError) {
    await supabase.from("vendor_bills").delete().eq("org_id", context.orgId).eq("id", releaseBill.id)
    throw new Error("Retainage was released concurrently; reload the payable and try again")
  }

  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "retainage_released",
      entityType: "vendor_bill",
      entityId: bill.id,
      payload: { release_bill_id: releaseBill.id, amount_cents: amountCents, project_id: bill.project_id },
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: "insert",
      entityType: "vendor_bill",
      entityId: releaseBill.id,
      after: { source: "retainage_release", parent_bill_id: bill.id, amount_cents: amountCents },
    }),
  ])
  return { releaseBillId: releaseBill.id, amountCents, remainingHeldCents: releasableCents - amountCents }
}

/** Outstanding on a bill, ignoring retainage that has already been released out. */
export function releasableRetainageCents(bill: { retainage_cents?: number | null; retainage_released_cents?: number | null }) {
  return Math.max(0, Number(bill.retainage_cents ?? 0) - Number(bill.retainage_released_cents ?? 0))
}

export { payableOutstandingCents }
