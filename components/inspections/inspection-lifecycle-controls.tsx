"use client"

import { useRef, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { inspectionReviewSource, inspectionItemNeedsCorrection, type InspectionLifecycleRequest, type InspectionObligation } from "@/lib/inspections/lifecycle"
import type { InspectionDetail } from "@/lib/services/inspections"
import { mutateInspectionObligationAction } from "@/app/(app)/projects/[id]/inspections/actions"

export function InspectionObligationsPanel({ projectId, page }: {
  projectId: string; page: { rows: InspectionObligation[]; nextCursor: string | null }
}) {
  return <section aria-label="Required inspections" className="shrink-0 border-b p-4">
    <h2 className="text-sm font-medium">Required before closing</h2>
    {page.rows.length ? <ul className="mt-2 space-y-2">{page.rows.map(obligation => <li key={obligation.id} className="flex flex-wrap items-center gap-2 text-sm">
      <span>{obligation.title}</span><Badge variant="outline">{obligation.accepted_inspection_id ? "Accepted" : "Awaiting acceptance"}</Badge>
      {obligation.attempts.map(attempt => <Link key={attempt.inspection_id} className="underline underline-offset-4" href={`/projects/${projectId}/inspections?inspection=${attempt.inspection_id}`}>
        Attempt {attempt.attempt_number} · {attempt.result ?? attempt.status.replace(/_/g, " ")}
      </Link>)}
      {obligation.attempt_count > obligation.attempts.length ? <span className="text-muted-foreground">Showing the latest {obligation.attempts.length} of {obligation.attempt_count} attempts</span> : null}
    </li>)}</ul> : <p className="mt-1 text-sm text-muted-foreground">No required inspections on this page. Open an inspection to require its acceptance before closing.</p>}
    <div className="mt-2 flex gap-3 text-sm">
      <Link href={`/projects/${projectId}/inspections`}>First page</Link>
      {page.nextCursor ? <Link href={`/projects/${projectId}/inspections?obligations_after=${page.nextCursor}`}>Next required inspections</Link> : null}
    </div>
  </section>
}

export function InspectionLifecycleControls({ inspection, obligation, canWrite, canReview }: {
  inspection: InspectionDetail; obligation: InspectionObligation | null; canWrite: boolean; canReview: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [note, setNote] = useState("")
  const [uncertain, setUncertain] = useState(false)
  const original = useRef<{ key: string; request: InspectionLifecycleRequest } | null>(null)
  const latest = obligation?.attempts.at(-1)
  const current = latest?.inspection_id === inspection.id
  const mutable = !obligation?.accepted_inspection_id
  const run = (operation?: InspectionLifecycleRequest["operation"]) => startTransition(async () => {
    try {
      if (!original.current) {
        if (!operation) return
        const common = { inspectionId: inspection.id, source: inspectionReviewSource(inspection) }
        const request: InspectionLifecycleRequest = operation === "create" ? { operation, ...common }
          : operation === "reinspect" ? { operation, ...common, obligationId: obligation!.id, correctionLinks: inspection.items.filter(inspectionItemNeedsCorrection).map(item => ({ failedItemId: item.id, punchId: item.punch_item_id })).sort((a, b) => a.failedItemId.localeCompare(b.failedItemId)), correctionNote: note }
          : { operation, ...common, obligationId: obligation!.id, reviewNote: note }
        original.current = { key: crypto.randomUUID(), request }
      }
      const result = await mutateInspectionObligationAction(inspection.project_id, original.current)
      if (!result.success) {
        if (result.code === "INSPECTION_NOT_COMMITTED") { original.current = null; setUncertain(false) }
        else setUncertain(true)
        toast.error(result.error)
        return
      }
      original.current = null; setUncertain(false); setNote("")
      toast.success("Required inspection updated")
      if (result.data.inspectionId !== inspection.id) router.push(`/projects/${inspection.project_id}/inspections?inspection=${result.data.inspectionId}`)
    } catch (error) {
      setUncertain(Boolean(original.current))
      toast.error(error instanceof Error ? error.message : "Unable to confirm inspection update")
    } finally { router.refresh() }
  })
  return <section aria-label="Inspection acceptance" className="border-t p-6">
    <h3 className="text-sm font-medium">Closing acceptance</h3>
    {obligation ? <p className="mt-1 text-sm text-muted-foreground">{obligation.accepted_inspection_id ? "This required inspection has been accepted." : current ? "This attempt must be accepted before the obligation can satisfy closing." : "A newer attempt exists. Review the latest attempt for acceptance."}</p>
      : <p className="mt-1 text-sm text-muted-foreground">Require this inspection when its accepted result must gate closing.</p>}
    {!obligation && canWrite ? <Button className="mt-3" disabled={pending || uncertain} onClick={() => run("create")}>Require before closing</Button> : null}
    {current && mutable && inspection.status === "completed" && (canWrite || canReview) ? <div className="mt-3 space-y-2">
      <label htmlFor={`inspection-review-${inspection.id}`} className="text-sm">{inspection.result === "pass" && latest?.review_decision !== "reject" ? "Review evidence and decision" : "Corrective work and evidence"}</label>
      <Textarea id={`inspection-review-${inspection.id}`} value={note} onChange={event => setNote(event.target.value)} disabled={pending || uncertain} placeholder="Describe the evidence reviewed (at least 10 characters)" />
      <div className="flex flex-wrap gap-2">
        {canWrite && (inspection.result !== "pass" || latest?.review_decision === "reject") ? <Button disabled={pending || uncertain || note.trim().length < 10} onClick={() => run("reinspect")}>Start reinspection</Button> : null}
        {canReview && inspection.result === "pass" ? <>
          <Button disabled={pending || uncertain || note.trim().length < 10} onClick={() => run("accept")}>Accept inspection</Button>
          <Button variant="outline" disabled={pending || uncertain || note.trim().length < 10} onClick={() => run("reject")}>Require further correction</Button>
        </> : null}
      </div>
    </div> : null}
    {uncertain ? <div className="mt-3 space-y-2"><p className="text-sm text-muted-foreground">The update could not be confirmed. Retry the same request to inspect its recorded outcome.</p><Button variant="outline" disabled={pending} onClick={() => run()}>Retry same request</Button></div> : null}
  </section>
}
