import Link from "next/link"
import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { buildInternalFileUrl } from "@/lib/services/files"
import { listStructuredFormRuns, listStructuredFormTemplates } from "@/lib/services/structured-forms"
import { getProjectAction } from "../actions"

export default async function FormsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [project, templates, runs] = await Promise.all([getProjectAction(id), listStructuredFormTemplates(), listStructuredFormRuns(id)])
  if (!project) notFound()
  return <><PageLayout title="Forms" breadcrumbs={[{ label: project.name, href: `/projects/${id}` }, { label: "Forms" }]} /><div className="space-y-5"><section className="border bg-card p-4"><div className="flex items-center justify-between"><div><h2 className="font-semibold">Structured form library</h2><p className="text-sm text-muted-foreground">Safety plans, inspections, signatures, and ad-hoc field forms use the same queryable response engine.</p></div><Badge variant="outline">{templates.length} templates</Badge></div><div className="mt-4 flex flex-wrap gap-2">{templates.map((template) => <Badge key={template.id} variant="secondary">{template.name}</Badge>)}</div></section><div className="overflow-hidden border bg-card"><Table><TableHeader><TableRow><TableHead>Form</TableHead><TableHead>Template</TableHead><TableHead>Status</TableHead><TableHead>Completed</TableHead><TableHead /></TableRow></TableHeader><TableBody>{runs.map((run) => { const template = Array.isArray(run.template) ? run.template[0] : run.template; return <TableRow key={run.id}><TableCell className="font-medium">{run.title}</TableCell><TableCell>{template?.name ?? "Form"}</TableCell><TableCell><Badge variant="outline" className="capitalize">{run.status.replaceAll("_", " ")}</Badge></TableCell><TableCell>{run.completed_at ? new Date(run.completed_at).toLocaleDateString() : "—"}</TableCell><TableCell className="text-right">{run.pdf_file_id && <Button size="sm" variant="ghost" asChild><Link href={buildInternalFileUrl(run.pdf_file_id)}>PDF</Link></Button>}</TableCell></TableRow>})}{runs.length === 0 && <TableRow><TableCell colSpan={5} className="h-32 text-center text-muted-foreground">No forms have been run on this project yet.</TableCell></TableRow>}</TableBody></Table></div></div></>
}
