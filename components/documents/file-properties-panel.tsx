"use client"

import {
  Activity,
  CheckCircle2,
  Clock,
  Download,
  Eye,
  FileSignature,
  FolderInput,
  HardHat,
  Info,
  Lock,
  Pencil,
  RefreshCw,
  Share2,
  Trash2,
  Upload,
  Users,
  History,
  X,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
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

function statusLabel(status?: string | null) {
  return status ? status.replace(/_/g, " ") : null
}

function WorkflowBadge({
  value,
  type,
}: {
  value?: string | null
  type: "approval" | "signature"
}) {
  const label = statusLabel(value)
  if (!label) return null

  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 px-1.5 text-[11px] font-normal capitalize",
        (value === "approved" || value === "signed") &&
          "border-emerald-200 bg-emerald-50 text-emerald-600 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-400",
        (value === "in_review" || value === "sent") &&
          "border-blue-200 bg-blue-50 text-blue-600 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-400",
        (value === "submitted" || value === "draft") &&
          "border-amber-200 bg-amber-50 text-amber-600 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-400",
        (value === "rejected" || value === "resubmit_required") &&
          "border-rose-200 bg-rose-50 text-rose-600 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-400",
      )}
    >
      {type === "signature" ? <FileSignature className="mr-1 h-3 w-3" /> : <CheckCircle2 className="mr-1 h-3 w-3" />}
      {label}
    </Badge>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-foreground">{value}</span>
    </div>
  )
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

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Info className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">Properties</span>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose} aria-label="Close properties">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted">
            <Icon className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="break-words text-sm font-semibold leading-5">{file.file_name}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{formatFileSize(file.size_bytes)}</p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <Button size="sm" onClick={() => onPreview(file.id)}>
            <Eye className="mr-2 h-4 w-4" />
            Preview
          </Button>
          <Button size="sm" variant="outline" onClick={() => onDownload(file)}>
            <Download className="mr-2 h-4 w-4" />
            Download
          </Button>
          {file.mime_type === "application/pdf" && (
            <Button size="sm" variant="outline" onClick={() => onSendForSignature(file.id)}>
              <FileSignature className="mr-2 h-4 w-4" />
              Sign
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => onSendForApproval(file.id)}>
            <Upload className="mr-2 h-4 w-4" />
            Submit
          </Button>
        </div>

        <Separator className="my-4" />

        <div className="space-y-3">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground">Details</h3>
          <DetailRow label="Category" value={categoryLabel} />
          <DetailRow label="Type" value={file.mime_type ?? "Unknown"} />
          <DetailRow label="Uploaded by" value={file.uploader_name ?? "-"} />
          <DetailRow label="Uploaded" value={formatDateTime(file.created_at)} />
          <DetailRow label="Modified" value={formatDateTime(file.updated_at ?? file.created_at)} />
          {file.version_number ? (
            <DetailRow label="Version" value={file.is_current === false ? `v${file.version_number} (superseded)` : `v${file.version_number}`} />
          ) : null}
        </div>

        <Separator className="my-4" />

        <div className="space-y-3">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground">Workflow</h3>
          <div className="flex flex-wrap gap-1.5">
            <WorkflowBadge value={file.status} type="approval" />
            <WorkflowBadge value={file.signature_status} type="signature" />
            {!file.status && !file.signature_status ? (
              <span className="text-sm text-muted-foreground">No active workflow</span>
            ) : null}
          </div>
        </div>

        <Separator className="my-4" />

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-xs font-semibold uppercase text-muted-foreground">Sharing</h3>
              <p className="mt-1 text-xs text-muted-foreground">{accessSummary}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => onShare(file.id)}>
              <Share2 className="mr-2 h-4 w-4" />
              Manage
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {!isShared ? (
              <Badge variant="secondary" className="h-5 px-1.5 text-[11px] font-normal text-muted-foreground">
                <Lock className="mr-1 h-3 w-3" />
                Private
              </Badge>
            ) : null}
            {file.share_with_clients ? (
              <Badge variant="outline" className="h-5 border-blue-200 bg-blue-50 px-1.5 text-[11px] font-normal text-blue-600 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-400">
                <Users className="mr-1 h-3 w-3" />
                Clients
              </Badge>
            ) : null}
            {file.share_with_subs ? (
              <Badge variant="outline" className="h-5 border-indigo-200 bg-indigo-50 px-1.5 text-[11px] font-normal text-indigo-600 dark:border-indigo-900 dark:bg-indigo-950/30 dark:text-indigo-400">
                <HardHat className="mr-1 h-3 w-3" />
                Subs
              </Badge>
            ) : null}
          </div>
        </div>

        <Separator className="my-4" />

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-xs font-semibold uppercase text-muted-foreground">Versions</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Keep the file history intact while replacing the current file.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => onUploadNewVersion(file.id)}>
              <History className="mr-2 h-4 w-4" />
              New version
            </Button>
          </div>
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">
                  Current version {file.version_number ? `v${file.version_number}` : "v1"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {file.is_current === false ? "Superseded revision" : "Latest revision"} • Updated{" "}
                  {formatDateTime(file.updated_at ?? file.created_at)}
                </p>
              </div>
              {file.version_number ? (
                <Badge variant="outline" className="h-5 px-1.5 text-[11px] font-normal">
                  v{file.version_number}
                </Badge>
              ) : null}
            </div>
          </div>
        </div>

        <Separator className="my-4" />

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-xs font-semibold uppercase text-muted-foreground">Activity</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Recent access, version, and workflow events.
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => onRefreshTimeline(file.id)}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
          {timelineLoading ? (
            <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
              Loading activity…
            </div>
          ) : timelineEvents.length === 0 ? (
            <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
              No activity yet.
            </div>
          ) : (
            <div className="space-y-2">
              {timelineEvents.slice(0, 8).map((event) => (
                <div key={event.id} className="rounded-md border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="capitalize">
                          {event.action.replace(/_/g, " ")}
                        </Badge>
                        <span className="text-xs text-muted-foreground uppercase tracking-[0.08em]">
                          {event.source}
                        </span>
                      </div>
                      {(event.actor_name || event.actor_email) && (
                        <p className="truncate text-sm text-muted-foreground">
                          {event.actor_name ?? "System"}
                          {event.actor_email ? ` • ${event.actor_email}` : ""}
                        </p>
                      )}
                      {event.details ? <p className="text-sm">{event.details}</p> : null}
                    </div>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {formatDateTime(event.created_at)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <Separator className="my-4" />

        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground">Actions</h3>
          <div className="grid gap-1">
            <Button variant="ghost" size="sm" className="justify-start" onClick={() => onRename(file.id)}>
              <Pencil className="mr-2 h-4 w-4" />
              Rename
            </Button>
            <Button variant="ghost" size="sm" className="justify-start" onClick={() => onMove(file.id)}>
              <FolderInput className="mr-2 h-4 w-4" />
              Move
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="justify-start text-destructive hover:text-destructive"
              onClick={() => onDelete(file.id)}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
