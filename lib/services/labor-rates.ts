import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { recordAudit } from "@/lib/services/audit"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { laborRateInputSchema } from "@/lib/validation/team"

// A worker's pay and bill rate are effective-dated (labor_rates): a raise starts on
// a date and every entry is priced at the rate in force on its work date. The
// memberships columns hold the rate in force today, which is what the roster lists.

const laborRateRow = z.object({
  id: z.string(),
  user_id: z.string(),
  effective_on: z.string(),
  cost_rate_cents: z.number(),
  burden_multiplier: z.coerce.number(),
  bill_rate_cents: z.number(),
  created_at: z.string(),
})
export type LaborRate = z.infer<typeof laborRateRow>

export type ResolvedLaborRate = {
  costRateCents: number
  burdenMultiplier: number
  billRateCents: number
  effectiveOn: string | null
}

export async function resolveLaborRate(args: {
  supabase: SupabaseClient
  orgId: string
  userId: string
  onDate: string
}): Promise<ResolvedLaborRate> {
  // A worker's rate history is fenced to its owner and the office, but pricing
  // anyone's hours needs it: read it as the service, scoped to the org.
  const [history, membership] = await Promise.all([
    createServiceSupabaseClient()
      .from("labor_rates")
      .select("effective_on, cost_rate_cents, burden_multiplier, bill_rate_cents")
      .eq("org_id", args.orgId)
      .eq("user_id", args.userId)
      .lte("effective_on", args.onDate)
      .order("effective_on", { ascending: false })
      .limit(1)
      .maybeSingle(),
    args.supabase
      .from("memberships")
      .select("labor_cost_rate_cents, labor_burden_multiplier, labor_bill_rate_cents")
      .eq("org_id", args.orgId)
      .eq("user_id", args.userId)
      .maybeSingle(),
  ])
  if (history.error) throw new Error(`Failed to load labor rate: ${history.error.message}`)
  if (membership.error) throw new Error(`Failed to load labor rate: ${membership.error.message}`)
  if (history.data) {
    return {
      costRateCents: Number(history.data.cost_rate_cents ?? 0),
      burdenMultiplier: Number(history.data.burden_multiplier ?? 1),
      billRateCents: Number(history.data.bill_rate_cents ?? 0),
      effectiveOn: String(history.data.effective_on),
    }
  }
  // Before the first dated rate, the current member rate applies.
  return {
    costRateCents: Number(membership.data?.labor_cost_rate_cents ?? 0),
    burdenMultiplier: Number(membership.data?.labor_burden_multiplier ?? 1),
    billRateCents: Number(membership.data?.labor_bill_rate_cents ?? 0),
    effectiveOn: null,
  }
}

const LIST_CAP = 50

export async function listLaborRates(membershipId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "members.manage",
    userId,
    orgId: resolvedOrgId,
    supabase,
    resourceType: "membership",
    resourceId: membershipId,
  })
  const { data: membership, error: membershipError } = await supabase
    .from("memberships")
    .select("user_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", membershipId)
    .maybeSingle()
  if (membershipError || !membership) throw new Error("Membership not found")
  const { data, count, error } = await supabase
    .from("labor_rates")
    .select("id, user_id, effective_on, cost_rate_cents, burden_multiplier, bill_rate_cents, created_at", { count: "exact" })
    .eq("org_id", resolvedOrgId)
    .eq("user_id", membership.user_id)
    .order("effective_on", { ascending: false })
    .limit(LIST_CAP)
  if (error) throw new Error(`Failed to load rate history: ${error.message}`)
  return { rates: z.array(laborRateRow).parse(data ?? []), total: count ?? 0, cap: LIST_CAP }
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

// Saves the rate for a date (replacing a rate already set for that date), then
// brings the member's current rate in line with whatever is in force today.
export async function saveLaborRate(membershipId: string, input: unknown, orgId?: string) {
  const parsed = laborRateInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "members.manage",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "membership",
    resourceId: membershipId,
  })
  const serviceClient = createServiceSupabaseClient()
  const { data: membership, error: membershipError } = await serviceClient
    .from("memberships")
    .select("id, user_id, labor_cost_rate_cents, labor_bill_rate_cents, labor_burden_multiplier, labor_is_billable_default")
    .eq("org_id", resolvedOrgId)
    .eq("id", membershipId)
    .maybeSingle()
  if (membershipError || !membership) throw new Error("Membership not found")

  const { data: rate, error } = await serviceClient
    .from("labor_rates")
    .upsert(
      {
        org_id: resolvedOrgId,
        user_id: membership.user_id,
        effective_on: parsed.effective_on,
        cost_rate_cents: parsed.labor_cost_rate_cents,
        burden_multiplier: parsed.labor_burden_multiplier,
        bill_rate_cents: parsed.labor_bill_rate_cents,
        created_by: userId,
      },
      { onConflict: "org_id,user_id,effective_on" },
    )
    .select("id, user_id, effective_on, cost_rate_cents, burden_multiplier, bill_rate_cents, created_at")
    .single()
  if (error || !rate) throw new Error(`Failed to save the rate: ${error?.message}`)

  const current = await resolveLaborRate({
    supabase: serviceClient,
    orgId: resolvedOrgId,
    userId: membership.user_id,
    onDate: today(),
  })
  const { data: after, error: updateError } = await serviceClient
    .from("memberships")
    .update({
      labor_cost_rate_cents: current.costRateCents,
      labor_bill_rate_cents: current.billRateCents,
      labor_burden_multiplier: current.burdenMultiplier,
      labor_is_billable_default: parsed.labor_is_billable_default,
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", membershipId)
    .select("id, user_id, labor_cost_rate_cents, labor_bill_rate_cents, labor_burden_multiplier, labor_is_billable_default")
    .single()
  if (updateError || !after) throw new Error(`Failed to update the current rate: ${updateError?.message}`)

  await Promise.all([
    recordAudit({
      orgId: resolvedOrgId,
      actorId: userId,
      action: "update",
      entityType: "membership",
      entityId: membershipId,
      before: membership,
      after: { ...after, labor_rate: rate },
    }),
    recordEvent({
      orgId: resolvedOrgId,
      eventType: "labor_rate_saved",
      entityType: "membership",
      entityId: membershipId,
      payload: { effective_on: parsed.effective_on },
    }),
  ])
  return { membership: after, rate: laborRateRow.parse(rate) }
}
