import { AppShell } from "@/components/layout/app-shell"
export const dynamic = 'force-dynamic'
import { getCurrentUserAction } from "@/app/actions/user"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { listCompanies } from "@/lib/services/companies"
import { listContacts } from "@/lib/services/contacts"
import { DirectoryClient } from "@/components/directory/directory-client"

interface DirectoryPageProps {
  searchParams?: {
    view?: string
  }
}

export default async function DirectoryPage({ searchParams }: DirectoryPageProps) {
  const initialViewParam = typeof searchParams?.view === "string" ? searchParams.view.toLowerCase() : undefined
  const initialView: "all" | "companies" | "people" =
    initialViewParam === "companies" || initialViewParam === "people" ? (initialViewParam as any) : "all"

  const [companies, contacts, currentUser, permissionResult] = await Promise.all([
    listCompanies(),
    listContacts(),
    getCurrentUserAction(),
    getCurrentUserPermissions(),
  ])

  const permissions = permissionResult.permissions
  const canEdit = permissions.includes("org.member")

  return (
    <AppShell title="Directory" user={currentUser}>
      <div className="p-4 lg:p-6 space-y-6">
        <DirectoryClient
          companies={companies}
          contacts={contacts}
          canCreate={canEdit}
          initialView={initialView}
        />
      </div>
    </AppShell>
  )
}
