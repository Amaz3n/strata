import { AppShell } from "@/components/layout/app-shell"
import { getCurrentUserAction } from "@/app/actions/user"
import { CompaniesTable } from "@/components/companies/companies-table"
import { listCompanies } from "@/lib/services/companies"

export default async function CompaniesPage() {
  const [companies, currentUser] = await Promise.all([listCompanies(), getCurrentUserAction()])

  return (
    <AppShell title="Companies" user={currentUser}>
      <div className="p-4 lg:p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Companies</h1>
          <p className="text-muted-foreground mt-1">
            Track subcontractors, suppliers, and partners with trade and insurance details.
          </p>
        </div>
        <CompaniesTable companies={companies} />
      </div>
    </AppShell>
  )
}

