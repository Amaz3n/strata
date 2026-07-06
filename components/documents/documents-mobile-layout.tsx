"use client"

import { useMemo, useState } from "react"
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Clock,
  Download,
  Eye,
  FilePlus2,
  FileSignature,
  FolderInput,
  FolderOpen,
  FolderPlus,
  HardHat,
  Info,
  Lock,
  MoreVertical,
  Pencil,
  Plus,
  Search,
  Share2,
  Trash2,
  Undo2,
  Upload,
  Users,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import type { FileTimelineEvent, FileWithUrls } from "@/app/(app)/documents/types"
import { useDocuments, buildFolderTree } from "./documents-context"
import { FilePropertiesPanel } from "./file-properties-panel"
import { getFileIcon, formatFileSize, formatDate } from "./documents-table"
import { QUICK_FILTER_CONFIG, type QuickFilter } from "./types"

interface DocumentsMobileLayoutProps {
  onFileClick: (fileId: string) => void
  onDownloadFile: (fileId: string) => void
  onUploadClick: () => void
  onCreateFolderClick: () => void
  onRenameFile: (fileId: string) => void
  onMoveFile: (fileId: string) => void
  onDeleteFile: (fileId: string) => void
  onRestoreFile?: (fileId: string) => void
  onViewActivity: (fileId: string) => void
  onShareFile: (fileId: string) => void
  onUploadNewVersion: (fileId: string) => void
  onSendForSignature?: (fileId: string) => void
  onOpenProperties: (fileId: string) => void
  // Properties drawer
  propertiesFile: FileWithUrls | null
  onCloseProperties: () => void
  onDownloadFromProperties: (file: FileWithUrls) => void
  propertiesVersions?: Array<{
    id: string
    version_number: number
    label?: string
    notes?: string
    file_name?: string
    size_bytes?: number
    creator_name?: string
    created_at: string
    is_current: boolean
  }>
  onDownloadVersion?: (versionId: string) => void
  propertiesTimelineEvents: FileTimelineEvent[]
  propertiesTimelineLoading: boolean
  onRefreshTimeline: (fileId: string) => void
}

function categoryLabel(category?: string | null): string | null {
  if (!category) return null
  return QUICK_FILTER_CONFIG[category as QuickFilter]?.label ?? category
}

const FILTER_CHIPS = (Object.entries(QUICK_FILTER_CONFIG) as [QuickFilter, { label: string }][])
  .filter(([key]) => key !== "drawings")

export function DocumentsMobileLayout({
  onFileClick,
  onDownloadFile,
  onUploadClick,
  onCreateFolderClick,
  onRenameFile,
  onMoveFile,
  onDeleteFile,
  onRestoreFile,
  onViewActivity,
  onShareFile,
  onUploadNewVersion,
  onSendForSignature,
  onOpenProperties,
  propertiesFile,
  onCloseProperties,
  onDownloadFromProperties,
  propertiesVersions = [],
  onDownloadVersion,
  propertiesTimelineEvents,
  propertiesTimelineLoading,
  onRefreshTimeline,
}: DocumentsMobileLayoutProps) {
  const {
    files,
    folders,
    folderItemCounts,
    currentPath,
    setCurrentPath,
    searchQuery,
    setSearchQuery,
    quickFilter,
    setQuickFilter,
    isLoading,
    isLoadingMore,
    hasMore,
    loadMore,
  } = useDocuments()

  const [newOpen, setNewOpen] = useState(false)
  const [actionsFile, setActionsFile] = useState<FileWithUrls | null>(null)

  const folderTree = useMemo(
    () => buildFolderTree(folders, files, folderItemCounts),
    [folders, files, folderItemCounts]
  )

  const currentFolders = useMemo(() => {
    const toItem = (node: { path: string; name: string; itemCount: number }) => ({
      path: node.path,
      name: node.name,
      itemCount: node.itemCount,
    })

    if (!currentPath) {
      return folderTree.map(toItem)
    }

    const findNode = (
      nodes: typeof folderTree,
      target: string,
    ): (typeof folderTree)[number] | null => {
      for (const node of nodes) {
        if (node.path === target) return node
        const found = findNode(node.children, target)
        if (found) return found
      }
      return null
    }

    const node = findNode(folderTree, currentPath)
    return node ? node.children.map(toItem) : []
  }, [folderTree, currentPath])

  const filteredFiles = useMemo(() => {
    let result = files
    if (currentPath && !searchQuery) {
      const normalizedPath = currentPath.replace(/\/+/g, "/")
      result = result.filter((file) => {
        const filePath = file.folder_path
          ? file.folder_path.startsWith("/")
            ? file.folder_path
            : `/${file.folder_path}`
          : ""
        return filePath === normalizedPath
      })
    } else if (!currentPath && !searchQuery && quickFilter === "all") {
      result = result.filter((file) => !file.folder_path || file.folder_path === "/")
    }
    return result
  }, [files, currentPath, searchQuery, quickFilter])

  const showFolders = quickFilter === "all" && (!searchQuery || Boolean(currentPath))
  const visibleFolderCount = showFolders ? currentFolders.length : 0
  const hasFilters = quickFilter !== "all" || Boolean(searchQuery) || Boolean(currentPath)

  const goUp = () => {
    const parts = currentPath.split("/").filter(Boolean)
    parts.pop()
    setCurrentPath(parts.length ? `/${parts.join("/")}` : "")
  }

  const isEmpty =
    !isLoading &&
    visibleFolderCount === 0 &&
    filteredFiles.length === 0

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="sticky top-0 z-10 shrink-0 border-b bg-background/95 backdrop-blur-sm">
        <div className="flex items-center gap-2 px-3 pt-3">
          {currentPath ? (
            <button
              type="button"
              onClick={goUp}
              aria-label="Go up one folder"
              className="-ml-1 flex h-10 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground active:bg-muted"
            >
              <ChevronRight className="h-5 w-5 rotate-180" />
            </button>
          ) : null}
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search documents..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-10 pl-9 pr-9 text-sm"
              inputMode="search"
            />
            {searchQuery ? (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground active:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>
          <Button
            size="icon"
            className="h-10 w-10 shrink-0"
            onClick={() => setNewOpen(true)}
            aria-label="Add"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        {/* Filter chips */}
        <div className="-mx-px flex gap-1.5 overflow-x-auto px-3 py-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {FILTER_CHIPS.map(([key, config]) => {
            const active = quickFilter === key
            return (
              <button
                key={key}
                type="button"
                onClick={() => setQuickFilter(key)}
                className={cn(
                  "shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-muted-foreground active:bg-muted",
                )}
              >
                {config.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Scrollable content */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-24">
        {isLoading && currentFolders.length === 0 && filteredFiles.length === 0 ? (
          <MobileSkeleton />
        ) : isEmpty ? (
          <EmptyState hasFilters={hasFilters} onUploadClick={onUploadClick} />
        ) : (
          <ul className="divide-y">
            {showFolders
              ? currentFolders.map((folder) => (
                  <FolderRow
                    key={folder.path}
                    name={folder.name}
                    itemCount={folder.itemCount}
                    onOpen={() => setCurrentPath(folder.path)}
                  />
                ))
              : null}
            {filteredFiles.map((file) => (
              <FileRow
                key={file.id}
                file={file}
                onOpen={() => onFileClick(file.id)}
                onActions={() => setActionsFile(file)}
              />
            ))}
          </ul>
        )}

        {hasMore ? (
          <div className="flex justify-center p-4">
            <Button
              variant="outline"
              size="sm"
              onClick={loadMore}
              disabled={isLoadingMore}
              className="w-full max-w-xs"
            >
              {isLoadingMore ? "Loading more..." : "Load more"}
            </Button>
          </div>
        ) : null}
      </div>

      {/* New (upload / folder) drawer */}
      <Drawer open={newOpen} onOpenChange={setNewOpen}>
        <DrawerContent>
          <DrawerHeader className="sr-only">
            <DrawerTitle>Add</DrawerTitle>
          </DrawerHeader>
          <div className="flex flex-col gap-1 px-3 pb-[max(env(safe-area-inset-bottom),1rem)] pt-2">
            <ActionItem
              icon={Upload}
              label="Upload files"
              onClick={() => {
                setNewOpen(false)
                onUploadClick()
              }}
            />
            <ActionItem
              icon={FolderPlus}
              label="New folder"
              onClick={() => {
                setNewOpen(false)
                onCreateFolderClick()
              }}
            />
          </div>
        </DrawerContent>
      </Drawer>

      {/* Per-file actions drawer */}
      <Drawer
        open={Boolean(actionsFile)}
        onOpenChange={(open) => {
          if (!open) setActionsFile(null)
        }}
      >
        <DrawerContent>
          {actionsFile ? (
            <FileActionsSheet
              file={actionsFile}
              close={() => setActionsFile(null)}
              onFileClick={onFileClick}
              onDownloadFile={onDownloadFile}
              onOpenProperties={onOpenProperties}
              onUploadNewVersion={onUploadNewVersion}
              onSendForSignature={onSendForSignature}
              onViewActivity={onViewActivity}
              onRenameFile={onRenameFile}
              onMoveFile={onMoveFile}
              onShareFile={onShareFile}
              onDeleteFile={onDeleteFile}
              onRestoreFile={onRestoreFile}
            />
          ) : null}
        </DrawerContent>
      </Drawer>

      {/* Properties drawer */}
      <Drawer
        open={Boolean(propertiesFile)}
        onOpenChange={(open) => {
          if (!open) onCloseProperties()
        }}
      >
        <DrawerContent className="max-h-[92vh]">
          <DrawerHeader className="sr-only">
            <DrawerTitle>File properties</DrawerTitle>
          </DrawerHeader>
          <div className="min-h-0 flex-1 overflow-hidden">
            <FilePropertiesPanel
              file={propertiesFile}
              onClose={onCloseProperties}
              onPreview={onFileClick}
              onDownload={onDownloadFromProperties}
              onRename={onRenameFile}
              onMove={onMoveFile}
              onShare={onShareFile}
              onUploadNewVersion={onUploadNewVersion}
              versions={propertiesVersions}
              onDownloadVersion={onDownloadVersion}
              timelineEvents={propertiesTimelineEvents}
              timelineLoading={propertiesTimelineLoading}
              onRefreshTimeline={onRefreshTimeline}
              onSendForSignature={(fileId) => onSendForSignature?.(fileId)}
              onDelete={onDeleteFile}
            />
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function FolderRow({
  name,
  itemCount,
  onOpen,
}: {
  name: string
  itemCount: number
  onOpen: () => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 px-3 py-3 text-left active:bg-muted/60"
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-100/80 dark:bg-amber-950/30">
          <FolderOpen className="h-5 w-5 text-amber-600 dark:text-amber-500" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="text-xs text-muted-foreground">
            {itemCount} {itemCount === 1 ? "item" : "items"}
          </p>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
    </li>
  )
}

function FileRow({
  file,
  onOpen,
  onActions,
}: {
  file: FileWithUrls
  onOpen: () => void
  onActions: () => void
}) {
  const Icon = getFileIcon(file.mime_type ?? undefined)
  const isImage = file.mime_type?.startsWith("image/")
  const thumbnailUrl = file.thumbnail_url ?? (isImage ? file.download_url : undefined)

  const meta = [
    categoryLabel(file.category),
    formatFileSize(file.size_bytes),
    formatDate(file.updated_at ?? file.created_at),
  ].filter(Boolean)

  const showStatus = Boolean(file.status) && file.status !== "draft"
  const showSuperseded = Boolean(file.version_number) && !file.is_current
  const hasWorkflowBadge = showStatus || Boolean(file.signature_status) || showSuperseded

  return (
    <li className="flex items-center">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 py-3 pl-3 text-left active:bg-muted/60"
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
          {isImage && thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={thumbnailUrl}
              alt={file.file_name}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <Icon className="h-5 w-5 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{file.file_name}</p>
          <div className="flex items-center gap-1.5">
            <p className="truncate text-xs text-muted-foreground">{meta.join(" · ")}</p>
            <ShareIcon
              clients={Boolean(file.share_with_clients)}
              subs={Boolean(file.share_with_subs)}
            />
          </div>
          {hasWorkflowBadge ? (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <StatusBadge status={file.status} />
              <SignatureBadge status={file.signature_status} />
              {showSuperseded ? (
                <Badge
                  variant="secondary"
                  className="h-4 px-1 py-0 text-[10px] font-normal text-muted-foreground"
                >
                  <Clock className="mr-1 h-2.5 w-2.5" />
                  Superseded
                </Badge>
              ) : null}
            </div>
          ) : null}
        </div>
      </button>
      <button
        type="button"
        onClick={onActions}
        aria-label={`Actions for ${file.file_name}`}
        className="flex h-12 w-12 shrink-0 items-center justify-center text-muted-foreground active:bg-muted/60"
      >
        <MoreVertical className="h-5 w-5" />
      </button>
    </li>
  )
}

function StatusBadge({ status }: { status?: string | null }) {
  if (!status || status === "draft") return null
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-4 px-1 py-0 text-[10px] font-normal capitalize",
        status === "approved" &&
          "border-emerald-200 bg-emerald-50 text-emerald-600 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-400",
        status === "in_review" &&
          "border-blue-200 bg-blue-50 text-blue-600 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-400",
        status === "submitted" &&
          "border-amber-200 bg-amber-50 text-amber-600 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-400",
        (status === "rejected" || status === "resubmit_required") &&
          "border-rose-200 bg-rose-50 text-rose-600 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-400",
      )}
    >
      {status === "approved" && <CheckCircle2 className="mr-1 h-2.5 w-2.5" />}
      {status === "in_review" && <Eye className="mr-1 h-2.5 w-2.5" />}
      {status === "submitted" && <Upload className="mr-1 h-2.5 w-2.5" />}
      {(status === "rejected" || status === "resubmit_required") && (
        <AlertCircle className="mr-1 h-2.5 w-2.5" />
      )}
      {status.replace(/_/g, " ")}
    </Badge>
  )
}

function SignatureBadge({ status }: { status?: string | null }) {
  if (!status) return null
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-4 px-1 py-0 text-[10px] font-normal capitalize",
        status === "signed" &&
          "border-emerald-200 bg-emerald-50 text-emerald-600 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-400",
        status === "sent" &&
          "border-blue-200 bg-blue-50 text-blue-600 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-400",
        (status === "voided" || status === "expired") &&
          "border-muted-foreground/30 bg-muted/30 text-muted-foreground",
      )}
    >
      <FileSignature className="mr-1 h-2.5 w-2.5" />
      {status}
    </Badge>
  )
}

function ShareIcon({ clients, subs }: { clients: boolean; subs: boolean }) {
  if (!clients && !subs) {
    return <Lock className="h-3 w-3 shrink-0 text-muted-foreground/60" aria-label="Private" />
  }
  return (
    <span className="flex shrink-0 items-center gap-1">
      {clients ? (
        <Users className="h-3 w-3 text-blue-600 dark:text-blue-400" aria-label="Shared with clients" />
      ) : null}
      {subs ? (
        <HardHat className="h-3 w-3 text-indigo-600 dark:text-indigo-400" aria-label="Shared with subs" />
      ) : null}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Drawers content
// ---------------------------------------------------------------------------

function FileActionsSheet({
  file,
  close,
  onFileClick,
  onDownloadFile,
  onOpenProperties,
  onUploadNewVersion,
  onSendForSignature,
  onViewActivity,
  onRenameFile,
  onMoveFile,
  onShareFile,
  onDeleteFile,
  onRestoreFile,
}: {
  file: FileWithUrls
  close: () => void
  onFileClick: (fileId: string) => void
  onDownloadFile: (fileId: string) => void
  onOpenProperties: (fileId: string) => void
  onUploadNewVersion: (fileId: string) => void
  onSendForSignature?: (fileId: string) => void
  onViewActivity: (fileId: string) => void
  onRenameFile: (fileId: string) => void
  onMoveFile: (fileId: string) => void
  onShareFile: (fileId: string) => void
  onDeleteFile: (fileId: string) => void
  onRestoreFile?: (fileId: string) => void
}) {
  const run = (fn: () => void) => {
    close()
    fn()
  }
  const isArchived = Boolean(file.archived_at)

  return (
    <>
      <DrawerHeader className="border-b px-4 py-3">
        <DrawerTitle className="truncate text-center text-sm font-semibold">
          {file.file_name}
        </DrawerTitle>
      </DrawerHeader>
      <div className="flex flex-col gap-0.5 overflow-y-auto px-3 pb-[max(env(safe-area-inset-bottom),1rem)] pt-2">
        <ActionItem icon={Eye} label="Preview" onClick={() => run(() => onFileClick(file.id))} />
        <ActionItem icon={Info} label="Properties" onClick={() => run(() => onOpenProperties(file.id))} />
        <ActionItem icon={Download} label="Download" onClick={() => run(() => onDownloadFile(file.id))} />
        {!isArchived ? (
          <ActionItem
            icon={FilePlus2}
            label="Upload new version"
            onClick={() => run(() => onUploadNewVersion(file.id))}
          />
        ) : null}
        {!isArchived && file.mime_type === "application/pdf" && onSendForSignature ? (
          <ActionItem
            icon={FileSignature}
            label="Send for signature"
            onClick={() => run(() => onSendForSignature(file.id))}
          />
        ) : null}
        <ActionItem icon={Activity} label="Timeline" onClick={() => run(() => onViewActivity(file.id))} />
        {isArchived ? (
          <ActionItem icon={Undo2} label="Restore" onClick={() => run(() => onRestoreFile?.(file.id))} />
        ) : (
          <>
            <ActionItem icon={Pencil} label="Rename" onClick={() => run(() => onRenameFile(file.id))} />
            <ActionItem icon={FolderInput} label="Move" onClick={() => run(() => onMoveFile(file.id))} />
            <ActionItem icon={Share2} label="Share" onClick={() => run(() => onShareFile(file.id))} />
            <ActionItem
              icon={Trash2}
              label="Move to trash"
              destructive
              onClick={() => run(() => onDeleteFile(file.id))}
            />
          </>
        )}
      </div>
    </>
  )
}

function ActionItem({
  icon: Icon,
  label,
  onClick,
  destructive,
}: {
  icon: React.ElementType
  label: string
  onClick: () => void
  destructive?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-3 text-left text-sm font-medium active:bg-muted",
        destructive ? "text-destructive" : "text-foreground",
      )}
    >
      <Icon className="h-[18px] w-[18px] shrink-0" />
      {label}
    </button>
  )
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

function MobileSkeleton() {
  return (
    <ul className="divide-y">
      {Array.from({ length: 8 }).map((_, i) => (
        <li key={i} className="flex items-center gap-3 px-3 py-3">
          <div className="h-10 w-10 shrink-0 animate-pulse rounded-lg bg-muted" />
          <div className="flex-1 space-y-2">
            <div className="h-3.5 w-2/3 animate-pulse rounded bg-muted" />
            <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
          </div>
        </li>
      ))}
    </ul>
  )
}

function EmptyState({
  hasFilters,
  onUploadClick,
}: {
  hasFilters?: boolean
  onUploadClick: () => void
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
        <Upload className="h-6 w-6 text-muted-foreground" />
      </div>
      <div>
        <p className="font-medium">{hasFilters ? "No files found" : "No documents yet"}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {hasFilters
            ? "Try adjusting your search or filters."
            : "Upload drawings, contracts, photos, and more for this project."}
        </p>
      </div>
      {!hasFilters ? (
        <Button onClick={onUploadClick} className="mt-1">
          <Upload className="mr-2 h-4 w-4" />
          Upload documents
        </Button>
      ) : null}
    </div>
  )
}
