import Link from "next/link"
import { Suspense } from "react"

import { PageLayout } from "@/components/layout/page-layout"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { getSafetyDesk } from "@/lib/services/safety-desk"

export const dynamic = "force-dynamic"

function dateLabel(value: string | null) {
  if (!value) return "—"
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value))
}

function SafetyDeskLoading() {
  return <div className="space-y-4 p-6">{Array.from({ length: 8 }).map((_, index) => <Skeleton className="h-10 w-full" key={index} />)}</div>
}

async function SafetyDeskData() {
  const data = await getSafetyDesk()
  const openIncidents = data.incidents.filter((incident) => incident.status !== "closed")
  const openObservations = data.observations.filter((observation) => observation.status === "open")
  const failedInspections = data.inspections.filter((inspection) => inspection.result === "fail")

  return (
    <div className="space-y-8 p-6">
      <div className="grid gap-px border bg-border sm:grid-cols-3">
        {[
          ["Open incidents", openIncidents.length],
          ["Open observations", openObservations.length],
          ["Failed inspections", failedInspections.length],
        ].map(([label, value]) => (
          <div className="bg-background px-4 py-3" key={label}>
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
          </div>
        ))}
      </div>

      <section className="space-y-2">
        <div><h2 className="text-sm font-semibold">Open incidents</h2><p className="text-xs text-muted-foreground">Newest first across every project.</p></div>
        {openIncidents.length === 0 ? <div className="border p-8 text-center text-sm text-muted-foreground">No open safety incidents.</div> : (
          <Table><TableHeader><TableRow><TableHead>Project</TableHead><TableHead>Incident</TableHead><TableHead>Occurred</TableHead><TableHead>Severity</TableHead><TableHead>Description</TableHead><TableHead>Status</TableHead></TableRow></TableHeader><TableBody>
            {openIncidents.map((incident) => <TableRow key={incident.id}>
              <TableCell><Link className="font-medium hover:underline" href={`/projects/${incident.project_id}/safety`}>{incident.project_name}</Link></TableCell>
              <TableCell className="tabular-nums">#{incident.incident_number}</TableCell><TableCell>{dateLabel(incident.occurred_at)}</TableCell>
              <TableCell><Badge variant={incident.severity === "fatality" || incident.severity === "lost_time" ? "destructive" : "outline"}>{incident.severity.replaceAll("_", " ")}</Badge></TableCell>
              <TableCell className="max-w-md truncate">{incident.description}</TableCell><TableCell>{incident.status.replaceAll("_", " ")}</TableCell>
            </TableRow>)}
          </TableBody></Table>
        )}
      </section>

      <section className="space-y-2">
        <div><h2 className="text-sm font-semibold">Open observations</h2><p className="text-xs text-muted-foreground">At-risk conditions and deficiencies awaiting resolution.</p></div>
        {openObservations.length === 0 ? <div className="border p-8 text-center text-sm text-muted-foreground">No open safety observations.</div> : (
          <Table><TableHeader><TableRow><TableHead>Project</TableHead><TableHead>Observation</TableHead><TableHead>Category</TableHead><TableHead>Description</TableHead><TableHead>Due</TableHead></TableRow></TableHeader><TableBody>
            {openObservations.map((observation) => <TableRow key={observation.id}>
              <TableCell><Link className="font-medium hover:underline" href={`/projects/${observation.project_id}/safety?tab=observations`}>{observation.project_name}</Link></TableCell>
              <TableCell className="tabular-nums">#{observation.observation_number}</TableCell><TableCell>{observation.category?.replaceAll("_", " ") ?? "—"}</TableCell>
              <TableCell className="max-w-lg truncate">{observation.description}</TableCell><TableCell>{dateLabel(observation.due_date)}</TableCell>
            </TableRow>)}
          </TableBody></Table>
        )}
      </section>

      <section className="space-y-2">
        <div><h2 className="text-sm font-semibold">Recent safety inspections</h2><p className="text-xs text-muted-foreground">Completed and in-progress inspections across the portfolio.</p></div>
        {data.inspections.length === 0 ? <div className="border p-8 text-center text-sm text-muted-foreground">No safety inspections yet.</div> : (
          <Table><TableHeader><TableRow><TableHead>Project</TableHead><TableHead>Inspection</TableHead><TableHead>Title</TableHead><TableHead>Result</TableHead><TableHead>Inspected</TableHead></TableRow></TableHeader><TableBody>
            {data.inspections.slice(0, 100).map((inspection) => <TableRow key={inspection.id}>
              <TableCell><Link className="font-medium hover:underline" href={`/projects/${inspection.project_id}/inspections`}>{inspection.project_name}</Link></TableCell>
              <TableCell className="tabular-nums">#{inspection.inspection_number}</TableCell><TableCell>{inspection.title}</TableCell>
              <TableCell><Badge variant={inspection.result === "fail" ? "destructive" : "outline"}>{inspection.result ?? inspection.status.replaceAll("_", " ")}</Badge></TableCell>
              <TableCell>{dateLabel(inspection.inspected_at)}</TableCell>
            </TableRow>)}
          </TableBody></Table>
        )}
      </section>
    </div>
  )
}

export default function SafetyDeskPage() {
  return <PageLayout title="Safety"><Suspense fallback={<SafetyDeskLoading />}><SafetyDeskData /></Suspense></PageLayout>
}
