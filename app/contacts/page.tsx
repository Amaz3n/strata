import { AppShell } from "@/components/layout/app-shell"
import { getCurrentUserAction } from "@/app/actions/user"
import { listContacts } from "@/lib/services/contacts"
import { listCompanies } from "@/lib/services/companies"
import { ContactsTable } from "@/components/contacts/contacts-table"
import { listProjectsAction } from "@/app/projects/actions"
import { getCurrentUserPermissions } from "@/lib/services/permissions"

export const dynamic = 'force-dynamic'

export default async function ContactsPage() {
  const [contacts, companies, projects, currentUser, permissionResult] = await Promise.all([
    listContacts(),
    listCompanies(),
    listProjectsAction(),
    getCurrentUserAction(),
    getCurrentUserPermissions(),
  ])

  const permissions = permissionResult.permissions
  const canEdit = permissions.includes("org.member")
  const canArchive = permissions.includes("org.admin") || permissions.includes("members.manage")
  const canInvitePortal = permissions.includes("project.manage")

  return (
    <AppShell title="Contacts" user={currentUser}>
      <div className="p-4 lg:p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Contacts</h1>
          <p className="text-muted-foreground mt-1">People you collaborate with across projects and companies.</p>
        </div>
        <ContactsTable
          contacts={contacts}
          companies={companies}
          projects={projects}
          canCreate={canEdit}
          canEdit={canEdit}
          canArchive={canArchive}
          canInvitePortal={canInvitePortal}
        />
      </div>
    </AppShell>
  )
}

