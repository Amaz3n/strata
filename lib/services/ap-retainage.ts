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
    .select("id,org_id,project_id,company_id,commitment_id,bill_number,currency,retainage_cents,retainage_released_cents,status,qbo_expense_account_id,qbo_expense_account_name,qbo_ap_account_id,qbo_ap_account_name,qbo_vendor_id,qbo_vendor_name")
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
      // Never null: the bulk approver rejects a payable with no number, and a
      // release with no identifier is unfindable in the vendor's own records.
      bill_number: `${bill.bill_number ?? `RET-${bill.id.slice(0, 8)}`}-RET`,
      status: "pending",
      bill_date: new Date().toISOString().slice(0, 10),
      total_cents: amountCents,
      currency: bill.currency ?? "usd",
      retainage_cents: 0,
      // Carried from the original so the release syncs to the same vendor and
      // accounts. Without these the release reached the accounting integration
      // as an unlinked, uncoded bill.
      qbo_expense_account_id: bill.qbo_expense_account_id,
      qbo_expense_account_name: bill.qbo_expense_account_name,
      qbo_ap_account_id: bill.qbo_ap_account_id,
      qbo_ap_account_name: bill.qbo_ap_account_name,
      qbo_vendor_id: bill.qbo_vendor_id,
      qbo_vendor_name: bill.qbo_vendor_name,
      metadata: {
        source: "retainage_release",
        parent_bill_id: bill.id,
        reason: parsed.reason ?? null,
      },
    })
    .select("id")
    .single()
  if (insertError || !releaseBill) throw new Error(`Unable to create the retainage release payable: ${insertError?.message}`)

  // Coding, inherited from what the retainage was withheld against.
  //
  // A release used to be created with no `bill_lines` at all, which made it
  // unapprovable by every path that exists: bulk approval refuses a payable
  // with no coding lines, and single approval synthesizes one line with a null
  // cost code that the project's cost-code gate then rejects. The money could
  // be released and never paid. Retainage is held proportionally across the
  // original's coding, so it is released the same way, with the rounding
  // remainder on the largest line so the lines still sum to the total.
  const { data: parentLines, error: parentLinesError } = await supabase
    .from("bill_lines")
    .select("cost_code_id,budget_line_id,description,quantity,unit_cost_cents,project_id")
    .eq("org_id", context.orgId)
    .eq("bill_id", bill.id)
  if (parentLinesError) {
    await supabase.from("vendor_bills").delete().eq("org_id", context.orgId).eq("id", releaseBill.id)
    throw new Error(`Unable to read the original payable's coding: ${parentLinesError.message}`)
  }

  const weighted = (parentLines ?? [])
    .map((line) => ({
      cost_code_id: line.cost_code_id,
      budget_line_id: line.budget_line_id,
      description: line.description,
      project_id: line.project_id ?? bill.project_id,
      amount_cents: Math.round(Number(line.quantity ?? 1) * Number(line.unit_cost_cents ?? 0)),
    }))
    .filter((line) => line.amount_cents > 0)
  const weightedTotal = weighted.reduce((sum, line) => sum + line.amount_cents, 0)

  const releaseLines =
    weightedTotal > 0
      ? (() => {
          const shares = weighted.map((line) => ({
            ...line,
            share: Math.floor((amountCents * line.amount_cents) / weightedTotal),
          }))
          const assigned = shares.reduce((sum, line) => sum + line.share, 0)
          let remainder = amountCents - assigned
          const largest = shares.reduce((best, line) => (line.amount_cents > best.amount_cents ? line : best), shares[0])
          return shares
            .map((line) => {
              const extra = line === largest ? remainder : 0
              remainder -= extra
              return { ...line, share: line.share + extra }
            })
            .filter((line) => line.share > 0)
        })()
      : []

  const lineRows = (releaseLines.length > 0
    ? releaseLines.map((line) => ({
        cost_code_id: line.cost_code_id,
        budget_line_id: line.budget_line_id,
        description: `Retainage release${line.description ? ` · ${line.description}` : ""}`,
        project_id: line.project_id,
        amount_cents: line.share,
      }))
    : [
        {
          cost_code_id: null,
          budget_line_id: null,
          description: "Retainage release",
          project_id: bill.project_id,
          amount_cents: amountCents,
        },
      ]
  ).map((line) => ({
    org_id: context.orgId,
    bill_id: releaseBill.id,
    project_id: line.project_id,
    cost_code_id: line.cost_code_id,
    budget_line_id: line.budget_line_id,
    description: line.description,
    quantity: 1,
    unit_cost_cents: line.amount_cents,
  }))

  const { error: lineError } = await supabase.from("bill_lines").insert(lineRows)
  if (lineError) {
    await supabase.from("vendor_bills").delete().eq("org_id", context.orgId).eq("id", releaseBill.id)
    throw new Error(`Unable to code the retainage release payable: ${lineError.message}`)
  }

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

export { payableOutstandingCents }
