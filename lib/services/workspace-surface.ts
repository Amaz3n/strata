import "server-only"
import { cache } from "react"
import { redirect } from "next/navigation"
import { z } from "zod"

import { isTradeProfile, resolveBusinessProfile } from "@/lib/business-profile"
import { isVendorPayoutSetupOpen } from "@/lib/services/payment-rail-setup"
import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  deskRefusal,
  projectTabRefusal,
  refusedRouteHref,
  resolveWorkspaceSurface,
  TRADE_PLAN,
  projectTabModuleKey,
  type WorkspaceDesk,
  type WorkspaceProjectTab,
  type WorkspaceSurface,
} from "@/lib/workspace-surface"

const entitlementRow = z.object({
  feature_key: z.string(),
  limit_type: z.string().nullable(),
  limit_value: z.union([z.number(), z.string()]).nullable(),
  expires_at: z.string().nullable(),
})

/**
 * The org's workspace surface: business profile plus plan entitlements. This is
 * the only reader of `entitlements`. Request-cached by org and read through the
 * service client because `authorize()` consults it for every decision.
 */
export const loadWorkspaceSurface = cache(async (orgId: string): Promise<WorkspaceSurface> => {
  const supabase = createServiceSupabaseClient()
  const [settings, entitlements, subscription] = await Promise.all([
    supabase.from("org_settings").select("settings").eq("org_id", orgId).maybeSingle(),
    supabase.from("entitlements").select("feature_key, limit_type, limit_value, expires_at").eq("org_id", orgId).eq("source", "plan"),
    supabase.from("subscriptions").select("plan:plans(name)").eq("org_id", orgId).neq("status", "canceled")
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ])
  const failed = settings.error ?? entitlements.error ?? subscription.error
  if (failed) throw new Error(`Unable to load the workspace plan: ${failed.message}`)

  const profile = resolveBusinessProfile(z.record(z.unknown()).parse(settings.data?.settings ?? {}))
  const plan = z.object({ name: z.string() }).nullable().safeParse(
    Array.isArray(subscription.data?.plan) ? subscription.data.plan[0] ?? null : subscription.data?.plan ?? null,
  )
  return resolveWorkspaceSurface({
    profile,
    // Without a subscription the brand names the plan: posture never changes it for a trade.
    planName: (plan.success ? plan.data?.name : null) ?? (isTradeProfile(profile) ? TRADE_PLAN.name : "Arc"),
    entitlements: z.array(entitlementRow).parse(entitlements.data ?? []),
    now: new Date(),
  })
})

export async function getWorkspaceSurface() {
  const { orgId } = await requireOrgContext(undefined, { allowLocked: true })
  return loadWorkspaceSurface(orgId)
}

/** Refuses an org desk or settings page the workspace does not serve, sending the member home with the reason. */
export async function guardWorkspaceDesk(desk: WorkspaceDesk) {
  if (deskRefusal(await getWorkspaceSurface(), desk)) redirect(refusedRouteHref(desk))
}

/** Refuses a controller tool a trade company opens by setting up vendor payouts; a builder always passes. */
export async function guardPayoutRailDesk(desk: "payment_runs" | "payment_reconciliation") {
  const { orgId } = await requireOrgContext(undefined, { allowLocked: true })
  const [surface, payoutRailOpen] = await Promise.all([loadWorkspaceSurface(orgId), isVendorPayoutSetupOpen(orgId)])
  if (deskRefusal(surface, desk, { payoutRailOpen })) redirect(refusedRouteHref(desk))
}

/** Refuses a project workbench tab, honouring a project module override that switches it back on. */
export async function guardProjectTab(projectId: string, tab: WorkspaceProjectTab) {
  const { supabase, orgId } = await requireOrgContext()
  const moduleKey = projectTabModuleKey(tab)
  const [surface, override] = await Promise.all([
    loadWorkspaceSurface(orgId),
    moduleKey
      ? supabase.from("project_module_overrides").select("enabled").eq("org_id", orgId).eq("project_id", projectId)
          .eq("module_key", moduleKey).maybeSingle()
      : null,
  ])
  if (override?.error) throw new Error(`Unable to load the project modules: ${override.error.message}`)
  const overrides: Record<string, boolean> = moduleKey && override?.data ? { [moduleKey]: override.data.enabled } : {}
  if (projectTabRefusal(surface, tab, overrides)) redirect(refusedRouteHref(tab))
}
