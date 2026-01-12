import { PageLayout } from "@/components/layout/page-layout"
export const dynamic = 'force-dynamic'
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { listCompanies } from "@/lib/services/companies"
import { listContacts } from "@/lib/services/contacts"
import { DirectoryClient } from "@/components/directory/directory-client"

interface DirectoryPageProps {
  searchParams: Promise<{
    view?: string
  }>
}

export default async function DirectoryPage({ searchParams }: DirectoryPageProps) {
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
    <PageLayout title="Directory">
      <div className="space-y-6">
        <DirectoryClient
          companies={companies}
          contacts={contacts}
          canCreate={canEdit}
          initialView={initialView}
        />
      </div>
    </PageLayout>
  )
}
