import "server-only"

import { z } from "zod"

import { createServiceSupabaseClient } from "@/lib/supabase/server"

export interface PaymentFeePolicyOrganization {
  id: string
  name: string
  status: string
}

export interface PaymentFeePolicyRecord {
  id: string
  orgId: string | null
  orgName: string | null
  pricingModel: "subscription_plus_pass_through" | "custom"
  passThroughProcessorFees: boolean
  processorFeeBps: number | null
  processorFeeFixedCents: number | null
  processorFeeCapCents: number | null
  platformFeeFlatCents: number
  platformFeeBps: number
  effectiveFrom: string
  effectiveTo: string | null
  createdBy: string | null
  createdByName: string | null
  createdAt: string
}

const optionalFeeSchema = z.number().int().min(0).nullable()

export const replacePaymentFeePolicySchema = z.object({
  orgId: z.string().uuid().nullable(),
  passThroughProcessorFees: z.boolean(),
  processorFeeBps: optionalFeeSchema.refine((value) => value == null || value <= 10_000, {
    message: "Processor fee rate cannot exceed 100%.",
  }),
  processorFeeFixedCents: optionalFeeSchema,
  processorFeeCapCents: optionalFeeSchema,
  platformFeeFlatCents: z.number().int().min(0),
  platformFeeBps: z.number().int().min(0).max(10_000),
  markupConfirmed: z.boolean(),
}).superRefine((value, context) => {
  if (
    value.passThroughProcessorFees
    && value.processorFeeBps == null
    && value.processorFeeFixedCents == null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["processorFeeBps"],
      message: "Enter a processor percentage, fixed fee, or both when pass-through is enabled.",
    })
  }
  if ((value.platformFeeFlatCents > 0 || value.platformFeeBps > 0) && !value.markupConfirmed) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["markupConfirmed"],
      message: "Confirm that this policy adds an Arc transaction fee.",
    })
  }
})

type FeePolicyRow = {
  id: string
  org_id: string | null
  pricing_model: "subscription_plus_pass_through" | "custom"
  pass_through_processor_fees: boolean
  processor_fee_bps: number | null
  processor_fee_fixed_cents: number | null
  processor_fee_cap_cents: number | null
  ap_platform_fee_flat_cents: number
  ap_platform_fee_bps: number
  effective_from: string
  effective_to: string | null
  created_by: string | null
  created_at: string
}

export async function listPaymentFeePolicyOrganizations(): Promise<PaymentFeePolicyOrganization[]> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("orgs")
    .select("id,name,status")
    .order("name", { ascending: true })

  if (error) throw new Error(`Unable to load organizations: ${error.message}`)
  return (data ?? []).map((org) => ({ id: org.id, name: org.name, status: org.status }))
}

export async function listPaymentFeePolicies(): Promise<PaymentFeePolicyRecord[]> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("payment_fee_policies")
    .select("id,org_id,pricing_model,pass_through_processor_fees,processor_fee_bps,processor_fee_fixed_cents,processor_fee_cap_cents,ap_platform_fee_flat_cents,ap_platform_fee_bps,effective_from,effective_to,created_by,created_at")
    .order("effective_from", { ascending: false })

  if (error) throw new Error(`Unable to load payment fee policies: ${error.message}`)

  const rows = (data ?? []) as FeePolicyRow[]
  const orgIds = Array.from(new Set(rows.flatMap((row) => row.org_id ? [row.org_id] : [])))
  const actorIds = Array.from(new Set(rows.flatMap((row) => row.created_by ? [row.created_by] : [])))

  const [{ data: orgs, error: orgError }, { data: actors, error: actorError }] = await Promise.all([
    orgIds.length > 0
      ? supabase.from("orgs").select("id,name").in("id", orgIds)
      : Promise.resolve({ data: [], error: null }),
    actorIds.length > 0
      ? supabase.from("app_users").select("id,full_name,email").in("id", actorIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (orgError) throw new Error(`Unable to resolve fee policy organizations: ${orgError.message}`)
  if (actorError) throw new Error(`Unable to resolve fee policy actors: ${actorError.message}`)

  const orgNames = new Map((orgs ?? []).map((org) => [org.id, org.name]))
  const actorNames = new Map(
    (actors ?? []).map((actor) => [actor.id, actor.full_name || actor.email || "Unknown administrator"]),
  )

  return rows.map((row) => ({
    id: row.id,
    orgId: row.org_id,
    orgName: row.org_id ? orgNames.get(row.org_id) ?? "Unknown organization" : null,
    pricingModel: row.pricing_model,
    passThroughProcessorFees: row.pass_through_processor_fees,
    processorFeeBps: row.processor_fee_bps == null ? null : Number(row.processor_fee_bps),
    processorFeeFixedCents: row.processor_fee_fixed_cents == null ? null : Number(row.processor_fee_fixed_cents),
    processorFeeCapCents: row.processor_fee_cap_cents == null ? null : Number(row.processor_fee_cap_cents),
    platformFeeFlatCents: Number(row.ap_platform_fee_flat_cents),
    platformFeeBps: Number(row.ap_platform_fee_bps),
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    createdBy: row.created_by,
    createdByName: row.created_by ? actorNames.get(row.created_by) ?? "Unknown administrator" : null,
    createdAt: row.created_at,
  }))
}

export async function replacePaymentFeePolicy(input: unknown, actorId: string): Promise<string> {
  const parsed = replacePaymentFeePolicySchema.parse(input)
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.rpc("replace_payment_fee_policy_atomic", {
    p_org_id: parsed.orgId,
    p_pass_through_processor_fees: parsed.passThroughProcessorFees,
    p_processor_fee_bps: parsed.passThroughProcessorFees ? parsed.processorFeeBps : null,
    p_processor_fee_fixed_cents: parsed.passThroughProcessorFees ? parsed.processorFeeFixedCents : null,
    p_processor_fee_cap_cents: parsed.passThroughProcessorFees ? parsed.processorFeeCapCents : null,
    p_ap_platform_fee_flat_cents: parsed.platformFeeFlatCents,
    p_ap_platform_fee_bps: parsed.platformFeeBps,
    p_actor_id: actorId,
  })

  if (error) throw new Error(`Unable to save payment fee policy: ${error.message}`)
  if (typeof data !== "string") throw new Error("The payment fee policy was saved without an identifier.")
  return data
}

export async function retireOrganizationPaymentFeePolicy(orgId: string, actorId: string): Promise<string> {
  const parsedOrgId = z.string().uuid().parse(orgId)
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.rpc("retire_org_payment_fee_policy_atomic", {
    p_org_id: parsedOrgId,
    p_actor_id: actorId,
  })

  if (error) throw new Error(`Unable to retire payment fee override: ${error.message}`)
  if (typeof data !== "string") throw new Error("The payment fee override was retired without an identifier.")
  return data
}
