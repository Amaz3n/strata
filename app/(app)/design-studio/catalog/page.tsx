import Link from "next/link"
import { connection } from "next/server"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { CatalogWorkbench } from "@/components/design-studio/catalog-workbench"
import { listCatalog, listPlanPricingMatrix } from "@/lib/services/option-catalog"
import { getAmbientDeskContext } from "@/lib/services/desk-context"
import { requireOrgContext } from "@/lib/services/context"
import { hasPermission } from "@/lib/services/permissions"


interface PageProps {
  searchParams: Promise<{ community?: string; category?: string; planPage?: string; optionPage?: string; view?: string; releases?: string }>
}

async function CatalogPageContent({ searchParams }: PageProps) {
  await connection()
  const [{ community, category, planPage, optionPage, view, releases }, ambient, context] = await Promise.all([
    searchParams,
    getAmbientDeskContext(),
    requireOrgContext(),
  ])
  const communityId = community || ambient.communityId

  const catalogPromise = listCatalog({ communityId })
  const matrixPromise = catalogPromise.then((catalog) => listPlanPricingMatrix({
    communityId,
    optionIds: (catalog.categories.find(row => row.id === category) ?? catalog.categories[0])?.options.map(option => option.id) ?? [],
    planPage: /^\d{1,5}$/.test(planPage ?? "") ? Math.min(10000,Math.max(1,Number(planPage))) : 1,
    includeOlderVersions: releases === "all",
    optionPage: /^\d{1,5}$/.test(optionPage ?? "") ? Math.min(10000,Math.max(1,Number(optionPage))) : 1,
  }))
  const [catalog, canManage, matrix] = await Promise.all([
    catalogPromise,
    hasPermission("selections.catalog.manage", context),
    matrixPromise,
  ])

  const categoryOptionCounts = Object.fromEntries(catalog.categories.map(row => [row.id,row.options.length]))
  const visibleCatalog = { ...catalog, packages: [], categories: catalog.categories.map(row => ({ ...row, options: row.options.filter(option => matrix.optionIds.includes(option.id)) })) }

  return (
    <PageLayout
      title="Option catalog"
      breadcrumbs={[{ label: "Design Studio", href: "/design-studio" }, { label: "Catalog" }]}
      fullBleed
    >
      {canManage && process.env.ARC_CATALOG_ATOMIC_PUBLICATION_ENABLED === "true" && <div className="px-6 py-2 text-sm">
        <Link className="text-muted-foreground underline underline-offset-4 hover:text-foreground" href={`/design-studio/catalog/history${communityId ? `?community=${encodeURIComponent(communityId)}` : ""}`}>Publication history</Link>
      </div>}
      <CatalogWorkbench
        key={`${context.orgId}:${context.userId}:${communityId ?? "org"}:${category ?? "first"}:${matrix.planPage}:${matrix.optionPage}:${matrix.includeOlderVersions}`}
        orgId={context.orgId}
        actorId={context.userId}
        initialCategoryId={category}
        initialView={view === "pricing" ? "pricing" : "grid"}
        catalog={visibleCatalog}
        categoryOptionCounts={categoryOptionCounts}
        matrix={matrix}
        communityId={communityId}
        canManage={canManage}
      />
    </PageLayout>
  )
}

export default function CatalogPage(props: Parameters<typeof CatalogPageContent>[0]) {
  return (
    <Suspense
      fallback={
        <PageLayout title="Option catalog" fullBleed breadcrumbs={[{ label: "Design Studio", href: "/design-studio" }, { label: "Catalog" }]}>
          <PageLoadingSkeleton />
        </PageLayout>
      }
    >
      <CatalogPageContent {...props} />
    </Suspense>
  )
}
