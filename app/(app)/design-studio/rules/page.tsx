import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { CutoffRules } from "@/components/design-studio/cutoff-rules"
import { listCatalog, listSelectionGroups } from "@/lib/services/option-catalog"
import { getAmbientDeskContext } from "@/lib/services/desk-context"
import { requireOrgContext } from "@/lib/services/context"
import { hasPermission } from "@/lib/services/permissions"


interface PageProps {
  searchParams: Promise<{ community?: string }>
}

async function CutoffRulesPageContent({ searchParams }: PageProps) {
  const { community } = await searchParams
  const ambient = await getAmbientDeskContext()
  const communityId = community || ambient.communityId

  const context = await requireOrgContext()
  const [groups, catalog, canManage] = await Promise.all([
    listSelectionGroups({ communityId }),
    listCatalog({ communityId }),
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
        canManage={canManage}
      />
    </PageLayout>
  )
}

export default function CutoffRulesPage(props: Parameters<typeof CutoffRulesPageContent>[0]) {
  return (
    <Suspense fallback={<PageLoadingSkeleton />}>
      <CutoffRulesPageContent {...props} />
    </Suspense>
  )
}
