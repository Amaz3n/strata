import { redirect } from "next/navigation"

import { requireAuth } from "@/lib/auth/context"
import { requirePermission } from "@/lib/services/permissions"

export async function requirePermissionGuard(permission: string, orgId?: string) {
  try {
    const { user, orgId: resolvedOrgId, supabase } = await requireAuth()
    const targetOrg = orgId ?? resolvedOrgId

    if (!targetOrg) {
      redirect("/unauthorized")
    }

    await requirePermission(permission, {
      supabase,
      orgId: targetOrg ?? undefined,
      userId: user.id,
    })
  } catch (error) {
    console.error("Permission guard failed", error)
    redirect("/unauthorized")
  }
}


