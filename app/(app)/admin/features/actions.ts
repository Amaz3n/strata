"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import {
  createFeatureFlag,
  deleteFeatureFlag,
  getFeatureFlags as getFeatureFlagsFromService,
  getFeatureFlagOrganizations,
  toggleFeatureFlag as toggleFeatureFlagFromService,
  updateFeatureFlag,
} from "@/lib/services/admin"
import { requireAuth } from "@/lib/auth/context"
import { requireAnyPermission } from "@/lib/services/permissions"

import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

const featureFlagSchema = z.object({
  orgId: z.string().uuid(),
  flagKey: z.string().trim().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/, "Use lowercase letters, numbers, and underscores"),
  enabled: z.boolean(),
  config: z.record(z.unknown()).default({}),
  expiresAt: z.string().datetime().nullable().default(null),
})

async function requireFeaturePermission() {
  const { user } = await requireAuth()
  await requireAnyPermission(["features.manage", "platform.feature_flags.manage"], { userId: user.id })
  return user
}

export async function getFeatureFlags() {
      await requireFeaturePermission()
      return getFeatureFlagsFromService()
}

export async function getFeatureFlagOrganizationsAction() {
      await requireFeaturePermission()
      return getFeatureFlagOrganizations()
}

export async function toggleFeatureFlag(flagId: string, orgId: string, flagKey: string, enabled: boolean) {
  return run(async () => {
      const user = await requireFeaturePermission()
      const parsed = z.object({
        flagId: z.string().uuid(),
        orgId: z.string().uuid(),
        flagKey: z.string().trim().min(1),
        enabled: z.boolean(),
      }).parse({ flagId, orgId, flagKey, enabled })
      await toggleFeatureFlagFromService(parsed.flagId, parsed.orgId, parsed.enabled, user.id)
      revalidatePath("/admin/features")
  })
}

export async function createFeatureFlagAction(input: unknown) {
  return run(async () => {
      const user = await requireFeaturePermission()
      const parsed = featureFlagSchema.parse(input)
      const flag = await createFeatureFlag({ ...parsed, actorId: user.id })
      revalidatePath("/admin/features")
      return flag
  })
}

export async function updateFeatureFlagAction(input: unknown) {
  return run(async () => {
      const user = await requireFeaturePermission()
      const parsed = featureFlagSchema.extend({ flagId: z.string().uuid() }).parse(input)
      await updateFeatureFlag({ ...parsed, actorId: user.id })
      revalidatePath("/admin/features")
  })
}

export async function deleteFeatureFlagAction(input: unknown) {
  return run(async () => {
      const user = await requireFeaturePermission()
      const parsed = z.object({ flagId: z.string().uuid(), orgId: z.string().uuid() }).parse(input)
      await deleteFeatureFlag({ ...parsed, actorId: user.id })
      revalidatePath("/admin/features")
  })
}
