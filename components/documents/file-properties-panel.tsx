"use client"

import {
  CheckCircle2,
  Download,
  Eye,
  FileSignature,
  FolderInput,
  HardHat,
  Info,
  Lock,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Share2,
  Trash2,
  Upload,
  Users,
  History,
  X,
} from "lucide-react"

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { FileTimelineEvent, FileWithUrls } from "@/app/(app)/documents/actions"
import { cn } from "@/lib/utils"
import { formatFileSize, getFileIcon } from "./documents-table"
import { QUICK_FILTER_CONFIG } from "./types"

interface FilePropertiesPanelProps {
  file: FileWithUrls | null
  onClose: () => void
  onPreview: (fileId: string) => void
  onDownload: (file: FileWithUrls) => void
  onRename: (fileId: string) => void
  onMove: (fileId: string) => void
  onShare: (fileId: string) => void
  onUploadNewVersion: (fileId: string) => void
  timelineEvents: FileTimelineEvent[]
  timelineLoading: boolean
  onRefreshTimeline: (fileId: string) => void
  onSendForSignature: (fileId: string) => void
  onSendForApproval: (fileId: string) => void
  onDelete: (fileId: string) => void
}

function formatDateTime(value?: string | null) {
  if (!value) return "-"
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

function formatDate(value?: string | null) {
  if (!value) return "-"
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value))
}

function statusLabel(status?: string | null) {
  return status ? status.replace(/_/g, " ") : null
}

function StatusPill({
  value,
  type,
}: {
  value?: string | null
  type: "approval" | "signature"
}) {
  const label = statusLabel(value)
  if (!label || value === "draft") return null

  return (
    <Badge
      variant="outline"
      className={cn(
        "h-6 px-2.5 text-xs font-medium capitalize shadow-sm",
        (value === "approved" || value === "signed") &&
          "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-400",
        (value === "in_review" || value === "sent") &&
          "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-400",
        (value === "submitted" || value === "draft") &&
          "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-400",
        (value === "rejected" || value === "resubmit_required") &&
          "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-400",
      )}
    >
      {type === "signature" ? (
        <FileSignature className="mr-1.5 h-3.5 w-3.5" />
      ) : (
        <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
      )}
      {label}
    </Badge>
  )
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border bg-card p-2.5 shadow-sm transition-colors hover:bg-accent/50">
      <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
      <span className="truncate text-[13px] font-semibold leading-snug text-foreground">{value}</span>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-sm font-semibold tracking-tight text-foreground">{children}</span>
}

export function FilePropertiesPanel({
  file,
  onClose,
  onPreview,
  onDownload,
  onRename,
  onMove,
  onShare,
  onUploadNewVersion,
  timelineEvents,
  timelineLoading,
  onRefreshTimeline,
  onSendForSignature,
  onSendForApproval,
  onDelete,
}: FilePropertiesPanelProps) {
  if (!file) return null

  const Icon = getFileIcon(file.mime_type ?? undefined)
  const categoryLabel = file.category
    ? QUICK_FILTER_CONFIG[file.category as keyof typeof QUICK_FILTER_CONFIG]?.label ?? file.category
    : "-"
  const isShared = file.share_with_clients || file.share_with_subs
  const accessSummary = !isShared
    ? "Only internal team members can access this file."
    : [
        file.share_with_clients ? "Client portal" : null,
        file.share_with_subs ? "Subcontractor portal" : null,
      ]
        .filter(Boolean)
        .join(" and ")
  const hasStatus = Boolean(file.status || file.signature_status)
  const isPdf = file.mime_type === "application/pdf"
  const workflowSummary = statusLabel(file.signature_status ?? file.status)

  return (
    <div className="flex h-full flex-col bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-10 shrink-0 items-center justify-between border-b px-4 bg-muted/30">
        <div className="flex min-w-0 items-center gap-2">
          <Info className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-semibold tracking-tight">Properties</span>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full hover:bg-muted" onClick={onClose} aria-label="Close properties">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 pb-4 pt-4">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 shadow-sm ring-1 ring-primary/20">
              <Icon className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <div className="space-y-1">
                <h2 className="break-words text-base font-bold leading-tight tracking-tight">{file.file_name}</h2>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium text-muted-foreground">
                  <span>{formatFileSize(file.size_bytes)}</span>
                </div>
              </div>
              {hasStatus ? (
                <div className="flex flex-wrap gap-2">
                  <StatusPill value={file.status} type="approval" />
                  <StatusPill value={file.signature_status} type="signature" />
                </div>
              ) : null}
            </div>
          </div>

          <div className="mt-4 flex items-center gap-2">
            <Button size="sm" className="h-9 min-w-0 flex-1 shadow-sm" onClick={() => onPreview(file.id)}>
              <Eye className="mr-2 h-4 w-4" />
              Preview
            </Button>
            <Button size="sm" variant="outline" className="h-9 min-w-0 flex-1 bg-background shadow-sm hover:bg-muted" onClick={() => onDownload(file)}>
              <Download className="mr-2 h-4 w-4" />
              Download
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="outline" className="h-9 w-9 shrink-0 shadow-sm bg-background hover:bg-muted" aria-label="More actions">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 rounded-xl">
                {isPdf ? (
                  <DropdownMenuItem onSelect={() => onSendForSignature(file.id)} className="py-2.5">
                    <FileSignature className="mr-2.5 h-4 w-4 text-muted-foreground" />
                    Send for signature
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem onSelect={() => onSendForApproval(file.id)} className="py-2.5">
                  <Upload className="mr-2.5 h-4 w-4 text-muted-foreground" />
                  Submit for approval
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onUploadNewVersion(file.id)} className="py-2.5">
                  <History className="mr-2.5 h-4 w-4 text-muted-foreground" />
                  Upload new version
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onRename(file.id)} className="py-2.5">
                  <Pencil className="mr-2.5 h-4 w-4 text-muted-foreground" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onMove(file.id)} className="py-2.5">
                  <FolderInput className="mr-2.5 h-4 w-4 text-muted-foreground" />
                  Move
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onShare(file.id)} className="py-2.5">
                  <Share2 className="mr-2.5 h-4 w-4 text-muted-foreground" />
                  Share
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => onDelete(file.id)}
                  className="py-2.5 text-destructive focus:bg-destructive/10 focus:text-destructive"
                >
                  <Trash2 className="mr-2.5 h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="border-t bg-muted/10 px-4 py-4">
          <SectionLabel>Details</SectionLabel>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <DetailRow label="Category" value={categoryLabel} />
            <DetailRow label="Status" value={workflowSummary ? <span className="capitalize">{workflowSummary}</span> : "-"} />
            <DetailRow label="Uploaded by" value={file.uploader_name ?? "-"} />
            <DetailRow label="Uploaded" value={formatDate(file.created_at)} />
            <DetailRow label="Modified" value={formatDate(file.updated_at ?? file.created_at)} />
            <DetailRow label="Version" value={file.version_number ? `v${file.version_number}` : "-"} />
          </div>
        </div>

        <Accordion type="multiple" className="border-t">
          <AccordionItem value="sharing" className="border-b-0 px-1">
            <AccordionTrigger className="px-4 py-4 hover:no-underline">
              <div className="flex flex-1 items-center justify-between gap-3 pr-2">
                <SectionLabel>Sharing</SectionLabel>
                <div className="flex items-center gap-2">
                  {!isShared ? (
                    <Badge variant="secondary" className="h-6 px-2 text-xs font-medium text-muted-foreground">
                      <Lock className="mr-1.5 h-3 w-3" />
                      Private
                    </Badge>
                  ) : null}
                  {file.share_with_clients ? (
                    <Badge
                      variant="outline"
                      className="h-6 border-blue-200 bg-blue-50 px-2 text-xs font-medium text-blue-700 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-400"
                    >
                      <Users className="mr-1.5 h-3 w-3" />
                      Clients
                    </Badge>
                  ) : null}
                  {file.share_with_subs ? (
                    <Badge
                      variant="outline"
                      className="h-6 border-indigo-200 bg-indigo-50 px-2 text-xs font-medium text-indigo-700 dark:border-indigo-900 dark:bg-indigo-950/30 dark:text-indigo-400"
                    >
                      <HardHat className="mr-1.5 h-3 w-3" />
                      Subs
                    </Badge>
                  ) : null}
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="px-4 pb-4">
              <div className="rounded-xl border bg-card p-4 shadow-sm">
                <p className="text-sm text-muted-foreground">{accessSummary}</p>
                <Button variant="secondary" size="sm" className="mt-4 w-full shadow-sm" onClick={() => onShare(file.id)}>
                  <Share2 className="mr-2 h-4 w-4 text-muted-foreground" />
                  Manage sharing settings
                </Button>
              </div>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="versions" className="border-b-0 border-t px-1">
            <AccordionTrigger className="px-4 py-4 hover:no-underline">
              <div className="flex flex-1 items-center justify-between gap-3 pr-2">
                <SectionLabel>Versions</SectionLabel>
                <Badge variant="secondary" className="h-6 px-2 text-xs font-medium">
                  v{file.version_number ?? 1}
                </Badge>
              </div>
            </AccordionTrigger>
            <AccordionContent className="px-4 pb-4">
              <div className="rounded-xl border bg-card p-4 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold">
                      Current version v{file.version_number ?? 1}
                    </p>
                    <p className="mt-1 text-xs font-medium text-muted-foreground">
                      {file.is_current === false ? "Superseded revision" : "Latest revision"}
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground">{formatDateTime(file.updated_at ?? file.created_at)}</span>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-4 w-full shadow-sm"
                  onClick={() => onUploadNewVersion(file.id)}
                >
                  <History className="mr-2 h-4 w-4 text-muted-foreground" />
                  Upload new version
                </Button>
              </div>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="activity" className="border-b-0 border-t px-1">
            <AccordionTrigger className="px-4 py-4 hover:no-underline">
              <div className="flex flex-1 items-center justify-between gap-3 pr-2">
                <SectionLabel>Activity</SectionLabel>
                {timelineEvents.length > 0 ? (
                  <Badge variant="secondary" className="h-6 px-2 text-xs font-medium">
                    {timelineEvents.length} events
                  </Badge>
                ) : null}
              </div>
            </AccordionTrigger>
            <AccordionContent className="px-4 pb-4">
              <div className="mb-3 flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground">Access, version, and workflow events.</p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 hover:bg-muted"
                  onClick={() => onRefreshTimeline(file.id)}
                >
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  Refresh
                </Button>
              </div>
              {timelineLoading ? (
                <div className="flex items-center justify-center rounded-xl border bg-card py-7 shadow-sm">
                  <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : timelineEvents.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-xl border bg-card py-7 text-center shadow-sm">
                  <History className="mb-2 h-8 w-8 text-muted-foreground/50" />
                  <p className="text-sm font-medium text-muted-foreground">No activity yet.</p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {timelineEvents.slice(0, 8).map((event) => (
                    <div key={event.id} className="relative flex flex-col gap-1.5 rounded-xl border bg-card p-3 shadow-sm transition-colors hover:bg-accent/50">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary" className="h-5 px-1.5 text-[11px] font-semibold uppercase tracking-wider text-foreground">
                            {event.action.replace(/_/g, " ")}
                          </Badge>
                        </div>
                        <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
                          {formatDateTime(event.created_at)}
                        </span>
                      </div>
                      <div className="space-y-0.5">
                        {(event.actor_name || event.actor_email) && (
                          <p className="truncate text-sm font-medium text-foreground">
                            {event.actor_name ?? "System"}
                            {event.actor_email ? <span className="text-muted-foreground font-normal"> · {event.actor_email}</span> : ""}
                          </p>
                        )}
                        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                          Via {event.source}
                        </span>
                        {event.details ? <p className="mt-1 text-sm text-muted-foreground">{event.details}</p> : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </div>
  )
}
