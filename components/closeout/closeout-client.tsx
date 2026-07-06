"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { format, isBefore, parseISO, startOfToday } from "date-fns"
import { toast } from "sonner"

import type { CloseoutItem, CloseoutPackage } from "@/lib/types"
import type { CloseReadinessCategory, CloseReadinessSection, ProjectCloseReadiness } from "@/lib/services/project-close-readiness"
import { createCloseoutItemAction, updateCloseoutItemAction } from "@/app/(app)/closeout/actions"
import { listAttachmentsAction, detachFileLinkAction, uploadFileAction, attachFileAction } from "@/app/(app)/documents/actions"
import { EntityAttachments, type AttachedFile } from "@/components/files"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import {
  AlertTriangle,
  Calendar,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  DollarSign,
  Download,
  FileText,
  Hammer,
  Link2,
  Plus,
  Search,
  Truck,
  XCircle,
  type LucideIcon,
} from "@/components/icons"

const statusLabels: Record<string, string> = {
  missing: "Missing",
  in_progress: "In progress",
  complete: "Complete",
}

const statusStyles: Record<string, string> = {
  missing: "bg-destructive/10 text-destructive border-destructive/30",
  in_progress: "bg-warning/15 text-warning border-warning/30",
  complete: "bg-success/15 text-success border-success/30",
}

type StatusFilter = "all" | "missing" | "in_progress" | "complete"

const readinessTone = {
  ready: {
    label: "Ready",
    badge: "border-success/30 bg-success/10 text-success",
    text: "text-success",
  },
  warning: {
    label: "Needs review",
    badge: "border-warning/30 bg-warning/10 text-warning",
    text: "text-warning",
  },
  blocked: {
    label: "Blocked",
    badge: "border-destructive/30 bg-destructive/10 text-destructive",
    text: "text-destructive",
  },
}

const categoryIcons: Record<CloseReadinessCategory, LucideIcon> = {
  financial: DollarSign,
  vendors: Truck,
  schedule: CalendarDays,
  field: Hammer,
  closeout: ClipboardCheck,
}

function formatMoney(cents?: number | null) {
  return ((cents ?? 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
}

function formatDate(date?: string | null) {
  if (!date) return "No due date"
  return format(parseISO(date), "MMM d, yyyy")
}

function isOverdue(item: CloseoutItem) {
  return item.status !== "complete" && Boolean(item.due_date) && isBefore(parseISO(item.due_date as string), startOfToday())
}

function statusBadge(status?: string) {
  const normalized = status ?? "missing"
  return (
    <Badge variant="outline" className={cn("capitalize border text-[11px]", statusStyles[normalized])}>
      {statusLabels[normalized] ?? normalized}
    </Badge>
  )
}

function mapAttachments(links: Awaited<ReturnType<typeof listAttachmentsAction>>): AttachedFile[] {
  return links.map((link) => ({
    id: link.file.id,
    linkId: link.id,
    file_name: link.file.file_name,
    mime_type: link.file.mime_type,
    size_bytes: link.file.size_bytes,
    download_url: link.file.download_url,
    thumbnail_url: link.file.thumbnail_url,
    created_at: link.created_at,
    link_role: link.link_role,
  }))
}

function ReadinessSectionCard({ section }: { section: CloseReadinessSection }) {
  const Icon = categoryIcons[section.key]
  const tone = readinessTone[section.state]
  const primaryIssue = section.issues[0]

  return (
    <div className="min-h-[132px] border bg-background p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center border bg-muted/40">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{section.title}</p>
            <p className="text-xs text-muted-foreground">
              {section.blockerCount} blockers · {section.warningCount} warnings
            </p>
          </div>
        </div>
        <Badge variant="outline" className={cn("shrink-0 text-[10px] uppercase", tone.badge)}>
          {tone.label}
        </Badge>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-xs text-muted-foreground">Exposure</p>
          <p className="font-semibold tabular-nums">{formatMoney(section.amountCents)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Open items</p>
          <p className="font-semibold tabular-nums">{section.issues.length}</p>
        </div>
      </div>
      <p className="mt-3 line-clamp-2 text-xs text-muted-foreground">
        {primaryIssue ? primaryIssue.title : "No close blockers detected in this area."}
      </p>
    </div>
  )
}

function ReadinessPanel({ readiness }: { readiness: ProjectCloseReadiness }) {
  const tone = readinessTone[readiness.state]
  const topIssues = readiness.sections.flatMap((section) => section.issues).slice(0, 6)

  return (
    <div className="space-y-4 px-4 sm:px-0">
      <div className="border bg-card p-4 sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={cn("text-[11px] uppercase", tone.badge)}>
                {tone.label}
              </Badge>
              <span className="text-xs text-muted-foreground">Project close readiness</span>
            </div>
            <h2 className="mt-3 text-xl font-semibold tracking-tight">
              {readiness.state === "ready"
                ? "This project is clear to close"
                : readiness.state === "blocked"
                  ? "This project is not ready to close"
                  : "This project needs closeout review"}
            </h2>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Closeout now checks the operational and financial loops around the job, not just the packet checklist.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-px overflow-hidden border bg-border text-sm lg:w-[420px]">
            <div className="bg-background p-3">
              <p className="text-xs text-muted-foreground">Blockers</p>
              <p className={cn("mt-1 text-lg font-semibold tabular-nums", readiness.blockerCount > 0 && "text-destructive")}>
                {readiness.blockerCount}
              </p>
            </div>
            <div className="bg-background p-3">
              <p className="text-xs text-muted-foreground">Warnings</p>
              <p className={cn("mt-1 text-lg font-semibold tabular-nums", readiness.warningCount > 0 && "text-warning")}>
                {readiness.warningCount}
              </p>
            </div>
            <div className="bg-background p-3">
              <p className="text-xs text-muted-foreground">At stake</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">{formatMoney(readiness.blockingAmountCents)}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {readiness.sections.map((section) => (
          <ReadinessSectionCard key={section.key} section={section} />
        ))}
      </div>

      <div className="border bg-background">
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <div>
            <p className="text-sm font-semibold">Action list</p>
            <p className="text-xs text-muted-foreground">Resolve these before final handoff.</p>
          </div>
          {topIssues.length > 0 && <AlertTriangle className="h-4 w-4 text-warning" />}
        </div>
        {topIssues.length > 0 ? (
          <div className="divide-y">
            {topIssues.map((issue) => {
              const Icon = categoryIcons[issue.category]
              return (
                <a key={issue.id} href={issue.href} className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/40">
                  <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center border bg-muted/40">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{issue.title}</span>
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px] uppercase",
                          issue.severity === "blocker"
                            ? "border-destructive/30 bg-destructive/10 text-destructive"
                            : "border-warning/30 bg-warning/10 text-warning",
                        )}
                      >
                        {issue.severity}
                      </Badge>
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {issue.detail}
                      {issue.amountCents ? ` · ${formatMoney(issue.amountCents)}` : ""}
                    </span>
                  </span>
                </a>
              )
            })}
          </div>
        ) : (
          <div className="px-4 py-8 text-center">
            <CheckCircle2 className="mx-auto h-8 w-8 text-success" />
            <p className="mt-3 text-sm font-medium">No close blockers detected</p>
            <p className="text-xs text-muted-foreground">The financial, vendor, schedule, field, and packet checks are clear.</p>
          </div>
        )}
      </div>
    </div>
  )
}

export function CloseoutClient({
  projectId,
  closeoutPackage,
  items,
  readiness,
}: {
  projectId: string
  closeoutPackage: CloseoutPackage
  items: CloseoutItem[]
  readiness: ProjectCloseReadiness
}) {
  const isMobile = useIsMobile()
  const [isPending, startTransition] = useTransition()
  const [rows, setRows] = useState<CloseoutItem[]>(items)
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [newTitle, setNewTitle] = useState("")
  const [selectedItem, setSelectedItem] = useState<CloseoutItem | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [attachmentsLoading, setAttachmentsLoading] = useState(false)
  const [draft, setDraft] = useState({ responsible_party: "", due_date: "", notes: "" })

  useEffect(() => setRows(items), [items])

  useEffect(() => {
    if (!selectedItem) return
    setDraft({
      responsible_party: selectedItem.responsible_party ?? "",
      due_date: selectedItem.due_date ?? "",
      notes: selectedItem.notes ?? "",
    })
  }, [selectedItem])

  useEffect(() => {
    if (!detailsOpen || !selectedItem) return
    setAttachmentsLoading(true)
    listAttachmentsAction("closeout_item", selectedItem.id)
      .then((links) => setAttachments(mapAttachments(links)))
      .catch((error) => {
        console.error("Failed to load closeout attachments", error)
        toast.error("Could not load closeout files")
      })
      .finally(() => setAttachmentsLoading(false))
  }, [detailsOpen, selectedItem])

  const progress = useMemo(() => {
    const total = rows.length
    const completed = rows.filter((row) => row.status === "complete").length
    const missing = rows.filter((row) => row.status === "missing").length
    const overdue = rows.filter(isOverdue).length
    return {
      total,
      completed,
      missing,
      overdue,
      percent: total > 0 ? Math.round((completed / total) * 100) : 0,
    }
  }, [rows])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return rows.filter((item) => {
      const matchesStatus = statusFilter === "all" || item.status === statusFilter
      const matchesSearch =
        !term ||
        [item.title, item.responsible_party ?? "", item.notes ?? ""].some((value) => value.toLowerCase().includes(term))
      return matchesStatus && matchesSearch
    })
  }, [rows, search, statusFilter])

  function mergeRow(updated: CloseoutItem) {
    setRows((prev) =>
      prev.map((row) =>
        row.id === updated.id ? { ...row, ...updated, attachment_count: updated.attachment_count ?? row.attachment_count } : row,
      ),
    )
    setSelectedItem((prev) =>
      prev?.id === updated.id ? { ...prev, ...updated, attachment_count: updated.attachment_count ?? prev.attachment_count } : prev,
    )
  }

  function handleCreate() {
    if (!newTitle.trim()) {
      toast.error("Add a closeout item title")
      return
    }
    startTransition(async () => {
      try {
        const created = await createCloseoutItemAction({
          project_id: projectId,
          closeout_package_id: closeoutPackage.id,
          title: newTitle.trim(),
          status: "missing",
        })
        setRows((prev) => [{ ...created, attachment_count: 0 }, ...prev])
        setNewTitle("")
        toast.success("Closeout item added")
      } catch (error: any) {
        toast.error("Unable to add item", { description: error?.message ?? "Try again." })
      }
    })
  }

  function handleStatusChange(item: CloseoutItem, status: string) {
    startTransition(async () => {
      try {
        const updated = await updateCloseoutItemAction(item.id, projectId, { status })
        mergeRow(updated)
      } catch (error: any) {
        toast.error("Unable to update item", { description: error?.message ?? "Try again." })
      }
    })
  }

  function handleSaveDetails() {
    if (!selectedItem) return
    startTransition(async () => {
      try {
        const updated = await updateCloseoutItemAction(selectedItem.id, projectId, {
          responsible_party: draft.responsible_party || null,
          due_date: draft.due_date || null,
          notes: draft.notes || null,
        })
        mergeRow(updated)
        toast.success("Closeout item updated")
      } catch (error: any) {
        toast.error("Unable to save details", { description: error?.message ?? "Try again." })
      }
    })
  }

  async function refreshAttachments(itemId: string) {
    const links = await listAttachmentsAction("closeout_item", itemId)
    setAttachments(mapAttachments(links))
    setRows((prev) => prev.map((row) => (row.id === itemId ? { ...row, attachment_count: links.length } : row)))
    setSelectedItem((prev) => (prev?.id === itemId ? { ...prev, attachment_count: links.length } : prev))
  }

  async function handleAttach(files: File[], linkRole?: string) {
    if (!selectedItem) return
    for (const file of files) {
      const formData = new FormData()
      formData.append("file", file)
      formData.append("projectId", projectId)
      formData.append("category", "other")

      const uploaded = await uploadFileAction(formData)
      await attachFileAction(uploaded.id, "closeout_item", selectedItem.id, projectId, linkRole)
    }
    await refreshAttachments(selectedItem.id)
  }

  async function handleDetach(linkId: string) {
    if (!selectedItem) return
    await detachFileLinkAction(linkId)
    await refreshAttachments(selectedItem.id)
  }

  function openDetails(item: CloseoutItem) {
    setSelectedItem(item)
    setDetailsOpen(true)
  }

  return (
    <>
      <ReadinessPanel readiness={readiness} />

      <div className="-mx-4 -mb-4 flex min-h-[620px] flex-col overflow-hidden border-t bg-background">
        <div className="sticky top-0 z-20 shrink-0 border-b bg-background">
          <div className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative w-full sm:w-72">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search closeout..."
                  className="pl-9"
                />
              </div>
              <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
                <SelectTrigger className="w-full sm:w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="missing">Missing</SelectItem>
                  <SelectItem value="in_progress">In progress</SelectItem>
                  <SelectItem value="complete">Complete</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="flex w-full gap-2 sm:w-auto">
                <Input
                  value={newTitle}
                  onChange={(event) => setNewTitle(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") handleCreate()
                  }}
                  placeholder="Add requirement..."
                  className="w-full sm:w-64"
                />
                <Button onClick={handleCreate} disabled={isPending} className="shrink-0">
                  <Plus className="mr-2 h-4 w-4" />
                  Add
                </Button>
              </div>
              <Button asChild variant="outline" className="w-full sm:w-auto">
                <a href={`/projects/${projectId}/closeout/export`} target="_blank" rel="noreferrer">
                  <Download className="mr-2 h-4 w-4" />
                  Export
                </a>
              </Button>
            </div>
          </div>

          <div className="grid gap-px border-t bg-border sm:grid-cols-4">
            <div className="bg-background px-4 py-3">
              <p className="text-xs text-muted-foreground">Readiness</p>
              <div className="mt-1 flex items-center gap-3">
                <span className="text-lg font-semibold">{progress.percent}%</span>
                <Progress value={progress.percent} className="h-2" />
              </div>
            </div>
            <div className="bg-background px-4 py-3">
              <p className="text-xs text-muted-foreground">Complete</p>
              <p className="mt-1 text-lg font-semibold">{progress.completed}/{progress.total}</p>
            </div>
            <div className="bg-background px-4 py-3">
              <p className="text-xs text-muted-foreground">Missing</p>
              <p className="mt-1 text-lg font-semibold">{progress.missing}</p>
            </div>
            <div className="bg-background px-4 py-3">
              <p className="text-xs text-muted-foreground">Overdue</p>
              <p className={cn("mt-1 text-lg font-semibold", progress.overdue > 0 && "text-destructive")}>
                {progress.overdue}
              </p>
            </div>
          </div>
        </div>

        {isMobile ? (
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <div className="space-y-3">
              {filtered.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => openDetails(item)}
                  className="block w-full rounded-lg border bg-card p-4 text-left transition-colors hover:bg-muted/50"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {statusBadge(item.status)}
                        {isOverdue(item) && (
                          <Badge variant="outline" className="border-destructive/30 text-destructive">
                            Overdue
                          </Badge>
                        )}
                      </div>
                      <p className="mt-2 font-semibold">{item.title}</p>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>{item.responsible_party || "No owner"}</span>
                        <span>{formatDate(item.due_date)}</span>
                        <span>{item.attachment_count ?? 0} files</span>
                      </div>
                    </div>
                  </div>
                </button>
              ))}
              {filtered.length === 0 && (
                <div className="rounded-lg border border-dashed p-10 text-center">
                  <FileText className="mx-auto h-8 w-8 text-muted-foreground" />
                  <p className="mt-3 font-medium">No closeout items found</p>
                  <p className="text-sm text-muted-foreground">Adjust the filters or add a requirement.</p>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="min-w-[320px]">Requirement</TableHead>
                  <TableHead className="w-[152px] text-center">Status</TableHead>
                  <TableHead className="hidden lg:table-cell w-[180px]">Responsible</TableHead>
                  <TableHead className="hidden md:table-cell w-[144px]">Due</TableHead>
                  <TableHead className="w-[96px] text-center">Files</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((item) => (
                  <TableRow
                    key={item.id}
                    onClick={() => openDetails(item)}
                    className="group h-[64px] cursor-pointer hover:bg-muted/30"
                  >
                    <TableCell>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          {item.status === "complete" ? (
                            <CheckCircle2 className="h-4 w-4 text-success" />
                          ) : isOverdue(item) ? (
                            <XCircle className="h-4 w-4 text-destructive" />
                          ) : (
                            <FileText className="h-4 w-4 text-muted-foreground" />
                          )}
                          <span className="truncate text-sm font-medium">{item.title}</span>
                        </div>
                        {item.notes && <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{item.notes}</p>}
                      </div>
                    </TableCell>
                    <TableCell className="text-center" onClick={(event) => event.stopPropagation()}>
                      <Select value={item.status ?? "missing"} onValueChange={(value) => handleStatusChange(item, value)}>
                        <SelectTrigger className="mx-auto h-8 w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="missing">Missing</SelectItem>
                          <SelectItem value="in_progress">In progress</SelectItem>
                          <SelectItem value="complete">Complete</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-sm text-muted-foreground">
                      {item.responsible_party || "Unassigned"}
                    </TableCell>
                    <TableCell className={cn("hidden md:table-cell text-sm text-muted-foreground", isOverdue(item) && "text-destructive")}>
                      <span className="inline-flex items-center gap-1.5">
                        <Calendar className="h-3.5 w-3.5" />
                        {formatDate(item.due_date)}
                      </span>
                    </TableCell>
                    <TableCell className="text-center">
                      <span className="inline-flex items-center justify-center gap-1 text-sm text-muted-foreground">
                        <Link2 className="h-3.5 w-3.5" />
                        {item.attachment_count ?? 0}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="h-64 text-center">
                      <FileText className="mx-auto h-8 w-8 text-muted-foreground" />
                      <p className="mt-3 font-medium">No closeout items found</p>
                      <p className="text-sm text-muted-foreground">Adjust the filters or add a requirement.</p>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <Dialog
        open={detailsOpen}
        onOpenChange={(nextOpen) => {
          setDetailsOpen(nextOpen)
          if (!nextOpen) {
            setSelectedItem(null)
            setAttachments([])
          }
        }}
      >
        <DialogContent className="max-h-[90svh] max-w-3xl overflow-auto">
          <DialogHeader>
            <DialogTitle>{selectedItem?.title ?? "Closeout item"}</DialogTitle>
            <DialogDescription>Track the owner, due date, notes, and final files for this requirement.</DialogDescription>
          </DialogHeader>

          {selectedItem && (
            <div className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="closeout-owner">Responsible</Label>
                  <Input
                    id="closeout-owner"
                    value={draft.responsible_party}
                    onChange={(event) => setDraft((prev) => ({ ...prev, responsible_party: event.target.value }))}
                    placeholder="Company or person"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="closeout-due">Due date</Label>
                  <Input
                    id="closeout-due"
                    type="date"
                    value={draft.due_date}
                    onChange={(event) => setDraft((prev) => ({ ...prev, due_date: event.target.value }))}
                  />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="closeout-notes">Notes</Label>
                  <Textarea
                    id="closeout-notes"
                    value={draft.notes}
                    onChange={(event) => setDraft((prev) => ({ ...prev, notes: event.target.value }))}
                    placeholder="What is needed to call this complete?"
                    className="min-h-24"
                  />
                </div>
              </div>

              <EntityAttachments
                entityType="closeout_item"
                entityId={selectedItem.id}
                projectId={projectId}
                attachments={attachments}
                onAttach={handleAttach}
                onDetach={handleDetach}
                readOnly={attachmentsLoading}
                compact
              />
            </div>
          )}

          <DialogFooter>
            <Button onClick={handleSaveDetails} disabled={isPending || !selectedItem}>
              Save details
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
