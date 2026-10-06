"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import { toast } from "sonner"

import type { BidPackage } from "@/lib/services/bids"
import { uploadDocumentForm as uploadFileAction } from "@/lib/files/upload-document-form"
import {
  attachFileAction,
  detachFileLinkAction,
  listAttachmentsAction,
  listFilesAction,
} from "@/app/(app)/documents/actions"
import type { FileWithUrls } from "@/app/(app)/documents/types"
import { unwrapAction } from "@/lib/action-result"
import type { AttachedFile } from "@/components/files"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { FileText, FolderOpen, Upload, X } from "@/components/icons"

function mapAttachments(links: unknown[]): AttachedFile[] {
  return (links ?? []).map((raw) => {
    const link = raw as {
      id: string
      created_at: string
      link_role?: string
      file: {
        id: string
        file_name: string
        mime_type?: string
        size_bytes?: number
        download_url?: string
        thumbnail_url?: string
      }
    }
    return {
      id: link.file.id,
      linkId: link.id,
      file_name: link.file.file_name,
      mime_type: link.file.mime_type,
      size_bytes: link.file.size_bytes,
      download_url: link.file.download_url,
      thumbnail_url: link.file.thumbnail_url,
      created_at: link.created_at,
      link_role: link.link_role,
    }
  })
}

/** What trades bid against: drawings, specs and instructions attached to the package. */
export function BidPackageDocuments({
  bidPackage,
  projectId,
  readOnly,
}: {
  bidPackage: BidPackage
  projectId: string
  readOnly: boolean
}) {
  const [attachments, setAttachments] = useState<AttachedFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const reload = useCallback(async () => {
    try {
      setAttachments(mapAttachments(await listAttachmentsAction("bid_package", bidPackage.id)))
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load documents")
    }
  }, [bidPackage.id])

  useEffect(() => {
    void reload()
  }, [reload])

  async function upload(files: File[]) {
    if (!files.length) return
    setUploading(true)
    try {
      for (const file of files) {
        const formData = new FormData()
        formData.append("file", file)
        formData.append("projectId", projectId)
        formData.append("category", "plans")
        const uploaded = unwrapAction(await uploadFileAction(formData))
        unwrapAction(await attachFileAction(uploaded.id, "bid_package", bidPackage.id, projectId))
      }
      await reload()
    } catch (cause) {
      toast.error("Upload failed", { description: cause instanceof Error ? cause.message : "Please try again." })
    } finally {
      setUploading(false)
    }
  }

  async function detach(linkId: string) {
    try {
      unwrapAction(await detachFileLinkAction(linkId))
      await reload()
    } catch (cause) {
      toast.error("Unable to remove", { description: cause instanceof Error ? cause.message : "Please try again." })
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="microlabel">Documents</p>
        {readOnly ? null : (
          <div className="flex gap-1">
            <input ref={inputRef} type="file" multiple className="hidden" onChange={(event) => void upload(Array.from(event.target.files ?? []))} />
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setPickerOpen(true)}>
              <FolderOpen className="mr-1 h-3.5 w-3.5" />
              Project files
            </Button>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={uploading} onClick={() => inputRef.current?.click()}>
              <Upload className="mr-1 h-3.5 w-3.5" />
              {uploading ? "Uploading…" : "Upload"}
            </Button>
          </div>
        )}
      </div>
      {error ? (
        <div role="alert" className="flex items-center justify-between gap-2 text-sm">
          <span className="text-destructive">{error}</span>
          <Button variant="outline" size="sm" className="h-7" onClick={() => void reload()}>Retry</Button>
        </div>
      ) : attachments === null ? (
        <div className="space-y-1.5">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-5 w-1/2" />
        </div>
      ) : attachments.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing attached. Trades will ask for drawings first.</p>
      ) : (
        <ul className="space-y-0.5">
          {attachments.map((file) => (
            <li key={file.linkId} className="group flex items-center gap-2 py-1 text-sm">
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              {file.download_url ? (
                <a href={file.download_url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate hover:text-primary">
                  {file.file_name}
                </a>
              ) : (
                <span className="min-w-0 flex-1 truncate">{file.file_name}</span>
              )}
              {readOnly ? null : (
                <button
                  type="button"
                  className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                  aria-label={`Remove ${file.file_name}`}
                  onClick={() => void detach(file.linkId)}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ProjectFilePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        projectId={projectId}
        bidPackageId={bidPackage.id}
        attachedFileIds={new Set((attachments ?? []).map((attachment) => attachment.id))}
        onAttached={reload}
      />
    </div>
  )
}

function ProjectFilePicker({
  open,
  onOpenChange,
  projectId,
  bidPackageId,
  attachedFileIds,
  onAttached,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  bidPackageId: string
  attachedFileIds: Set<string>
  onAttached: () => Promise<void>
}) {
  const [files, setFiles] = useState<FileWithUrls[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [isSaving, startSaving] = useTransition()

  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true)
    listFilesAction({ project_id: projectId, include_archived: false, limit: 200, offset: 0 })
      .then((page) => {
        if (active) setFiles(page.data)
      })
      .catch(() => {
        if (active) toast.error("Failed to load project files")
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [open, projectId])

  const filtered = useMemo(() => {
    const term = search.toLowerCase()
    return files.filter((file) => !term || file.file_name.toLowerCase().includes(term))
  }, [files, search])

  function handleAttach() {
    if (selected.size === 0) {
      toast.error("Select at least one file")
      return
    }
    const ids = Array.from(selected)
    startSaving(async () => {
      try {
        await Promise.all(
          ids.map((fileId) => attachFileAction(fileId, "bid_package", bidPackageId, projectId).then(unwrapAction)),
        )
        await onAttached()
        toast.success(`Added ${ids.length} file${ids.length === 1 ? "" : "s"}`)
        setSelected(new Set())
        setSearch("")
        onOpenChange(false)
      } catch (error) {
        toast.error("Failed to attach files", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col p-0 sm:max-w-md">
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle>Add from project files</SheetTitle>
          <SheetDescription>Attach existing project documents to this package.</SheetDescription>
        </SheetHeader>
        <div className="border-b px-6 py-3">
          <Input placeholder="Search files…" value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
        <ScrollArea className="flex-1">
          {loading ? (
            <div className="space-y-2 px-6 py-4">
              {[0, 1, 2, 3, 4].map((index) => <Skeleton key={index} className="h-6 w-full" />)}
            </div>
          ) : filtered.length === 0 ? (
            <p className="px-6 py-10 text-center text-sm text-muted-foreground">No files found.</p>
          ) : (
            <div className="divide-y">
              {filtered.map((file) => {
                const already = attachedFileIds.has(file.id)
                return (
                  <label
                    key={file.id}
                    className="flex cursor-pointer items-center gap-2 px-6 py-2 text-sm hover:bg-muted/40"
                  >
                    <Checkbox
                      checked={selected.has(file.id)}
                      disabled={already}
                      onCheckedChange={(value) =>
                        setSelected((prev) => {
                          const next = new Set(prev)
                          if (value === true) next.add(file.id)
                          else next.delete(file.id)
                          return next
                        })
                      }
                    />
                    <span className="flex-1 truncate">{file.file_name}</span>
                    {file.folder_path ? (
                      <span className="text-xs text-muted-foreground">{file.folder_path}</span>
                    ) : null}
                    {already ? <span className="text-xs text-muted-foreground">Attached</span> : null}
                  </label>
                )
              })}
            </div>
          )}
        </ScrollArea>
        <SheetFooter className="border-t px-6 py-4">
          <div className="flex w-full gap-2">
            <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button className="flex-1" onClick={handleAttach} disabled={isSaving}>
              {isSaving ? "Adding…" : `Add ${selected.size || ""}`.trim()}
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
