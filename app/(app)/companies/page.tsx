import { PageLayout } from "@/components/layout/page-layout"
export const dynamic = 'force-dynamic'
import { CompaniesTable } from "@/components/companies/companies-table"
import { listCompanies } from "@/lib/services/companies"
import { listContacts } from "@/lib/services/contacts"
import { listTeamMembers } from "@/lib/services/team"
import { InsuranceWidget } from "@/components/companies/insurance-widget"
import { getCurrentUserPermissions } from "@/lib/services/permissions"

export default async function CompaniesPage() {
  const [companies, contacts, teamMembers, permissionResult] = await Promise.all([
    listCompanies(),
    listContacts(),
    listTeamMembers(),
    getCurrentUserPermissions(),
  ])

  const permissions = permissionResult.permissions
  const canEdit = permissions.includes("org.member")
  const canArchive = permissions.includes("org.admin") || permissions.includes("members.manage")

  return (
    <PageLayout title="Companies">
      <div className="space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Companies</h1>
            <p className="text-muted-foreground mt-1">
              Track subcontractors, suppliers, and partners with trade and insurance details.
            </p>
          </div>
          <div className="w-full lg:max-w-sm">
            <InsuranceWidget companies={companies} />
          </div>
        </div>
        <CompaniesTable
          companies={companies}
          contacts={contacts}
          teamMembers={teamMembers}
          canCreate={canEdit}
          canEdit={canEdit}
          canArchive={canArchive}
        />
      </div>
    </PageLayout>
  )
}

