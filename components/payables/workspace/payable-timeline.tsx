"use client"

import { format } from "date-fns"
import Link from "next/link"

import { accountingProviderLabel, isAccountingProviderKey } from "@/components/accounting/provider-label"
import { cn } from "@/lib/utils"
import { formatMoneyFromCents } from "@/components/financials/workspace/workspace-helpers"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import type { PayableRunMembership } from "@/lib/services/org-payables"
import type { EntityAuditEntry } from "@/lib/services/audit"
import type { AccountingSyncState } from "@/lib/services/accounting-sync-state"
import { AccountingSyncBadge } from "@/components/accounting/accounting-sync-badge"
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
  syncState?: AccountingSyncState | null
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
  accountingProvider,
  accountingProviderName,
  billSync,
  paymentSync,
  auditTrail = [],
}: {
  bill: VendorBillSummary
  runMembership?: PayableRunMembership
  accountingEnabled: boolean
  /** Provider key of the org's accounting connection, when it is known. */
  accountingProvider?: string | null
  /** Connection label, for providers the catalog does not name. */
  accountingProviderName?: string | null
  billSync?: AccountingSyncState | null
  paymentSync?: AccountingSyncState | null
  auditTrail?: EntityAuditEntry[]
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
      href: "/payables",
    })
  }

  for (const payment of bill.payments) {
    events.push({
      key: `payment-${payment.id}`,
      label: payment.vendor_credit_applied
        ? "Vendor credit applied"
        : isAccountingProviderKey(payment.provider)
          ? `Payment recorded in ${accountingProviderLabel(payment.provider)}`
          : "Payment recorded",
      detail: payment.reference ?? undefined,
      amountCents: payment.amount_cents,
      date: payment.received_at,
    })
  }

  if (status === "paid" && bill.paid_at) {
    events.push({ key: "paid", label: "Paid in full", date: bill.paid_at, current: !runMembership })
  }

  if (accountingEnabled) {
    events.push({
      key: "bill-sync",
      label: "Bill accounting sync",
      date: billSync?.updatedAt ?? null,
      syncState: billSync ?? null,
    })
    if (bill.payments.length > 0) {
      events.push({
        key: "bill-payment-sync",
        label: "Bill-payment accounting sync",
        date: paymentSync?.updatedAt ?? null,
        syncState: paymentSync ?? null,
      })
    }
  }

  for (const entry of auditTrail) {
    const changedKeys = entry.action === "update"
      ? Object.keys(entry.after ?? {}).filter((key) => (entry.before ?? {})[key] !== (entry.after ?? {})[key])
      : []
    const blockedSync = entry.source === "accounting_sync_enqueue"
    events.push({
      key: `audit-${entry.id}`,
      label: blockedSync ? "Accounting sync needs review" : entry.action === "insert" ? "Record created" : entry.action === "delete" ? "Record deleted" : "Record updated",
      detail: blockedSync
        ? String(entry.after?.accounting_sync_reason ?? "enqueue_failed").replaceAll("_", " ")
        : `${entry.actor?.name ?? "System"}${changedKeys.length > 0 ? ` · ${changedKeys.slice(0, 3).join(", ")}${changedKeys.length > 3 ? "…" : ""}` : ""}`,
      date: entry.createdAt,
    })
  }

  events.sort((left, right) => String(left.date ?? "").localeCompare(String(right.date ?? "")))

  return (
    <ol>
      {events.map((event, index) => {
        const date = formatDate(event.date)
        const last = index === events.length - 1
        return (
          <li key={event.key} className="flex gap-4 text-sm">
            {/* Dates in their own gutter so every entry aligns on one axis. */}
            <span className="w-[100px] shrink-0 pt-[3px] text-[13px] tabular-nums text-muted-foreground">
              {date ?? ""}
            </span>
            <span aria-hidden className="relative flex w-2 shrink-0 justify-center">
              <span
                className={cn(
                  "absolute top-[7px] size-[7px] rounded-full",
                  event.current ? "bg-primary ring-4 ring-primary/15" : "bg-muted-foreground/40",
                )}
              />
              {!last ? <span className="mt-[14px] w-px flex-1 bg-border" /> : null}
            </span>
            <div className="flex min-w-0 flex-1 items-baseline justify-between gap-3 pb-5 last:pb-0">
              <div className="min-w-0">
                <span className={event.current ? "font-medium" : undefined}>
                  {event.href ? (
                    <Link href={event.href} className="hover:underline">
                      {event.label}
                    </Link>
                  ) : (
                    event.label
                  )}
                </span>
                {event.detail ? (
                  <span className="ml-2 truncate text-xs text-muted-foreground">{event.detail}</span>
                ) : null}
              </div>
              {event.amountCents != null ? (
                <span className="shrink-0 font-mono text-xs font-medium tabular-nums text-success">
                  {formatMoneyFromCents(event.amountCents)}
                </span>
              ) : event.syncState ? (
                <AccountingSyncBadge
                  status={event.syncState.status}
                  externalId={event.syncState.externalId}
                  error={event.syncState.error}
                  provider={event.syncState.provider ?? accountingProvider}
                  providerLabel={accountingProviderName}
                  syncedAt={event.syncState.syncedAt}
                  compact
                />
              ) : event.key.endsWith("-sync") ? (
                <AccountingSyncBadge
                  status="not_synced"
                  provider={accountingProvider}
                  providerLabel={accountingProviderName}
                  compact
                />
              ) : null}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
