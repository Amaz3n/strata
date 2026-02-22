import { PageLayout } from "@/components/layout/page-layout"
export const dynamic = 'force-dynamic'
import { CompaniesTable } from "@/components/companies/companies-table"
import { listCompanies } from "@/lib/services/companies"
import { listContacts } from "@/lib/services/contacts"
import { listTeamMembers } from "@/lib/services/team"
import { ComplianceWatchWidget } from "@/components/companies/compliance-watch-widget"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { getCompaniesComplianceStatus } from "@/lib/services/compliance-documents"

export default async function CompaniesPage() {
  const [companies, contacts, teamMembers, permissionResult] = await Promise.all([
    listCompanies(),
    listContacts(),
    listTeamMembers(),
    getCurrentUserPermissions(),
  ])
  const complianceCompanyIds = companies
    .filter((company) => company.company_type === "subcontractor" || company.company_type === "supplier")
    .map((company) => company.id)
  const complianceStatusByCompanyId = await getCompaniesComplianceStatus(complianceCompanyIds).catch(() => ({}))

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
              Track subcontractors, suppliers, and partners with a unified compliance system.
            </p>
          </div>
          <div className="w-full lg:max-w-sm">
            <ComplianceWatchWidget companies={companies} complianceStatusByCompanyId={complianceStatusByCompanyId} />
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
