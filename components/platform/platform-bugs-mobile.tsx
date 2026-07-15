"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import type React from "react"

import {
  AlertCircle,
  Archive,
  Bug,
  Check,
  ChevronDown,
  ExternalLink,
  FileText,
  GitPullRequest,
  Loader2,
  Paperclip,
  Plus,
  Search,
  Send,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  User,
  X,
} from "@/components/icons"
import { useMobileAction } from "@/components/layout/mobile-action-context"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { formatFileSize } from "@/components/files/types"
import { cn } from "@/lib/utils"
import {
  PLATFORM_BUG_PRIORITIES,
  PLATFORM_BUG_STATUSES,
  type PlatformBug,
  type PlatformBugAiFix,
  type PlatformBugAiReview,
  type PlatformBugEvent,
  type PlatformBugPerson,
  type PlatformBugPriority,
  type PlatformBugRef,
  type PlatformBugStatus,
} from "@/lib/platform-bugs/types"
import {
  AiReviewProposal,
  PRIORITY_LABELS,
  STATUS_LABELS,
  StatusCircle,
  activeStatuses,
  applyFilesToInput,
  canRequestCodexFix,
  eventText,
  formatDate,
  getFixStatusLabel,
  getReviewStatusLabel,
  initials,
  isAiRunning,
  isPdfPreview,
  previewsForFiles,
  priorityClass,
  priorityDot,
  statusOrder,
  type AttachmentPreview,
} from "./platform-bug-ui"

type View = "active" | "backlog" | "done" | "all"

type Props = {
  bugs: PlatformBug[]
  owners: PlatformBugPerson[]
  orgs: { id: string; name: string }[]
  isPending: boolean
  error: string | null
  // Detail — selection lives in the parent so the shared FileViewer stays wired.
  panelBug: PlatformBug | null
  panelOpen: boolean
  panelEvents: PlatformBugEvent[]
  panelReview: PlatformBugAiReview | null
  panelFix: PlatformBugAiFix | null
  onOpenDetails: (id: string) => void
  onCloseDetails: () => void
  onViewAttachment: (id: string) => void
  viewerOpen: boolean
  // Mutations
  onUpdateBug: (id: string, payload: Record<string, unknown>) => void
  onArchiveBug: (id: string) => void
  onDeleteBug: (id: string) => void
  onAddComment: (id: string, body: string, onSuccess: () => void) => void
  onStartAiReview: (id: string) => void
  onStartAiFix: (id: string) => void
  // Composer
  composerOpen: boolean
  onComposerOpenChange: (open: boolean) => void
  onCreateBug: (formData: FormData) => void
  orgId: string
  projectId: string
  projects: PlatformBugRef[]
  projectsLoading: boolean
  onOrgChange: (value: string) => void
  onProjectChange: (value: string) => void
  attachmentPreviews: AttachmentPreview[]
  onAttachmentsChange: (previews: AttachmentPreview[]) => void
}

// A tap target that reads as a row: full width, 44px+, arrow-free.
const ROW_TAP = "flex w-full items-center gap-3 px-4 text-left transition-colors active:bg-accent"

export function PlatformBugsMobile({
  bugs,
  owners,
  orgs,
  isPending,
  error,
  panelBug,
  panelOpen,
  panelEvents,
  panelReview,
  panelFix,
  onOpenDetails,
  onCloseDetails,
  onViewAttachment,
  viewerOpen,
  onUpdateBug,
  onArchiveBug,
  onDeleteBug,
  onAddComment,
  onStartAiReview,
  onStartAiFix,
  composerOpen,
  onComposerOpenChange,
  onCreateBug,
  orgId,
  projectId,
  projects,
  projectsLoading,
  onOrgChange,
  onProjectChange,
  attachmentPreviews,
  onAttachmentsChange,
}: Props) {
  const [view, setView] = useState<View>("active")
  const [query, setQuery] = useState("")
  const [priority, setPriority] = useState<PlatformBugPriority | "all">("all")
  const [assignee, setAssignee] = useState("all")
  const [filterOpen, setFilterOpen] = useState(false)
  const [statusSheetId, setStatusSheetId] = useState<string | null>(null)

  // The bottom nav owns the primary action on phones — reuse it instead of
  // floating a second button over it.
  const { setAction } = useMobileAction()
  useEffect(() => {
    setAction({ label: "New issue", icon: Plus, onAction: () => onComposerOpenChange(true) })
    return () => setAction(null)
  }, [setAction, onComposerOpenChange])

  const counts = useMemo(() => ({
    active: bugs.filter((bug) => activeStatuses.has(bug.status)).length,
    backlog: bugs.filter((bug) => bug.status === "backlog").length,
    done: bugs.filter((bug) => bug.status === "done" || bug.status === "wont_fix").length,
    all: bugs.length,
  }), [bugs])

  const filteredBugs = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return bugs.filter((bug) => {
      if (view === "active" && !activeStatuses.has(bug.status)) return false
      if (view === "backlog" && bug.status !== "backlog") return false
      if (view === "done" && bug.status !== "done" && bug.status !== "wont_fix") return false
      if (priority !== "all" && bug.priority !== priority) return false
      if (assignee === "unassigned" && bug.assignee_user_id) return false
      if (assignee !== "all" && assignee !== "unassigned" && bug.assignee_user_id !== assignee) return false
      if (!normalizedQuery) return true
      return [bug.issue_key, bug.title, bug.description]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery)
    })
  }, [assignee, bugs, priority, query, view])

  const grouped = useMemo(() => {
    return statusOrder
      .map((status) => ({ status, bugs: filteredBugs.filter((bug) => bug.status === status) }))
      .filter((group) => group.bugs.length > 0)
  }, [filteredBugs])

  const activeFilterCount = (priority !== "all" ? 1 : 0) + (assignee !== "all" ? 1 : 0)
  const statusSheetBug = statusSheetId ? bugs.find((bug) => bug.id === statusSheetId) ?? null : null
  const hasFilters = activeFilterCount > 0 || Boolean(query.trim())

  const viewChips: [View, string, number][] = [
    ["active", "Active", counts.active],
    ["backlog", "Backlog", counts.backlog],
    ["done", "Resolved", counts.done],
    ["all", "All", counts.all],
  ]

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <div className="shrink-0 border-b bg-background">
        <div className="flex items-center gap-2 px-3 pt-3">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search issues"
              inputMode="search"
              className="h-10 pl-9 pr-9"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute right-1 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center text-muted-foreground active:bg-muted"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          <Button
            variant="outline"
            size="icon"
            className="relative size-10 shrink-0"
            onClick={() => setFilterOpen(true)}
            aria-label="Filter issues"
          >
            <SlidersHorizontal className="size-4" />
            {activeFilterCount > 0 && (
              <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center bg-primary text-[10px] font-medium tabular-nums text-primary-foreground">
                {activeFilterCount}
              </span>
            )}
          </Button>
        </div>

        <div className="flex gap-1.5 overflow-x-auto px-3 py-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {viewChips.map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              onClick={() => setView(key)}
              aria-pressed={view === key}
              className={cn(
                "flex shrink-0 items-center gap-1.5 border px-3 py-1.5 text-xs font-medium transition-colors",
                view === key
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-background text-muted-foreground active:bg-muted",
              )}
            >
              {label}
              <span className="tabular-nums opacity-70">{count}</span>
            </button>
          ))}
        </div>

        {error && (
          <div className="flex items-center gap-2 border-t border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="size-3.5 shrink-0" />
            {error}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[calc(5.5rem+env(safe-area-inset-bottom))]">
        {grouped.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
            <Bug className="size-9 text-muted-foreground" />
            <p className="mt-4 text-sm font-medium">
              {hasFilters ? "No issues match" : "No issues yet"}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {hasFilters ? "Try clearing search or filters." : "Tap + to file the first one."}
            </p>
            {hasFilters && (
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={() => {
                  setQuery("")
                  setPriority("all")
                  setAssignee("all")
                }}
              >
                Clear filters
              </Button>
            )}
          </div>
        ) : (
          grouped.map((group) => (
            <section key={group.status}>
              <div className="sticky top-0 z-10 flex h-9 items-center gap-2 border-b bg-muted/60 px-4 text-xs font-medium backdrop-blur">
                <StatusCircle status={group.status} className="size-3.5" />
                {STATUS_LABELS[group.status]}
                <span className="tabular-nums text-muted-foreground">{group.bugs.length}</span>
              </div>
              <ul>
                {group.bugs.map((bug) => (
                  <MobileBugRow
                    key={bug.id}
                    bug={bug}
                    onOpen={() => onOpenDetails(bug.id)}
                    onStatusTap={() => setStatusSheetId(bug.id)}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      <MobileComposer
        open={composerOpen}
        onOpenChange={onComposerOpenChange}
        onSubmit={onCreateBug}
        isPending={isPending}
        error={error}
        owners={owners}
        orgs={orgs}
        orgId={orgId}
        projectId={projectId}
        projects={projects}
        projectsLoading={projectsLoading}
        onOrgChange={onOrgChange}
        onProjectChange={onProjectChange}
        attachmentPreviews={attachmentPreviews}
        onAttachmentsChange={onAttachmentsChange}
      />

      <MobileBugDetail
        bug={panelBug}
        open={panelOpen}
        onClose={onCloseDetails}
        events={panelEvents}
        review={panelReview}
        fix={panelFix}
        owners={owners}
        isPending={isPending}
        error={error}
        onUpdateBug={onUpdateBug}
        onArchiveBug={onArchiveBug}
        onDeleteBug={onDeleteBug}
        onAddComment={onAddComment}
        onStartAiReview={onStartAiReview}
        onStartAiFix={onStartAiFix}
        onViewAttachment={onViewAttachment}
        viewerOpen={viewerOpen}
      />

      {/* Status picker — a sheet beats a 7-item dropdown under a thumb. */}
      <Drawer open={Boolean(statusSheetBug)} onOpenChange={(open) => { if (!open) setStatusSheetId(null) }}>
        <DrawerContent>
          <DrawerHeader className="px-4 pb-1 pt-3 text-left">
            <DrawerTitle className="truncate text-sm font-medium">
              {statusSheetBug?.title ?? "Status"}
            </DrawerTitle>
          </DrawerHeader>
          <div className="flex flex-col pb-[max(env(safe-area-inset-bottom),1rem)]">
            {PLATFORM_BUG_STATUSES.map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => {
                  if (statusSheetBug && statusSheetBug.status !== status) {
                    onUpdateBug(statusSheetBug.id, { status })
                  }
                  setStatusSheetId(null)
                }}
                className={cn(ROW_TAP, "h-12 text-sm")}
              >
                <StatusCircle status={status} />
                {STATUS_LABELS[status]}
                {statusSheetBug?.status === status && <Check className="ml-auto size-4" />}
              </button>
            ))}
          </div>
        </DrawerContent>
      </Drawer>

      <Drawer open={filterOpen} onOpenChange={setFilterOpen}>
        <DrawerContent>
          <DrawerHeader className="flex-row items-center justify-between px-4 pb-2 pt-3 text-left">
            <DrawerTitle className="text-sm font-medium">Filters</DrawerTitle>
            {activeFilterCount > 0 && (
              <button
                type="button"
                onClick={() => {
                  setPriority("all")
                  setAssignee("all")
                }}
                className="text-xs text-muted-foreground active:text-foreground"
              >
                Clear all
              </button>
            )}
          </DrawerHeader>
          <div className="space-y-4 px-4 pb-[max(env(safe-area-inset-bottom),1rem)] pt-2">
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Priority</p>
              <div className="grid grid-cols-5 border">
                {(["all", ...PLATFORM_BUG_PRIORITIES] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setPriority(item)}
                    className={cn(
                      "h-11 border-r text-xs font-medium last:border-r-0 transition-colors",
                      priority === item ? "bg-foreground text-background" : "active:bg-muted",
                    )}
                  >
                    {item === "all" ? "All" : PRIORITY_LABELS[item]}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Owner</p>
              <Select value={assignee} onValueChange={setAssignee}>
                <SelectTrigger className="h-11 w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All owners</SelectItem>
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                  {owners.map((owner) => (
                    <SelectItem key={owner.id} value={owner.id}>{owner.full_name ?? owner.email}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button className="h-11 w-full" onClick={() => setFilterOpen(false)}>
              Show {filteredBugs.length} {filteredBugs.length === 1 ? "issue" : "issues"}
            </Button>
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  )
}

function MobileBugRow({
  bug,
  onOpen,
  onStatusTap,
}: {
  bug: PlatformBug
  onOpen: () => void
  onStatusTap: () => void
}) {
  return (
    <li className="flex items-stretch border-b last:border-b-0">
      <button
        type="button"
        onClick={onStatusTap}
        aria-label={`Status: ${STATUS_LABELS[bug.status]}`}
        className="flex w-12 shrink-0 items-center justify-center active:bg-accent"
      >
        <StatusCircle status={bug.status} />
      </button>
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 flex-col justify-center gap-1 py-3 pr-3 text-left active:bg-accent"
      >
        <span className="line-clamp-2 text-sm font-medium leading-snug">{bug.title}</span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-mono">{bug.issue_key}</span>
          <span aria-hidden>·</span>
          <span className={cn("flex items-center gap-1 font-medium", priorityClass(bug.priority))}>
            <span className={cn("size-1.5 shrink-0", priorityDot(bug.priority))} />
            {PRIORITY_LABELS[bug.priority]}
          </span>
          {bug.attachment_names.length > 0 && (
            <>
              <span aria-hidden>·</span>
              <span className="flex items-center gap-0.5">
                <Paperclip className="size-3" />
                {bug.attachment_names.length}
              </span>
            </>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
            {bug.assignee ? (
              <Avatar className="size-4 rounded-none">
                <AvatarImage src={bug.assignee.avatar_url ?? undefined} />
                <AvatarFallback className="rounded-none text-[8px]">{initials(bug.assignee)}</AvatarFallback>
              </Avatar>
            ) : (
              <User className="size-3.5" />
            )}
            <span className="tabular-nums">{formatDate(bug.updated_at)}</span>
          </span>
        </span>
      </button>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Composer — the reason this layout exists. Title is the only required
// decision; everything else defaults so an admin can file in two taps.
// ---------------------------------------------------------------------------

function MobileComposer({
  open,
  onOpenChange,
  onSubmit,
  isPending,
  error,
  owners,
  orgs,
  orgId,
  projectId,
  projects,
  projectsLoading,
  onOrgChange,
  onProjectChange,
  attachmentPreviews,
  onAttachmentsChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (formData: FormData) => void
  isPending: boolean
  error: string | null
  owners: PlatformBugPerson[]
  orgs: { id: string; name: string }[]
  orgId: string
  projectId: string
  projects: PlatformBugRef[]
  projectsLoading: boolean
  onOrgChange: (value: string) => void
  onProjectChange: (value: string) => void
  attachmentPreviews: AttachmentPreview[]
  onAttachmentsChange: (previews: AttachmentPreview[]) => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Quick capture defaults to triage: the point is to dump it now and sort later.
  const [priority, setPriority] = useState<PlatformBugPriority>("medium")
  const [status, setStatus] = useState<PlatformBugStatus>("triage")
  const [assigneeUserId, setAssigneeUserId] = useState("none")
  const [detailsOpen, setDetailsOpen] = useState(false)

  useEffect(() => {
    if (!open) {
      setPriority("medium")
      setStatus("triage")
      setAssigneeUserId("none")
      setDetailsOpen(false)
    }
  }, [open])

  const setAttachmentFiles = (files: File[]) => {
    const input = fileInputRef.current
    if (!input) return
    applyFilesToInput(input, files)
    onAttachmentsChange(previewsForFiles(files))
  }

  const contextCount = (orgId !== "none" ? 1 : 0) + (projectId !== "none" ? 1 : 0)

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[94vh]">
        <DrawerHeader className="sr-only">
          <DrawerTitle>New issue</DrawerTitle>
        </DrawerHeader>
        <form action={onSubmit} className="flex min-h-0 flex-1 flex-col">
          {/* Collapsed "More details" unmounts its selects, and an absent field
              submits as null — which zod's .default() does not catch. Carry every
              non-text value in an always-mounted hidden input instead. */}
          <input type="hidden" name="priority" value={priority} />
          <input type="hidden" name="status" value={status} />
          <input type="hidden" name="assigneeUserId" value={assigneeUserId} />
          <input type="hidden" name="orgId" value={orgId} />
          <input type="hidden" name="projectId" value={projectId} />

          <div className="flex shrink-0 items-center justify-between border-b px-2 py-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <span className="text-sm font-medium">New issue</span>
            <Button type="submit" variant="ghost" disabled={isPending} className="font-medium text-primary">
              {isPending ? <Loader2 className="size-4 animate-spin" /> : "Create"}
            </Button>
          </div>

          {error && (
            <div className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
              <AlertCircle className="size-3.5 shrink-0" />
              {error}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="px-4 pt-4">
              <Input
                name="title"
                placeholder="What's broken?"
                required
                autoFocus
                maxLength={180}
                className="h-auto border-0 px-0 py-0 text-lg font-semibold shadow-none focus-visible:ring-0"
              />
              <Textarea
                name="description"
                placeholder="Steps, expected vs actual, anything useful…"
                className="mt-2 min-h-24 resize-none border-0 px-0 shadow-none focus-visible:ring-0"
              />
            </div>

            <div className="px-4 pb-3">
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Priority</p>
              <div className="grid grid-cols-4 border">
                {PLATFORM_BUG_PRIORITIES.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setPriority(item)}
                    aria-pressed={priority === item}
                    className={cn(
                      "flex h-11 items-center justify-center gap-1.5 border-r text-xs font-medium transition-colors last:border-r-0",
                      priority === item ? "bg-foreground text-background" : "active:bg-muted",
                    )}
                  >
                    <span className={cn("size-1.5 shrink-0", priorityDot(item))} />
                    {PRIORITY_LABELS[item]}
                  </button>
                ))}
              </div>
            </div>

            <div className="px-4 pb-3">
              {/* iOS offers Photo Library / Take Photo / Choose File from this
                  one input, which is exactly the capture menu we want. */}
              <Button type="button" variant="outline" className="h-11 w-full justify-center" asChild>
                <label>
                  <Paperclip className="size-4" />
                  Add screenshot or PDF
                  <input
                    ref={fileInputRef}
                    type="file"
                    name="attachments"
                    multiple
                    accept="image/*,application/pdf,.pdf"
                    className="sr-only"
                    onChange={(event) => onAttachmentsChange(previewsForFiles(Array.from(event.target.files ?? [])))}
                  />
                </label>
              </Button>

              {attachmentPreviews.length > 0 && (
                <ul className="mt-2 divide-y border">
                  {attachmentPreviews.map((preview, index) => (
                    <li key={preview.id} className="flex items-center gap-3 p-2">
                      <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden border bg-muted">
                        {preview.url && preview.type.startsWith("image/") ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={preview.url} alt="" className="size-full object-cover" />
                        ) : (
                          <FileText className="size-4 text-muted-foreground" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{preview.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {isPdfPreview(preview) ? "PDF" : formatFileSize(preview.size)}
                        </p>
                      </div>
                      <button
                        type="button"
                        aria-label={`Remove ${preview.name}`}
                        onClick={() => {
                          const next = Array.from(fileInputRef.current?.files ?? []).filter((_, i) => i !== index)
                          setAttachmentFiles(next)
                        }}
                        className="flex size-9 shrink-0 items-center justify-center text-muted-foreground active:bg-muted"
                      >
                        <X className="size-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <button
              type="button"
              onClick={() => setDetailsOpen((current) => !current)}
              className="flex h-11 w-full items-center gap-2 border-y px-4 text-sm text-muted-foreground active:bg-muted"
            >
              <ChevronDown className={cn("size-4 transition-transform", !detailsOpen && "-rotate-90")} />
              More details
              {!detailsOpen && contextCount > 0 && (
                <Badge variant="outline" className="ml-auto tabular-nums">{contextCount}</Badge>
              )}
            </button>

            {detailsOpen && (
              <div className="space-y-3 px-4 py-3 pb-6">
                <Field label="Status">
                  <Select value={status} onValueChange={(value) => setStatus(value as PlatformBugStatus)}>
                    <SelectTrigger className="h-11 w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {PLATFORM_BUG_STATUSES.map((item) => (
                        <SelectItem key={item} value={item}>{STATUS_LABELS[item]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Assignee">
                  <Select value={assigneeUserId} onValueChange={setAssigneeUserId}>
                    <SelectTrigger className="h-11 w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Unassigned</SelectItem>
                      {owners.map((owner) => (
                        <SelectItem key={owner.id} value={owner.id}>{owner.full_name ?? owner.email ?? "Owner"}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Organization">
                  <Select value={orgId} onValueChange={onOrgChange}>
                    <SelectTrigger className="h-11 w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No organization</SelectItem>
                      {orgs.map((org) => (
                        <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Project">
                  <Select
                    value={projectId}
                    onValueChange={onProjectChange}
                    disabled={orgId === "none" || projectsLoading}
                  >
                    <SelectTrigger className="h-11 w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">
                        {orgId === "none" ? "Select an org first" : projectsLoading ? "Loading projects…" : "No project"}
                      </SelectItem>
                      {projects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
            )}
          </div>

          <div className="shrink-0 border-t p-3 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
            <Button type="submit" disabled={isPending} className="h-12 w-full text-base">
              {isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Create issue
            </Button>
          </div>
        </form>
      </DrawerContent>
    </Drawer>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detail — a full-height sheet instead of the desktop side panel.
// ---------------------------------------------------------------------------

function MobileBugDetail({
  bug,
  open,
  onClose,
  events,
  review,
  fix,
  owners,
  isPending,
  error,
  onUpdateBug,
  onArchiveBug,
  onDeleteBug,
  onAddComment,
  onStartAiReview,
  onStartAiFix,
  onViewAttachment,
  viewerOpen,
}: {
  bug: PlatformBug | null
  open: boolean
  onClose: () => void
  events: PlatformBugEvent[]
  review: PlatformBugAiReview | null
  fix: PlatformBugAiFix | null
  owners: PlatformBugPerson[]
  isPending: boolean
  error: string | null
  onUpdateBug: (id: string, payload: Record<string, unknown>) => void
  onArchiveBug: (id: string) => void
  onDeleteBug: (id: string) => void
  onAddComment: (id: string, body: string, onSuccess: () => void) => void
  onStartAiReview: (id: string) => void
  onStartAiFix: (id: string) => void
  onViewAttachment: (id: string) => void
  viewerOpen: boolean
}) {
  const [comment, setComment] = useState("")
  const fixAllowed = bug ? canRequestCodexFix(bug) : false

  return (
    // The viewer portals out of this drawer, so vaul reads taps inside it as
    // outside clicks. Ignore dismissals while the viewer is up.
    <Drawer open={open} onOpenChange={(next) => { if (!next && !viewerOpen) onClose() }}>
      <DrawerContent className="max-h-[94vh]">
        <DrawerHeader className="sr-only">
          <DrawerTitle>{bug?.title ?? "Issue"}</DrawerTitle>
        </DrawerHeader>
        {bug && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
              <span className="font-mono text-xs text-muted-foreground">{bug.issue_key}</span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-9"
                  onClick={() => onArchiveBug(bug.id)}
                  disabled={isPending}
                  aria-label="Archive"
                >
                  <Archive className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-9 text-destructive"
                  onClick={() => onDeleteBug(bug.id)}
                  disabled={isPending}
                  aria-label="Delete"
                >
                  <Trash2 className="size-4" />
                </Button>
                <Button variant="ghost" size="icon" className="size-9" onClick={onClose} aria-label="Close">
                  <X className="size-4" />
                </Button>
              </div>
            </div>

            {error && (
              <div className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
                <AlertCircle className="size-3.5 shrink-0" />
                {error}
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
              <h2 className="text-lg font-semibold leading-snug">{bug.title}</h2>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <Select value={bug.status} onValueChange={(value) => onUpdateBug(bug.id, { status: value })}>
                  <SelectTrigger className="h-11 w-full gap-1.5">
                    <StatusCircle status={bug.status} className="size-3.5" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PLATFORM_BUG_STATUSES.map((item) => (
                      <SelectItem key={item} value={item}>{STATUS_LABELS[item]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={bug.priority} onValueChange={(value) => onUpdateBug(bug.id, { priority: value })}>
                  <SelectTrigger className="h-11 w-full gap-1.5">
                    <span className={cn("size-2 shrink-0", priorityDot(bug.priority))} />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PLATFORM_BUG_PRIORITIES.map((item) => (
                      <SelectItem key={item} value={item}>{PRIORITY_LABELS[item]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={bug.assignee_user_id ?? "unassigned"}
                  onValueChange={(value) => onUpdateBug(bug.id, { assigneeUserId: value === "unassigned" ? "" : value })}
                >
                  <SelectTrigger className="col-span-2 h-11 w-full gap-1.5">
                    {bug.assignee ? (
                      <Avatar className="size-4 rounded-none">
                        <AvatarImage src={bug.assignee.avatar_url ?? undefined} />
                        <AvatarFallback className="rounded-none text-[8px]">{initials(bug.assignee)}</AvatarFallback>
                      </Avatar>
                    ) : (
                      <User className="size-3.5" />
                    )}
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unassigned">Unassigned</SelectItem>
                    {owners.map((owner) => (
                      <SelectItem key={owner.id} value={owner.id}>{owner.full_name ?? owner.email}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <p className="mt-4 whitespace-pre-wrap text-sm leading-6">
                {bug.description || <span className="text-muted-foreground">No description.</span>}
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
                <span>{bug.org?.name ?? "No org"}</span>
                {bug.project && (<><span aria-hidden>·</span><span>{bug.project.name}</span></>)}
                <span aria-hidden>·</span>
                <span>Updated {formatDate(bug.updated_at)}</span>
              </div>

              {bug.attachments.length > 0 && (
                <div className="mt-4">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Attachments ({bug.attachments.length})
                  </p>
                  <ul className="divide-y border">
                    {bug.attachments.map((attachment) => (
                      <li key={attachment.id}>
                        <button
                          type="button"
                          onClick={() => onViewAttachment(attachment.id)}
                          className="flex w-full items-center gap-3 p-2 text-left active:bg-accent"
                        >
                          <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden border bg-muted">
                            {attachment.content_type?.startsWith("image/") ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={attachment.download_url} alt="" className="size-full object-cover" />
                            ) : (
                              <FileText className="size-4 text-muted-foreground" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm">{attachment.file_name}</p>
                            <p className="text-xs text-muted-foreground">
                              {formatFileSize(attachment.size_bytes ?? undefined)}
                            </p>
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="mt-5 border-t pt-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <Sparkles className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium">Codex review</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {review ? getReviewStatusLabel(review.status) : "No review yet"}
                      </p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant={review ? "outline" : "default"}
                    onClick={() => onStartAiReview(bug.id)}
                    disabled={isPending || isAiRunning(review?.status)}
                  >
                    {isPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                    {review ? "Again" : "Run"}
                  </Button>
                </div>

                {review && (
                  <div className="mt-3 space-y-3 border bg-muted/25 p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant={review.status === "failed" ? "destructive" : "outline"}>
                        {getReviewStatusLabel(review.status)}
                      </Badge>
                      <span>Updated {formatDate(review.updated_at)}</span>
                      {review.github_run_url && (
                        <a
                          href={review.github_run_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 active:text-foreground"
                        >
                          GitHub run
                          <ExternalLink className="size-3" />
                        </a>
                      )}
                    </div>
                    {review.error ? (
                      <p className="whitespace-pre-wrap text-destructive">{review.error}</p>
                    ) : review.summary ? (
                      <p className="whitespace-pre-wrap leading-6">{review.summary}</p>
                    ) : (
                      <p className="text-muted-foreground">Codex is preparing a proposal.</p>
                    )}
                    <AiReviewProposal review={review} />
                  </div>
                )}
              </div>

              <div className="mt-4 border-t pt-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <GitPullRequest className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium">Codex fix PR</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {fix ? getFixStatusLabel(fix.status) : fixAllowed ? "No PR request yet" : "Move out of triage first"}
                      </p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant={fix ? "outline" : "default"}
                    onClick={() => onStartAiFix(bug.id)}
                    disabled={isPending || !fixAllowed || isAiRunning(fix?.status)}
                  >
                    {isPending ? <Loader2 className="size-4 animate-spin" /> : <GitPullRequest className="size-4" />}
                    {fix ? "Again" : "Create"}
                  </Button>
                </div>

                {fix && (
                  <div className="mt-3 space-y-3 border bg-muted/25 p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant={fix.status === "failed" ? "destructive" : "outline"}>
                        {getFixStatusLabel(fix.status)}
                      </Badge>
                      <span>Updated {formatDate(fix.updated_at)}</span>
                      {fix.github_run_url && (
                        <a
                          href={fix.github_run_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 active:text-foreground"
                        >
                          GitHub run
                          <ExternalLink className="size-3" />
                        </a>
                      )}
                      {fix.pr_url && (
                        <a
                          href={fix.pr_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 active:text-foreground"
                        >
                          Pull request
                          <ExternalLink className="size-3" />
                        </a>
                      )}
                    </div>
                    {fix.error ? (
                      <p className="whitespace-pre-wrap text-destructive">{fix.error}</p>
                    ) : fix.summary ? (
                      <p className="whitespace-pre-wrap leading-6">{fix.summary}</p>
                    ) : (
                      <p className="text-muted-foreground">Codex is preparing a fix branch.</p>
                    )}
                    {fix.branch_name && (
                      <p className="text-xs text-muted-foreground">
                        Branch <code className="border bg-background px-1 py-0.5">{fix.branch_name}</code>
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div className="mt-5 border-t pt-4">
                <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Activity</p>
                <div className="flex flex-col gap-4">
                  {events.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No activity yet.</p>
                  ) : events.map((event) => (
                    <div key={event.id} className="flex gap-3 text-sm">
                      <Avatar className="size-6 shrink-0 rounded-none">
                        <AvatarImage src={event.actor?.avatar_url ?? undefined} />
                        <AvatarFallback className="rounded-none text-[9px]">{initials(event.actor)}</AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <p className="text-muted-foreground">
                          <span className="font-medium text-foreground">
                            {event.actor?.full_name ?? event.actor?.email ?? "Arc"}
                          </span>{" "}
                          {eventText(event)}
                          <span className="ml-1 text-xs">· {formatDate(event.created_at)}</span>
                        </p>
                        {event.body && (
                          <p className="mt-1 whitespace-pre-wrap border-l pl-3 text-foreground/90">{event.body}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex shrink-0 items-end gap-2 border-t p-3 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
              <Textarea
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="Add a note…"
                rows={1}
                className="max-h-28 min-h-11 flex-1 resize-none py-2.5"
              />
              <Button
                size="icon"
                className="size-11 shrink-0"
                onClick={() => onAddComment(bug.id, comment, () => setComment(""))}
                disabled={isPending || !comment.trim()}
                aria-label="Add note"
              >
                {isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              </Button>
            </div>
          </div>
        )}
      </DrawerContent>
    </Drawer>
  )
}
