"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { ProjectTeamMember } from "@/app/(app)/projects/[id]/actions"
import { createProjectPunchItemAction, type ProjectPunchItem, updateProjectPunchItemAction } from "@/app/(app)/projects/[id]/actions"
import { EntityAttachments, type AttachedFile } from "@/components/files"
import { attachFileAction, detachFileLinkAction, listAttachmentsAction, uploadFileAction } from "@/app/(app)/files/actions"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Plus, CheckSquare, CalendarDays } from "@/components/icons"
import { cn } from "@/lib/utils"

type PunchStatus = "open" | "in_progress" | "ready_for_review" | "closed"

const statusLabels: Record<PunchStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  ready_for_review: "Ready for review",
  closed: "Closed",
}

const statusStyles: Record<PunchStatus, string> = {
  open: "bg-muted text-muted-foreground border-muted",
  in_progress: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  ready_for_review: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  closed: "bg-success/15 text-success border-success/30",
}

export function PunchTab({
  projectId,
  initialItems,
  team,
}: {
  projectId: string
  initialItems: ProjectPunchItem[]
  team: ProjectTeamMember[]
}) {
  const [items, setItems] = useState<ProjectPunchItem[]>(initialItems)
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<"all" | PunchStatus>("all")
  const [sheetOpen, setSheetOpen] = useState(false)
  const [selected, setSelected] = useState<ProjectPunchItem | null>(null)
  const [isPending, startTransition] = useTransition()

  useEffect(() => setItems(initialItems), [initialItems])

  const filtered = useMemo(() => {
    const safeItems = items ?? []
    const term = search.trim().toLowerCase()
    return safeItems.filter((item) => {
      const status = (item.status as PunchStatus) || "open"
      const matchesStatus = statusFilter === "all" || status === statusFilter
      const haystack = [item.title, item.description ?? "", item.location ?? "", item.severity ?? ""].join(" ").toLowerCase()
      const matchesSearch = !term || haystack.includes(term)
      return matchesStatus && matchesSearch
    })
  }, [items, search, statusFilter])

  const openNew = () => {
    setSelected(null)
    setSheetOpen(true)
  }

  const openEdit = (item: ProjectPunchItem) => {
    setSelected(item)
    setSheetOpen(true)
  }

  const assigneeName = (assigneeId?: string | null) => {
    if (!assigneeId) return "Unassigned"
    const found = team.find((m) => m.user_id === assigneeId)
    return found?.full_name ?? "Assigned"
  }

  const handleQuickStatus = (item: ProjectPunchItem, status: PunchStatus) => {
    startTransition(async () => {
      try {
        const updated = await updateProjectPunchItemAction(projectId, item.id, { status })
        setItems((prev) => prev.map((p) => (p.id === item.id ? updated : p)))
      } catch (error: any) {
        console.error(error)
        toast.error(error?.message ?? "Could not update punch item")
      }
    })
  }

  return (
    <div className="space-y-4 lg:space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="w-full sm:max-w-md">
          <Input
            placeholder="Search by title, description, location, or priority"
            className="w-full"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as any)}>
            <SelectTrigger className="w-full sm:w-[180px]">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {(["open", "in_progress", "ready_for_review", "closed"] as PunchStatus[]).map((s) => (
                <SelectItem key={s} value={s}>
                  {statusLabels[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button onClick={openNew} className="w-full sm:w-auto">
            <Plus className="h-4 w-4 mr-2" />
            New punch item
          </Button>
        </div>
      </div>

      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="divide-x">
                <TableHead className="min-w-[200px] px-4 py-4">Title</TableHead>
                <TableHead className="px-4 py-4">Location</TableHead>
                <TableHead className="px-4 py-4">Priority</TableHead>
                <TableHead className="px-4 py-4">Assigned to</TableHead>
                <TableHead className="px-4 py-4 text-center">Due date</TableHead>
                <TableHead className="px-4 py-4 text-center">Status</TableHead>
                <TableHead className="px-4 py-4 text-center">Verification</TableHead>
                <TableHead className="text-center w-24 px-4 py-4">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((item) => {
                const status = (item.status as PunchStatus) || "open"
                return (
                  <TableRow
                    key={item.id}
                    className="divide-x cursor-pointer hover:bg-muted/50 transition-colors"
                    onClick={() => openEdit(item)}
                  >
                    <TableCell className="px-4 py-4 align-top">
                      <div className="flex flex-col gap-1">
                        <div className="font-semibold">{item.title}</div>
                        {item.description && (
                          <p className="text-sm text-muted-foreground line-clamp-2">{item.description}</p>
                        )}
                      </div>
                    </TableCell>

                    <TableCell className="px-4 py-4 text-muted-foreground">
                      {item.location || "—"}
                    </TableCell>

                    <TableCell className="px-4 py-4 text-muted-foreground">
                      {item.severity || "—"}
                    </TableCell>

                    <TableCell className="px-4 py-4 text-muted-foreground">
                      {assigneeName(item.assigned_to)}
                    </TableCell>

                    <TableCell className="px-4 py-4 text-center text-sm text-muted-foreground">
                      {item.due_date ? format(new Date(item.due_date), "MMM d, yyyy") : "—"}
                    </TableCell>

                    <TableCell className="px-4 py-4 text-center">
                      <Badge variant="secondary" className={`border ${statusStyles[status]}`}>
                        {statusLabels[status]}
                      </Badge>
                    </TableCell>

                    <TableCell className="px-4 py-4 text-center">
                      {item.verification_required ? (
                        <Badge
                          variant="outline"
                          className={item.verified_at ? "bg-success/10 text-success border-success/30" : "bg-warning/10 text-warning border-warning/30"}
                        >
                          {item.verified_at ? "Verified" : "Needs verify"}
                        </Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </TableCell>

                    <TableCell className="px-4 py-4 text-center">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation()
                          openEdit(item)
                        }}
                      >
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}

              {filtered.length === 0 && (
                <TableRow className="divide-x">
                  <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                    <div className="flex flex-col items-center gap-4">
                      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                        <CheckSquare className="h-6 w-6" />
                      </div>
                      <div>
                        <p className="font-medium">No punch items yet</p>
                        <p className="text-sm">Create your first punch item to get started.</p>
                      </div>
                      <Button onClick={openNew}>
                        <Plus className="mr-2 h-4 w-4" />
                        Create punch item
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <PunchItemSheet
        open={sheetOpen}
        onOpenChange={(open) => {
          setSheetOpen(open)
          if (!open) setSelected(null)
        }}
        projectId={projectId}
        team={team}
        item={selected}
        onCreated={(created) => setItems((prev) => [created, ...prev])}
        onUpdated={(updated) => setItems((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))}
      />
    </div>
  )
}

function PunchItemSheet({
  open,
  onOpenChange,
  projectId,
  team,
  item,
  onCreated,
  onUpdated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  team: ProjectTeamMember[]
  item: ProjectPunchItem | null
  onCreated: (item: ProjectPunchItem) => void
  onUpdated: (item: ProjectPunchItem) => void
}) {
  const isEditing = !!item
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [location, setLocation] = useState("")
  const [severity, setSeverity] = useState("")
  const [dueDate, setDueDate] = useState<Date | undefined>(undefined)
  const [assignedTo, setAssignedTo] = useState<string>("__none__")
  const [status, setStatus] = useState<PunchStatus>("open")
  const [verificationRequired, setVerificationRequired] = useState(false)
  const [verificationNotes, setVerificationNotes] = useState("")
  const [isPending, startTransition] = useTransition()

  const [attachmentsLoading, setAttachmentsLoading] = useState(false)
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [shareWithClients, setShareWithClients] = useState(true)

  useEffect(() => {
    if (!open) return
    setTitle(item?.title ?? "")
    setDescription(item?.description ?? "")
    setLocation(item?.location ?? "")
    setSeverity(item?.severity ?? "")
    setDueDate(item?.due_date ? new Date(item.due_date) : undefined)
    setAssignedTo(item?.assigned_to ?? "__none__")
    setStatus(((item?.status as PunchStatus) ?? "open") as PunchStatus)
    setVerificationRequired(Boolean(item?.verification_required))
    setVerificationNotes(item?.verification_notes ?? "")
  }, [open, item])

  useEffect(() => {
    if (!open || !item) return
    setAttachmentsLoading(true)
    listAttachmentsAction("punch_item", item.id)
      .then((links) =>
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
        ),
      )
      .catch((error) => console.error("Failed to load punch item attachments", error))
      .finally(() => setAttachmentsLoading(false))
  }, [open, item])

  const beforeAttachments = attachments.filter((a) => (a.link_role ?? "") === "before")
  const afterAttachments = attachments.filter((a) => (a.link_role ?? "") === "after")

  const handleAttach = async (files: File[], linkRole?: string) => {
    if (!item) return
    for (const file of files) {
      const formData = new FormData()
      formData.append("file", file)
      formData.append("projectId", projectId)
      formData.append("category", file.type.startsWith("image/") ? "photos" : "other")
      formData.append("shareWithClients", shareWithClients ? "true" : "false")

      const uploaded = await uploadFileAction(formData)
      await attachFileAction(uploaded.id, "punch_item", item.id, projectId, linkRole)
    }
    const links = await listAttachmentsAction("punch_item", item.id)
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
  }

  const handleDetach = async (linkId: string) => {
    await detachFileLinkAction(linkId)
    if (!item) return
    const links = await listAttachmentsAction("punch_item", item.id)
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
  }

  const handleSave = () => {
    startTransition(async () => {
      try {
        if (!title.trim()) {
          toast.error("Title is required")
          return
        }

        if (isEditing && item) {
          if (status === "closed" && verificationRequired && afterAttachments.length === 0) {
            toast.error("Add verification evidence before closing this item.")
            return
          }
          const updated = await updateProjectPunchItemAction(projectId, item.id, {
            title: title.trim(),
            description: description.trim() || null,
            location: location.trim() || null,
            severity: severity.trim() || null,
            due_date: dueDate ? format(dueDate, "yyyy-MM-dd") : null,
            assigned_to: assignedTo === "__none__" ? null : assignedTo,
            status,
            verification_required: verificationRequired,
            verification_notes: verificationNotes.trim() || null,
          })
          toast.success("Punch item updated")
          onUpdated(updated)
          onOpenChange(false)
          return
        }

        const created = await createProjectPunchItemAction(projectId, {
          title: title.trim(),
          description: description.trim() || null,
          location: location.trim() || null,
          severity: severity.trim() || null,
          due_date: dueDate ? format(dueDate, "yyyy-MM-dd") : null,
          assigned_to: assignedTo === "__none__" ? null : assignedTo,
          verification_required: verificationRequired,
        })
        toast.success("Punch item created")
        onCreated(created)
        onOpenChange(false)
      } catch (error: any) {
        console.error(error)
        toast.error(error?.message ?? "Could not save punch item")
      }
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:max-w-lg sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
        style={{
          animationDuration: '150ms',
          transitionDuration: '150ms'
        } as React.CSSProperties}
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
          <SheetTitle className="flex items-center gap-2">
            <CheckSquare className="h-5 w-5" />
            {isEditing ? "Punch item" : "New punch item"}
          </SheetTitle>
          <SheetDescription>
            {isEditing ? "Track and close with evidence." : "Create and assign a punch item."}
          </SheetDescription>
        </SheetHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleSave()
          }}
          className="flex-1 flex flex-col overflow-hidden"
        >
          <ScrollArea className="flex-1 min-h-0">
            <div className="px-6 py-4 space-y-6">
              <div className="space-y-2">
                <Label>Title</Label>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Fix cabinet scratch" />
              </div>

              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Details..." rows={3} />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Location</Label>
                  <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Kitchen" />
                </div>
                <div className="space-y-2">
                  <Label>Priority</Label>
                  <Input value={severity} onChange={(e) => setSeverity(e.target.value)} placeholder="Low / Medium / High" />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Due date</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className={cn(
                          "w-full justify-start text-left font-normal",
                          !dueDate && "text-muted-foreground"
                        )}
                      >
                        <CalendarDays className="mr-2 h-4 w-4" />
                        {dueDate ? format(dueDate, "LLL dd, y") : "Pick a date"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={dueDate}
                        onSelect={setDueDate}
                        initialFocus
                      />
                    </PopoverContent>
                  </Popover>
                </div>
                <div className="space-y-2">
                  <Label>Assigned to</Label>
                  <Select value={assignedTo} onValueChange={setAssignedTo}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select assignee" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Unassigned</SelectItem>
                      {team.map((member) => (
                        <SelectItem key={member.user_id} value={member.user_id}>
                          {member.full_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {isEditing ? (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label>Status</Label>
                      <Select value={status} onValueChange={(v) => setStatus(v as PunchStatus)}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select status" />
                        </SelectTrigger>
                        <SelectContent>
                          {(["open", "in_progress", "ready_for_review", "closed"] as PunchStatus[]).map((s) => (
                            <SelectItem key={s} value={s}>
                              {statusLabels[s]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Current status</Label>
                      <div className="flex h-10 items-center">
                        <Badge variant="outline" className={statusStyles[status]}>
                          {statusLabels[status]}
                        </Badge>
                      </div>
                    </div>
                  </div>
                </>
              ) : null}

              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={verificationRequired}
                    onCheckedChange={(v) => setVerificationRequired(Boolean(v))}
                    id="punch-verification-required"
                  />
                  <Label htmlFor="punch-verification-required">Verification required before close</Label>
                </div>
                {verificationRequired ? (
                  <Textarea
                    value={verificationNotes}
                    onChange={(e) => setVerificationNotes(e.target.value)}
                    placeholder="Verification notes or acceptance criteria..."
                    rows={3}
                  />
                ) : null}
              </div>

              {isEditing && item ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-sm font-semibold">Evidence</Label>
                      <p className="text-xs text-muted-foreground mt-0.5">Upload before and after photos</p>
                    </div>
                  </div>

                  <div className="space-y-3 rounded-lg border p-4 bg-muted/30">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={shareWithClients}
                        onCheckedChange={(v) => setShareWithClients(Boolean(v))}
                        id="share-punch-evidence"
                      />
                      <Label htmlFor="share-punch-evidence" className="text-xs font-normal text-muted-foreground">
                        Share new evidence with client portal
                      </Label>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <EntityAttachments
                        entityType="punch_item"
                        entityId={item.id}
                        projectId={projectId}
                        attachments={beforeAttachments}
                        onAttach={(files) => handleAttach(files, "before")}
                        onDetach={handleDetach}
                        readOnly={attachmentsLoading}
                        compact
                        title="Before"
                      />
                      <EntityAttachments
                        entityType="punch_item"
                        entityId={item.id}
                        projectId={projectId}
                        attachments={afterAttachments}
                        onAttach={(files) => handleAttach(files, "after")}
                        onDetach={handleDetach}
                        readOnly={attachmentsLoading}
                        compact
                        title="After"
                      />
                    </div>
                  </div>
                </div>
              ) : null}

              {!isEditing ? (
                <p className="text-xs text-muted-foreground">Create the item first to add before/after attachments.</p>
              ) : null}
            </div>
          </ScrollArea>

          {/* Footer */}
          <div className="flex-shrink-0 border-t bg-muted/30 p-4">
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="flex-1"
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={isPending}
                className="flex-1"
              >
                {isPending ? "Saving..." : isEditing ? "Save changes" : "Create item"}
              </Button>
            </div>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}
