"use client"

import { useMemo, useState, useTransition } from "react"

import type { WarrantyRequest } from "@/lib/types"
import { createWarrantyRequestAction, updateWarrantyRequestAction } from "@/app/(app)/warranty/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
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

export function WarrantyClient({
  projectId,
  requests,
}: {
  projectId: string
  requests: WarrantyRequest[]
}) {
  const { toast } = useToast()
  const [items, setItems] = useState<WarrantyRequest[]>(requests)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<WarrantyRequest | null>(null)
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [isPending, startTransition] = useTransition()

  const [form, setForm] = useState({
    title: "",
    description: "",
    priority: "normal",
    status: "open",
  })

  const filtered = useMemo(() => {
    const safeItems = items ?? []
    const term = search.trim().toLowerCase()
    return safeItems.filter((item) => {
      if (statusFilter !== "all" && item.status !== statusFilter) return false
      if (!term) return true
      return item.title.toLowerCase().includes(term)
    })
  }, [items, search, statusFilter])

  const openCreate = () => {
    setEditing(null)
    setForm({ title: "", description: "", priority: "normal", status: "open" })
    setDialogOpen(true)
  }

  const openEdit = (item: WarrantyRequest) => {
    setEditing(item)
    setForm({
      title: item.title ?? "",
      description: item.description ?? "",
      priority: item.priority ?? "normal",
      status: item.status ?? "open",
    })
    setDialogOpen(true)
  }

  const handleSubmit = () => {
    startTransition(async () => {
      try {
        if (!form.title.trim()) {
          toast({ title: "Title required", description: "Add a request title." })
          return
        }

        if (editing) {
          const updated = await updateWarrantyRequestAction(editing.id, projectId, {
            title: form.title.trim(),
            description: form.description.trim() || null,
            priority: form.priority,
            status: form.status,
          })
          setItems((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
          toast({ title: "Warranty request updated" })
        } else {
          const created = await createWarrantyRequestAction({
            project_id: projectId,
            title: form.title.trim(),
            description: form.description.trim() || null,
            priority: form.priority,
            status: form.status,
          })
          setItems((prev) => [created, ...prev])
          toast({ title: "Warranty request created" })
        }

        setDialogOpen(false)
      } catch (error: any) {
        toast({ title: "Unable to save request", description: error?.message ?? "Try again." })
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <p className="text-sm font-medium">Warranty requests</p>
          <p className="text-xs text-muted-foreground">Track homeowner service issues after closeout.</p>
        </div>
        <Button onClick={openCreate}>New request</Button>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search requests..."
          className="h-9 w-full sm:w-72"
        />
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-9 w-full sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            {["open", "in_progress", "resolved", "closed"].map((status) => (
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
              <TableHead className="px-4 py-3">Issue</TableHead>
              <TableHead className="px-4 py-3">Priority</TableHead>
              <TableHead className="px-4 py-3">Status</TableHead>
              <TableHead className="w-32 px-4 py-3 text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((item) => (
              <TableRow key={item.id} className="divide-x">
                <TableCell className="px-4 py-3">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">{item.title}</p>
                    {item.description ? (
                      <p className="text-xs text-muted-foreground">{item.description}</p>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="px-4 py-3 text-sm">{priorityLabels[item.priority ?? "normal"]}</TableCell>
                <TableCell className="px-4 py-3">{statusBadge(item.status)}</TableCell>
                <TableCell className="px-4 py-3 text-right">
                  <Button variant="outline" size="sm" onClick={() => openEdit(item)}>
                    Edit
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 && (
              <TableRow className="divide-x">
                <TableCell colSpan={4} className="text-center text-muted-foreground py-10">
                  No warranty requests yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit request" : "New warranty request"}</DialogTitle>
            <DialogDescription>Log post-closeout service needs.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
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
            <div className="grid gap-3 sm:grid-cols-2">
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
              <Select value={form.status} onValueChange={(value) => setForm((prev) => ({ ...prev, status: value }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["open", "in_progress", "resolved", "closed"].map((status) => (
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
                {isPending ? "Saving..." : editing ? "Save changes" : "Create request"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
