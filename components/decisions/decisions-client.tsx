"use client"

import { useMemo, useState, useTransition } from "react"

import type { Decision } from "@/lib/types"
import { createDecisionAction, updateDecisionAction } from "@/app/(app)/decisions/actions"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"

const statusLabels: Record<string, string> = {
  requested: "Requested",
  pending: "Pending",
  approved: "Approved",
  revised: "Revised",
}

function statusBadge(status?: string) {
  const normalized = (status ?? "requested").toLowerCase()
  if (normalized === "approved") return <Badge variant="secondary">Approved</Badge>
  if (normalized === "revised") return <Badge variant="outline">Revised</Badge>
  if (normalized === "pending") return <Badge variant="outline">Pending</Badge>
  return <Badge variant="outline">Requested</Badge>
}

type DecisionFormState = {
  title: string
  description: string
  due_date: string
  status: string
}

export function DecisionsClient({
  projectId,
  decisions,
}: {
  projectId: string
  decisions: Decision[]
}) {
  const { toast } = useToast()
  const [items, setItems] = useState<Decision[]>(decisions)
  const [isPending, startTransition] = useTransition()
  const [statusFilter, setStatusFilter] = useState("all")
  const [search, setSearch] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Decision | null>(null)
  const [form, setForm] = useState<DecisionFormState>({
    title: "",
    description: "",
    due_date: "",
    status: "requested",
  })

  const filtered = useMemo(() => {
    const safeItems = items ?? []
    const term = search.trim().toLowerCase()
    return safeItems.filter((decision) => {
      if (statusFilter !== "all" && decision.status !== statusFilter) return false
      if (!term) return true
      const haystack = [decision.title, decision.description ?? ""].join(" ").toLowerCase()
      return haystack.includes(term)
    })
  }, [items, statusFilter, search])

  const openCreate = () => {
    setEditing(null)
    setForm({
      title: "",
      description: "",
      due_date: "",
      status: "requested",
    })
    setDialogOpen(true)
  }

  const openEdit = (decision: Decision) => {
    setEditing(decision)
    setForm({
      title: decision.title ?? "",
      description: decision.description ?? "",
      due_date: decision.due_date ?? "",
      status: decision.status ?? "requested",
    })
    setDialogOpen(true)
  }

  const handleSubmit = () => {
    startTransition(async () => {
      try {
        if (!form.title.trim()) {
          toast({ title: "Title required", description: "Add a decision title." })
          return
        }

        if (editing) {
          const updated = await updateDecisionAction(editing.id, projectId, {
            title: form.title.trim(),
            description: form.description.trim() || null,
            due_date: form.due_date || null,
            status: form.status,
          })
          setItems((prev) => prev.map((d) => (d.id === updated.id ? updated : d)))
          toast({ title: "Decision updated" })
        } else {
          const created = await createDecisionAction({
            project_id: projectId,
            title: form.title.trim(),
            description: form.description.trim() || null,
            due_date: form.due_date || null,
            status: form.status,
          })
          setItems((prev) => [created, ...prev])
          toast({ title: "Decision created" })
        }
        setDialogOpen(false)
      } catch (error: any) {
        toast({ title: "Unable to save decision", description: error?.message ?? "Try again." })
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <p className="text-sm font-medium">Decision log</p>
          <p className="text-xs text-muted-foreground">Track client choices, approvals, and revisions.</p>
        </div>
        <Button onClick={openCreate}>New decision</Button>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search decisions..."
          className="h-9 w-full sm:w-72"
        />
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-9 w-full sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            {["requested", "pending", "approved", "revised"].map((status) => (
              <SelectItem key={status} value={status}>
                {statusLabels[status]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="divide-x">
              <TableHead className="px-4 py-3">Title</TableHead>
              <TableHead className="px-4 py-3">Status</TableHead>
              <TableHead className="px-4 py-3">Due</TableHead>
              <TableHead className="px-4 py-3">Approved</TableHead>
              <TableHead className="w-32 px-4 py-3 text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((decision) => (
              <TableRow key={decision.id} className="divide-x">
                <TableCell className="px-4 py-3">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">{decision.title}</p>
                    {decision.description ? (
                      <p className="text-xs text-muted-foreground">{decision.description}</p>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="px-4 py-3">{statusBadge(decision.status)}</TableCell>
                <TableCell className="px-4 py-3 text-sm">{decision.due_date ?? "—"}</TableCell>
                <TableCell className="px-4 py-3 text-sm">
                  {decision.approved_at ? new Date(decision.approved_at).toLocaleDateString() : "—"}
                </TableCell>
                <TableCell className="px-4 py-3 text-right">
                  <Button variant="outline" size="sm" onClick={() => openEdit(decision)}>
                    Edit
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 && (
              <TableRow className="divide-x">
                <TableCell colSpan={5} className="text-center text-muted-foreground py-10">
                  No decisions yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit decision" : "New decision"}</DialogTitle>
            <DialogDescription>Capture client approvals and changes.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Input
                value={form.title}
                onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
                placeholder="Decision title"
              />
            </div>
            <div className="space-y-2">
              <Textarea
                value={form.description}
                onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="Context, scope, or notes..."
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                type="date"
                value={form.due_date}
                onChange={(e) => setForm((prev) => ({ ...prev, due_date: e.target.value }))}
              />
              <Select
                value={form.status}
                onValueChange={(value) => setForm((prev) => ({ ...prev, status: value }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["requested", "pending", "approved", "revised"].map((status) => (
                    <SelectItem key={status} value={status}>
                      {statusLabels[status]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={isPending}>
                Cancel
              </Button>
              <Button onClick={handleSubmit} disabled={isPending}>
                {isPending ? "Saving..." : editing ? "Save changes" : "Create decision"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
