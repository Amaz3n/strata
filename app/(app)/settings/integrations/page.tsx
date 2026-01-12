import { redirect } from "next/navigation"
import { requirePermissionGuard } from "@/lib/auth/guards"
export const dynamic = 'force-dynamic'

export default async function IntegrationsPage() {
  await requirePermissionGuard("org.admin")
  redirect("/settings?tab=integrations")
}
