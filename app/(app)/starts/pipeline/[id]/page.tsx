import { notFound } from "next/navigation"

import { PageLayout } from "@/components/layout/page-layout"
import { StartPackageDetail } from "@/components/starts/start-package-detail"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { getStartPackage, listSuperintendentCandidates } from "@/lib/services/starts"

export const dynamic = "force-dynamic"

export default async function StartPackagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [pkg, superintendents, permissions] = await Promise.all([
    getStartPackage(id).catch(() => null),
    listSuperintendentCandidates().catch(() => []),
    getCurrentUserPermissions(),
  ])
  if (!pkg) notFound()
  const grants = permissions.permissions
  const isAdmin = grants.includes("*") || grants.includes("org.admin")
  return (
    <PageLayout
      title={`${pkg.communityName} · ${pkg.lotLabel}`}
      breadcrumbs={[{ label: "Starts", href: "/starts" }, { label: "Pipeline", href: "/starts/pipeline" }, { label: pkg.lotLabel }]}
    >
      <div className="p-4">
        <StartPackageDetail
          pkg={pkg}
          superintendents={superintendents}
          canWrite={isAdmin || grants.includes("start.write")}
          canRelease={isAdmin || grants.includes("start.release")}
        />
      </div>
    </PageLayout>
  )
}
