"use server"

import { revalidatePath } from "next/cache"

import { requireOrgMembership } from "@/lib/auth/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { getCurrentUserPermissions, requireAnyPermission } from "@/lib/services/permissions"
import { getOrgCostCodesEnabled } from "@/lib/financials/cost-codes-enabled"
import { getOrgSettings } from "@/lib/services/orgs"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

export interface CostCodingSettings {
  /** The org-wide default: projects with no explicit override follow this. */
  costCodesEnabled: boolean
  canManage: boolean
}

/** Read the org-level cost-coding settings for the settings tab. Any member may read. */
export async function getCostCodingSettingsAction(): Promise<CostCodingSettings> {
  const { orgId, supabase } = await requireOrgMembership()
  const [costCodesEnabled, permissionResult] = await Promise.all([
    getOrgCostCodesEnabled(supabase, orgId),
    getCurrentUserPermissions(orgId),
  ])
  const permissions = permissionResult?.permissions ?? []
  const canManage = permissions.includes("*") || permissions.includes("org.admin")
  return { costCodesEnabled, canManage }
}

/** Flip the org-wide cost-codes default. Inheriting projects follow it immediately. */
export async function updateCostCodesEnabledAction(enabled: boolean) {
  return run(async () => {
    const { orgId, user, supabase } = await requireOrgMembership()
    await requireAnyPermission(["org.admin"], { orgId, userId: user.id, supabase })

    const service = createServiceSupabaseClient()
    const before = await getOrgSettings(service, orgId)

    const { data: mergedSettings, error } = await service.rpc("merge_org_settings", {
      p_org_id: orgId,
      p_patch: { cost_codes_enabled: enabled },
      p_delete_keys: [],
    })
    if (error) {
      throw new Error(error.message ?? "Failed to update cost-coding settings.")
    }

    await recordAudit({
      orgId,
      actorId: user.id,
      action: "update",
      entityType: "org_settings",
      entityId: orgId,
      before: { cost_codes_enabled: before.cost_codes_enabled ?? null },
      after: { cost_codes_enabled: (mergedSettings as Record<string, unknown> | null)?.cost_codes_enabled ?? enabled },
      source: "settings.cost_coding",
    })

    try {
      await recordEvent({
        orgId,
        actorId: user.id,
        eventType: "settings_updated",
        entityType: "org_settings",
        entityId: orgId,
        payload: { section: "cost_coding", cost_codes_enabled: enabled },
        channel: "activity",
      })
    } catch (eventError) {
      console.error("Failed to record cost-coding settings event", eventError)
    }

    revalidatePath("/settings/cost-coding")
    return { costCodesEnabled: enabled }
  })
}
