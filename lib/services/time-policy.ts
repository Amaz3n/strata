import "server-only"
import { cache } from "react"
import { z } from "zod"

import { isTradeProfile, resolveBusinessProfile } from "@/lib/business-profile"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { resolveTimePolicy, timePolicySchema, type TimePolicy } from "@/lib/time/policy"

export type OrgTimePolicy = { policy: TimePolicy; timeZone: string | null }

// Request-cached and read through the service client: approval, the clock and
// period close all consult it, and it holds no member data.
export const loadTimePolicy = cache(async (orgId: string): Promise<OrgTimePolicy> => {
  const supabase = createServiceSupabaseClient()
  const [settings, org] = await Promise.all([
    supabase.from("org_settings").select("settings").eq("org_id", orgId).maybeSingle(),
    supabase.from("orgs").select("time_zone").eq("id", orgId).maybeSingle(),
  ])
  const failed = settings.error ?? org.error
  if (failed) throw new Error(`Unable to load the pay schedule: ${failed.message}`)
  const bag = z.record(z.unknown()).parse(settings.data?.settings ?? {})
  return {
    policy: resolveTimePolicy(bag, isTradeProfile(resolveBusinessProfile(bag))),
    timeZone: typeof org.data?.time_zone === "string" ? org.data.time_zone : null,
  }
})

export async function saveTimePolicy(input: unknown) {
  const policy = timePolicySchema.parse(input)
  const context = await requireOrgContext()
  await requirePermission("org.admin", context)
  const { supabase, orgId, userId } = context
  const { data: current, error: readError } = await supabase
    .from("org_settings")
    .select("settings,updated_at")
    .eq("org_id", orgId)
    .maybeSingle()
  if (readError) throw new Error("Unable to load the company settings.")
  const before = z.record(z.unknown()).parse(current?.settings ?? {})
  const settings = { ...before, time_policy: policy }
  // Compare-and-swap avoids overwriting concurrent changes in the shared bag.
  const result = current
    ? await supabase
        .from("org_settings")
        .update({ settings, updated_at: new Date().toISOString() })
        .eq("org_id", orgId)
        .eq("updated_at", current.updated_at)
        .select("org_id")
    : await supabase.from("org_settings").insert({ org_id: orgId, settings }).select("org_id")
  if (result.error || !result.data?.length) throw new Error("Company settings changed. Reload and try again.")
  await Promise.all([
    recordEvent({
      orgId,
      eventType: "time_policy_updated",
      entityType: "org_settings",
      entityId: orgId,
      payload: { time_policy: policy },
    }),
    recordAudit({
      orgId,
      actorId: userId,
      action: "update",
      entityType: "org_settings",
      entityId: orgId,
      before: { time_policy: before.time_policy ?? null },
      after: { time_policy: policy },
    }),
  ])
  return policy
}
