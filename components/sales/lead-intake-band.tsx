"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { dismissLeadReceiptAction, retryLeadReceiptAction } from "@/app/(app)/sales/lead-actions"
import { InquiryRegistrationSheet, type InquiryFromLead } from "@/components/sales/new-inquiry-sheet"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"
import type { LeadAttention, LeadAttentionKind, LeadAttentionRow } from "@/lib/services/lead-intake"
import { cn, formatPhone } from "@/lib/utils"

const KIND_LABELS: Record<LeadAttentionKind, string> = {
  failed: "Not filed",
  retrying: "Retrying",
  unrouted: "No owner",
}

const FAILURE_LABELS: Record<string, string> = {
  invalid_payload: "The form sent something Arc cannot read",
  no_contact_key: "No email or phone to reach them",
  unknown_community: "The community on the form is not one of yours",
  filing_error: "Arc could not file it after three tries",
}

const time = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

function why(row: LeadAttentionRow) {
  if (row.kind === "retrying") {
    return `Attempt ${row.attempts} failed${row.nextAttemptAt ? ` · next try ${time.format(new Date(row.nextAttemptAt))}` : ""}`
  }
  if (row.kind === "unrouted") return row.detail ?? "Nobody could take this lead"
  return (row.failureCode && FAILURE_LABELS[row.failureCode]) ?? row.detail ?? "Not filed"
}

/**
 * Website leads that need a person, on the desk that works them: deliveries
 * that could not be filed (and why), ones still retrying (and when), and leads
 * filed with no owner. Absent when nothing waits. Retry and Dismiss call the
 * lead intake service; an ownerless lead opens its deal, where the owner is set.
 * Given the registration card's options (the Sales desk), a failed delivery can
 * also be filed by hand: the card opens with what the form sent, and
 * registering files the delivery onto the deal.
 * `compact` stacks each row for the Pipeline's narrow list column.
 */
export function LeadIntakeBand({ attention, compact = false, registration }: {
  attention: LeadAttention
  compact?: boolean
  registration?: { communities: Array<{ id: string; name: string }>; teamMembers: Array<{ id: string; name: string }> }
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [dismissing, setDismissing] = useState<LeadAttentionRow | null>(null)
  const [note, setNote] = useState("")
  const [filing, setFiling] = useState<InquiryFromLead | null>(null)
  if (attention.rows.length === 0) return null

  function retry(row: LeadAttentionRow) {
    startTransition(async () => {
      try {
        const outcome = unwrapAction(await retryLeadReceiptAction(row.receiptId))
        if (outcome.status === "filed" || outcome.status === "merged") toast.success(`${row.contactName ?? "Lead"} filed`)
        else if (outcome.status === "retrying") toast.message("Still failing — Arc will keep trying")
        else toast.error("Still not filed", { description: "message" in outcome ? outcome.message : undefined })
        router.refresh()
      } catch (error) {
        toast.error("That did not go through", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  function dismiss() {
    const row = dismissing
    if (!row) return
    startTransition(async () => {
      try {
        unwrapAction(await dismissLeadReceiptAction({ receiptId: row.receiptId, note }))
        toast.success("Lead dismissed")
        setDismissing(null)
        setNote("")
        router.refresh()
      } catch (error) {
        toast.error("That did not go through", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  const { counts } = attention
  const summary = [
    counts.failed ? `${counts.failed} not filed` : null,
    counts.retrying ? `${counts.retrying} retrying` : null,
    counts.unrouted ? `${counts.unrouted} without an owner` : null,
  ].filter(Boolean).join(" · ")

  return (
    <section className={cn(compact ? "border-b bg-background" : "border")} aria-label="Website leads needing attention">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b px-3 py-2">
        <h2 className="microlabel">Website leads need attention</h2>
        <p className="text-[11px] text-muted-foreground">
          <span className="tabular-nums text-foreground">{summary}</span>
          {attention.truncated ? " · newest 100 shown" : null}
        </p>
      </div>
      <ul className="divide-y">
        {attention.rows.map((row) => (
          <li
            key={row.receiptId}
            className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-xs transition-colors hover:bg-muted/40"
          >
            <span
              className={cn(
                "w-20 shrink-0 text-[11px] font-medium",
                row.kind === "failed" ? "text-destructive" : "text-warning",
              )}
            >
              {KIND_LABELS[row.kind]}
            </span>
            <span className={cn("min-w-0 truncate", compact ? "flex-1" : "w-48 shrink-0")}>
              {row.dealHref ? (
                <Link href={row.dealHref} className="font-medium hover:underline">
                  {row.contactName ?? "Unnamed lead"}
                </Link>
              ) : (
                <span className="font-medium">{row.contactName ?? "Unnamed lead"}</span>
              )}
              <span className="ml-1.5 text-muted-foreground">
                {row.contactEmail ?? (row.contactPhone ? formatPhone(row.contactPhone) : "")}
              </span>
            </span>
            <span className={cn("truncate text-muted-foreground", compact ? "w-full" : "w-44 shrink-0")}>
              {row.sourceName}
              {row.communityName ? ` · ${row.communityName}` : ""}
            </span>
            <span className={cn("min-w-0 truncate", compact ? "w-full" : "flex-1")} title={row.detail ?? undefined}>
              {why(row)}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{time.format(new Date(row.receivedAt))}</span>
            {row.kind === "failed" && attention.canAct ? (
              <span className="flex shrink-0 gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 rounded-none px-2 text-[11px]"
                  disabled={isPending}
                  onClick={() => setDismissing(row)}
                >
                  Dismiss
                </Button>
                {registration ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 rounded-none px-2 text-[11px]"
                    disabled={isPending}
                    onClick={() => setFiling({ receiptId: row.receiptId, name: row.contactName, email: row.contactEmail, phone: row.contactPhone, communityId: row.communityId })}
                  >
                    File by hand
                  </Button>
                ) : null}
                <Button size="sm" className="h-6 rounded-none px-2 text-[11px]" disabled={isPending} onClick={() => retry(row)}>
                  Retry
                </Button>
              </span>
            ) : row.kind === "unrouted" && row.dealHref ? (
              <Button asChild size="sm" variant="outline" className="h-6 shrink-0 rounded-none px-2 text-[11px]">
                <Link href={row.dealHref}>Assign owner</Link>
              </Button>
            ) : null}
          </li>
        ))}
      </ul>

      {registration ? (
        <InquiryRegistrationSheet
          communities={registration.communities}
          teamMembers={registration.teamMembers}
          open={filing !== null}
          onOpenChange={(open) => { if (!open) setFiling(null) }}
          lead={filing}
        />
      ) : null}

      <Dialog open={dismissing !== null} onOpenChange={(open) => (open ? null : setDismissing(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dismiss {dismissing?.contactName ?? "this lead"}?</DialogTitle>
            <DialogDescription>
              It leaves the desk and is never filed. Its submission is deleted after 90 days.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Why — spam, a test, entered by hand as a walk-in…"
            aria-label="Reason for dismissing"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDismissing(null)} disabled={isPending}>
              Keep it
            </Button>
            <Button onClick={dismiss} disabled={isPending || note.trim().length < 3}>
              Dismiss lead
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

/** The band's shape while it loads: a header and two rows. */
export function LeadIntakeBandSkeleton() {
  return (
    <div className="border" aria-hidden>
      <div className="border-b px-3 py-2">
        <Skeleton className="h-3 w-48 rounded-none" />
      </div>
      {[0, 1].map((row) => (
        <div key={row} className="flex items-center gap-4 px-3 py-2">
          <Skeleton className="h-3 w-20 rounded-none" />
          <Skeleton className="h-3 w-48 rounded-none" />
          <Skeleton className="h-3 flex-1 rounded-none" />
        </div>
      ))}
    </div>
  )
}

/** The band could not load; the desk below it still works. */
export function LeadIntakeBandError() {
  return (
    <p role="alert" className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      Website lead deliveries could not be loaded. Refresh to try again.
    </p>
  )
}
