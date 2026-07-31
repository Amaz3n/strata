import { PageLayout } from "@/components/layout/page-layout"
import { CatalogWorkbench } from "@/components/design-studio/catalog-workbench"
import { listCatalog, listPlanPricingMatrix } from "@/lib/services/option-catalog"
import { getAmbientDeskContext } from "@/lib/services/desk-context"
import { requireOrgContext } from "@/lib/services/context"
import { hasPermission } from "@/lib/services/permissions"

export const dynamic = "force-dynamic"

interface PageProps {
  searchParams: Promise<{ community?: string }>
}

export default async function CatalogPage({ searchParams }: PageProps) {
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
