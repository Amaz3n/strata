import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { CatalogWorkbench } from "@/components/design-studio/catalog-workbench"
import { listCatalog, listPlanPricingMatrix } from "@/lib/services/option-catalog"
import { getAmbientDeskContext } from "@/lib/services/desk-context"
import { requireOrgContext } from "@/lib/services/context"
import { hasPermission } from "@/lib/services/permissions"


interface PageProps {
  searchParams: Promise<{ community?: string }>
}

async function CatalogPageContent({ searchParams }: PageProps) {
  const { community } = await searchParams
  const ambient = await getAmbientDeskContext()
  const communityId = community || ambient.communityId

  const context = await requireOrgContext()
  const [catalog, canManage] = await Promise.all([
    listCatalog({ communityId }),
    hasPermission("selections.catalog.manage", context),
  ])
  const matrix = await listPlanPricingMatrix({
    communityId,
    optionIds: catalog.categories.flatMap((category) => category.options.map((option) => option.id)),
  })

  return (
    <PageLayout
      title="Option catalog"
      breadcrumbs={[{ label: "Design Studio", href: "/design-studio" }, { label: "Catalog" }]}
      fullBleed
    >
      <CatalogWorkbench
        catalog={catalog}
        matrix={matrix}
        communityId={communityId}
        canManage={canManage}
      />
    </PageLayout>
  )
}

export default function CatalogPage(props: Parameters<typeof CatalogPageContent>[0]) {
  return (
    <Suspense fallback={<PageLoadingSkeleton />}>
      <CatalogPageContent {...props} />
    </Suspense>
  )
}
