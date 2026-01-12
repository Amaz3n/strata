"use client"

import { useState, useTransition } from "react"

import type { WarrantyRequest } from "@/lib/types"
import { createWarrantyRequestPortalAction } from "./actions"
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
  projectId,
  requests: initialRequests,
}: {
  token: string
  projectId: string
  requests: WarrantyRequest[]
}) {
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()
  const [requests, setRequests] = useState(initialRequests)
  const [form, setForm] = useState({
    title: "",
    description: "",
    priority: "normal",
  })

  const handleSubmit = () => {
    if (!form.title.trim()) {
      toast({ title: "Title required", description: "Add a request title." })
      return
    }

    startTransition(async () => {
      try {
        const created = await createWarrantyRequestPortalAction(token, {
          project_id: projectId,
          title: form.title.trim(),
          description: form.description.trim() || null,
          priority: form.priority,
        })
        setRequests((prev) => [created, ...prev])
        setForm({ title: "", description: "", priority: "normal" })
        toast({ title: "Warranty request submitted" })
      } catch (error: any) {
        toast({ title: "Unable to submit request", description: error?.message ?? "Try again." })
      }
    })
  }

  return (
    <div className="p-4 space-y-4">
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
          <div className="flex justify-end">
            <Button onClick={handleSubmit} disabled={isPending}>
              {isPending ? "Submitting..." : "Submit request"}
            </Button>
          </div>
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
