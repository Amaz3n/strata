import { connection } from "next/server"
import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { CatalogPublicationHistory } from "@/components/design-studio/catalog-publication-history"
import { getAmbientDeskContext } from "@/lib/services/desk-context"
import { requireOrgContext } from "@/lib/services/context"
import { hasPermission } from "@/lib/services/permissions"
import { listPendingCatalogPublications, listCatalogPublicationHistory } from "@/lib/services/catalog-publication-history"

interface PageProps { searchParams: Promise<{ community?: string }> }
const breadcrumbs = [{ label: "Design Studio", href: "/design-studio" }, { label: "Catalog", href: "/design-studio/catalog" }, { label: "Publication history" }]
async function PublicationHistoryContent({ searchParams }: PageProps) {
  await connection()
  const [params, ambient, context] = await Promise.all([searchParams, getAmbientDeskContext(), requireOrgContext()])
  const enabled = process.env.ARC_CATALOG_ATOMIC_PUBLICATION_ENABLED === "true"
  const canManage = await hasPermission("selections.catalog.manage", context)
  const scope = { expectedOrgId: context.orgId, expectedActorId: context.userId, communityId: params.community || ambient.communityId || null }
  const [page, pendingPage] = enabled && canManage ? await Promise.all([listCatalogPublicationHistory(scope).catch(() => null), listPendingCatalogPublications({ expectedOrgId: context.orgId, expectedActorId: context.userId })]) : [null, null]
  return <PageLayout title="Publication history" breadcrumbs={breadcrumbs}>
    {pendingPage ? <CatalogPublicationHistory key={`${scope.expectedOrgId}:${scope.expectedActorId}:${scope.communityId ?? "org"}`} scope={scope} initialPage={page} initialPendingPage={pendingPage} /> : <p className="text-sm text-muted-foreground">{canManage ? "Publication history becomes available after the approved catalog cutover." : "Catalog management permission is required to review publication history."}</p>}
  </PageLayout>
}
export default function PublicationHistoryPage(props: PageProps) {
  return <Suspense fallback={<PageLayout title="Publication history" breadcrumbs={breadcrumbs}><PageLoadingSkeleton /></PageLayout>}><PublicationHistoryContent {...props} /></Suspense>
}
