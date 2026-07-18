"use client"

import { useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { BidAddendum, BidPackage } from "@/lib/services/bids"
import { createBidAddendumAction } from "@/app/(app)/bids/actions"
import { unwrapAction } from "@/lib/action-result"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Plus } from "@/components/icons"
import type { BidWorkbenchContext } from "@/components/bids/bid-workbench-helpers"

interface BidAddendaSectionProps {
  context: BidWorkbenchContext
  bidPackage: BidPackage
  addenda: BidAddendum[]
  reloadAddenda: () => Promise<void>
}

export function BidAddendaSection({ context, bidPackage, addenda, reloadAddenda }: BidAddendaSectionProps) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState("")
  const [message, setMessage] = useState("")
  const [isSaving, startSaving] = useTransition()

  function handleCreate() {
    if (!message.trim() && !title.trim()) {
      toast.error("Add a title or message")
      return
    }
    startSaving(async () => {
      try {
        unwrapAction(
          await createBidAddendumAction(
            { ...context, bidPackageId: bidPackage.id },
            { bid_package_id: bidPackage.id, title: title.trim() || null, message: message.trim() || null },
          ),
        )
        setTitle("")
        setMessage("")
        setOpen(false)
        await reloadAddenda()
        toast.success("Addendum issued")
      } catch (error) {
        toast.error("Failed to issue addendum", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">
          Addenda <span className="font-normal text-muted-foreground">{addenda.length}</span>
        </h2>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Issue addendum
        </Button>
      </div>

      {addenda.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No addenda issued. Issue one to notify all invited vendors of a scope change.
        </div>
      ) : (
        <ol className="space-y-2">
          {addenda.map((addendum) => (
            <li key={addendum.id} className="rounded-lg border px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  Addendum {addendum.number}
                  {addendum.title ? ` — ${addendum.title}` : ""}
                </span>
                <span className="text-xs text-muted-foreground">
                  {format(new Date(addendum.issued_at), "MMM d, yyyy")}
                </span>
              </div>
              {addendum.message ? (
                <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{addendum.message}</p>
              ) : null}
            </li>
          ))}
        </ol>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Issue addendum</DialogTitle>
            <DialogDescription>All invited vendors are notified of this update.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Title</Label>
              <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Revised scope" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Message</Label>
              <Textarea value={message} rows={4} onChange={(event) => setMessage(event.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={isSaving}>
              {isSaving ? "Issuing…" : "Issue addendum"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
