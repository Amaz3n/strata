"use client"

import { useRouter } from "next/navigation"
import {
  Download,
  Eye,
  FileSignature,
  FolderInput,
  Info,
  Link2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Share2,
  Trash2,
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
import type { FileTimelineEvent, FileWithUrls } from "@/app/(app)/documents/types"
import { cn } from "@/lib/utils"
import { FileThumbnail } from "./file-type-icon"
import {
  FileSharingBadges,
  FileSignatureBadge,
  FileStatusBadge,
  getPrimarySourceContext,
} from "./file-badges"
import { formatDate, formatDateTime, formatFileSize } from "./format"
import { useProductTerminology } from "@/components/layout/use-product-terminology"
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
  versions?: FilePropertyVersion[]
  onDownloadVersion?: (versionId: string) => void
  timelineEvents: FileTimelineEvent[]
  timelineLoading: boolean
  onRefreshTimeline: (fileId: string) => void
  onSendForSignature: (fileId: string) => void
  onDelete: (fileId: string) => void
}

interface FilePropertyVersion {
  id: string
  version_number: number
  label?: string
  notes?: string
  file_name?: string
  size_bytes?: number
  creator_name?: string
  created_at: string
  is_current: boolean
}

function statusLabel(status?: string | null) {
  return status ? status.replace(/_/g, " ") : null
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="microlabel">{label}</span>
      <span className="truncate text-[13px] font-medium leading-snug text-foreground">
        {value || "-"}
      </span>
    </div>
  )
}

function formatSourceType(type?: string) {
  if (!type || type === "manual_upload") return "Manual upload"
  if (type === "executed_signature") return "Executed signature"
  return type.replaceAll("_", " ")
}

function getSourceBadgeClass(type?: string) {
  switch (type) {
    case "drawing_set":
    case "drawing_sheet":
      return "border-chart-1/30 bg-chart-1/10 text-chart-1"
    case "submittal":
      return "border-warning/30 bg-warning/10 text-warning"
    case "signature_document":
    case "executed_signature":
      return "border-success/30 bg-success/10 text-success"
    case "rfi":
    case "change_order":
      return "border-chart-2/30 bg-chart-2/10 text-chart-2"
    default:
      return "border-border bg-muted/40 text-muted-foreground"
  }
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
  versions = [],
  onDownloadVersion,
  timelineEvents,
  timelineLoading,
  onRefreshTimeline,
  onSendForSignature,
  onDelete,
}: FilePropertiesPanelProps) {
  const router = useRouter()
  const terms = useProductTerminology()

  if (!file) return null

  const categoryLabel = file.category
    ? QUICK_FILTER_CONFIG[file.category as keyof typeof QUICK_FILTER_CONFIG]?.label ?? file.category
    : "-"
  const isShared = file.share_with_clients || file.share_with_subs
  const accessSummary = !isShared
    ? "Only internal team members can access this file."
    : [
        file.share_with_clients ? terms.ownerPortal : null,
        file.share_with_subs ? "Subcontractor portal" : null,
      ]
        .filter(Boolean)
        .join(" and ")
  const hasStatus = Boolean(file.status || file.signature_status)
  const isPdf = file.mime_type === "application/pdf"
  const workflowSummary = statusLabel(file.signature_status ?? file.status)
  const sourceContexts = file.source_contexts ?? []
  const primarySource = getPrimarySourceContext(file)
  const visibleVersions = versions.length > 0
    ? versions
    : [{
        id: "",
        version_number: file.version_number ?? 1,
        file_name: file.file_name,
        size_bytes: file.size_bytes ?? undefined,
        created_at: file.updated_at ?? file.created_at,
        is_current: true,
      }]

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center justify-between border-b bg-muted/30 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Info className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-semibold tracking-tight">Properties</span>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose} aria-label="Close properties">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 pb-4 pt-4">
          <div className="flex items-start gap-3">
            <FileThumbnail
              fileName={file.file_name}
              mimeType={file.mime_type}
              thumbnailUrl={file.thumbnail_url}
              className="h-11 w-11"
              iconClassName="h-5 w-5"
            />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="space-y-1">
                <h2 className="break-words text-base font-semibold leading-tight tracking-tight">{file.file_name}</h2>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-muted-foreground">
                  <span>{formatFileSize(file.size_bytes)}</span>
                </div>
              </div>
              {hasStatus ? (
                <div className="flex flex-wrap gap-2">
                  <FileStatusBadge status={file.status} scale="md" />
                  <FileSignatureBadge status={file.signature_status} scale="md" />
                </div>
              ) : null}
            </div>
          </div>

          <div className="mt-4 flex items-center gap-2">
            <Button size="sm" className="h-9 min-w-0 flex-1" onClick={() => onPreview(file.id)}>
              <Eye className="mr-2 h-4 w-4" />
              Preview
            </Button>
            <Button size="sm" variant="outline" className="h-9 min-w-0 flex-1" onClick={() => onDownload(file)}>
              <Download className="mr-2 h-4 w-4" />
              Download
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="outline" className="h-9 w-9 shrink-0" aria-label="More actions">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {isPdf ? (
                  <DropdownMenuItem onSelect={() => onSendForSignature(file.id)}>
                    <FileSignature className="mr-2.5 h-4 w-4 text-muted-foreground" />
                    Send for signature
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem onSelect={() => onUploadNewVersion(file.id)}>
                  <History className="mr-2.5 h-4 w-4 text-muted-foreground" />
                  Upload new version
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onRename(file.id)}>
                  <Pencil className="mr-2.5 h-4 w-4 text-muted-foreground" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onMove(file.id)}>
                  <FolderInput className="mr-2.5 h-4 w-4 text-muted-foreground" />
                  Move
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onShare(file.id)}>
                  <Share2 className="mr-2.5 h-4 w-4 text-muted-foreground" />
                  Share
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => onDelete(file.id)}
                  className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                >
                  <Trash2 className="mr-2.5 h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="border-t px-4 py-4">
          <SectionLabel>Details</SectionLabel>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
            <DetailRow label="Category" value={categoryLabel} />
            <DetailRow label="Status" value={workflowSummary ? <span className="capitalize">{workflowSummary}</span> : null} />
            <DetailRow label="Uploaded by" value={file.uploader_name} />
            <DetailRow label="Uploaded" value={formatDate(file.created_at)} />
            <DetailRow label="Modified" value={formatDate(file.updated_at ?? file.created_at)} />
            <DetailRow label="Version" value={file.version_number ? `v${file.version_number}` : null} />
          </div>
          <div className="mt-4 border bg-card p-4">
            {primarySource ? (
              <>
                <div className="min-w-0 space-y-2">
                  <Badge
                    variant="outline"
                    className={cn(
                      "max-w-full justify-start gap-1.5 px-2 py-0.5 text-xs font-medium capitalize",
                      getSourceBadgeClass(primarySource.type),
                    )}
                  >
                    <span className="truncate">{formatSourceType(primarySource.type)}</span>
                  </Badge>
                  <p className="break-words text-sm font-medium leading-snug text-foreground">
                    {primarySource.label}
                  </p>
                  {sourceContexts.length > 1 ? (
                    <p className="text-xs text-muted-foreground">
                      Linked to {sourceContexts.length} workflow records.
                    </p>
                  ) : null}
                </div>
                {primarySource.href ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-4 w-full"
                    onClick={() => router.push(primarySource.href!)}
                  >
                    <Link2 className="mr-2 h-4 w-4 text-muted-foreground" />
                    {primarySource.primary_action_label ?? "Open source"}
                  </Button>
                ) : null}
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-foreground">Manual upload</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  This file is not linked to a source workflow record.
                </p>
              </>
            )}
          </div>
        </div>

        <Accordion type="multiple" className="border-t">
          <AccordionItem value="sharing" className="border-b-0 px-1">
            <AccordionTrigger className="px-4 py-4 hover:no-underline">
              <div className="flex flex-1 items-center justify-between gap-3 pr-2">
                <SectionLabel>Sharing</SectionLabel>
                <div className="flex items-center gap-2">
                  <FileSharingBadges
                    clients={file.share_with_clients}
                    subs={file.share_with_subs}
                    clientsLabel={terms.owners}
                    scale="md"
                  />
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="px-4 pb-4">
              <div className="border bg-card p-4">
                <p className="text-sm text-muted-foreground">{accessSummary}</p>
                <Button variant="secondary" size="sm" className="mt-4 w-full" onClick={() => onShare(file.id)}>
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
                  {visibleVersions.length} version{visibleVersions.length === 1 ? "" : "s"}
                </Badge>
              </div>
            </AccordionTrigger>
            <AccordionContent className="px-4 pb-4">
              <div className="border bg-card">
                <div className="divide-y">
                  {visibleVersions.map((version) => (
                    <div key={version.id} className="flex items-center gap-3 p-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center bg-muted text-xs font-semibold tabular-nums">
                        v{version.version_number}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <p className="truncate text-sm font-medium">
                            {version.label || version.file_name || `Version ${version.version_number}`}
                          </p>
                          {version.is_current ? (
                            <Badge variant="secondary" className="h-5 shrink-0 px-1.5 text-[10px]">
                              Current
                            </Badge>
                          ) : null}
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {version.creator_name ?? "Unknown"} · {formatDate(version.created_at)}
                          {version.size_bytes ? ` · ${formatFileSize(version.size_bytes)}` : ""}
                        </p>
                        {version.notes ? (
                          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{version.notes}</p>
                        ) : null}
                      </div>
                      {onDownloadVersion && version.id ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          onClick={() => onDownloadVersion(version.id)}
                          aria-label={`Download version ${version.version_number}`}
                        >
                          <Download className="h-4 w-4" />
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  className="m-3 mt-2 w-[calc(100%-1.5rem)]"
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
                <p className="text-xs text-muted-foreground">Access, version, and workflow events.</p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2"
                  onClick={() => onRefreshTimeline(file.id)}
                >
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  Refresh
                </Button>
              </div>
              {timelineLoading ? (
                <div className="flex items-center justify-center border bg-card py-7">
                  <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : timelineEvents.length === 0 ? (
                <div className="flex flex-col items-center justify-center border bg-card py-7 text-center">
                  <History className="mb-2 h-8 w-8 text-muted-foreground/50" />
                  <p className="text-sm font-medium text-muted-foreground">No activity yet.</p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {timelineEvents.slice(0, 8).map((event) => (
                    <div key={event.id} className="relative flex flex-col gap-1.5 border bg-card p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary" className="h-5 px-1.5 text-[11px] font-semibold uppercase tracking-wider text-foreground">
                            {event.action.replace(/_/g, " ")}
                          </Badge>
                        </div>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {formatDateTime(event.created_at)}
                        </span>
                      </div>
                      <div className="space-y-0.5">
                        {(event.actor_name || event.actor_email) && (
                          <p className="truncate text-sm font-medium text-foreground">
                            {event.actor_name ?? "System"}
                            {event.actor_email ? <span className="font-normal text-muted-foreground"> · {event.actor_email}</span> : ""}
                          </p>
                        )}
                        <span className="microlabel">Via {event.source}</span>
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
