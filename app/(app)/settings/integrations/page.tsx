import { redirect } from "next/navigation"
export const instant = false
import { requirePermissionGuard } from "@/lib/auth/guards"

export default async function IntegrationsPage() {
  await requirePermissionGuard("org.admin")
  redirect("/settings?tab=integrations")
}
