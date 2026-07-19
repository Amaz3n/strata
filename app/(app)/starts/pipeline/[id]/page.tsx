import { notFound } from "next/navigation"

import { PageLayout } from "@/components/layout/page-layout"
import { StartPackageDetail } from "@/components/starts/start-package-detail"
import { getStartPackage } from "@/lib/services/starts"

export const dynamic = "force-dynamic"

export default async function StartPackagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const pkg = await getStartPackage(id).catch(() => null)
  if (!pkg) notFound()
  return <PageLayout title={`${pkg.communityName} · ${pkg.lotLabel}`} breadcrumbs={[{ label: "Starts", href: "/starts" }, { label: "Pipeline", href: "/starts/pipeline" }, { label: pkg.lotLabel }]}><div className="p-4"><StartPackageDetail pkg={pkg} /></div></PageLayout>
}
