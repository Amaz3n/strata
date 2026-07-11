import { PageLayout } from "@/components/layout/page-layout"
import { getInspection, listChecklistTemplates, listInspections } from "@/lib/services/inspections"
import { getOrgCompaniesAction, getProjectVendorsAction } from "../actions"
import { InspectionsClient } from "./inspections-client"

export default async function InspectionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ inspection?: string }>
}) {
  const [{ id }, query] = await Promise.all([params, searchParams])
  const [inspections, templates, selected, vendors, orgCompanies] = await Promise.all([
    listInspections(id),
    listChecklistTemplates(),
    query.inspection ? getInspection(query.inspection) : Promise.resolve(null),
    getProjectVendorsAction(id),
    getOrgCompaniesAction(),
  ])

  const vendorCompanies = vendors
    .map((vendor) => vendor.company)
    .filter((company): company is NonNullable<typeof company> => Boolean(company))
    .map((company) => ({ id: company.id, name: company.name }))
  const companies = (vendorCompanies.length > 0 ? vendorCompanies : orgCompanies.map((company) => ({ id: company.id, name: company.name })))
    .filter((company, index, all) => all.findIndex((c) => c.id === company.id) === index)
    .sort((a, b) => a.name.localeCompare(b.name))

  return (
    <PageLayout title="Inspections" breadcrumbs={[{ label: "Project" }, { label: "Inspections" }]}>
      <InspectionsClient projectId={id} inspections={inspections} templates={templates} selected={selected} companies={companies} />
    </PageLayout>
  )
}
