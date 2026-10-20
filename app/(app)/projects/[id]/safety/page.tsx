import { guardProjectTab } from "@/lib/services/workspace-surface"
import { notFound } from "next/navigation"
import { connection } from "next/server"
import { Suspense } from "react"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { PageLayout } from "@/components/layout/page-layout"
import { getSafetyRecord, getSafetyWorkspace } from "@/lib/services/safety"
import { getOrgCompaniesAction, getProjectVendorsAction } from "../actions"
import { SafetyClient } from "./safety-client"
import { listProjectLocations } from "@/lib/services/locations"
import { authorize } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { hasPermission } from "@/lib/services/permissions"

async function SafetyPageContent({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string; incident?: string; observation?: string; talk?: string; q?: string; type?: string; status?: string; after?: string }>
}) {
  await connection()
  const [{ id }, query] = await Promise.all([params, searchParams])
  await guardProjectTab(id, "safety")
  const context = await requireOrgContext()
  const filters = { q: query.q, type: query.type ?? (query.tab === "talks" ? "talk" : query.tab === "observations" ? "observation" : "all"), status: query.status, after: query.after }
  const [workspace, vendors, orgCompanies, locations, canManageLocations, orgWrite, writeDecision, selectedIncident, selectedObservation, selectedTalk] = await Promise.all([
    getSafetyWorkspace(id, filters), getProjectVendorsAction(id), getOrgCompaniesAction(), listProjectLocations(id),
    hasPermission("project.manage"), hasPermission("safety.write"),
    authorize({ ...context, permission: "safety.write", projectId: id, logDecision: false }),
    query.incident ? getSafetyRecord(id, "incident", query.incident) : Promise.resolve(null),
    query.observation ? getSafetyRecord(id, "observation", query.observation) : Promise.resolve(null),
    query.talk ? getSafetyRecord(id, "talk", query.talk) : Promise.resolve(null),
  ])
  const selection = { incident: selectedIncident?.kind === "incident" ? selectedIncident.data : null,
    observation: selectedObservation?.kind === "observation" ? selectedObservation.data : null,
    talk: selectedTalk?.kind === "talk" ? selectedTalk.data : null }

  if ((query.incident && !selection.incident) || (query.observation && !selection.observation) || (query.talk && !selection.talk)) notFound()

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
        key={`${id}:${workspace.filters.q}:${workspace.filters.type}:${workspace.filters.status}:${query.after ?? "first"}:${query.incident ?? ""}:${query.observation ?? ""}:${query.talk ?? ""}`}
        projectId={id}
        incidents={workspace.incidents}
        talks={workspace.talks}
        observations={workspace.observations}
        canWrite={orgWrite && writeDecision.allowed}
        workspace={workspace}
        selection={selection}
        companies={companies}
        initialIncidentId={query.incident}
        initialObservationId={query.observation}
        locations={locations}
        canManageLocations={canManageLocations}
      />
    </PageLayout>
  )
}

export default function SafetyPage(props: Parameters<typeof SafetyPageContent>[0]) {
  return (
    <Suspense
      fallback={
        <PageLayout title="Safety">
          <PageLoadingSkeleton />
        </PageLayout>
      }
    >
      <SafetyPageContent {...props} />
    </Suspense>
  )
}
