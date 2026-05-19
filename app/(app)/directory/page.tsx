import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { PageLayout } from "@/components/layout/page-layout"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { listCompanies } from "@/lib/services/companies"
import { listContacts } from "@/lib/services/contacts"
import { DirectoryClient } from "@/components/directory/directory-client"

export const dynamic = 'force-dynamic'

interface DirectoryPageProps {
  searchParams: Promise<{
    view?: string
  }>
}

async function DirectoryData({ searchParams }: DirectoryPageProps) {
  const [companies, contacts, permissionResult, resolvedSearchParams] = await Promise.all([
    listCompanies(),
    listContacts(),
    getCurrentUserPermissions(),
    searchParams,
  ])

  const initialViewParam = typeof resolvedSearchParams?.view === "string" ? resolvedSearchParams.view.toLowerCase() : undefined
  const initialView: "all" | "companies" | "people" =
    initialViewParam === "companies" || initialViewParam === "people" ? (initialViewParam as any) : "all"

  const permissions = permissionResult?.permissions ?? []
  const canEdit = permissions.includes("org.member") || permissions.includes("directory.write")

  return (
    <DirectoryClient
      companies={companies}
      contacts={contacts}
      canCreate={canEdit}
      initialView={initialView}
    />
  )
}

function DirectorySkeleton() {
  return (
    <div className="flex min-h-full flex-col bg-background">
      <div className="grid border-t sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="border-r border-b bg-background p-4 last:border-r-0">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-3 h-7 w-12" />
          </div>
        ))}
      </div>
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-9 w-9 rounded-md" />
      </div>
      <div className="space-y-2 p-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </div>
  )
}

export default function DirectoryPage(props: DirectoryPageProps) {
  return (
    <PageLayout
      title="Directory"
      breadcrumbs={[{ label: "Company" }, { label: "Directory" }]}
      fullBleed
    >
      <Suspense fallback={<DirectorySkeleton />}>
        <DirectoryData searchParams={props.searchParams} />
      </Suspense>
    </PageLayout>
  )
}
