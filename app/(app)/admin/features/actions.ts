"use server"

import { revalidatePath } from "next/cache"
import { getFeatureFlags as getFeatureFlagsFromService, toggleFeatureFlag as toggleFeatureFlagFromService } from "@/lib/services/admin"
import { requireAuth } from "@/lib/auth/context"
import { requirePermission } from "@/lib/services/permissions"

export async function getFeatureFlags() {
  const { user } = await requireAuth()
  await requirePermission("features.manage", { userId: user.id })

  return getFeatureFlagsFromService()
}

export async function toggleFeatureFlag(flagId: string, orgId: string, flagKey: string, enabled: boolean) {
  const { user } = await requireAuth()
  await requirePermission("features.manage", { userId: user.id })

  await toggleFeatureFlagFromService(flagId, orgId, flagKey, enabled)

  revalidatePath("/admin/features")
}