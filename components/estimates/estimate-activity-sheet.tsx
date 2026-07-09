"use client"

import { useEffect, useState, useTransition } from "react"
import { toast } from "sonner"

import type { Estimate } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Send } from "@/components/icons"
import { listEstimateCommentsAction, addEstimateCommentAction } from "@/app/(app)/estimates/actions"

import { unwrapAction } from "@/lib/action-result"

type Comment = {
  id: string
  author_type: string
  author_name: string | null
  author_email: string | null
  kind: string
  body: string | null
  created_at: string
}

const KIND_LABEL: Record<string, string> = {
  sent: "sent the estimate",
  approval: "approved",
  rejection: "declined",
  changes_requested: "requested changes",
  revision: "revised the estimate",
  viewed: "viewed the estimate",
  comment: "",
}

function formatTime(value: string) {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

interface Props {
  estimate: (Estimate & { recipient_name?: string | null }) | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function EstimateActivitySheet({ estimate, open, onOpenChange }: Props) {
  const [comments, setComments] = useState<Comment[]>([])
  const [loading, setLoading] = useState(false)
  const [reply, setReply] = useState("")
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    if (!open || !estimate) return
    let active = true
    setLoading(true)
    listEstimateCommentsAction(estimate.id)
      .then((data) => {
        if (active) setComments(data as Comment[])
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [open, estimate])

  function postReply() {
    if (!estimate || !reply.trim()) return
    startTransition(async () => {
      try {
        unwrapAction(await addEstimateCommentAction(estimate.id, reply.trim()))
        const data = await listEstimateCommentsAction(estimate.id)
        setComments(data as Comment[])
        setReply("")
        toast.success("Reply added")
      } catch (error: any) {
        toast.error(error?.message ?? "Couldn't post reply")
      }
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle>{estimate?.title ?? "Estimate"}</SheetTitle>
          <SheetDescription>
            {estimate?.recipient_name ? `Client: ${estimate.recipient_name}` : "Activity & client responses"}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
          {estimate?.decision_note ? (
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Latest client note
              </p>
              <p className="whitespace-pre-line">{estimate.decision_note}</p>
              {estimate.client_decision_name ? (
                <p className="mt-1 text-xs text-muted-foreground">— {estimate.client_decision_name}</p>
              ) : null}
            </div>
          ) : null}

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading activity…</p>
          ) : comments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No activity yet. Send the estimate to your client to start.</p>
          ) : (
            <ul className="space-y-3">
              {comments.map((c) => {
                const who = c.author_name ?? (c.author_type === "client" ? "Client" : "Builder")
                const action = KIND_LABEL[c.kind] ?? ""
                return (
                  <li key={c.id} className="text-sm">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-medium">
                        {who}
                        {action ? <span className="font-normal text-muted-foreground"> {action}</span> : null}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">{formatTime(c.created_at)}</span>
                    </div>
                    {c.body ? <p className="mt-0.5 whitespace-pre-line text-muted-foreground">{c.body}</p> : null}
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="border-t px-6 py-4">
          <Separator className="mb-3" />
          <Textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            rows={2}
            placeholder="Add an internal note or reply to the thread…"
          />
          <Button className="mt-2 w-full" size="sm" disabled={pending || !reply.trim()} onClick={postReply}>
            <Send className="mr-2 h-4 w-4" />
            Post reply
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
