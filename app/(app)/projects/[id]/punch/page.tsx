import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getOrgCompaniesAction, getProjectAction, getProjectTeamAction, getProjectVendorsAction, listProjectPunchItemsAction } from "../actions"
import { ProjectPunchClient } from "./project-punch-client"
import { Button } from "@/components/ui/button"

import { unwrapAction } from "@/lib/action-result"
import { listProjectLocations } from "@/lib/services/locations"
import { hasPermission } from "@/lib/services/permissions"

interface ProjectPunchPageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<{ item?: string }>
}

export default async function ProjectPunchPage({ params, searchParams }: ProjectPunchPageProps) {
  const [{ id }, query] = await Promise.all([params, searchParams])

  return (
    <>
      <PageLayout
        title="Punch"
        breadcrumbs={[
          { label: "Project" },
          { label: "Punch" },
        ]}
      />
      <Suspense fallback={<ProjectPunchFallback />}>
        <ProjectPunchData id={id} initialItemId={query.item} />
      </Suspense>
    </>
  )
}

function ProjectPunchFallback() {
  return (
    <div className="p-6 space-y-4">
      <Skeleton className="h-8 w-48 mb-6" />
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-md" />
        ))}
      </div>
    </div>
  )
}

async function ProjectPunchData({ id, initialItemId }: { id: string; initialItemId?: string }) {
  const project = await getProjectAction(id)

  if (!project) {
    notFound()
  }

  const [team, punchItems, vendors, orgCompanies, locations, canManageLocations] = await Promise.all([
    getProjectTeamAction(id),
    listProjectPunchItemsAction(id),
    getProjectVendorsAction(id),
    getOrgCompaniesAction(),
    listProjectLocations(id),
    hasPermission("project.manage"),
  ])

  // Companies on the project first; fall back to the whole org list when the
  // project has no vendors yet.
  const vendorCompanies = vendors
    .map((vendor) => vendor.company)
    .filter((company): company is NonNullable<typeof company> => Boolean(company))
    .map((company) => ({ id: company.id, name: company.name }))
  const companies = (vendorCompanies.length > 0 ? vendorCompanies : orgCompanies.map((company) => ({ id: company.id, name: company.name })))
    .filter((company, index, all) => all.findIndex((c) => c.id === company.id) === index)
    .sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div className="space-y-6">
      <div className="flex justify-end px-6"><Button variant="outline" asChild><a href={`/projects/${project.id}/exports/punch-list`} target="_blank" rel="noreferrer">Export punch list PDF</a></Button></div>
      <ProjectPunchClient projectId={project.id} initialItems={punchItems} initialItemId={initialItemId} team={team} companies={companies} locations={locations} canManageLocations={canManageLocations} />
    </div>
  )
}
