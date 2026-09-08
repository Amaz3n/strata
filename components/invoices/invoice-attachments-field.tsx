"use client"

import { useRef, useState } from "react"
import { Download, FileText, Image as ImageIcon, Loader2, Paperclip, Plus, X } from "lucide-react"

import type { AttachedFile } from "@/components/files"
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment"
import { cn } from "@/lib/utils"

/**
 * Files that ride with the invoice, as attachment chips: drop zone first, then
 * one chip per file with download and remove. Dropping or picking files hands
 * them up; the editor persists the draft and links them.
 */
export function InvoiceAttachmentsField({
  attachments,
  busy,
  canAttach,
  onAttach,
  onDetach,
}: {
  attachments: AttachedFile[]
  busy: boolean
  /** False until the invoice has enough on it to be saved. */
  canAttach: boolean
  onAttach: (files: File[]) => Promise<void>
  onDetach: (linkId: string) => Promise<void>
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)

  const pick = (files: FileList | null) => {
    const list = Array.from(files ?? [])
    if (list.length > 0) void onAttach(list)
  }

  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          pick(event.target.files)
          event.target.value = ""
        }}
      />
      <button
        type="button"
        disabled={busy || !canAttach}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          if (!canAttach || busy) return
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          if (!canAttach || busy) return
          pick(event.dataTransfer.files)
        }}
        className={cn(
          "flex w-full items-center justify-center gap-2 border border-dashed px-4 py-4 text-sm text-muted-foreground transition-colors",
          "hover:border-foreground/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60",
          dragging && "border-primary bg-primary/5 text-foreground",
        )}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        {busy ? "Uploading…" : canAttach ? "Drop files here or click to add" : "Add an item first, then attach files"}
      </button>

      {attachments.length > 0 ? (
        <AttachmentGroup className="flex-wrap">
          {attachments.map((file) => {
            const isImage = (file.mime_type ?? "").startsWith("image/")
            return (
              <Attachment key={file.linkId} size="sm" className="animate-in fade-in zoom-in-95 duration-150 motion-reduce:animate-none">
                <AttachmentMedia variant={isImage && file.thumbnail_url ? "image" : "icon"}>
                  {isImage && file.thumbnail_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={file.thumbnail_url} alt="" />
                  ) : isImage ? (
                    <ImageIcon />
                  ) : (
                    <FileText />
                  )}
                </AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle>{file.file_name}</AttachmentTitle>
                  <AttachmentDescription>{formatSize(file.size_bytes)}</AttachmentDescription>
                </AttachmentContent>
                <AttachmentActions>
                  {file.download_url ? (
                    <AttachmentAction asChild aria-label={`Download ${file.file_name}`}>
                      <a href={file.download_url} target="_blank" rel="noreferrer">
                        <Download />
                      </a>
                    </AttachmentAction>
                  ) : null}
                  <AttachmentAction
                    aria-label={`Remove ${file.file_name}`}
                    disabled={removing === file.linkId}
                    onClick={async () => {
                      setRemoving(file.linkId)
                      try {
                        await onDetach(file.linkId)
                      } finally {
                        setRemoving(null)
                      }
                    }}
                  >
                    {removing === file.linkId ? <Loader2 className="animate-spin" /> : <X />}
                  </AttachmentAction>
                </AttachmentActions>
              </Attachment>
            )
          })}
        </AttachmentGroup>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Paperclip className="h-3.5 w-3.5" />
          Nothing attached yet.
        </p>
      )}
    </div>
  )
}

function formatSize(bytes?: number | null) {
  if (!bytes) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
