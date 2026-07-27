"use client"

import { useRouter } from "next/navigation"
import { useEffect, useState, useTransition } from "react"

import { markDealLostAction } from "@/app/(app)/sales/actions"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { unwrapAction } from "@/lib/action-result"
import { LOST_REASON_CODES, LOST_REASON_LABELS, type LostReasonCode } from "@/lib/sales/lost-reasons"
import { cn } from "@/lib/utils"

/**
 * Closing a deal out. The reason is required and picked from a fixed list: a
 * free-text reason is a note nobody can count, and the cancellation report is
 * the number a VP of Sales actually manages against.
 */
export function MarkLostDialog({
  prospectId,
  open,
  onOpenChange,
}: {
  prospectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const { toast } = useToast()
  const [reason, setReason] = useState<LostReasonCode | null>(null)
  const [note, setNote] = useState("")
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    if (open) return
    setReason(null)
    setNote("")
  }, [open])

  const markLost = () => {
    if (!reason) return
    startTransition(async () => {
      try {
        unwrapAction(await markDealLostAction(prospectId, { reasonCode: reason, note: note.trim() || null }))
        toast({ title: "Deal marked lost" })
        onOpenChange(false)
        router.refresh()
      } catch (error) {
        toast({ title: "Could not mark the deal lost", description: (error as Error).message })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mark this deal lost</DialogTitle>
          <DialogDescription>
            The reason is what makes the cancellation report useful. Pick the closest one.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-1.5">
            {LOST_REASON_CODES.map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => setReason(code)}
                aria-pressed={reason === code}
                className={cn(
                  "border px-2.5 py-2 text-left text-xs transition-colors",
                  reason === code ? "border-foreground bg-foreground font-medium text-background" : "hover:bg-muted",
                )}
              >
                {LOST_REASON_LABELS[code]}
              </button>
            ))}
          </div>

          <div className="space-y-1">
            <Label htmlFor="lost-note" className="text-[11px] font-normal text-muted-foreground">
              Detail (optional)
            </Label>
            <Textarea
              id="lost-note"
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Lender denied on debt-to-income…"
              className="resize-none rounded-none text-[13px]"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" className="rounded-none" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" className="rounded-none" onClick={markLost} disabled={pending || !reason}>
            {pending ? "Saving…" : "Mark lost"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
