"use client"

import { useEffect, useMemo, useRef, useState, useTransition } from "react"
import type React from "react"
import { useRouter } from "next/navigation"

import {
  addPlatformBugCommentAction,
  archivePlatformBugAction,
  createPlatformBugFromFormAction,
  deletePlatformBugAction,
  listPlatformBugProjectsAction,
  startPlatformBugAiFixAction,
  startPlatformBugAiReviewAction,
  updatePlatformBugAction,
} from "@/app/(app)/platform/bugs/actions"
import {
  AlertCircle,
  Archive,
  Building2,
  Bug,
  Check,
  ChevronDown,
  Circle,
  ExternalLink,
  FileText,
  FolderOpen,
  GitPullRequest,
  Loader2,
  MoreHorizontal,
  Paperclip,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Timer,
  Trash2,
  User,
  X,
} from "@/components/icons"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/components/ui/attachment"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { FileViewer } from "@/components/files/file-viewer"
import { formatFileSize } from "@/components/files/types"
import { useIsMobile } from "@/hooks/use-mobile"
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
import { PlatformBugsMobile } from "./platform-bugs-mobile"
import {
  AiReviewProposal,
  PRIORITY_LABELS,
  STATUS_LABELS,
  StatusCircle,
  activeStatuses,
  applyFilesToInput,
  attachmentToViewerFile,
  canRequestCodexFix,
  eventText,
  formatDate,
  getFixStatusLabel,
  getReviewStatusLabel,
  initials,
  isAiRunning,
  isFileDrag,
  isPdfPreview,
  isSupportedAttachment,
  previewsForFiles,
  priorityClass,
  priorityDot,
  statusOrder,
  type AttachmentPreview,
} from "./platform-bug-ui"

import { unwrapAction } from "@/lib/action-result"

type Props = {
  initialBugs: PlatformBug[]
  initialEvents: PlatformBugEvent[]
  initialAiReviews: PlatformBugAiReview[]
  initialAiFixes: PlatformBugAiFix[]
  owners: PlatformBugPerson[]
  orgs: { id: string; name: string }[]
}

function StatusMenu({
  status,
  onChange,
  children,
}: {
  status: PlatformBugStatus
  onChange: (status: PlatformBugStatus) => void
  children: React.ReactNode
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {PLATFORM_BUG_STATUSES.map((item) => (
          <DropdownMenuItem key={item} onSelect={() => onChange(item)} className="gap-2">
            <StatusCircle status={item} />
            {STATUS_LABELS[item]}
            {item === status && <Check className="ml-auto size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function PlatformBugsClient({ initialBugs, initialEvents, initialAiReviews, initialAiFixes, owners, orgs }: Props) {
  const router = useRouter()
  const [bugs, setBugs] = useState(initialBugs)
  const [events, setEvents] = useState(initialEvents)
  const [aiReviews, setAiReviews] = useState(initialAiReviews)
  const [aiFixes, setAiFixes] = useState(initialAiFixes)
  const [selectedId, setSelectedId] = useState("")
  const [detailOpen, setDetailOpen] = useState(false)
  const [collapsedStatuses, setCollapsedStatuses] = useState<PlatformBugStatus[]>([])
  const [view, setView] = useState<"active" | "backlog" | "done" | "all">("active")
  const [query, setQuery] = useState("")
  const [searchOpen, setSearchOpen] = useState(false)
  const [priority, setPriority] = useState<PlatformBugPriority | "all">("all")
  const [assignee, setAssignee] = useState<string>("all")
  const [showNew, setShowNew] = useState(false)
  const [newOrgId, setNewOrgId] = useState("none")
  const [newProjectId, setNewProjectId] = useState("none")
  const [newProjects, setNewProjects] = useState<PlatformBugRef[]>([])
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [attachmentPreviews, setAttachmentPreviews] = useState<AttachmentPreview[]>([])
  const [viewerAttachmentId, setViewerAttachmentId] = useState<string | null>(null)
  const [comment, setComment] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const isMobile = useIsMobile()

  useEffect(() => {
    setBugs(initialBugs)
    setEvents(initialEvents)
    setAiReviews(initialAiReviews)
    setAiFixes(initialAiFixes)
  }, [initialBugs, initialEvents, initialAiReviews, initialAiFixes])

  useEffect(() => {
    return () => {
      for (const preview of attachmentPreviews) {
        if (preview.url) URL.revokeObjectURL(preview.url)
      }
    }
  }, [attachmentPreviews])

  useEffect(() => {
    if (isMobile) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isTyping = Boolean(target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)))
      if (event.key === "Escape" && detailOpen && !showNew && !isTyping) {
        setDetailOpen(false)
        return
      }
      if (event.key.toLowerCase() !== "n" || event.metaKey || event.ctrlKey || event.altKey) return
      if (isTyping || showNew || detailOpen) return
      event.preventDefault()
      setShowNew(true)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [showNew, detailOpen, isMobile])

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

  const selectedBug = bugs.find((bug) => bug.id === selectedId) ?? null
  // Keep the last shown bug so the panel can animate closed without its content
  // vanishing mid-transition (e.g. after archive removes it from the list).
  const lastBugRef = useRef<PlatformBug | null>(null)
  if (selectedBug) lastBugRef.current = selectedBug
  const panelOpen = detailOpen && Boolean(selectedBug)
  const panelBug = selectedBug ?? lastBugRef.current
  const panelEvents = panelBug ? events.filter((event) => event.bug_id === panelBug.id) : []
  const panelReview = panelBug ? aiReviews.find((review) => review.bug_id === panelBug.id) ?? null : null
  const panelFix = panelBug ? aiFixes.find((fix) => fix.bug_id === panelBug.id) ?? null : null
  const fixAllowed = panelBug ? canRequestCodexFix(panelBug) : false
  const panelOrg = panelBug?.org ?? null
  const panelProject = panelBug?.project ?? null
  const panelAttachmentFiles = useMemo(
    () => panelBug?.attachments.map(attachmentToViewerFile) ?? [],
    [panelBug],
  )
  const viewerAttachment = viewerAttachmentId
    ? panelAttachmentFiles.find((file) => file.id === viewerAttachmentId) ?? null
    : null

  const handleNewOrgChange = (value: string) => {
    setNewOrgId(value)
    setNewProjectId("none")
    setNewProjects([])
    if (value === "none") return
    setProjectsLoading(true)
    listPlatformBugProjectsAction(value)
      .then((result) => setNewProjects(result.projects ?? []))
      .finally(() => setProjectsLoading(false))
  }
  const activeFilterCount = (priority !== "all" ? 1 : 0) + (assignee !== "all" ? 1 : 0)

  const counts = useMemo(() => ({
    active: bugs.filter((bug) => activeStatuses.has(bug.status)).length,
    backlog: bugs.filter((bug) => bug.status === "backlog").length,
    done: bugs.filter((bug) => bug.status === "done" || bug.status === "wont_fix").length,
    all: bugs.length,
  }), [bugs])

  const grouped = useMemo(() => {
    return statusOrder
      .map((status) => ({
        status,
        bugs: filteredBugs.filter((bug) => bug.status === status),
      }))
      .filter((group) => group.bugs.length > 0)
  }, [filteredBugs])

  const updateBug = (id: string, payload: Record<string, unknown>) => {
    setError(null)
    startTransition(async () => {
      const result = unwrapAction(await updatePlatformBugAction(id, payload))
      if (result.error) {
        setError(result.error)
        return
      }
      if (result.bug) {
        setBugs((current) => current.map((bug) => (bug.id === id ? result.bug : bug)))
        router.refresh()
      }
    })
  }

  const createBug = (formData: FormData) => {
    setError(null)
    startTransition(async () => {
      const result = unwrapAction(await createPlatformBugFromFormAction(formData))
      if (result.error) {
        setError(result.error)
        return
      }
      if (result.bug) {
        setBugs((current) => [result.bug, ...current])
        setShowNew(false)
        setNewOrgId("none")
        setNewProjectId("none")
        setNewProjects([])
        setAttachmentPreviews([])
        router.refresh()
      }
    })
  }

  const addComment = (id: string, body: string, onSuccess: () => void) => {
    if (!body.trim()) return
    setError(null)
    startTransition(async () => {
      const result = unwrapAction(await addPlatformBugCommentAction(id, body))
      if (result.error) {
        setError(result.error)
        return
      }
      onSuccess()
      router.refresh()
    })
  }

  const startAiReview = (id: string) => {
    setError(null)
    startTransition(async () => {
      const result = unwrapAction(await startPlatformBugAiReviewAction(id))
      if (result.error) {
        setError(result.error)
        return
      }
      if (result.review) {
        setAiReviews((current) => [
          result.review,
          ...current.filter((review) => review.bug_id !== result.review.bug_id),
        ])
        router.refresh()
      }
    })
  }

  const startAiFix = (id: string) => {
    setError(null)
    startTransition(async () => {
      const result = unwrapAction(await startPlatformBugAiFixAction(id))
      if (result.error) {
        setError(result.error)
        return
      }
      if (result.fix) {
        setAiFixes((current) => [
          result.fix,
          ...current.filter((fix) => fix.bug_id !== result.fix.bug_id),
        ])
        router.refresh()
      }
    })
  }

  const archiveBug = (id?: string) => {
    const targetId = id ?? selectedBug?.id
    if (!targetId) return
    setError(null)
    startTransition(async () => {
      const result = unwrapAction(await archivePlatformBugAction(targetId))
      if (result.error) {
        setError(result.error)
        return
      }
      setBugs((current) => current.filter((bug) => bug.id !== targetId))
      if (selectedId === targetId) {
        setSelectedId("")
        setDetailOpen(false)
      }
      router.refresh()
    })
  }

  const deleteBug = (id: string) => {
    const bug = bugs.find((item) => item.id === id)
    if (!window.confirm(`Delete ${bug?.issue_key ?? "this issue"} permanently? This cannot be undone.`)) return
    setError(null)
    startTransition(async () => {
      const result = unwrapAction(await deletePlatformBugAction(id))
      if (result.error) {
        setError(result.error)
        return
      }
      setBugs((current) => current.filter((bug) => bug.id !== id))
      if (selectedId === id) {
        setSelectedId("")
        setDetailOpen(false)
      }
      router.refresh()
    })
  }

  const openDetails = (id: string) => {
    setViewerAttachmentId(null)
    setSelectedId(id)
    setDetailOpen(true)
  }

  const toggleStatusCollapsed = (status: PlatformBugStatus) => {
    setCollapsedStatuses((current) =>
      current.includes(status)
        ? current.filter((item) => item !== status)
        : [...current, status],
    )
  }

  // Shared by both layouts: attachment previews open the full-screen viewer,
  // which also hides the mobile bottom nav while it is up.
  const fileViewer = (
    <FileViewer
      file={viewerAttachment}
      files={panelAttachmentFiles}
      open={Boolean(viewerAttachment)}
      onOpenChange={(open) => {
        if (!open) setViewerAttachmentId(null)
      }}
      onFileChange={(file) => setViewerAttachmentId(file.id)}
      onDownload={(file) => {
        if (file.download_url) window.open(file.download_url, "_blank", "noopener,noreferrer")
      }}
    />
  )

  if (isMobile) {
    return (
      <>
        <PlatformBugsMobile
          bugs={bugs}
          owners={owners}
          orgs={orgs}
          isPending={isPending}
          error={error}
          panelBug={panelBug}
          panelOpen={panelOpen}
          panelEvents={panelEvents}
          panelReview={panelReview}
          panelFix={panelFix}
          onOpenDetails={openDetails}
          onCloseDetails={() => setDetailOpen(false)}
          onViewAttachment={setViewerAttachmentId}
          viewerOpen={Boolean(viewerAttachment)}
          onUpdateBug={updateBug}
          onArchiveBug={archiveBug}
          onDeleteBug={deleteBug}
          onAddComment={addComment}
          onStartAiReview={startAiReview}
          onStartAiFix={startAiFix}
          composerOpen={showNew}
          onComposerOpenChange={setShowNew}
          onCreateBug={createBug}
          orgId={newOrgId}
          projectId={newProjectId}
          projects={newProjects}
          projectsLoading={projectsLoading}
          onOrgChange={handleNewOrgChange}
          onProjectChange={setNewProjectId}
          attachmentPreviews={attachmentPreviews}
          onAttachmentsChange={setAttachmentPreviews}
        />
        {fileViewer}
      </>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <div className="shrink-0 border-b bg-background/95 px-3 py-2 backdrop-blur">
        <div className="flex items-center justify-between gap-2">
          <Tabs value={view} onValueChange={(value) => setView(value as typeof view)}>
            <TabsList className="h-9 gap-5 rounded-none bg-transparent p-0">
              {[
                ["active", "Active", counts.active],
                ["backlog", "Backlog", counts.backlog],
                ["done", "Resolved", counts.done],
                ["all", "All", counts.all],
              ].map(([key, label, count]) => (
                <TabsTrigger
                  key={key as string}
                  value={key as string}
                  className="h-9 gap-1.5 rounded-none border-0 border-b-2 border-transparent bg-transparent px-0 text-muted-foreground shadow-none transition-colors hover:text-foreground data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
                >
                  {label}
                  <span className="rounded-none bg-muted px-1 text-[11px] tabular-nums text-muted-foreground">{count}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <div className="flex items-center gap-1.5">
            {searchOpen ? (
              <div className="relative w-[200px] sm:w-[240px]">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onBlur={() => {
                    if (!query.trim()) setSearchOpen(false)
                  }}
                  placeholder="Search issues"
                  className="h-8 pl-8 pr-8 text-sm"
                />
                <button
                  type="button"
                  onClick={() => {
                    setQuery("")
                    setSearchOpen(false)
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label="Close search"
                >
                  <X className="size-4" />
                </button>
              </div>
            ) : (
              <Button variant="ghost" size="icon-sm" onClick={() => setSearchOpen(true)} aria-label="Search issues">
                <Search className="size-4" />
              </Button>
            )}

            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm">
                  <SlidersHorizontal className="size-4" />
                  Filter
                  {activeFilterCount > 0 && (
                    <Badge className="ml-1 h-4 min-w-4 justify-center rounded-full px-1 text-[10px] tabular-nums">
                      {activeFilterCount}
                    </Badge>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 space-y-3 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Filters</p>
                  {activeFilterCount > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setPriority("all")
                        setAssignee("all")
                      }}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Clear all
                    </button>
                  )}
                </div>
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">Priority</p>
                  <Select value={priority} onValueChange={(value) => setPriority(value as PlatformBugPriority | "all")}>
                    <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All priorities</SelectItem>
                      {PLATFORM_BUG_PRIORITIES.map((item) => (
                        <SelectItem key={item} value={item}>{PRIORITY_LABELS[item]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">Owner</p>
                  <Select value={assignee} onValueChange={setAssignee}>
                    <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All owners</SelectItem>
                      <SelectItem value="unassigned">Unassigned</SelectItem>
                      {owners.map((owner) => (
                        <SelectItem key={owner.id} value={owner.id}>{owner.full_name ?? owner.email}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </PopoverContent>
            </Popover>

            <Button size="sm" onClick={() => setShowNew(true)}>
              <Plus className="size-4" />
              New
              <kbd className="ml-1 hidden rounded-none border border-primary-foreground/40 px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground sm:inline-flex">
                N
              </kbd>
            </Button>
          </div>
        </div>
        {error && (
          <div className="mt-2 flex items-center gap-2 border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            <AlertCircle className="size-3.5" />
            {error}
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-h-0 flex-1 overflow-auto">
          {grouped.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <Bug className="size-10 text-muted-foreground" />
              <p className="mt-4 text-sm font-medium">No issues match this view</p>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">Clear filters or create the first Arc platform issue.</p>
            </div>
          ) : grouped.map((group) => {
            const isCollapsed = collapsedStatuses.includes(group.status)
            return (
              <section key={group.status} className="border-b">
                <button
                  type="button"
                  onClick={() => toggleStatusCollapsed(group.status)}
                  className="sticky top-0 z-10 flex h-10 w-full items-center justify-between border-b bg-muted/40 px-4 text-left backdrop-blur transition-colors hover:bg-muted/60"
                  aria-expanded={!isCollapsed}
                >
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", isCollapsed && "-rotate-90")} />
                    <StatusCircle status={group.status} />
                    {STATUS_LABELS[group.status]}
                    <span className="text-muted-foreground">{group.bugs.length}</span>
                  </div>
                </button>
                {!isCollapsed && (
                  <div>
                    {group.bugs.map((bug) => (
                    <div
                      key={bug.id}
                      className={cn(
                        "group flex min-h-12 w-full items-center gap-3 border-b px-4 text-sm transition-colors last:border-b-0 hover:bg-accent/45",
                        selectedId === bug.id && detailOpen && "bg-accent/70",
                      )}
                    >
                      <StatusMenu status={bug.status} onChange={(value) => updateBug(bug.id, { status: value })}>
                        <button
                          type="button"
                          onClick={(event) => event.stopPropagation()}
                          className="flex size-6 shrink-0 items-center justify-center rounded-none hover:bg-accent"
                          aria-label={`Status: ${STATUS_LABELS[bug.status]}`}
                        >
                          <StatusCircle status={bug.status} />
                        </button>
                      </StatusMenu>

                      <button
                        type="button"
                        onClick={() => openDetails(bug.id)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <span className="truncate font-medium">{bug.title}</span>
                        <span className={cn("flex shrink-0 items-center gap-1.5 text-xs font-medium", priorityClass(bug.priority))}>
                          <span className={cn("size-2 shrink-0 rounded-none", priorityDot(bug.priority))} />
                          {PRIORITY_LABELS[bug.priority]}
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() => openDetails(bug.id)}
                        className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground"
                      >
                        {bug.assignee ? (
                          <span className="flex items-center gap-1.5">
                            <Avatar className="size-5 rounded-none">
                              <AvatarImage src={bug.assignee.avatar_url ?? undefined} />
                              <AvatarFallback className="rounded-none text-[9px]">{initials(bug.assignee)}</AvatarFallback>
                            </Avatar>
                            <span className="max-w-28 truncate">{bug.assignee.full_name ?? bug.assignee.email}</span>
                          </span>
                        ) : (
                          <span className="flex items-center gap-1.5">
                            <User className="size-4" />
                            Unassigned
                          </span>
                        )}
                        <span className="w-11 text-right tabular-nums">{formatDate(bug.updated_at)}</span>
                      </button>

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            onClick={(event) => event.stopPropagation()}
                            className="flex size-6 shrink-0 items-center justify-center rounded-none text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100"
                            aria-label="Bug actions"
                          >
                            <MoreHorizontal className="size-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-40">
                          <DropdownMenuItem onSelect={() => openDetails(bug.id)}>Open</DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => archiveBug(bug.id)}>
                            <Archive className="size-4" />
                            Archive
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onSelect={() => deleteBug(bug.id)}>
                            <Trash2 className="size-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    ))}
                  </div>
                )}
              </section>
            )
          })}
        </div>

        <aside
          className={cn(
            "flex shrink-0 flex-col overflow-hidden border-l bg-background transition-[width,opacity] duration-300 ease-in-out",
            panelOpen ? "w-[420px] max-w-[46%] opacity-100" : "w-0 border-l-0 opacity-0",
          )}
          aria-hidden={!panelOpen}
        >
          {panelBug && (
            <div className="flex h-full w-[420px] max-w-full flex-col">
              <div className="flex shrink-0 items-center justify-between gap-2 px-5 pt-5">
                <span className="font-mono text-xs text-muted-foreground">{panelBug.issue_key}</span>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon-sm" onClick={() => archiveBug()} disabled={isPending} aria-label="Archive">
                    <Archive className="size-4" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => setDetailOpen(false)} aria-label="Close panel">
                    <X className="size-4" />
                  </Button>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-auto px-5 pb-6">
                <h2 className="mt-2 text-xl font-semibold leading-snug">{panelBug.title}</h2>

                <div className="mt-3 flex flex-wrap items-center gap-1">
                  <Select value={panelBug.status} onValueChange={(value) => updateBug(panelBug.id, { status: value })}>
                    <SelectTrigger size="sm" className="w-fit gap-1.5 border-0 bg-transparent px-2 shadow-none hover:bg-accent">
                      <StatusCircle status={panelBug.status} className="size-3.5" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>{PLATFORM_BUG_STATUSES.map((item) => <SelectItem key={item} value={item}>{STATUS_LABELS[item]}</SelectItem>)}</SelectContent>
                  </Select>
                  <Select value={panelBug.priority} onValueChange={(value) => updateBug(panelBug.id, { priority: value })}>
                    <SelectTrigger size="sm" className="w-fit gap-1.5 border-0 bg-transparent px-2 shadow-none hover:bg-accent">
                      <span className={cn("size-2 rounded-none", priorityDot(panelBug.priority))} />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>{PLATFORM_BUG_PRIORITIES.map((item) => <SelectItem key={item} value={item}>{PRIORITY_LABELS[item]}</SelectItem>)}</SelectContent>
                  </Select>
                  <Select value={panelBug.assignee_user_id ?? "unassigned"} onValueChange={(value) => updateBug(panelBug.id, { assigneeUserId: value === "unassigned" ? "" : value })}>
                    <SelectTrigger size="sm" className="w-fit gap-1.5 border-0 bg-transparent px-2 shadow-none hover:bg-accent">
                      {panelBug.assignee ? (
                        <Avatar className="size-4 rounded-none">
                          <AvatarImage src={panelBug.assignee.avatar_url ?? undefined} />
                          <AvatarFallback className="rounded-none text-[8px]">{initials(panelBug.assignee)}</AvatarFallback>
                        </Avatar>
                      ) : <User className="size-3.5" />}
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unassigned">Unassigned</SelectItem>
                      {owners.map((owner) => <SelectItem key={owner.id} value={owner.id}>{owner.full_name ?? owner.email}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>

                <p className="mt-4 whitespace-pre-wrap text-sm leading-6">
                  {panelBug.description || <span className="text-muted-foreground">No description.</span>}
                </p>

                <div className="mt-4 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
                  <span>{panelOrg?.name ?? "No org"}</span>
                  {panelProject && (<><span aria-hidden>·</span><span>{panelProject.name}</span></>)}
                  <span aria-hidden>·</span>
                  <span>Updated {formatDate(panelBug.updated_at)}</span>
                  {panelBug.attachment_names.length > 0 && (
                    <>
                      <span aria-hidden>·</span>
                      <span className="inline-flex items-center gap-1"><Paperclip className="size-3" />{panelBug.attachment_names.length}</span>
                    </>
                  )}
                </div>

                {panelBug.attachments.length > 0 && (
                  <div className="mt-5">
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Attachments ({panelBug.attachments.length})
                    </p>
                    <AttachmentGroup className="flex-col gap-2 overflow-visible py-0">
                      {panelBug.attachments.map((attachment) => {
                        const isImage = attachment.content_type?.startsWith("image/")
                        return (
                          <Attachment key={attachment.id} size="sm" className="w-full">
                            <AttachmentMedia variant={isImage ? "image" : "icon"}>
                              {isImage ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={attachment.download_url} alt="" />
                              ) : (
                                <FileText className="size-4" />
                              )}
                            </AttachmentMedia>
                            <AttachmentContent>
                              <AttachmentTitle>{attachment.file_name}</AttachmentTitle>
                              <AttachmentDescription>{formatFileSize(attachment.size_bytes ?? undefined)}</AttachmentDescription>
                            </AttachmentContent>
                            <AttachmentActions className="pr-1">
                              <AttachmentAction
                                type="button"
                                aria-label={`Open ${attachment.file_name}`}
                                onClick={() => setViewerAttachmentId(attachment.id)}
                              >
                                <ExternalLink className="size-3.5" />
                              </AttachmentAction>
                            </AttachmentActions>
                            <AttachmentTrigger
                              aria-label={`Open ${attachment.file_name}`}
                              onClick={() => setViewerAttachmentId(attachment.id)}
                            />
                          </Attachment>
                        )
                      })}
                    </AttachmentGroup>
                  </div>
                )}

                <div className="mt-6 border-t pt-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <Sparkles className="size-4 text-muted-foreground" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium">Codex review</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {panelReview ? getReviewStatusLabel(panelReview.status) : "No review yet"}
                        </p>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={panelReview ? "outline" : "default"}
                      onClick={() => startAiReview(panelBug.id)}
                      disabled={isPending || isAiRunning(panelReview?.status)}
                    >
                      {isPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                      {panelReview ? "Run again" : "Run review"}
                    </Button>
                  </div>

                  {panelReview && (
                    <div className="mt-3 space-y-3 border bg-muted/25 p-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <Badge variant={panelReview.status === "failed" ? "destructive" : "outline"}>
                          {getReviewStatusLabel(panelReview.status)}
                        </Badge>
                        <span>Updated {formatDate(panelReview.updated_at)}</span>
                        {panelReview.github_run_url && (
                          <a
                            href={panelReview.github_run_url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 hover:text-foreground"
                          >
                            GitHub run
                            <ExternalLink className="size-3" />
                          </a>
                        )}
                      </div>

                      {panelReview.error ? (
                        <p className="whitespace-pre-wrap text-destructive">{panelReview.error}</p>
                      ) : panelReview.summary ? (
                        <p className="whitespace-pre-wrap leading-6">{panelReview.summary}</p>
                      ) : (
                        <p className="text-muted-foreground">Codex is preparing a proposal.</p>
                      )}

                      <AiReviewProposal review={panelReview} />
                    </div>
                  )}
                </div>

                <div className="mt-4 border-t pt-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <GitPullRequest className="size-4 text-muted-foreground" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium">Codex fix PR</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {panelFix ? getFixStatusLabel(panelFix.status) : fixAllowed ? "No PR request yet" : "Move out of triage first"}
                        </p>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={panelFix ? "outline" : "default"}
                      onClick={() => startAiFix(panelBug.id)}
                      disabled={isPending || !fixAllowed || isAiRunning(panelFix?.status)}
                    >
                      {isPending ? <Loader2 className="size-4 animate-spin" /> : <GitPullRequest className="size-4" />}
                      {panelFix ? "Run again" : "Create PR"}
                    </Button>
                  </div>

                  {panelFix && (
                    <div className="mt-3 space-y-3 border bg-muted/25 p-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <Badge variant={panelFix.status === "failed" ? "destructive" : "outline"}>
                          {getFixStatusLabel(panelFix.status)}
                        </Badge>
                        <span>Updated {formatDate(panelFix.updated_at)}</span>
                        {panelFix.github_run_url && (
                          <a
                            href={panelFix.github_run_url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 hover:text-foreground"
                          >
                            GitHub run
                            <ExternalLink className="size-3" />
                          </a>
                        )}
                        {panelFix.pr_url && (
                          <a
                            href={panelFix.pr_url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 hover:text-foreground"
                          >
                            Pull request
                            <ExternalLink className="size-3" />
                          </a>
                        )}
                      </div>

                      {panelFix.error ? (
                        <p className="whitespace-pre-wrap text-destructive">{panelFix.error}</p>
                      ) : panelFix.summary ? (
                        <p className="whitespace-pre-wrap leading-6">{panelFix.summary}</p>
                      ) : (
                        <p className="text-muted-foreground">Codex is preparing a fix branch.</p>
                      )}

                      {panelFix.branch_name && (
                        <p className="text-xs text-muted-foreground">
                          Branch <code className="border bg-background px-1 py-0.5">{panelFix.branch_name}</code>
                        </p>
                      )}
                    </div>
                  )}
                </div>

                <div className="mt-6 border-t pt-4">
                  <div className="flex gap-2">
                    <Textarea
                      value={comment}
                      onChange={(event) => setComment(event.target.value)}
                      placeholder="Add a note…"
                      className="min-h-16 text-sm"
                    />
                    <Button
                      size="icon"
                      onClick={() => addComment(panelBug.id, comment, () => setComment(""))}
                      disabled={isPending || !comment.trim()}
                      aria-label="Add comment"
                    >
                      <Plus className="size-4" />
                    </Button>
                  </div>
                  <div className="mt-4 flex flex-col gap-4">
                    {panelEvents.map((event) => (
                      <div key={event.id} className="flex gap-3 text-sm">
                        <Avatar className="size-6 rounded-none">
                          <AvatarImage src={event.actor?.avatar_url ?? undefined} />
                          <AvatarFallback className="rounded-none text-[9px]">{initials(event.actor)}</AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <p className="text-muted-foreground">
                            <span className="font-medium text-foreground">{event.actor?.full_name ?? event.actor?.email ?? "Arc"}</span>{" "}
                            {eventText(event)}
                            <span className="ml-1 text-xs">· {formatDate(event.created_at)}</span>
                          </p>
                          {event.body && <p className="mt-1 whitespace-pre-wrap border-l pl-3 text-foreground/90">{event.body}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </aside>
      </div>

      <NewBugDialog
        open={showNew}
        onOpenChange={setShowNew}
        onSubmit={createBug}
        isPending={isPending}
        owners={owners}
        orgs={orgs}
        projects={newProjects}
        projectsLoading={projectsLoading}
        orgId={newOrgId}
        projectId={newProjectId}
        attachmentPreviews={attachmentPreviews}
        onOrgChange={handleNewOrgChange}
        onProjectChange={setNewProjectId}
        onAttachmentsChange={setAttachmentPreviews}
      />

      {fileViewer}
    </div>
  )
}

function NewBugDialog({
  open,
  onOpenChange,
  onSubmit,
  isPending,
  owners,
  orgs,
  projects,
  projectsLoading,
  orgId,
  projectId,
  attachmentPreviews,
  onOrgChange,
  onProjectChange,
  onAttachmentsChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (formData: FormData) => void
  isPending: boolean
  owners: PlatformBugPerson[]
  orgs: { id: string; name: string }[]
  projects: PlatformBugRef[]
  projectsLoading: boolean
  orgId: string
  projectId: string
  attachmentPreviews: AttachmentPreview[]
  onOrgChange: (value: string) => void
  onProjectChange: (value: string) => void
  onAttachmentsChange: (previews: AttachmentPreview[]) => void
}) {
  const orgSelected = orgId !== "none"
  const contextCount = (orgSelected ? 1 : 0) + (projectId !== "none" ? 1 : 0)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)

  const setAttachmentFiles = (files: File[]) => {
    const input = fileInputRef.current
    if (!input) return
    applyFilesToInput(input, files)
    onAttachmentsChange(previewsForFiles(files))
  }

  const handleDrop = (event: React.DragEvent) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    dragDepth.current = 0
    setDragActive(false)
    const input = fileInputRef.current
    if (!input) return
    const dropped = Array.from(event.dataTransfer.files).filter(isSupportedAttachment)
    if (dropped.length === 0) return
    setAttachmentFiles([...Array.from(input.files ?? []), ...dropped])
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="overflow-hidden p-0 sm:max-w-2xl">
        <form
          action={onSubmit}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault()
              event.currentTarget.requestSubmit()
            }
          }}
          onDragEnter={(event) => {
            if (!isFileDrag(event)) return
            event.preventDefault()
            dragDepth.current += 1
            setDragActive(true)
          }}
          onDragOver={(event) => {
            if (isFileDrag(event)) event.preventDefault()
          }}
          onDragLeave={(event) => {
            if (!isFileDrag(event)) return
            dragDepth.current -= 1
            if (dragDepth.current <= 0) {
              dragDepth.current = 0
              setDragActive(false)
            }
          }}
          onDrop={handleDrop}
          className="relative flex flex-col"
        >
          {/* The org/project selects live in a Popover that unmounts on close, so
              their own fields are gone by submit time. Carry the values here. */}
          <input type="hidden" name="orgId" value={orgId} />
          <input type="hidden" name="projectId" value={projectId} />

          {dragActive && (
            <div className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 border-2 border-dashed border-primary bg-background/90 text-sm font-medium">
              <Paperclip className="size-6 text-muted-foreground" />
              Drop images or PDFs to attach
            </div>
          )}
          <DialogHeader className="space-y-0 px-5 pt-5">
            <DialogTitle className="sr-only">New issue</DialogTitle>
            <DialogDescription className="sr-only">
              Report an Arc platform issue with a title, description, and optional organization or project context.
            </DialogDescription>
            <Input
              name="title"
              placeholder="Title"
              required
              autoFocus
              className="h-auto border-0 px-0 py-0 text-2xl font-semibold shadow-none focus-visible:ring-0 md:text-2xl"
            />
          </DialogHeader>

          <div className="px-5 pb-2 pt-2">
            <Textarea
              name="description"
              placeholder="Add a description…"
              className="min-h-28 resize-none border-0 px-0 text-sm shadow-none focus-visible:ring-0"
            />

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <PillSelect name="status" defaultValue="todo" icon={Circle} items={PLATFORM_BUG_STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] }))} />
              <PillSelect name="priority" defaultValue="medium" icon={Timer} items={PLATFORM_BUG_PRIORITIES.map((value) => ({ value, label: PRIORITY_LABELS[value] }))} />
              <PillSelect
                name="assigneeUserId"
                defaultValue="none"
                icon={User}
                items={[
                  { value: "none", label: "Unassigned" },
                  ...owners.map((owner) => ({ value: owner.id, label: owner.full_name ?? owner.email ?? "Owner" })),
                ]}
              />
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="relative size-9 bg-muted/50"
                    aria-label="Organization and project"
                  >
                    <MoreHorizontal className="size-4" />
                    {contextCount > 0 && (
                      <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center bg-primary text-[10px] font-medium text-primary-foreground">
                        {contextCount}
                      </span>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-72 space-y-3 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Context (optional)</p>
                  <div className="space-y-1.5">
                    <p className="text-xs text-muted-foreground">Organization</p>
                    <PillSelect
                      value={orgId}
                      onValueChange={onOrgChange}
                      icon={Building2}
                      className="w-full justify-start"
                      items={[
                        { value: "none", label: "No organization" },
                        ...orgs.map((org) => ({ value: org.id, label: org.name })),
                      ]}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-xs text-muted-foreground">Project</p>
                    <PillSelect
                      value={projectId}
                      onValueChange={onProjectChange}
                      icon={FolderOpen}
                      className="w-full justify-start"
                      disabled={!orgSelected || projectsLoading}
                      items={[
                        {
                          value: "none",
                          label: !orgSelected ? "Select an org first" : projectsLoading ? "Loading projects…" : "No project",
                        },
                        ...projects.map((project) => ({ value: project.id, label: project.name })),
                      ]}
                    />
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          </div>

          <DialogFooter className="items-center justify-between border-t px-5 py-3 sm:justify-between">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Button type="button" variant="outline" size="icon" asChild>
                <label aria-label="Attach images or PDFs">
                  <Paperclip className="size-4" />
                  <input
                    ref={fileInputRef}
                    type="file"
                    name="attachments"
                    multiple
                    accept="image/*,application/pdf,.pdf"
                    className="sr-only"
                    onChange={(event) => {
                      onAttachmentsChange(previewsForFiles(Array.from(event.target.files ?? [])))
                    }}
                  />
                </label>
              </Button>
              {attachmentPreviews.length > 0 && (
                <AttachmentGroup className="max-w-[390px] flex-1 gap-2">
                  {attachmentPreviews.map((preview, index) => {
                    const isPdf = isPdfPreview(preview)
                    return (
                      <Attachment
                        key={`${preview.name}-${index}`}
                        size="xs"
                        className="w-44"
                      >
                        {preview.url ? (
                          <AttachmentMedia variant={preview.type.startsWith("image/") ? "image" : "icon"}>
                            {preview.type.startsWith("image/") ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={preview.url} alt="" />
                            ) : (
                              <FileText className="size-4" />
                            )}
                          </AttachmentMedia>
                        ) : (
                          <AttachmentMedia variant="icon">
                            <FileText className="size-5" />
                          </AttachmentMedia>
                        )}
                        <AttachmentContent>
                          <AttachmentTitle>{preview.name}</AttachmentTitle>
                          <AttachmentDescription>{isPdf ? "PDF" : formatFileSize(preview.size)}</AttachmentDescription>
                        </AttachmentContent>
                        <AttachmentActions className="pr-0.5">
                          <AttachmentAction
                            type="button"
                            aria-label={`Remove ${preview.name}`}
                            onClick={() => {
                              const input = fileInputRef.current
                              const nextFiles = Array.from(input?.files ?? []).filter((_, fileIndex) => fileIndex !== index)
                              setAttachmentFiles(nextFiles)
                            }}
                          >
                            <X className="size-3" />
                          </AttachmentAction>
                        </AttachmentActions>
                      </Attachment>
                    )
                  })}
                </AttachmentGroup>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button disabled={isPending} className="gap-2">
                Submit
                <kbd className="inline-flex items-center rounded-none border border-primary-foreground/40 px-1.5 py-0.5 text-xs font-medium text-primary-foreground">⌘↵</kbd>
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function PillSelect({
  name,
  value,
  defaultValue,
  onValueChange,
  icon: Icon,
  items,
  className,
  disabled,
  placeholder,
}: {
  name?: string
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  icon: React.ComponentType<{ className?: string }>
  items: { value: string; label: string }[]
  className?: string
  disabled?: boolean
  placeholder?: string
}) {
  return (
    <Select name={name} value={value} defaultValue={defaultValue} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger className={cn("w-fit justify-start rounded-none bg-muted/50 px-3", className)}>
        <Icon className="size-4" />
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
