import { connection } from "next/server"
import { Suspense } from "react"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { PageLayout } from "@/components/layout/page-layout"
import { getInspection, listChecklistTemplates, listInspectionObligations, listInspections } from "@/lib/services/inspections"
import { getOrgCompaniesAction, getProjectVendorsAction } from "../actions"
import { InspectionsClient } from "./inspections-client"
import { listProjectLocations } from "@/lib/services/locations"
import { hasPermission } from "@/lib/services/permissions"
import { authorize } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { notFound } from "next/navigation"

async function InspectionsPageContent({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ inspection?: string; schedule_item?: string; title?: string; obligations_after?: string }>
}) {
  await connection()
  const [{ id }, query] = await Promise.all([params, searchParams])
  const scheduleLink = query.schedule_item
    ? { id: query.schedule_item, title: query.title?.trim() ?? "" }
    : null
  const context = await requireOrgContext()
  const [inspections, templates, selected, vendors, orgCompanies, locations, canManageLocations, writeDecision, reviewDecision, obligationPage, selectedObligations, canWriteOrg, canReviewOrg] = await Promise.all([
    listInspections(id),
    listChecklistTemplates(),
    query.inspection ? getInspection(query.inspection) : Promise.resolve(null),
    getProjectVendorsAction(id),
    getOrgCompaniesAction(),
    listProjectLocations(id),
    hasPermission("project.manage"),
    authorize({ ...context, permission: "inspection.write", projectId: id, logDecision: false }),
    authorize({ ...context, permission: "inspection.review", projectId: id, logDecision: false }),
    listInspectionObligations(id, query.obligations_after),
    query.inspection ? listInspectionObligations(id, undefined, undefined, query.inspection) : Promise.resolve({ rows: [], nextCursor: null }),
    hasPermission("inspection.write"),
    hasPermission("inspection.review"),
  ])
  if (selected && selected.project_id !== id) notFound()

  const vendorCompanies = vendors
    .map((vendor) => vendor.company)
    .filter((company): company is NonNullable<typeof company> => Boolean(company))
    .map((company) => ({ id: company.id, name: company.name }))
  const companies = (vendorCompanies.length > 0 ? vendorCompanies : orgCompanies.map((company) => ({ id: company.id, name: company.name })))
    .filter((company, index, all) => all.findIndex((c) => c.id === company.id) === index)
    .sort((a, b) => a.name.localeCompare(b.name))

  return (
    <PageLayout title="Inspections" breadcrumbs={[{ label: "Project" }, { label: "Inspections" }]}>
      <InspectionsClient projectId={id} inspections={inspections} templates={templates} selected={selected} companies={companies} locations={locations} canManageLocations={canManageLocations} canWrite={canWriteOrg && writeDecision.allowed} canReview={canReviewOrg && reviewDecision.allowed && selected?.inspector_user_id !== context.userId} obligationPage={obligationPage} selectedObligation={selectedObligations.rows[0] ?? null} scheduleLink={scheduleLink} />
    </PageLayout>
  )
}

export default function InspectionsPage(props: Parameters<typeof InspectionsPageContent>[0]) {
  return (
    <Suspense
      fallback={
        <PageLayout title="Inspections">
          <PageLoadingSkeleton />
        </PageLayout>
      }
    >
      <InspectionsPageContent {...props} />
    </Suspense>
  )
}
