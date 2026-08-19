"use client"

import { useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"
import type { PortalDocumentSlot } from "./prequal-types"

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,.heic"
const MAX_BYTES = 25 * 1024 * 1024

export function documentSlotState(slot: PortalDocumentSlot): {
  label: string
  className: string
  settled: boolean
} {
  switch (slot.status) {
    case "approved":
      return {
        label: "On file",
        className: "border-success/30 bg-success/10 text-success",
        settled: true,
      }
    case "pending_review":
      return {
        label: "Sent — under review",
        className: "border-primary/30 bg-primary/10 text-primary",
        settled: true,
      }
    case "rejected":
      return {
        label: "Rejected — send again",
        className: "border-destructive/30 bg-destructive/10 text-destructive",
        settled: false,
      }
    case "expired":
      return {
        label: "Expired — send again",
        className: "border-destructive/30 bg-destructive/10 text-destructive",
        settled: false,
      }
    default:
      return slot.is_required
        ? { label: "Needed", className: "border-warning/30 bg-warning/10 text-warning", settled: false }
        : { label: "Optional", className: "border-border bg-muted text-muted-foreground", settled: true }
  }
}

export function DocumentSlotRow({
  token,
  prequalificationId,
  slot,
}: {
  token: string
  prequalificationId: string
  slot: PortalDocumentSlot
}) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [pending, startTransition] = useTransition()
  const [expiry, setExpiry] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [progress, setProgress] = useState(0)

  const state = documentSlotState(slot)

  const upload = (file: File) => {
    setError(null)
    if (file.size > MAX_BYTES) {
      setError("That file is over 25 MB. Send a smaller scan or a PDF.")
      return
    }

    startTransition(async () => {
      // The two-step upload gives no byte-level progress, so this is a paced
      // hint that work is happening, finished off by the real completion.
      const ticker = setInterval(() => setProgress((prev) => Math.min(prev + 12, 85)), 220)
      try {
        const formData = new FormData()
        formData.append("file", file)
        const uploadResponse = await fetch(`/api/portal/s/${token}/compliance/upload`, {
          method: "POST",
          body: formData,
        })
        if (!uploadResponse.ok) {
          const body = await uploadResponse.json().catch(() => ({}))
          throw new Error(body.error ?? "That upload did not go through. Try again.")
        }
        const { fileId } = await uploadResponse.json()

        const response = await fetch(`/api/portal/s/${token}/compliance`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            document_type_id: slot.document_type_id,
            file_id: fileId,
            expiry_date: slot.has_expiry && expiry ? expiry : undefined,
            prequalification_id: prequalificationId,
          }),
        })
        if (!response.ok) {
          const body = await response.json().catch(() => ({}))
          throw new Error(body.error ?? "That document could not be saved.")
        }
        setProgress(100)
        setExpiry("")
        router.refresh()
      } catch (uploadError) {
        setError(uploadError instanceof Error ? uploadError.message : "Upload failed")
        setProgress(0)
      } finally {
        clearInterval(ticker)
      }
    })
  }

  const expiryId = `expiry-${slot.document_type_id}`

  return (
    <li
      className={cn(
        "border p-4 transition-colors sm:p-5",
        dragging ? "border-primary bg-primary/5" : "border-border bg-card",
      )}
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        const file = event.dataTransfer.files?.[0]
        if (file) upload(file)
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{slot.name}</span>
            <span
              className={cn(
                "inline-flex items-center border px-2 py-0.5 text-[11px] font-medium",
                state.className,
              )}
            >
              {state.label}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {slot.expiry_date
              ? `Expires ${new Date(slot.expiry_date).toLocaleDateString()}`
              : slot.status === "approved" || slot.status === "pending_review"
                ? "Already with the builder"
                : "PDF or photo, up to 25 MB"}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            accept={ACCEPT}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) upload(file)
              event.target.value = ""
            }}
          />
          <Button
            type="button"
            size="sm"
            variant={state.settled ? "outline" : "default"}
            disabled={pending}
            className="h-10"
            onClick={() => inputRef.current?.click()}
          >
            {pending ? "Uploading…" : slot.status ? "Replace" : "Upload"}
          </Button>
        </div>
      </div>

      {slot.has_expiry && !state.settled ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Label htmlFor={expiryId} className="text-xs text-muted-foreground">
            Expiry date
          </Label>
          <Input
            id={expiryId}
            type="date"
            value={expiry}
            onChange={(event) => setExpiry(event.target.value)}
            className="h-10 w-44"
          />
          <span className="text-xs text-muted-foreground">Set this before uploading.</span>
        </div>
      ) : null}

      {pending || progress === 100 ? (
        <Progress value={progress} className="mt-3 h-1" />
      ) : null}

      {error ? <p className="mt-2 text-xs font-medium text-destructive">{error}</p> : null}
    </li>
  )
}

export function DocumentsStep({
  token,
  prequalificationId,
  slots,
}: {
  token: string
  prequalificationId: string
  slots: PortalDocumentSlot[]
}) {
  const outstanding = slots.filter((slot) => !documentSlotState(slot).settled)

  return (
    <div className="space-y-4">
      {outstanding.length === 0 ? (
        <p className="border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">
          Every document the builder asked for is with them.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Drag a file onto a row or tap Upload. You can send your answers first and add documents
          later — the builder sees both in one place.
        </p>
      )}
      <ul className="space-y-3">
        {slots.map((slot) => (
          <DocumentSlotRow
            key={slot.document_type_id}
            token={token}
            prequalificationId={prequalificationId}
            slot={slot}
          />
        ))}
      </ul>
    </div>
  )
}
