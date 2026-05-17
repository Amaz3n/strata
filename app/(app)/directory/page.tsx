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
  const canEdit = permissions.includes("org.member")

  return (
    <div className="space-y-6">
      <DirectoryClient
        companies={companies}
        contacts={contacts}
        canCreate={canEdit}
        initialView={initialView}
      />
    </div>
  )
}

export default function DirectoryPage(props: DirectoryPageProps) {
  return (
    <PageLayout title="Directory">
      <Suspense fallback={
        <div className="p-6 space-y-4">
          <Skeleton className="h-8 w-48 mb-6" />
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-md" />
            ))}
          </div>
        </div>
      }>
        <DirectoryData searchParams={props.searchParams} />
      </Suspense>
    </PageLayout>
  )
}
