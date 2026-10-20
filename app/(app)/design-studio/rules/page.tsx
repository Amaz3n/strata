import { guardWorkspaceDesk } from "@/lib/services/workspace-surface"
import Link from "next/link"
import { connection } from "next/server"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { CutoffRules } from "@/components/design-studio/cutoff-rules"
import { readCatalogGroupCategoryLabels } from "@/lib/services/catalog-group-categories"
import { listCatalog, listSelectionGroupPage } from "@/lib/services/option-catalog"
import { getAmbientDeskContext } from "@/lib/services/desk-context"
import { requireOrgContext } from "@/lib/services/context"
import { hasPermission } from "@/lib/services/permissions"


interface PageProps {
  searchParams: Promise<{ community?: string; groupsAfter?: string }>
}

async function CutoffRulesPageContent({ searchParams }: PageProps) {
  await connection()
  const [, { community, groupsAfter }, ambient, context] = await Promise.all([guardWorkspaceDesk("design_studio"),
    searchParams,
    getAmbientDeskContext(),
    requireOrgContext(),
  ])
  const communityId = community || ambient.communityId

  const [groupPage, catalog, canManage] = await Promise.all([
    listSelectionGroupPage({ communityId, cursor: groupsAfter }),
    listCatalog({ communityId, includeOptions: false, includeCategories: false }),
    hasPermission("selections.catalog.manage", context),
  ])

  const categoryLabels = await readCatalogGroupCategoryLabels({ expectedOrgId: context.orgId, expectedActorId: context.userId, communityId: communityId ?? null,
    groupIds: groupPage.groups.map(group => group.id), categoryIds: groupPage.groups.flatMap(group => group.category_ids),
  })

  return (
    <PageLayout
      title="Cutoff rules"
      breadcrumbs={[{ label: "Design Studio", href: "/design-studio" }, { label: "Cutoff rules" }]}
      fullBleed
    >
      {canManage && <div className="px-6 py-2 text-sm">
        <Link className="text-muted-foreground underline underline-offset-4 hover:text-foreground" href={`/design-studio/catalog/history${communityId ? `?community=${encodeURIComponent(communityId)}` : ""}`}>Publication history</Link>
      </div>}
      <CutoffRules
        key={`${context.orgId}:${context.userId}:${communityId ?? "org"}`}
        orgId={context.orgId}
        actorId={context.userId}
        groups={groupPage.groups}
        groupCursor={groupsAfter}
        nextGroupCursor={groupPage.nextCursor}
        catalog={catalog}
        categoryLabels={categoryLabels}
        communityId={communityId}
        canManage={canManage}
      />
    </PageLayout>
  )
}

export default function CutoffRulesPage(props: Parameters<typeof CutoffRulesPageContent>[0]) {
  return (
    <Suspense
      fallback={
        <PageLayout title="Cutoff rules" fullBleed breadcrumbs={[{ label: "Design Studio", href: "/design-studio" }, { label: "Cutoff rules" }]}>
          <PageLoadingSkeleton />
        </PageLayout>
      }
    >
      <CutoffRulesPageContent {...props} />
    </Suspense>
  )
}
