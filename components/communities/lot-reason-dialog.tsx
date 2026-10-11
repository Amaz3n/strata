"use client"

import { useEffect, useState, useTransition } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

/**
 * A recorded exception is a person saying why, on the record. The dialog holds
 * the reason until the service accepts it, so a refusal (a missing permission,
 * a lot that changed underneath) stays next to the text instead of in a toast
 * that disappears with the words still unsaved.
 */
export function LotReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  minLength,
  submitLabel,
  success,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  minLength: number
  submitLabel: string
  success: string
  /** Resolves on success; throws the service's message on refusal. */
  onSubmit: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    if (open) {
      setReason("")
      setError(null)
    }
  }, [open])

  const trimmed = reason.trim()

  function submit() {
    startTransition(async () => {
      try {
        await onSubmit(trimmed)
        toast.success(success)
        onOpenChange(false)
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "Unable to record the exception")
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (isPending ? undefined : onOpenChange(next))}>
      <DialogContent className="rounded-none sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="lot-reason">Reason</Label>
          <Textarea
            id="lot-reason"
            className="min-h-24 rounded-none text-sm"
            value={reason}
            disabled={isPending}
            aria-invalid={error ? true : undefined}
            onChange={(event) => {
              setReason(event.target.value)
              setError(null)
            }}
          />
          <p className="text-xs text-muted-foreground tabular-nums">
            {trimmed.length}/{minLength} characters minimum
          </p>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" className="rounded-none" disabled={isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="rounded-none" disabled={isPending || trimmed.length < minLength} onClick={submit}>
            {isPending ? "Recording…" : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
