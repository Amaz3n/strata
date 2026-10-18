import "server-only"
import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"
import { FEATURE_FLAGS } from "@/lib/feature-flags/registry"
const cents = z.number().int().safe().nonnegative(), signed = z.number().int().safe()
const costRow = z.object({ community_id: z.string().uuid(), community_name: z.string().nullable(), warranty_cost_cents: cents, recovered_cents: cents, net_cost_cents: signed, closed_revenue_cents: cents, cost_percent: z.number().finite().nullable() }).refine(row => BigInt(row.warranty_cost_cents) - BigInt(row.recovered_cents) === BigInt(row.net_cost_cents), "Warranty net cost differs from its source totals")
const defectRow = z.object({ group_id: z.string(), group_name: z.string().nullable(), request_count: cents, affected_home_count: cents, closed_home_count: cents, affected_home_percent: z.number().finite().nullable(), remediation_cost_cents: cents, recovered_cents: cents, average_cost_cents: cents, top_categories: z.array(z.object({ category: z.string(), count: cents })) })
const companyRow = z.object({ request_count: cents, backcharge_cents: cents, recovered_cents: cents, open_backcharges: cents }).refine(row => row.recovered_cents <= row.backcharge_cents, "Warranty company recovery exceeds its charges")
export async function warrantyActorAnalyticsEnabled(supabase: SupabaseClient, orgId: string) {
  const { data, error } = await supabase.from("feature_flags").select("enabled,expires_at").eq("org_id", orgId).eq("flag_key", FEATURE_FLAGS.warrantyActorAnalytics).order("updated_at", { ascending: false }).limit(1).maybeSingle()
  if (error) throw new Error(`Unable to verify warranty analytics rollout: ${error.message}`)
  if (!data) return false
  const flag = z.object({ enabled: z.boolean(), expires_at: z.string().nullable() }).parse(data)
  if (flag.enabled && flag.expires_at) throw new Error("Scoped warranty analytics cannot use an expiring rollout")
  return flag.enabled
}
export async function readActorWarrantyAnalytics(input: { supabase: SupabaseClient; orgId: string; actorId: string; kind: "cost" | "defect" | "company"; divisionId?: string; communityId?: string; companyId?: string; groupBy?: string; from?: string; to?: string }) {
  z.object({ orgId: z.string().uuid(), actorId: z.string().uuid(), divisionId: z.string().uuid().optional(), communityId: z.string().uuid().optional(), companyId: z.string().uuid().optional(), from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() }).parse(input)
  const args: Record<string, unknown> = { p_org_id: input.orgId, p_actor_id: input.actorId }
  if (input.kind === "company") args.p_company_id = z.string().uuid().parse(input.companyId)
  else { args.p_division_id = input.divisionId ?? null; args.p_community_id = input.communityId ?? null }
  if (input.kind === "defect") {
    args.p_group_by = z.enum(["community", "company", "cost_code", "plan", "plan_version"]).parse(input.groupBy)
    args.p_from = input.from ?? null; args.p_to = input.to ?? null
    if (input.from && input.to && Date.parse(input.to) <= Date.parse(input.from)) throw new Error("Invalid warranty analytics period")
  }
  const name = input.kind === "company" ? "warranty_company_signal_for_actor" : input.kind === "cost" ? "warranty_cost_summary_for_actor" : "warranty_defect_analysis_for_actor"
  const result = await input.supabase.rpc(name, args)
  if (result.error) throw new Error(`Scoped warranty analytics is unavailable: ${result.error.message}`)
  if (input.kind === "company") return companyRow.parse(result.data)
  return input.kind === "cost" ? z.array(costRow).max(10000).parse(result.data) : z.array(defectRow).max(10000).parse(result.data)
}
