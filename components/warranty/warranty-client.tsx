"use client"

import { useCallback, useEffect, useMemo, useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { Company, WarrantyRequest } from "@/lib/types"
import { unwrapAction } from "@/lib/action-result"
import { downloadCsv } from "@/lib/csv"
import { createWarrantyRequestAction, updateWarrantyRequestAction } from "@/app/(app)/warranty/actions"
import {
  listAttachmentsAction,
  detachFileLinkAction,
  uploadFileAction,
  attachFileAction,
} from "@/app/(app)/documents/actions"
import { EntityAttachments, type AttachedFile } from "@/components/files"
import { useIsMobile } from "@/hooks/use-mobile"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Calendar as CalendarPicker } from "@/components/ui/calendar"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Separator } from "@/components/ui/separator"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { Calendar, FileText, Plus } from "@/components/icons"
import { cn, formatLocalDate, parseLocalDate, isDateExpired } from "@/lib/utils"

const NONE_COMPANY = "__none__"

const statusLabels: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  closed: "Closed",
}

const statusStyles: Record<string, string> = {
  open: "bg-warning/20 text-warning border-warning/40",
  in_progress: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  resolved: "bg-success/20 text-success border-success/30",
  closed: "bg-muted text-muted-foreground border-muted",
}

const statusDot: Record<string, string> = {
  open: "bg-amber-500",
  in_progress: "bg-blue-500",
  resolved: "bg-emerald-500",
  closed: "bg-zinc-400",
}

const priorityLabels: Record<string, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
}

const filterOrder = ["all", "open", "in_progress", "resolved", "closed"] as const

const shortStatusLabel: Record<string, string> = {
  all: "All",
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  closed: "Closed",
}

type WarrantyFormState = {
  title: string
  description: string
  priority: string
  status: string
  assigned_company_id: string | null
  scheduled_date: string
  resolution_note: string
}

const emptyForm: WarrantyFormState = {
  title: "",
  description: "",
  priority: "normal",
  status: "open",
  assigned_company_id: null,
  scheduled_date: "",
  resolution_note: "",
}

export function WarrantyClient({
  projectId,
  requests,
  companies,
}: {
  projectId: string
  requests: WarrantyRequest[]
  companies: Company[]
}) {
  const isMobile = useIsMobile()
  const [items, setItems] = useState<WarrantyRequest[]>(requests)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editing, setEditing] = useState<WarrantyRequest | null>(null)
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>("all")
  const [isPending, startTransition] = useTransition()
  const [form, setForm] = useState<WarrantyFormState>(emptyForm)
  const [attachments, setAttachments] = useState<AttachedFile[]>([])

  const filtered = useMemo(() => {
    const safeItems = items ?? []
    const term = search.trim().toLowerCase()
    return safeItems.filter((item) => {
      if (statusFilter !== "all" && item.status !== statusFilter) return false
      if (!term) return true
      return [item.title, item.description ?? ""].join(" ").toLowerCase().includes(term)
    })
  }, [items, search, statusFilter])

  const companyName = useCallback(
    (companyId?: string | null) => (companyId ? companies.find((c) => c.id === companyId)?.name ?? null : null),
    [companies],
  )

  const openCreate = () => {
    setEditing(null)
    setForm(emptyForm)
    setAttachments([])
    setSheetOpen(true)
  }

  const openEdit = (item: WarrantyRequest) => {
    setEditing(item)
    setForm({
      title: item.title ?? "",
      description: item.description ?? "",
      priority: item.priority ?? "normal",
      status: item.status ?? "open",
      assigned_company_id: item.assigned_company_id ?? null,
      scheduled_date: item.scheduled_date ?? "",
      resolution_note: item.resolution_note ?? "",
    })
    setSheetOpen(true)
  }

  const loadAttachments = useCallback(async () => {
    if (!editing) return
    try {
      const links = await listAttachmentsAction("warranty_request", editing.id)
      setAttachments(
        links.map((link) => ({
          id: link.file.id,
          linkId: link.id,
          file_name: link.file.file_name,
          mime_type: link.file.mime_type,
          size_bytes: link.file.size_bytes,
          download_url: link.file.download_url,
          thumbnail_url: link.file.thumbnail_url,
          created_at: link.created_at,
          link_role: link.link_role,
        })),
      )
    } catch (error) {
      console.error("Failed to load warranty attachments:", error)
      setAttachments([])
    }
  }, [editing])

  useEffect(() => {
    if (sheetOpen && editing) {
      void loadAttachments()
    }
  }, [sheetOpen, editing, loadAttachments])

  const handleAttach = useCallback(
    async (files: File[], linkRole?: string) => {
      if (!editing) return
      for (const file of files) {
        const formData = new FormData()
        formData.append("file", file)
        formData.append("projectId", projectId)
        formData.append("category", "warranty")

        const uploaded = unwrapAction(await uploadFileAction(formData))
        unwrapAction(await attachFileAction(uploaded.id, "warranty_request", editing.id, projectId, linkRole))
      }
      await loadAttachments()
    },
    [editing, projectId, loadAttachments],
  )

  const handleDetach = useCallback(
    async (linkId: string) => {
      unwrapAction(await detachFileLinkAction(linkId))
      await loadAttachments()
    },
    [loadAttachments],
  )

  const handleSubmit = () => {
    startTransition(async () => {
      try {
        if (!form.title.trim()) {
          toast.error("Title required", { description: "Add a request title." })
          return
        }

        if (editing) {
          const updated = unwrapAction(
            await updateWarrantyRequestAction(editing.id, projectId, {
              title: form.title.trim(),
              description: form.description.trim() || null,
              priority: form.priority,
              status: form.status,
              assigned_company_id: form.assigned_company_id,
              scheduled_date: form.scheduled_date || null,
              resolution_note: form.resolution_note.trim() || null,
            }),
          )
          setItems((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
          setEditing(updated)
          toast.success("Warranty request updated")
        } else {
          const created = unwrapAction(
            await createWarrantyRequestAction({
              project_id: projectId,
              title: form.title.trim(),
              description: form.description.trim() || null,
              priority: form.priority,
              status: form.status,
            }),
          )
          setItems((prev) => [created, ...prev])
          toast.success("Warranty request created")
        }
        setSheetOpen(false)
      } catch (error) {
        toast.error("Unable to save request", {
          description: error instanceof Error ? error.message : "Try again.",
        })
      }
    })
  }

  function handleExportCsv() {
    const rows = filtered.map((item) => ({
      title: item.title,
      status: statusLabels[item.status] ?? item.status,
      priority: priorityLabels[item.priority ?? "normal"],
      requested_by: item.requested_by_name ?? "",
      assigned_to: companyName(item.assigned_company_id) ?? "",
      scheduled: item.scheduled_date ? formatLocalDate(item.scheduled_date, "MMM d, yyyy") : "",
      created: format(new Date(item.created_at), "MMM d, yyyy"),
      closed: item.closed_at ? format(new Date(item.closed_at), "MMM d, yyyy") : "",
      resolution: item.resolution_note ?? "",
    }))
    downloadCsv(`warranty-log-${format(new Date(), "yyyy-MM-dd")}.csv`, rows, [
      { key: "title", header: "Issue" },
      { key: "status", header: "Status" },
      { key: "priority", header: "Priority" },
      { key: "requested_by", header: "Requested By" },
      { key: "assigned_to", header: "Assigned To" },
      { key: "scheduled", header: "Scheduled" },
      { key: "created", header: "Created" },
      { key: "closed", header: "Closed" },
      { key: "resolution", header: "Resolution" },
    ])
    toast.success(`Exported ${rows.length} request${rows.length === 1 ? "" : "s"} to CSV`)
  }

  const isResolvedState = form.status === "resolved" || form.status === "closed"

  return (
    <>
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent
          side="right"
          mobileFullscreen
          className="sm:max-w-xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
          style={{ animationDuration: "150ms", transitionDuration: "150ms" } as React.CSSProperties}
        >
          <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
            <SheetTitle className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary" />
              {editing ? "Warranty request" : "New warranty request"}
            </SheetTitle>
            <SheetDescription className="text-sm text-muted-foreground">
              {editing?.requested_by_name
                ? `Requested by ${editing.requested_by_name}${editing.created_at ? ` on ${format(new Date(editing.created_at), "MMM d, yyyy")}` : ""}`
                : "Track post-closeout service work through to resolution."}
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
              <div className="space-y-2">
                <label className="text-sm font-medium leading-none">Issue</label>
                <Input
                  value={form.title}
                  onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
                  placeholder="Issue title"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium leading-none">Description</label>
                <Textarea
                  value={form.description}
                  onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                  placeholder="Describe the issue..."
                  rows={3}
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium leading-none">Priority</label>
                  <Select
                    value={form.priority}
                    onValueChange={(value) => setForm((prev) => ({ ...prev, priority: value }))}
                  >
                    <SelectTrigger className="w-full">
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
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium leading-none">Status</label>
                  <Select
                    value={form.status}
                    onValueChange={(value) => setForm((prev) => ({ ...prev, status: value }))}
                  >
                    <SelectTrigger className="w-full">
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
              </div>

              {editing && (
                <>
                  <Separator />
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-sm font-medium leading-none">Assign to sub/vendor</label>
                      <Select
                        value={form.assigned_company_id ?? NONE_COMPANY}
                        onValueChange={(value) =>
                          setForm((prev) => ({ ...prev, assigned_company_id: value === NONE_COMPANY ? null : value }))
                        }
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Unassigned" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE_COMPANY}>Unassigned</SelectItem>
                          {companies.map((company) => (
                            <SelectItem key={company.id} value={company.id}>
                              {company.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        Assigning emails the company&apos;s contacts with the service details.
                      </p>
                    </div>
                    <div className="space-y-2 flex flex-col">
                      <label className="text-sm font-medium leading-none">Service visit</label>
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            className={cn(
                              "w-full justify-start text-left font-normal",
                              !form.scheduled_date && "text-muted-foreground",
                            )}
                          >
                            <Calendar className="mr-2 h-4 w-4" />
                            {form.scheduled_date ? formatLocalDate(form.scheduled_date, "PPP") : "Schedule a date"}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0" align="start">
                          <CalendarPicker
                            mode="single"
                            selected={form.scheduled_date ? parseLocalDate(form.scheduled_date) ?? undefined : undefined}
                            onSelect={(date) =>
                              setForm((prev) => ({ ...prev, scheduled_date: date ? format(date, "yyyy-MM-dd") : "" }))
                            }
                            initialFocus
                          />
                        </PopoverContent>
                      </Popover>
                    </div>
                  </div>

                  {(isResolvedState || form.resolution_note) && (
                    <div className="space-y-2">
                      <label className="text-sm font-medium leading-none">Resolution</label>
                      <Textarea
                        value={form.resolution_note}
                        onChange={(e) => setForm((prev) => ({ ...prev, resolution_note: e.target.value }))}
                        placeholder="What was done to resolve this? The homeowner receives this note."
                        rows={3}
                      />
                    </div>
                  )}

                  <Separator />

                  <EntityAttachments
                    entityType="warranty_request"
                    entityId={editing.id}
                    projectId={projectId}
                    attachments={attachments}
                    onAttach={handleAttach}
                    onDetach={handleDetach}
                    title="Photos & documents"
                    description="Photos of the issue, service reports, or receipts"
                  />
                </>
              )}
            </div>

            <SheetFooter className="border-t bg-background/80 px-6 py-4 flex flex-row gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setSheetOpen(false)} disabled={isPending}>
                Cancel
              </Button>
              <Button className="flex-1" onClick={handleSubmit} disabled={isPending}>
                {isPending ? "Saving..." : editing ? "Save changes" : "Create request"}
              </Button>
            </SheetFooter>
          </div>
        </SheetContent>
      </Sheet>

      <div className="-mx-4 -mb-4 -mt-6 flex h-[calc(100svh-3.5rem)] min-h-0 flex-col overflow-hidden bg-background">
        {isMobile ? (
          <div className="sticky top-0 z-20 shrink-0 border-b bg-background/95 backdrop-blur-sm">
            <div className="flex items-center gap-2 px-3 pt-3">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search requests..."
                className="h-10 text-sm"
                inputMode="search"
              />
              <Button size="icon" className="h-10 w-10 shrink-0" onClick={openCreate} aria-label="New warranty request">
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <div className="-mx-px flex gap-1.5 overflow-x-auto px-3 py-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {filterOrder.map((key) => {
                const active = statusFilter === key
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setStatusFilter(key)}
                    className={cn(
                      "shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-muted-foreground active:bg-muted",
                    )}
                  >
                    {shortStatusLabel[key]}
                  </button>
                )
              })}
            </div>
          </div>
        ) : (
          <div className="sticky top-0 z-20 flex shrink-0 flex-col gap-3 border-b bg-background px-4 py-3 sm:min-h-14 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search requests..."
                className="w-full sm:w-72"
              />
              <div className="flex items-center gap-2">
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-full sm:w-36">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    {["open", "in_progress", "resolved", "closed"].map((status) => (
                      <SelectItem key={status} value={status}>
                        {statusLabels[status]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex w-full gap-2 sm:w-auto">
              <Button variant="outline" onClick={handleExportCsv} disabled={filtered.length === 0} className="w-full sm:w-auto">
                Export CSV
              </Button>
              <Button onClick={openCreate} className="w-full sm:w-auto">
                <Plus className="mr-2 h-4 w-4" />
                New request
              </Button>
            </div>
          </div>
        )}

        {isMobile ? (
          <div className="min-h-0 flex-1 overflow-auto">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
                  <FileText className="h-6 w-6 text-muted-foreground" />
                </div>
                <div>
                  <p className="font-medium">No warranty requests</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    Homeowner service issues after closeout land here.
                  </p>
                </div>
                <Button onClick={openCreate} className="mt-1">
                  <Plus className="mr-2 h-4 w-4" />
                  New request
                </Button>
              </div>
            ) : (
              <ul className="divide-y">
                {filtered.map((item) => {
                  const subtitleParts = [
                    statusLabels[item.status] ?? item.status,
                    companyName(item.assigned_company_id) ?? "Unassigned",
                    item.requested_by_name,
                  ].filter(Boolean) as string[]
                  return (
                    <li key={item.id} className="flex items-stretch">
                      <button
                        type="button"
                        onClick={() => openEdit(item)}
                        className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left active:bg-muted/60"
                      >
                        <span
                          aria-hidden
                          className={cn("h-2 w-2 shrink-0 rounded-full", statusDot[item.status] ?? "bg-muted-foreground/40")}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="min-w-0 flex-1 truncate text-sm font-medium leading-tight">{item.title}</p>
                            {item.scheduled_date ? (
                              <span
                                className={cn(
                                  "shrink-0 text-[10px]",
                                  item.status !== "resolved" && item.status !== "closed" && isDateExpired(item.scheduled_date)
                                    ? "font-medium text-rose-600 dark:text-rose-400"
                                    : "text-muted-foreground",
                                )}
                              >
                                {formatLocalDate(item.scheduled_date, "MMM d")}
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{subtitleParts.join(" · ")}</p>
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="w-[36%] min-w-[280px] pl-4">Issue</TableHead>
                  <TableHead className="hidden md:table-cell w-[160px] text-center">Assigned To</TableHead>
                  <TableHead className="hidden sm:table-cell w-[128px] text-center">Status</TableHead>
                  <TableHead className="hidden lg:table-cell w-[112px] text-center">Scheduled</TableHead>
                  <TableHead className="hidden xl:table-cell w-[100px] text-center">Priority</TableHead>
                  <TableHead className="hidden xl:table-cell w-[140px] text-center">Requested By</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((item) => (
                  <TableRow
                    key={item.id}
                    className="group cursor-pointer hover:bg-muted/30 h-[64px]"
                    onClick={() => openEdit(item)}
                  >
                    <TableCell className="min-w-0 pl-4">
                      <span className="text-sm font-medium truncate block">{item.title}</span>
                      {item.description ? (
                        <span className="text-xs text-muted-foreground truncate block mt-0.5">{item.description}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-center">
                      <span className="text-xs text-muted-foreground truncate block">
                        {companyName(item.assigned_company_id) ?? "Unassigned"}
                      </span>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-center">
                      <Badge
                        variant="secondary"
                        className={`text-[10px] px-1 py-0 h-4 font-normal capitalize border ${statusStyles[item.status] ?? ""}`}
                      >
                        {statusLabels[item.status] ?? item.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-center">
                      <span
                        className={cn(
                          "text-xs",
                          item.scheduled_date &&
                            item.status !== "resolved" &&
                            item.status !== "closed" &&
                            isDateExpired(item.scheduled_date)
                            ? "font-medium text-destructive"
                            : "text-muted-foreground",
                        )}
                      >
                        {item.scheduled_date ? formatLocalDate(item.scheduled_date, "MMM d, yyyy") : "—"}
                      </span>
                    </TableCell>
                    <TableCell className="hidden xl:table-cell text-center">
                      <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 font-normal capitalize">
                        {priorityLabels[item.priority ?? "normal"]}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden xl:table-cell text-center">
                      <span className="text-xs text-muted-foreground truncate block">
                        {item.requested_by_name ?? "—"}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="h-48 text-center text-muted-foreground hover:bg-transparent">
                      <div className="flex flex-col items-center gap-3">
                        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                          <FileText className="h-6 w-6" />
                        </div>
                        <div className="text-center max-w-[400px]">
                          <p className="font-medium">No warranty requests</p>
                          <p className="text-sm text-muted-foreground mt-0.5">
                            Homeowner service issues after closeout land here.
                          </p>
                        </div>
                        <div className="mt-2">
                          <Button variant="default" size="sm" onClick={openCreate}>
                            <Plus className="mr-2 h-4 w-4" />
                            New request
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
