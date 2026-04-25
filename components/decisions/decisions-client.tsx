"use client"

import { useMemo, useState, useTransition } from "react"
import { format } from "date-fns"

import type { Decision } from "@/lib/types"
import { createDecisionAction, updateDecisionAction } from "@/app/(app)/decisions/actions"
import { useIsMobile } from "@/hooks/use-mobile"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Calendar as CalendarPicker } from "@/components/ui/calendar"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { Calendar, FileText, MoreHorizontal, Plus } from "@/components/icons"
import { cn } from "@/lib/utils"

const statusLabels: Record<string, string> = {
  requested: "Requested",
  pending: "Pending",
  approved: "Approved",
  revised: "Revised",
}

const statusStyles: Record<string, string> = {
  requested: "bg-zinc-500/15 text-zinc-600 border-zinc-500/30",
  pending: "bg-warning/20 text-warning border-warning/40",
  approved: "bg-success/20 text-success border-success/30",
  revised: "bg-muted text-muted-foreground border-muted",
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
  const isMobile = useIsMobile()
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
    <>
      <Sheet open={dialogOpen} onOpenChange={setDialogOpen}>
        <SheetContent
          side="right"
          mobileFullscreen
          className="sm:max-w-xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
          style={{ animationDuration: "150ms", transitionDuration: "150ms" } as React.CSSProperties}
        >
          <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
            <SheetTitle className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary" />
              {editing ? "Edit Decision" : "New Decision"}
            </SheetTitle>
            <SheetDescription className="text-sm text-muted-foreground">
              Capture client approvals and changes.
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
              <div className="space-y-2">
                <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                  Title
                </label>
                <Input
                  value={form.title}
                  onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
                  placeholder="Decision title"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                  Description
                </label>
                <Textarea
                  value={form.description}
                  onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                  placeholder="Context, scope, or notes..."
                  rows={4}
                />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                    Status
                  </label>
                  <Select
                    value={form.status}
                    onValueChange={(value) => setForm((prev) => ({ ...prev, status: value }))}
                  >
                    <SelectTrigger className="w-full">
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
                <div className="space-y-2 flex flex-col pt-2 md:pt-0">
                  <label className="mb-1.5 md:mb-0 text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                    Due date
                  </label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        className={cn("w-full justify-start text-left font-normal", !form.due_date && "text-muted-foreground")}
                      >
                        <Calendar className="mr-2 h-4 w-4" />
                        {form.due_date ? format(new Date(form.due_date), "PPP") : "Pick a date"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <CalendarPicker
                        mode="single"
                        selected={form.due_date ? new Date(form.due_date) : undefined}
                        onSelect={(date) => setForm((prev) => ({ ...prev, due_date: date ? format(date, "yyyy-MM-dd") : "" }))}
                        initialFocus
                      />
                    </PopoverContent>
                  </Popover>
                </div>
              </div>
            </div>

            <SheetFooter className="border-t bg-background/80 px-6 py-4 flex flex-row gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setDialogOpen(false)} disabled={isPending}>
                Cancel
              </Button>
              <Button className="flex-1" onClick={handleSubmit} disabled={isPending}>
                {isPending ? "Saving..." : editing ? "Save changes" : "Create decision"}
              </Button>
            </SheetFooter>
          </div>
        </SheetContent>
      </Sheet>

      <div className="-mx-4 -mb-4 -mt-6 flex h-[calc(100svh-3.5rem)] min-h-0 flex-col overflow-hidden bg-background">
        <div className="sticky top-0 z-20 flex shrink-0 flex-col gap-3 border-b bg-background px-4 py-3 sm:min-h-14 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search decisions..."
              className="w-full sm:w-72"
            />
            <div className="flex items-center gap-2">
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-full sm:w-36">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {["requested", "pending", "approved", "revised"].map((status) => (
                    <SelectItem key={status} value={status}>
                      {statusLabels[status]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex w-full gap-2 sm:w-auto">
            <Button onClick={openCreate} className="w-full sm:w-auto">
              <Plus className="mr-2 h-4 w-4" />
              New decision
            </Button>
          </div>
        </div>

        {isMobile ? (
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <div className="space-y-3">
              {filtered.map((decision) => (
                <button
                  key={decision.id}
                  type="button"
                  onClick={() => openEdit(decision)}
                  className="block w-full text-left rounded-lg border bg-card p-4 transition-colors hover:bg-muted/50 active:bg-muted"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="secondary" className={`capitalize border text-[11px] ${statusStyles[decision.status] ?? ""}`}>
                          {statusLabels[decision.status] ?? decision.status}
                        </Badge>
                      </div>
                      <p className="font-semibold mt-1 line-clamp-2">{decision.title}</p>
                      {decision.due_date && (
                        <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          Due {format(new Date(decision.due_date), "MMM d")}
                        </p>
                      )}
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                          <MoreHorizontal className="h-4 w-4" />
                          <span className="sr-only">Actions</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openEdit(decision)}>
                          Edit
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </button>
              ))}
              {filtered.length === 0 && (
                <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground">
                  <div className="flex flex-col items-center gap-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                      <FileText className="h-6 w-6" />
                    </div>
                    <div>
                      <p className="font-medium">No decisions yet</p>
                      <p className="text-sm">Create your first decision to get started.</p>
                    </div>
                    <Button onClick={openCreate}>
                      <Plus className="mr-2 h-4 w-4" />
                      Create decision
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="w-[40%] min-w-[320px] pl-4">Title</TableHead>
                  <TableHead className="hidden sm:table-cell w-[128px] text-center">Status</TableHead>
                  <TableHead className="hidden lg:table-cell w-[112px] text-center">Due</TableHead>
                  <TableHead className="hidden xl:table-cell w-[112px] text-center">Approved</TableHead>
                  <TableHead className="w-[92px] pr-2" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((decision) => (
                  <TableRow 
                    key={decision.id} 
                    className="group cursor-pointer hover:bg-muted/30 h-[64px]"
                    onClick={() => openEdit(decision)}
                  >
                    <TableCell className="min-w-0 pl-4">
                      <span className="text-sm font-medium truncate block">{decision.title}</span>
                      {decision.description ? (
                        <span className="text-xs text-muted-foreground truncate block mt-0.5">{decision.description}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-center">
                      <div className="flex flex-col gap-1 items-center">
                        <Badge variant="secondary" className={`text-[10px] px-1 py-0 h-4 font-normal capitalize border ${statusStyles[decision.status] ?? ""}`}>
                          {statusLabels[decision.status] ?? decision.status}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-center">
                      <span className="text-xs text-muted-foreground">
                        {decision.due_date ? format(new Date(decision.due_date), "MMM d, yyyy") : "—"}
                      </span>
                    </TableCell>
                    <TableCell className="hidden xl:table-cell text-center">
                      <span className="text-xs text-muted-foreground">
                        {decision.approved_at ? format(new Date(decision.approved_at), "MMM d, yyyy") : "—"}
                      </span>
                    </TableCell>
                    <TableCell className="pr-2" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity">
                              <MoreHorizontal className="h-3.5 w-3.5" />
                              <span className="sr-only">Decision actions</span>
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openEdit(decision)}>
                              Edit
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="h-48 text-center text-muted-foreground hover:bg-transparent">
                      <div className="flex flex-col items-center gap-3">
                        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                          <FileText className="h-6 w-6" />
                        </div>
                        <div className="text-center max-w-[400px]">
                          <p className="font-medium">No decisions yet</p>
                          <p className="text-sm text-muted-foreground mt-0.5">Create your first decision to get started.</p>
                        </div>
                        <div className="mt-2">
                          <Button variant="default" size="sm" onClick={openCreate}>
                            <Plus className="mr-2 h-4 w-4" />
                            Create decision
                          </Button>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </>
  )
}
