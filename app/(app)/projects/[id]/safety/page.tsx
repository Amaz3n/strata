import { PageLayout } from "@/components/layout/page-layout"
import { listObservations, listSafetyIncidents, listToolboxTalks } from "@/lib/services/safety"
import { getOrgCompaniesAction, getProjectVendorsAction } from "../actions"
import { SafetyClient } from "./safety-client"
import { listProjectLocations } from "@/lib/services/locations"
import { hasPermission } from "@/lib/services/permissions"

export default async function SafetyPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string; incident?: string; observation?: string }>
}) {
  const [{ id }, query] = await Promise.all([params, searchParams])
  const [incidents, talks, observations, vendors, orgCompanies, locations, canManageLocations] = await Promise.all([
    listSafetyIncidents(id),
    listToolboxTalks(id),
    listObservations(id),
    getProjectVendorsAction(id),
    getOrgCompaniesAction(),
    listProjectLocations(id),
    hasPermission("project.manage"),
  ])

  const vendorCompanies = vendors
    .map((vendor) => vendor.company)
    .filter((company): company is NonNullable<typeof company> => Boolean(company))
    .map((company) => ({ id: company.id, name: company.name }))
  const companies = (vendorCompanies.length > 0 ? vendorCompanies : orgCompanies.map((company) => ({ id: company.id, name: company.name })))
    .filter((company, index, all) => all.findIndex((c) => c.id === company.id) === index)
    .sort((a, b) => a.name.localeCompare(b.name))

  return (
    <PageLayout title="Safety" breadcrumbs={[{ label: "Project" }, { label: "Safety" }]}>
      <SafetyClient
        projectId={id}
        incidents={incidents}
        talks={talks}
        observations={observations}
        companies={companies}
        initialTab={query.tab}
        initialIncidentId={query.incident}
        initialObservationId={query.observation}
        locations={locations}
        canManageLocations={canManageLocations}
      />
    </PageLayout>
  )
}
