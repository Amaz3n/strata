import { redirect, unstable_rethrow } from "next/navigation"
import { connection } from "next/server"

import { requireAnyPlatformPermission } from "@/lib/services/platform-access"
import { requireAuth } from "@/lib/auth/context"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"

export async function requirePermissionGuard(permission: string, orgId?: string) {
  await connection()
  try {
    const { user, orgId: resolvedOrgId } = await requireAuth()
    const targetOrg = orgId ?? resolvedOrgId
    const isPlatformPermission = permission.startsWith("platform.") || permission.startsWith("impersonation.")

    if (!targetOrg && !isPlatformPermission) {
      redirect("/unauthorized")
    }

    if (isPlatformPermission) {
      await requireAnyPlatformPermission([permission])
      return
    }

    await requirePermission(permission, {
      orgId: targetOrg ?? undefined,
      userId: user.id,
    })
  } catch (error) {
    unstable_rethrow(error)
    console.error("Permission guard failed", error)
    redirect("/unauthorized")
  }
}

export async function requireAnyPermissionGuard(permissions: string[], orgId?: string) {
  await connection()
  try {
    const { user, orgId: resolvedOrgId } = await requireAuth()
    const targetOrg = orgId ?? resolvedOrgId
    const hasAnyPlatformPermission = permissions.some(
      (permission) => permission.startsWith("platform.") || permission.startsWith("impersonation."),
    )

    if (!targetOrg && !hasAnyPlatformPermission) {
      redirect("/unauthorized")
    }

    if (permissions.length > 0 && permissions.every(
      permission => permission.startsWith("platform.") || permission.startsWith("impersonation."),
    )) {
      await requireAnyPlatformPermission(permissions)
      return
    }

    await requireAnyPermission(permissions, {
      orgId: targetOrg ?? undefined,
      userId: user.id,
    })
  } catch (error) {
    unstable_rethrow(error)
    console.error("Permission guard failed", error)
    redirect("/unauthorized")
  }
}




