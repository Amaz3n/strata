"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { unwrapAction } from "@/lib/action-result"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Attachment,
  AttachmentMedia,
  AttachmentContent,
  AttachmentTitle,
  AttachmentDescription,
  AttachmentActions,
  AttachmentAction,
} from "@/components/ui/attachment"
import { Upload, X, FileText, Loader2, Eye } from "@/components/icons"
import { cn } from "@/lib/utils"
import { formatFileSize } from "@/components/files/types"
import type { AttachedFile } from "@/components/files/entity-attachments"
import {
  attachFileAction,
  detachFileLinkAction,
  listAttachmentsAction,
  uploadFileAction,
} from "@/app/(app)/documents/actions"

/**
 * Shared attachment field built on the shadcn Attachment primitive, with drag-and-drop.
 * - Linked mode (entityId set): loads, uploads, and detaches attachments against the entity.
 * - Pending mode (pendingFiles/onPendingChange): holds files client-side until the parent saves.
 */
export function AttachmentField({
  projectId,
  label = "Photos & evidence",
  accept = "image/*,.pdf,.doc,.docx",
  folderPath,
  multiple = true,
  emptyHint = "Drag and drop or click to add photos and documents",
  disabled = false,
  entityType,
  entityId,
  legacyFileId,
  pendingFiles,
  onPendingChange,
}: {
  projectId: string
  label?: string
  accept?: string
  folderPath?: string
  multiple?: boolean
  emptyHint?: string
  disabled?: boolean
  entityType?: string
  entityId?: string
  legacyFileId?: string | null
  pendingFiles?: File[]
  onPendingChange?: (files: File[]) => void
}) {
  const linked = Boolean(entityType && entityId)
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [uploading, setUploading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const dragCounter = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    if (!entityType || !entityId) return
    try {
      const links = await listAttachmentsAction(entityType, entityId)
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
      console.error("Failed to load attachments:", error)
    }
  }, [entityType, entityId])

  useEffect(() => {
    if (!linked) {
      setAttachments([])
      return
    }
    let cancelled = false
    ;(async () => {
      if (legacyFileId && entityType && entityId) {
        try {
          unwrapAction(await attachFileAction(legacyFileId, entityType, entityId, projectId, "legacy_attachment"))
        } catch (error) {
          console.warn("Failed to backfill legacy attachment", error)
        }
      }
      if (!cancelled) await load()
    })()
    return () => {
      cancelled = true
    }
  }, [linked, legacyFileId, entityType, entityId, projectId, load])

  const addFiles = useCallback(
    async (files: File[]) => {
      if (disabled || files.length === 0) return
      if (!linked) {
        onPendingChange?.(multiple ? [...(pendingFiles ?? []), ...files] : [files[0]])
        return
      }
      setUploading(true)
      try {
        for (const file of multiple ? files : [files[0]]) {
          const fd = new FormData()
          fd.append("file", file)
          fd.append("projectId", projectId)
          fd.append("category", "photos")
          fd.append("visibility", "private")
          if (folderPath) fd.append("folderPath", folderPath)
          const uploaded = unwrapAction(await uploadFileAction(fd))
          unwrapAction(await attachFileAction(uploaded.id, entityType as string, entityId as string, projectId))
        }
        await load()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to attach files")
      } finally {
        setUploading(false)
      }
    },
    [disabled, linked, multiple, pendingFiles, onPendingChange, projectId, folderPath, entityType, entityId, load],
  )

  const removeLinked = useCallback(
    async (linkId: string) => {
      try {
        unwrapAction(await detachFileLinkAction(linkId))
        await load()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to remove file")
      }
    },
    [load],
  )

  const dragProps = disabled
    ? {}
    : {
        onDragEnter: (event: React.DragEvent) => {
          event.preventDefault()
          event.stopPropagation()
          dragCounter.current += 1
          if (event.dataTransfer.items?.length) setIsDragging(true)
        },
        onDragLeave: (event: React.DragEvent) => {
          event.preventDefault()
          event.stopPropagation()
          dragCounter.current -= 1
          if (dragCounter.current === 0) setIsDragging(false)
        },
        onDragOver: (event: React.DragEvent) => {
          event.preventDefault()
          event.stopPropagation()
        },
        onDrop: (event: React.DragEvent) => {
          event.preventDefault()
          event.stopPropagation()
          setIsDragging(false)
          dragCounter.current = 0
          void addFiles(Array.from(event.dataTransfer.files))
        },
      }

  const pending = pendingFiles ?? []
  const hasItems = linked ? attachments.length > 0 || uploading : pending.length > 0

  return (
    <div className="space-y-2" {...dragProps}>
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={disabled || uploading}>
          <Upload className="mr-1.5 h-4 w-4" />
          {uploading ? "Uploading…" : "Add"}
        </Button>
      </div>
      <input ref={inputRef} type="file" accept={accept} multiple={multiple} className="hidden" onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void addFiles(files) }} />
      {!hasItems ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          className={cn(
            "flex w-full items-center justify-center gap-2 border border-dashed bg-card px-3 py-6 text-sm text-muted-foreground transition-colors hover:bg-muted/50",
            isDragging && "border-primary bg-primary/5 text-foreground",
          )}
        >
          <Upload className="h-4 w-4" />
          {emptyHint}
        </button>
      ) : (
        <div className={cn("space-y-1.5", isDragging && "outline outline-1 outline-dashed outline-primary")}>
          {uploading ? (
            <Attachment state="uploading" className="w-full">
              <AttachmentMedia variant="icon">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle>Uploading…</AttachmentTitle>
                <AttachmentDescription>Adding files</AttachmentDescription>
              </AttachmentContent>
            </Attachment>
          ) : null}
          {linked
            ? attachments.map((file) => {
                const isImage = file.mime_type?.startsWith("image/")
                const preview = file.thumbnail_url ?? file.download_url
                return (
                  <Attachment key={file.linkId} state="done" className="w-full">
                    <AttachmentMedia variant={isImage && preview ? "image" : "icon"}>
                      {isImage && preview ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={preview} alt={file.file_name} />
                      ) : (
                        <FileText className="h-4 w-4" />
                      )}
                    </AttachmentMedia>
                    <AttachmentContent>
                      <AttachmentTitle>{file.file_name}</AttachmentTitle>
                      <AttachmentDescription>{formatFileSize(file.size_bytes)}</AttachmentDescription>
                    </AttachmentContent>
                    <AttachmentActions className="pr-1.5">
                      {file.download_url ? (
                        <AttachmentAction asChild aria-label={`View ${file.file_name}`}>
                          <a href={file.download_url} target="_blank" rel="noreferrer">
                            <Eye className="h-4 w-4" />
                          </a>
                        </AttachmentAction>
                      ) : null}
                      <AttachmentAction onClick={() => void removeLinked(file.linkId)} aria-label={`Remove ${file.file_name}`}>
                        <X className="h-4 w-4" />
                      </AttachmentAction>
                    </AttachmentActions>
                  </Attachment>
                )
              })
            : pending.map((file, index) => (
                <Attachment key={`${file.name}-${index}`} state="idle" className="w-full">
                  <AttachmentMedia variant="icon">
                    <FileText className="h-4 w-4" />
                  </AttachmentMedia>
                  <AttachmentContent>
                    <AttachmentTitle>{file.name}</AttachmentTitle>
                    <AttachmentDescription>{formatFileSize(file.size)}</AttachmentDescription>
                  </AttachmentContent>
                  <AttachmentActions className="pr-1.5">
                    <AttachmentAction onClick={() => onPendingChange?.(pending.filter((_, i) => i !== index))} aria-label={`Remove ${file.name}`}>
                      <X className="h-4 w-4" />
                    </AttachmentAction>
                  </AttachmentActions>
                </Attachment>
              ))}
        </div>
      )}
    </div>
  )
}
