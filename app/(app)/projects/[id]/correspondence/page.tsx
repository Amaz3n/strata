import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { getProjectAction } from "../actions"
import { listProjectCorrespondence, projectInboundAddress } from "@/lib/services/project-email-ingest"

export default async function CorrespondencePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ q?: string; classification?: string }> }) {
  const { id } = await params
  const filters = await searchParams
  const [project, emails] = await Promise.all([getProjectAction(id), listProjectCorrespondence(id, filters)])
  if (!project) notFound()
  const address = projectInboundAddress((project as any).correspondence_slug ?? "")
  return <><PageLayout title="Correspondence" breadcrumbs={[{ label: project.name }, { label: "Correspondence" }]} /><div className="space-y-4"><div className="flex items-end justify-between border bg-card p-4"><div><p className="text-xs font-medium uppercase text-muted-foreground">File email into this project</p><p className="mt-1 font-mono text-sm">{address ?? "Configure PAYABLES_INBOUND_DOMAIN to enable inbound filing"}</p></div><form><Input name="q" defaultValue={filters.q} placeholder="Search subject…" className="w-64" /></form></div><div className="overflow-hidden border bg-card"><Table><TableHeader><TableRow><TableHead>Subject</TableHead><TableHead>From</TableHead><TableHead>Classification</TableHead><TableHead>Received</TableHead></TableRow></TableHeader><TableBody>{emails.map((email) => <TableRow key={email.id}><TableCell><p className="font-medium">{email.subject}</p>{email.linked_entity_type && <p className="text-xs text-muted-foreground">Linked to {email.linked_entity_type.replaceAll("_", " ")}</p>}</TableCell><TableCell>{email.from_address}</TableCell><TableCell><Badge variant="outline" className="capitalize">{email.classification.replaceAll("_", " ")}</Badge></TableCell><TableCell>{new Date(email.received_at ?? email.created_at).toLocaleDateString()}</TableCell></TableRow>)}{emails.length === 0 && <TableRow><TableCell colSpan={4} className="h-32 text-center text-muted-foreground">No project correspondence yet. BCC the address above to start the log.</TableCell></TableRow>}</TableBody></Table></div></div></>
}
