"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/components/ui/attachment"
import { Button } from "@/components/ui/button"
import { ImageIcon, Loader2, Upload, X } from "@/components/icons"
import { cn } from "@/lib/utils"

export const PLAN_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/avif"]

function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function PlanImageAttachment({
  file = null,
  existingUrl = null,
  existingName = "Plan imagery",
  description = "PNG, JPEG, WebP or AVIF",
  uploading = false,
  disabled = false,
  compact = false,
  onSelect,
  onRemove,
}: {
  file?: File | null
  existingUrl?: string | null
  existingName?: string
  description?: string
  uploading?: boolean
  disabled?: boolean
  compact?: boolean
  onSelect: (file: File) => void
  onRemove?: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const [isDragging, setIsDragging] = useState(false)
  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file])

  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    },
    [previewUrl],
  )

  function choose(nextFile: File | undefined) {
    if (!nextFile || disabled || uploading) return
    if (!PLAN_IMAGE_TYPES.includes(nextFile.type)) {
      toast.error("Choose a PNG, JPEG, WebP or AVIF image")
      return
    }
    onSelect(nextFile)
  }

  const dragProps =
    disabled || uploading
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
            dragDepth.current = 0
            setIsDragging(false)
            choose(event.dataTransfer.files?.[0])
          },
        }

  const imageUrl = previewUrl ?? existingUrl
  const title = file?.name ?? existingName
  const detail = file ? `${fileSize(file.size)} · ready to attach` : description

  return (
    <div {...dragProps}>
      <input
        ref={inputRef}
        type="file"
        accept={PLAN_IMAGE_TYPES.join(",")}
        disabled={disabled || uploading}
        className="hidden"
        onChange={(event) => {
          choose(event.target.files?.[0])
          event.target.value = ""
        }}
      />

      {uploading ? (
        <Attachment state="uploading" size={compact ? "sm" : "default"} className="w-full">
          <AttachmentMedia>
            <Loader2 className="animate-spin text-primary" />
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>Uploading imagery…</AttachmentTitle>
            <AttachmentDescription>Sending the selected file to storage</AttachmentDescription>
          </AttachmentContent>
        </Attachment>
      ) : imageUrl ? (
        <Attachment state="done" size={compact ? "sm" : "default"} className="w-full">
          <AttachmentMedia variant="image">
            {/* eslint-disable-next-line @next/next/no-img-element -- local preview or authenticated file route */}
            <img src={imageUrl} alt="" />
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>{title}</AttachmentTitle>
            <AttachmentDescription>{detail}</AttachmentDescription>
          </AttachmentContent>
          <AttachmentActions className="pr-1.5">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="relative z-20 h-7 rounded-none px-2 text-[11px]"
              disabled={disabled}
              onClick={() => inputRef.current?.click()}
            >
              Replace
            </Button>
            {onRemove ? (
              <AttachmentAction type="button" onClick={onRemove} disabled={disabled} aria-label={`Remove ${title}`}>
                <X className="h-4 w-4" />
              </AttachmentAction>
            ) : null}
          </AttachmentActions>
        </Attachment>
      ) : (
        <Attachment
          state="idle"
          size={compact ? "sm" : "default"}
          className={cn(
            "w-full cursor-pointer",
            compact ? "min-h-12" : "min-h-20",
            isDragging && "border-primary bg-primary/5",
          )}
        >
          <AttachmentMedia>
            {isDragging ? <Upload className="text-primary" /> : <ImageIcon className="text-muted-foreground" />}
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>{isDragging ? "Drop image to attach" : "Attach product imagery"}</AttachmentTitle>
            <AttachmentDescription>
              {compact ? "Click or drop an image" : "Exterior rendering or architectural elevation image"}
            </AttachmentDescription>
          </AttachmentContent>
          <AttachmentTrigger
            type="button"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
            aria-label="Choose plan imagery"
          />
        </Attachment>
      )}
    </div>
  )
}
