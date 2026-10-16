"use client"

import { useRef, useState } from "react"
import { toast } from "sonner"

import { Paperclip } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { unwrapAction } from "@/lib/action-result"
import { uploadDocumentForm } from "@/lib/files/upload-document-form"

/**
 * Uploads cost evidence (a quote, invoice or receipt) into the home's financial
 * files and hands back the new file ids; the caller decides what they attach to.
 */
export function VpoEvidenceUpload({ projectId, onUploaded, disabled, label = "Attach evidence" }: {
  projectId: string
  onUploaded: (fileIds: string[]) => void | Promise<void>
  disabled?: boolean
  label?: string
}) {
  const input = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  const upload = async (files: File[]) => {
    setUploading(true)
    try {
      const ids: string[] = []
      for (const file of files) {
        const form = new FormData()
        form.append("file", file)
        form.append("projectId", projectId)
        form.append("category", "financials")
        form.append("visibility", "private")
        ids.push(unwrapAction(await uploadDocumentForm(form)).id)
      }
      await onUploaded(ids)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not attach the evidence")
    } finally {
      setUploading(false)
      if (input.current) input.current.value = ""
    }
  }

  return (
    <>
      <input ref={input} type="file" multiple className="sr-only" tabIndex={-1} aria-label={label}
        onChange={(event) => { const files = Array.from(event.target.files ?? []); if (files.length > 0) void upload(files) }} />
      <Button type="button" size="sm" variant="ghost" disabled={disabled || uploading} onClick={() => input.current?.click()}>
        <Paperclip /> {uploading ? "Uploading…" : label}
      </Button>
    </>
  )
}
