import { notFound } from "next/navigation"
import { AppShell } from "@/components/layout/app-shell"
export const dynamic = "force-dynamic"

import { z } from "zod"
import { getCurrentUserAction } from "@/app/actions/user"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { getCompany, getCompanyProjects } from "@/lib/services/companies"
import { listCompanyCommitments } from "@/lib/services/commitments"
import { listVendorBillsForCompany } from "@/lib/services/vendor-bills"
import { listProjectsAction } from "@/app/projects/actions"
import { CompanyDetailPage } from "@/components/companies/company-detail-page"

interface CompanyDetailPageProps {
  params: Promise<{ id: string }>
}

export default async function CompanyDetailPageRoute({ params }: CompanyDetailPageProps) {
  const { id: companyId } = await params
  if (!z.string().uuid().safeParse(companyId).success) {
    notFound()
  }

  const [company, projectHistory, commitments, vendorBills, projects, currentUser, permissionResult] = await Promise.all([
    getCompany(companyId),
    getCompanyProjects(companyId),
    listCompanyCommitments(companyId),
    listVendorBillsForCompany(companyId),
    listProjectsAction(),
    getCurrentUserAction(),
    getCurrentUserPermissions(),
  ])

  const permissions = permissionResult.permissions
  const canEdit = permissions.includes("org.member")
  const canArchive = permissions.includes("org.admin") || permissions.includes("members.manage")

  const breadcrumbs = [
    { label: "Directory", href: "/directory" },
    { label: "Companies", href: "/directory?view=companies" },
    { label: company.name },
  ]

  return (
    <AppShell title={company.name} user={currentUser} breadcrumbs={breadcrumbs}>
      <div className="p-4 lg:p-6">
        <CompanyDetailPage
          company={company}
          projectHistory={projectHistory}
          commitments={commitments}
          vendorBills={vendorBills}
          projects={projects}
          canEdit={canEdit}
          canArchive={canArchive}
        />
      </div>
    </AppShell>
  )
}
