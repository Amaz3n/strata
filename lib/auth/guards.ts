import { redirect } from "next/navigation"

import { requireAuth } from "@/lib/auth/context"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"

export async function requirePermissionGuard(permission: string, orgId?: string) {
  try {
    const { user, orgId: resolvedOrgId } = await requireAuth()
    const targetOrg = orgId ?? resolvedOrgId
    const isPlatformPermission = permission.startsWith("platform.") || permission.startsWith("impersonation.")

    if (!targetOrg && !isPlatformPermission) {
      redirect("/unauthorized")
    }

    await requirePermission(permission, {
      orgId: targetOrg ?? undefined,
      userId: user.id,
    })
  } catch (error) {
    console.error("Permission guard failed", error)
    redirect("/unauthorized")
  }
}

export async function requireAnyPermissionGuard(permissions: string[], orgId?: string) {
  try {
    const { user, orgId: resolvedOrgId } = await requireAuth()
    const targetOrg = orgId ?? resolvedOrgId
    const hasAnyPlatformPermission = permissions.some(
      (permission) => permission.startsWith("platform.") || permission.startsWith("impersonation."),
    )

    if (!targetOrg && !hasAnyPlatformPermission) {
      redirect("/unauthorized")
    }

    await requireAnyPermission(permissions, {
      orgId: targetOrg ?? undefined,
      userId: user.id,
    })
  } catch (error) {
    console.error("Permission guard failed", error)
    redirect("/unauthorized")
  }
}





