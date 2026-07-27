"use client"

import { useRouter } from "next/navigation"
import { useEffect, useState, useTransition } from "react"

import { logDealActivityAction } from "@/app/(app)/sales/actions"
import { CalendarDays, MessageSquare, Plus } from "@/components/icons"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { PillSelect } from "@/components/ui/pill-select"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { unwrapAction } from "@/lib/action-result"
import { ACTIVITY_KINDS, ACTIVITY_LABELS, isActivityKind, type ActivityKind } from "@/lib/sales/activity"

const PROMPTS: Record<ActivityKind, string> = {
  call: "What came out of the call?",
  visit: "What did they see, and what did they say?",
  text: "What was said?",
  email: "What was sent?",
  note: "What is worth remembering?",
}

function localDay(): string {
  const now = new Date()
  const offset = now.getTimezoneOffset() * 60_000
  return new Date(now.getTime() - offset).toISOString().slice(0, 10)
}

/**
 * Logging a touch, in the app's composer dialog — the same shape as a new task
 * or a new issue. It is a dialog rather than an inline box because the note is
 * the whole point: it deserves the focus, and the deal file underneath stays
 * readable while the consultant is still on the phone.
 */
export function LogActivityDialog({
  prospectId,
  buyerName,
  open,
  onOpenChange,
}: {
  prospectId: string
  buyerName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const { toast } = useToast()
  const [kind, setKind] = useState<ActivityKind>("call")
  const [note, setNote] = useState("")
  const [day, setDay] = useState(localDay)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    if (open) return
    setKind("call")
    setNote("")
    setDay(localDay())
  }, [open])

  const submit = () => {
    startTransition(async () => {
      try {
        unwrapAction(
          await logDealActivityAction(prospectId, {
            kind,
            note: note.trim() || null,
            // Today logs at the moment it happened; a back-dated touch lands at
            // midday so it sorts inside its own day rather than against it.
            occurredAt: day === localDay() ? new Date().toISOString() : new Date(`${day}T12:00:00`).toISOString(),
          }),
        )
        toast({ title: `${ACTIVITY_LABELS[kind]} logged` })
        onOpenChange(false)
        router.refresh()
      } catch (error) {
        toast({ title: "Could not log that", description: (error as Error).message })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent showCloseButton={false} className="overflow-hidden p-0 sm:max-w-2xl">
          <form
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault()
                submit()
              }
            }}
            className="flex flex-col"
          >
            <DialogHeader className="space-y-0 px-5 pt-5">
              <DialogTitle className="sr-only">Log activity with {buyerName}</DialogTitle>
              <DialogDescription className="sr-only">
                Record a call, visit, text, email or note on this deal, with what came out of it and the day it happened.
              </DialogDescription>
              <Textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder={PROMPTS[kind]}
                autoFocus
                rows={3}
                className="min-h-24 resize-none border-0 px-0 py-0 text-xl font-medium shadow-none focus-visible:ring-0 md:text-xl"
              />
            </DialogHeader>

            <div className="flex flex-wrap items-center gap-2 px-5 pt-2 pb-2">
              <PillSelect
                value={kind}
                onValueChange={(value) => isActivityKind(value) && setKind(value)}
                icon={MessageSquare}
                items={ACTIVITY_KINDS.map((value) => ({ value, label: ACTIVITY_LABELS[value] }))}
              />
              <div className="flex h-9 w-fit items-center gap-2 bg-muted/50 px-3">
                <CalendarDays className="size-4 shrink-0" />
                <Input
                  type="date"
                  aria-label="When it happened"
                  max={localDay()}
                  value={day}
                  onChange={(event) => setDay(event.target.value || localDay())}
                  className="h-auto w-fit border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
                />
              </div>
            </div>

            <DialogFooter className="items-center justify-end border-t px-5 py-3">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending} className="gap-2">
                {pending ? "Logging…" : `Log ${ACTIVITY_LABELS[kind].toLowerCase()}`}
                <kbd className="inline-flex items-center rounded-none border border-primary-foreground/40 px-1.5 py-0.5 text-xs font-medium text-primary-foreground">
                  ⌘↵
                </kbd>
              </Button>
            </DialogFooter>
          </form>
      </DialogContent>
    </Dialog>
  )
}

/** Self-contained trigger, for the deal file where the button lives beside History. */
export function LogActivityButton({ prospectId, buyerName }: { prospectId: string; buyerName: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="outline" size="sm" className="h-7 rounded-none text-xs" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" />
        Log activity
      </Button>
      <LogActivityDialog prospectId={prospectId} buyerName={buyerName} open={open} onOpenChange={setOpen} />
    </>
  )
}
