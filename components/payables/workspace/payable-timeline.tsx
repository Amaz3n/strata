"use client"

import { format } from "date-fns"
import Link from "next/link"

import { cn } from "@/lib/utils"
import { formatMoneyFromCents } from "@/components/financials/workspace/workspace-helpers"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import type { PayableRunMembership } from "@/lib/services/org-payables"
import { billStatus } from "./payable-form"

interface TimelineEvent {
  key: string
  label: string
  detail?: string
  amountCents?: number
  date?: string | null
  /** Rendered emphasized — the event describes where the payable is right now. */
  current?: boolean
  href?: string
}

const RUN_STATUS_LABELS: Record<string, string> = {
  draft: "In a draft payment run",
  pending_approval: "In a payment run awaiting approval",
  approved: "In an approved payment run",
  processing: "Payment processing — builder debited, funds in transit",
  partially_paid: "Payment run partially paid",
}

function formatDate(value?: string | null) {
  if (!value) return null
  const parsed = new Date(value.includes("T") ? value : `${value}T00:00:00`)
  return Number.isNaN(parsed.getTime()) ? null : format(parsed, "MMM d, yyyy")
}

/**
 * The payable's evidence trail: how it arrived, who approved it, what has been
 * paid, and — when the payment rail has it — where the money is right now.
 * Labels distinguish builder-side movement from the vendor actually being paid.
 */
export function PayableTimeline({
  bill,
  runMembership,
  accountingEnabled,
}: {
  bill: VendorBillSummary
  runMembership?: PayableRunMembership
  accountingEnabled: boolean
}) {
  const status = billStatus(bill)
  const events: TimelineEvent[] = []

  events.push({ key: "received", label: "Received", date: bill.created_at })

  if (bill.approved_at) {
    events.push({
      key: "approved",
      label: "Approved for payment",
      detail: bill.approved_by ? `by ${bill.approved_by}` : undefined,
      date: bill.approved_at,
    })
  }

  if (runMembership) {
    events.push({
      key: "run",
      label: RUN_STATUS_LABELS[runMembership.status] ?? "In a payment run",
      current: true,
      href: "/payables/payment-runs",
    })
  }

  for (const payment of bill.payments) {
    events.push({
      key: `payment-${payment.id}`,
      label: payment.vendor_credit_applied ? "Vendor credit applied" : payment.provider === "qbo" ? "Payment recorded in QuickBooks" : "Payment recorded",
      detail: payment.reference ?? undefined,
      amountCents: payment.amount_cents,
      date: payment.received_at,
    })
  }

  if (status === "paid" && bill.paid_at) {
    events.push({ key: "paid", label: "Paid in full", date: bill.paid_at, current: !runMembership })
  }

  if (accountingEnabled && bill.qbo_synced_at) {
    events.push({ key: "synced", label: "Synced to QuickBooks", date: bill.qbo_synced_at })
  }

  return (
    <section>
      <h3 className="microlabel">Activity</h3>
      <ol className="mt-3 space-y-0">
        {events.map((event, index) => {
          const date = formatDate(event.date)
          const last = index === events.length - 1
          return (
            <li key={event.key} className="relative flex gap-3 pb-4 last:pb-0">
              {!last ? <span aria-hidden className="absolute left-[3px] top-3 h-full w-px bg-border" /> : null}
              <span
                aria-hidden
                className={cn(
                  "relative mt-1.5 size-[7px] shrink-0 rounded-full",
                  event.current ? "bg-primary ring-4 ring-primary/15" : "bg-muted-foreground/40",
                )}
              />
              <div className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <span className={cn("text-sm", event.current ? "font-medium" : "text-foreground")}>
                    {event.href ? (
                      <Link href={event.href} className="hover:underline">
                        {event.label}
                      </Link>
                    ) : (
                      event.label
                    )}
                  </span>
                  {event.detail ? <span className="ml-2 truncate text-xs text-muted-foreground">{event.detail}</span> : null}
                </div>
                <div className="flex shrink-0 items-baseline gap-3">
                  {event.amountCents != null ? (
                    <span className="font-mono text-xs font-medium tabular-nums text-success">{formatMoneyFromCents(event.amountCents)}</span>
                  ) : null}
                  {date ? <span className="text-xs tabular-nums text-muted-foreground">{date}</span> : null}
                </div>
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
