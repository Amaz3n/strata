"use client"

import { useMemo, useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { BidActivityItem, BidAddendum, BidPackage } from "@/lib/services/bids"
import type { Rfi } from "@/lib/types"
import { answerBidPackageRfiAction, createBidAddendumAction } from "@/app/(app)/bids/actions"
import { unwrapAction } from "@/lib/action-result"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { activityActor, activityLabel, type BidWorkbenchContext } from "@/components/bids/bid-workbench-helpers"

/** Events the feed already shows as a question or an addendum of their own. */
const SHOWN_ELSEWHERE = new Set(["bid_addendum_created", "bid_rfi_answered"])
const ACTIVITY_PREVIEW = 5

type FeedItem =
  | { kind: "question"; at: string; rfi: Rfi }
  | { kind: "addendum"; at: string; addendum: BidAddendum }
  | { kind: "activity"; at: string; item: BidActivityItem }

const stamp = (at: string) => format(new Date(at), "MMM d, h:mm a")

/**
 * Everything said about a package, in one thread: trades' questions, your
 * answers, addenda, and what happened. An answer shared with everyone becomes
 * an addendum, so there is only ever one way to tell the bidders something.
 */
export function BidConversation({
  context,
  bidPackage,
  rfis,
  addenda,
  activity,
  onChanged,
}: {
  context: BidWorkbenchContext
  bidPackage: BidPackage
  rfis: Rfi[]
  addenda: BidAddendum[]
  activity: BidActivityItem[]
  onChanged: () => Promise<void>
}) {
  const [showAll, setShowAll] = useState(false)
  const [message, setMessage] = useState("")
  const [title, setTitle] = useState("")
  const [isPosting, startPosting] = useTransition()
  const live = bidPackage.status !== "draft" && bidPackage.status !== "cancelled" && bidPackage.status !== "awarded"
  const withContext = { ...context, bidPackageId: bidPackage.id }

  const open = rfis.filter((rfi) => !isAnswered(rfi))
  const feed = useMemo(() => {
    const items: FeedItem[] = [
      ...rfis.filter(isAnswered).map((rfi): FeedItem => ({ kind: "question", at: rfi.answered_at ?? rfi.submitted_at ?? "", rfi })),
      ...addenda.map((addendum): FeedItem => ({ kind: "addendum", at: addendum.issued_at, addendum })),
      ...activity
        .filter((item) => !SHOWN_ELSEWHERE.has(item.event_type))
        .map((item): FeedItem => ({ kind: "activity", at: item.created_at, item })),
    ]
    return items.filter((item) => item.at).sort((a, b) => b.at.localeCompare(a.at))
  }, [rfis, addenda, activity])
  const visible = showAll ? feed : feed.slice(0, ACTIVITY_PREVIEW)

  function postAddendum() {
    if (!message.trim()) return
    startPosting(async () => {
      try {
        const result = unwrapAction(
          await createBidAddendumAction(withContext, {
            bid_package_id: bidPackage.id,
            title: title.trim() || null,
            message: message.trim(),
          }),
        )
        setMessage("")
        setTitle("")
        await onChanged()
        if (result.notifications.failed.length) {
          toast.error(`Addendum ${result.number} saved, but not every bidder was notified`, {
            description: result.notifications.failed.map((entry) => entry.error).join(" · "),
          })
        } else {
          toast.success(`Addendum ${result.number} sent to every bidder`)
        }
      } catch (error) {
        toast.error("Unable to post", { description: error instanceof Error ? error.message : "Please try again." })
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <p className="microlabel">Conversation</p>
        {open.length ? <span className="text-xs font-medium text-warning">{open.length} waiting on you</span> : null}
      </div>

      {open.length ? (
        <div className="space-y-3">
          {open.map((rfi) => (
            <OpenQuestion key={rfi.id} context={withContext} bidPackageId={bidPackage.id} rfi={rfi} onAnswered={onChanged} />
          ))}
        </div>
      ) : null}

      {feed.length === 0 && !open.length ? (
        <p className="text-sm text-muted-foreground">
          {bidPackage.status === "draft"
            ? "Questions from trades land here once the package is out. An answer you share with everyone becomes an addendum."
            : "No questions yet."}
        </p>
      ) : (
        <ol className="space-y-3">
          {visible.map((entry) => (
            <li key={`${entry.kind}-${entry.kind === "question" ? entry.rfi.id : entry.kind === "addendum" ? entry.addendum.id : entry.item.id}`} className="grid grid-cols-[10px_1fr] gap-2.5 text-sm">
              <span
                className={cn(
                  "mt-1.5 h-1.5 w-1.5 rounded-full",
                  entry.kind === "addendum" ? "bg-primary" : entry.kind === "question" ? "bg-success" : "bg-border",
                )}
              />
              <div className="min-w-0">
                {entry.kind === "question" ? (
                  <>
                    <p className="font-medium">{entry.rfi.subject}</p>
                    <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-muted-foreground">{entry.rfi.question}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">Answered {stamp(entry.at)}</p>
                  </>
                ) : entry.kind === "addendum" ? (
                  <>
                    <p className="font-medium">
                      Addendum {entry.addendum.number}
                      {entry.addendum.title ? ` · ${entry.addendum.title}` : ""}
                    </p>
                    {entry.addendum.message ? (
                      <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-muted-foreground">{entry.addendum.message}</p>
                    ) : null}
                    <p className="mt-0.5 text-xs text-muted-foreground">{stamp(entry.at)}</p>
                  </>
                ) : (
                  <p className="text-muted-foreground">
                    <span className="text-foreground">{activityLabel(entry.item.event_type)}</span>
                    {activityActor(entry.item.payload) ? ` · ${activityActor(entry.item.payload)}` : ""}
                    <span className="ml-1.5 text-xs">{stamp(entry.at)}</span>
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      {feed.length > ACTIVITY_PREVIEW ? (
        <Button variant="ghost" size="sm" className="h-7 px-0 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground" onClick={() => setShowAll((value) => !value)}>
          {showAll ? "Show less" : `Show all ${feed.length}`}
        </Button>
      ) : null}

      {live ? (
        <div className="space-y-2 border-t pt-4">
          <Input aria-label="Addendum title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Addendum title (optional)" className="h-8" />
          <Textarea aria-label="Addendum" value={message} onChange={(event) => setMessage(event.target.value)} rows={3} placeholder="Tell every bidder something: a clarification, a revised sheet, a new walk time" />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">Goes to every bidder as Addendum {addenda.length + 1}</span>
            <Button size="sm" onClick={postAddendum} disabled={isPosting || !message.trim()}>
              {isPosting ? "Sending…" : "Send addendum"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function isAnswered(rfi: Rfi) {
  return rfi.status === "answered" || rfi.status === "closed" || Boolean(rfi.answered_at)
}

function OpenQuestion({
  context,
  bidPackageId,
  rfi,
  onAnswered,
}: {
  context: BidWorkbenchContext & { bidPackageId: string }
  bidPackageId: string
  rfi: Rfi
  onAnswered: () => Promise<void>
}) {
  const [body, setBody] = useState("")
  const [broadcast, setBroadcast] = useState(true)
  const [isSaving, startSaving] = useTransition()

  function answer() {
    if (!body.trim()) return
    startSaving(async () => {
      try {
        unwrapAction(
          await answerBidPackageRfiAction(context, {
            bid_package_id: bidPackageId,
            rfi_id: rfi.id,
            body: body.trim(),
            broadcast_as_addendum: broadcast,
          }),
        )
        setBody("")
        await onAnswered()
        toast.success(broadcast ? "Answered everyone as an addendum" : "Answer sent")
      } catch (error) {
        toast.error("Unable to answer", { description: error instanceof Error ? error.message : "Please try again." })
      }
    })
  }

  return (
    <div className="space-y-2 border border-warning/40 p-3">
      <div>
        <p className="text-sm font-medium">{rfi.subject}</p>
        <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted-foreground">{rfi.question}</p>
        {rfi.submitted_at ? <p className="mt-0.5 text-xs text-muted-foreground">Asked {stamp(rfi.submitted_at)}</p> : null}
      </div>
      <Textarea aria-label={`Answer ${rfi.subject}`} value={body} rows={2} onChange={(event) => setBody(event.target.value)} placeholder="Your answer" />
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={broadcast} onCheckedChange={setBroadcast} />
          {broadcast ? "Everyone, as an addendum" : "Only the trade who asked"}
        </label>
        <Button size="sm" onClick={answer} disabled={isSaving || !body.trim()}>
          {isSaving ? "Sending…" : "Answer"}
        </Button>
      </div>
    </div>
  )
}
