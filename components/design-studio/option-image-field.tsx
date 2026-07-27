"use client"

import { useCallback, useRef, useState } from "react"
import { toast } from "sonner"

import { uploadOptionImageAction } from "@/app/(app)/design-studio/actions"
import { unwrapAction } from "@/lib/action-result"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Attachment,
  AttachmentActions,
  AttachmentAction,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment"
import { ImageIcon, Loader2, Upload, X } from "@/components/icons"
import { cn } from "@/lib/utils"

export interface OptionImage {
  fileId: string | null
  url: string | null
  fileName: string | null
}

interface Props {
  value: OptionImage
  onChange: (value: OptionImage) => void
  disabled?: boolean
}

/**
 * One photo per option, dropped or picked and uploaded to R2 immediately. The
 * upload is committed before the option is saved, which is deliberate: the
 * coordinator sees the real image in the preview rather than a filename, and an
 * abandoned dialog leaves an orphaned object rather than a broken reference.
 */
export function OptionImageField({ value, onChange, disabled }: Props) {
  const [uploading, setUploading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const dragDepth = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const upload = useCallback(
    async (file: File | undefined) => {
      if (!file || disabled) return
      if (!file.type.startsWith("image/")) {
        toast.error("Option photography must be an image file")
        return
      }
      setUploading(true)
      try {
        const data = new FormData()
        data.set("file", file)
        const image = unwrapAction(await uploadOptionImageAction(data))
        onChange({ fileId: image.fileId, url: image.url, fileName: image.fileName })
      } catch (error) {
        toast.error("Could not upload that image", {
          description: error instanceof Error ? error.message : undefined,
        })
      } finally {
        setUploading(false)
      }
    },
    [disabled, onChange],
  )

  const dragProps = disabled
    ? {}
    : {
        onDragEnter: (event: React.DragEvent) => {
          event.preventDefault()
          dragDepth.current += 1
          if (event.dataTransfer.items?.length) setIsDragging(true)
        },
        onDragLeave: (event: React.DragEvent) => {
          event.preventDefault()
          dragDepth.current -= 1
          if (dragDepth.current === 0) setIsDragging(false)
        },
        onDragOver: (event: React.DragEvent) => event.preventDefault(),
        onDrop: (event: React.DragEvent) => {
          event.preventDefault()
          setIsDragging(false)
          dragDepth.current = 0
          void upload(event.dataTransfer.files?.[0])
        },
      }

  return (
    <div className="space-y-2" {...dragProps}>
      <div className="flex items-center justify-between">
        <Label>Photo</Label>
        {value.url && !uploading && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 rounded-none"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            Replace
          </Button>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ""
          void upload(file)
        }}
      />

      {uploading ? (
        <Attachment state="uploading" className="w-full">
          <AttachmentMedia variant="icon">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>Uploading…</AttachmentTitle>
            <AttachmentDescription>Sending to storage</AttachmentDescription>
          </AttachmentContent>
        </Attachment>
      ) : value.url ? (
        <Attachment state="done" className="w-full">
          <AttachmentMedia variant="image">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={value.url} alt={value.fileName ?? "Option photo"} />
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>{value.fileName ?? "Option photo"}</AttachmentTitle>
            <AttachmentDescription>Shown to buyers in the studio and the portal</AttachmentDescription>
          </AttachmentContent>
          <AttachmentActions className="pr-1.5">
            <AttachmentAction
              onClick={() => onChange({ fileId: null, url: null, fileName: null })}
              aria-label="Remove photo"
            >
              <X className="h-4 w-4" />
            </AttachmentAction>
          </AttachmentActions>
        </Attachment>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          className={cn(
            "flex w-full flex-col items-center justify-center gap-1.5 border border-dashed bg-card px-3 py-6 text-sm text-muted-foreground transition-colors hover:bg-muted/50",
            isDragging && "border-primary bg-primary/5 text-foreground",
          )}
        >
          <span className="flex items-center gap-2">
            {isDragging ? <Upload className="h-4 w-4" /> : <ImageIcon className="h-4 w-4" />}
            {isDragging ? "Drop to upload" : "Drag an image here, or click to choose one"}
          </span>
          <span className="text-xs">PNG or JPG, up to 8 MB</span>
        </button>
      )}
    </div>
  )
}
