"use client"

import { useState, useTransition } from "react"

import type { WarrantyRequest } from "@/lib/types"
import type { ProjectWarrantyCoverageDTO, WarrantyServiceVisitDTO } from "@/lib/services/warranty"
import { createWarrantyRequestPortalAction, signOffWarrantyVisitPortalAction } from "./actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"

const statusLabels: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  closed: "Closed",
}

const priorityLabels: Record<string, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
}

function statusBadge(status?: string) {
  const normalized = (status ?? "open").toLowerCase()
  if (normalized === "resolved") return <Badge variant="secondary">Resolved</Badge>
  if (normalized === "closed") return <Badge variant="outline">Closed</Badge>
  if (normalized === "in_progress") return <Badge variant="outline">In progress</Badge>
  return <Badge variant="outline">Open</Badge>
}

export function WarrantyPortalClient({
  token,
  requests: initialRequests,
  coverage,
  visits: initialVisits,
}: {
  token: string
  requests: WarrantyRequest[]
  coverage: ProjectWarrantyCoverageDTO | null
  visits: WarrantyServiceVisitDTO[]
}) {
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()
  const [requests, setRequests] = useState(initialRequests)
  const [visits, setVisits] = useState(initialVisits)
  const [form, setForm] = useState({
    title: "",
    description: "",
    priority: "normal",
    severity: "routine_30",
    category: "",
    coverageTermKey: coverage?.terms[0]?.key ?? "",
  })
  const [photo, setPhoto] = useState<File | null>(null)

  const handleSubmit = () => {
    if (!form.title.trim()) {
      toast({ title: "Title required", description: "Add a request title." })
      return
    }

    startTransition(async () => {
      try {
        const formData = new FormData()
        formData.append("title", form.title.trim())
        if (form.description.trim()) formData.append("description", form.description.trim())
        formData.append("priority", form.priority)
        formData.append("severity", form.severity)
        if (form.category.trim()) formData.append("category", form.category.trim())
        if (form.coverageTermKey) formData.append("coverage_term_key", form.coverageTermKey)
        if (photo) formData.append("photo", photo)

        const created = await createWarrantyRequestPortalAction(token, formData)
        setRequests((prev) => [created, ...prev])
        setForm({ title: "", description: "", priority: "normal", severity: "routine_30", category: "", coverageTermKey: coverage?.terms[0]?.key ?? "" })
        setPhoto(null)
        toast({ title: "Warranty request submitted" })
      } catch (error) {
        toast({
          title: "Unable to submit request",
          description: error instanceof Error ? error.message : "Try again.",
        })
      }
    })
  }

  return (
    <div className="p-4 space-y-4">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Your warranty</CardTitle></CardHeader>
        <CardContent>
          {!coverage ? <p className="text-sm text-muted-foreground">Coverage details have not been enrolled yet. Contact your builder for assistance.</p> : <div className="divide-y border-y">{coverage.terms.map((term) => <div key={term.key} className="flex items-start justify-between gap-4 py-2 text-sm"><div><p className="font-medium">{term.label}</p>{term.description ? <p className="text-xs text-muted-foreground">{term.description}</p> : null}</div><div className={term.expired ? "text-xs text-muted-foreground" : "text-xs"}>{term.expired ? "Expired" : "Through"} {new Date(`${term.expires_on}T00:00:00`).toLocaleDateString()}</div></div>)}</div>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Submit a warranty request</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            value={form.title}
            onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
            placeholder="Issue title"
          />
          <Textarea
            value={form.description}
            onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
            placeholder="Describe the issue..."
          />
          <Select value={form.priority} onValueChange={(value) => setForm((prev) => ({ ...prev, priority: value }))}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["low", "normal", "high", "urgent"].map((priority) => (
                <SelectItem key={priority} value={priority}>
                  {priorityLabels[priority]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="grid gap-3 sm:grid-cols-2">
            <Select value={form.severity} onValueChange={(value) => setForm((prev) => ({ ...prev, severity: value }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="emergency">Emergency — immediate safety or active damage</SelectItem><SelectItem value="routine_30">30-day service list</SelectItem><SelectItem value="routine_60">60-day service list</SelectItem></SelectContent></Select>
            <Input value={form.category} onChange={(event) => setForm((prev) => ({ ...prev, category: event.target.value }))} placeholder="Category, e.g. HVAC" />
          </div>
          {coverage?.terms.length ? <Select value={form.coverageTermKey} onValueChange={(value) => setForm((prev) => ({ ...prev, coverageTermKey: value }))}><SelectTrigger><SelectValue placeholder="Coverage term" /></SelectTrigger><SelectContent>{coverage.terms.map((term) => <SelectItem key={term.key} value={term.key}>{term.label}</SelectItem>)}</SelectContent></Select> : null}
          <div className="space-y-1">
            <Input
              type="file"
              accept="image/*"
              onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
            />
            <p className="text-xs text-muted-foreground">Attach a photo of the issue (optional)</p>
          </div>
          <div className="flex justify-end">
            <Button onClick={handleSubmit} disabled={isPending}>
              {isPending ? "Submitting..." : "Submit request"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Service appointments</CardTitle></CardHeader>
        <CardContent className="divide-y">
          {visits.length === 0 ? <p className="text-sm text-muted-foreground">No appointments scheduled.</p> : visits.map((visit) => <div key={visit.id} className="py-3"><div className="flex items-center justify-between gap-3"><div><p className="text-sm font-medium">Visit {visit.visit_number}</p><p className="text-xs text-muted-foreground">{new Date(visit.window_start).toLocaleString()} – {new Date(visit.window_end).toLocaleTimeString()}</p>{visit.assigned_user_name || visit.assigned_company_name ? <p className="text-xs text-muted-foreground">{visit.assigned_user_name ?? visit.assigned_company_name}</p> : null}</div><Badge variant="outline">{visit.status.replaceAll("_", " ")}</Badge></div>{visit.status === "completed" && !visit.buyer_signoff_at ? <form className="mt-3 flex gap-2" action={(formData) => startTransition(async () => { try { const signed = await signOffWarrantyVisitPortalAction(token, formData); setVisits((rows) => rows.map((row) => row.id === signed.id ? signed : row)); toast({ title: "Service visit signed off" }) } catch (error) { toast({ title: "Unable to sign off", description: error instanceof Error ? error.message : "Try again" }) } })}><input type="hidden" name="visit_id" value={visit.id}/><Input name="name" placeholder="Your name" required/><Button size="sm" type="submit" disabled={isPending}>Sign off</Button></form> : null}</div>)}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Previous requests</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {requests.length === 0 ? (
            <p className="text-sm text-muted-foreground">No requests yet.</p>
          ) : (
            requests.map((request) => (
              <div key={request.id} className="flex items-center justify-between py-2 border-b last:border-0">
                <div>
                  <p className="text-sm font-medium">{request.title}</p>
                  {request.description ? (
                    <p className="text-xs text-muted-foreground">{request.description}</p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{priorityLabels[request.priority ?? "normal"]}</Badge>
                  {statusBadge(request.status)}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}
