import { PageLayout } from "@/components/layout/page-layout"
import { CutoffRules } from "@/components/design-studio/cutoff-rules"
import { listCommunities } from "@/lib/services/communities"
import { listCatalog, listSelectionGroups } from "@/lib/services/option-catalog"
import { getAmbientDeskContext } from "@/lib/services/desk-context"
import { requireOrgContext } from "@/lib/services/context"
import { hasPermission } from "@/lib/services/permissions"

export const dynamic = "force-dynamic"

interface PageProps {
  searchParams: Promise<{ community?: string }>
}

export default async function CutoffRulesPage({ searchParams }: PageProps) {
  const { community } = await searchParams
  const ambient = await getAmbientDeskContext()
  const communityId = community || ambient.communityId

  const context = await requireOrgContext()
  const [groups, catalog, communities, canManage] = await Promise.all([
    listSelectionGroups({ communityId }),
    listCatalog({ communityId }),
    listCommunities(ambient.divisionId ? { divisionId: ambient.divisionId } : {}),
    hasPermission("selections.catalog.manage", context),
  ])

  return (
    <PageLayout
      title="Cutoff rules"
      breadcrumbs={[{ label: "Design Studio", href: "/design-studio" }, { label: "Cutoff rules" }]}
      fullBleed
    >
      <CutoffRules
        groups={groups}
        catalog={catalog}
        communityId={communityId}
        communities={communities.map((item) => ({ id: item.id, name: item.name }))}
        canManage={canManage}
      />
    </PageLayout>
  )
}
