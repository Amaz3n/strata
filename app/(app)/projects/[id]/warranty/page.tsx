import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { listWarrantyRequestsAction } from "@/app/(app)/warranty/actions"
import { listCompaniesAction } from "@/app/(app)/companies/actions"
import { WarrantyClient } from "@/components/warranty/warranty-client"
import { getProjectWarrantyCoverage, listWarrantyVisitsForProject } from "@/lib/services/warranty"
import { Badge } from "@/components/ui/badge"

import { unwrapAction } from "@/lib/action-result"

interface ProjectWarrantyPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectWarrantyPage({ params }: ProjectWarrantyPageProps) {
  const { id } = await params

  return (
    <>
      <PageLayout
        title="Warranty"
        breadcrumbs={[
          { label: "Project" },
          { label: "Warranty" },
        ]}
      />
      <Suspense fallback={<ProjectWarrantyFallback />}>
        <ProjectWarrantyData id={id} />
      </Suspense>
    </>
  )
}

function ProjectWarrantyFallback() {
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

async function ProjectWarrantyData({ id }: { id: string }) {
  const project = await getProjectAction(id)

  if (!project) notFound()

  const [requests, companies, coverage, visits] = await Promise.all([listWarrantyRequestsAction(id), listCompaniesAction(), getProjectWarrantyCoverage(id), listWarrantyVisitsForProject(id)])

  return <div className="space-y-4"><section className="border"><div className="border-b px-4 py-3"><h2 className="text-sm font-semibold">Coverage</h2></div>{coverage ? <div className="divide-y">{coverage.terms.map((term) => <div key={term.key} className="flex items-center justify-between gap-4 px-4 py-2 text-sm"><div><p className="font-medium">{term.label}</p><p className="text-xs text-muted-foreground">{term.duration_months} months from {new Date(`${coverage.effective_date}T00:00:00`).toLocaleDateString()}</p></div><Badge variant="outline">{term.expired ? "Expired" : `Through ${new Date(`${term.expires_on}T00:00:00`).toLocaleDateString()}`}</Badge></div>)}</div> : <p className="p-4 text-sm text-muted-foreground">This home has not been enrolled in a warranty program.</p>}</section>{visits.length ? <section className="border"><div className="border-b px-4 py-3"><h2 className="text-sm font-semibold">Service visits</h2></div><div className="divide-y">{visits.map((visit) => <div key={visit.id} className="flex items-center justify-between gap-4 px-4 py-2 text-sm"><div><p className="font-medium">Visit {visit.visit_number} · {visit.assigned_user_name ?? visit.assigned_company_name}</p><p className="text-xs text-muted-foreground">{new Date(visit.window_start).toLocaleString()} – {new Date(visit.window_end).toLocaleTimeString()}</p></div><Badge variant="outline">{visit.status.replaceAll("_", " ")}</Badge></div>)}</div></section> : null}<WarrantyClient projectId={project.id} requests={requests} companies={companies} /></div>
}
