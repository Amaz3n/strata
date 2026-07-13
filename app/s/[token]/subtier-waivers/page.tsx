import Link from "next/link"
import { notFound } from "next/navigation"
import { Button } from "@/components/ui/button"
import { listSubtierRequirementsForPortal } from "@/lib/services/lien-waivers"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { SubtierWaiversClient } from "./subtier-waivers-client"

export const dynamic = "force-dynamic"

export default async function SubtierWaiversPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  let access
  try {
    access = await assertPortalActionAccess(token, { portalType: "sub", requireCompany: true, permission: "can_upload_subtier_waivers" })
  } catch {
    notFound()
  }
  if (!access.company_id) notFound()
  const requirements = await listSubtierRequirementsForPortal({ orgId: access.org_id, projectId: access.project_id, companyId: access.company_id })
  return <main className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6"><div className="flex items-start justify-between gap-4 border-b pb-4"><div><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Subcontractor portal</p><h1 className="text-xl font-semibold">Sub-tier lien waivers</h1><p className="mt-1 text-sm text-muted-foreground">Upload signed waivers from your suppliers and sub-subcontractors for each requested pay period.</p></div><Button variant="outline" size="sm" asChild><Link href={`/s/${token}`}>Back to portal</Link></Button></div><SubtierWaiversClient token={token} requirements={requirements as any[]} /></main>
}
