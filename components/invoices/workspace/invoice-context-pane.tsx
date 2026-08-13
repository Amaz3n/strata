"use client"

import { useState } from "react"
import { format } from "date-fns"
import { ExternalLink, MinusCircle } from "lucide-react"
import { toast } from "sonner"

import { voidReceivableAdjustmentAction } from "@/app/(app)/invoices/actions"
import { unwrapAction } from "@/lib/action-result"
import { Button } from "@/components/ui/button"
import type { Invoice, InvoiceDelivery, InvoiceView, Payment, PaymentReversal, ReceivableAdjustment } from "@/lib/types"
import { qboTxnUrl } from "@/lib/integrations/accounting/qbo/links"
import { cn } from "@/lib/utils"

import { ReceivableAdjustmentDialog } from "../receivable-adjustment-dialog"
import { balanceCentsOf } from "./receivables-filters"
import { formatMoneyFromCents } from "./invoice-ui"

type SyncRecord = { id: string; status: string; last_synced_at: string; error_message?: string | null; qbo_id?: string | null }

interface InvoiceContextPaneProps {
  projectId: string
  invoice: Invoice | null
  link?: string
  views?: InvoiceView[]
  deliveries?: InvoiceDelivery[]
  syncHistory?: SyncRecord[]
  payments?: Payment[]
  reversals?: PaymentReversal[]
  adjustments?: ReceivableAdjustment[]
  booksEntries?: Array<{ id: string; entry_date: string; status: string; posting_key: string; posted_at?: string | null; reversal_of_entry_id?: string | null }>
  loading?: boolean
  onChanged?: () => void | Promise<void>
}

function describeUserAgent(ua?: string | null): string | null {
  if (!ua) return null
  const device = /iphone/i.test(ua) ? "iPhone" : /ipad/i.test(ua) ? "iPad" : /android/i.test(ua) ? "Android" : /macintosh|mac os x/i.test(ua) ? "Mac" : /windows/i.test(ua) ? "Windows" : null
  const browser = /edg\//i.test(ua) ? "Edge" : /chrome|crios/i.test(ua) ? "Chrome" : /firefox|fxios/i.test(ua) ? "Firefox" : /safari/i.test(ua) ? "Safari" : null
  return [device, browser].filter(Boolean).join(" · ") || null
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-sm">
      <span className="microlabel shrink-0 pt-0.5">{label}</span>
      <span className="min-w-0 text-right text-foreground">{children}</span>
    </div>
  )
}

export function InvoiceContextPane({ projectId, invoice, link, views, deliveries, syncHistory, payments, reversals, adjustments, booksEntries, loading, onChanged }: InvoiceContextPaneProps) {
  const [adjusting, setAdjusting] = useState(false)
  const [voidingAdjustmentId, setVoidingAdjustmentId] = useState<string | null>(null)
  if (!invoice) {
    return (
      <div className="flex h-full flex-col bg-muted/20">
        <div className="flex h-16 shrink-0 items-center border-b bg-background px-4">
          <span className="text-sm font-semibold">Details</span>
        </div>
        <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
          {loading ? "Loading…" : "Provenance, QuickBooks status, and client activity appear here once the draft is saved."}
        </div>
      </div>
    )
  }

  const metadata = (invoice.metadata ?? {}) as Record<string, any>
  const total = invoice.total_cents ?? invoice.totals?.total_cents ?? 0
  const balance = balanceCentsOf(invoice)

  const sourceDrawId = metadata.source_draw_id as string | undefined
  const sourceChangeOrderId = metadata.source_change_order_id as string | undefined
  const sourcePayAppId = metadata.source_pay_application_id as string | undefined
  const sourceType = metadata.source_type as string | undefined

  const sentAt = (invoice.sent_at ?? metadata.sent_at) as string | undefined
  const qboUrl = invoice.qbo_id ? qboTxnUrl("invoice", invoice.qbo_id) : null
  const appliedPayments = (payments ?? []).filter((p) => p.status === "succeeded")
  const activeReversals = (reversals ?? []).filter((reversal) => reversal.status !== "failed")
  const postedAdjustments = (adjustments ?? []).filter((adjustment) => adjustment.status === "posted")
  const collected = Math.max(
    appliedPayments.reduce((sum, payment) => sum + payment.amount_cents, 0) -
      activeReversals.reduce((sum, reversal) => sum + reversal.amount_cents, 0),
    0,
  )
  const adjusted = postedAdjustments.reduce((sum, adjustment) => sum + adjustment.amount_cents, 0)
  const activity = [
    ...(deliveries ?? []).map((delivery) => ({
      id: `delivery:${delivery.id}`,
      at: delivery.delivered_at ?? delivery.sent_at ?? delivery.failed_at ?? delivery.queued_at,
      label:
        delivery.metadata?.kind === "payment_reminder"
          ? delivery.status === "failed" ? "Reminder failed" : "Payment reminder sent"
          : delivery.status === "failed" ? "Invoice delivery failed" : `Invoice ${delivery.status}`,
      detail: delivery.error_message ?? delivery.recipient ?? null,
      tone: delivery.status === "failed" || delivery.status === "bounced" ? "destructive" : "default",
    })),
    ...(views ?? []).map((view) => ({
      id: `view:${view.id}`,
      at: view.viewed_at,
      label: "Invoice viewed",
      detail: describeUserAgent(view.user_agent),
      tone: "default",
    })),
    ...(payments ?? []).map((payment) => ({
      id: `payment:${payment.id}`,
      at: payment.received_at,
      label:
        payment.status === "succeeded"
          ? `Payment received · ${formatMoneyFromCents(payment.amount_cents)}`
          : payment.status === "processing"
            ? `Payment processing · ${formatMoneyFromCents(payment.amount_cents)}`
            : `Payment ${payment.status}`,
      detail: payment.reference ?? payment.method ?? null,
      tone: payment.status === "succeeded" ? "positive" : payment.status === "failed" ? "destructive" : "default",
    })),
    ...activeReversals.map((reversal) => ({
      id: `reversal:${reversal.id}`,
      at: reversal.occurred_at ?? reversal.created_at ?? "",
      label: `Payment ${reversal.reversal_type.replaceAll("_", " ")} · −${formatMoneyFromCents(reversal.amount_cents)}`,
      detail: reversal.reason ?? null,
      tone: "destructive",
    })),
    ...(adjustments ?? []).map((adjustment) => ({
      id: `adjustment:${adjustment.id}`,
      at: adjustment.voided_at ?? adjustment.created_at,
      label: `${adjustment.adjustment_type === "write_off" ? "Write-off" : "Credit memo"}${adjustment.status === "void" ? " voided" : " posted"} · −${formatMoneyFromCents(adjustment.amount_cents)}`,
      detail: adjustment.reason,
      tone: adjustment.status === "void" ? "default" : "destructive",
    })),
  ].filter((entry) => entry.at).sort((left, right) => String(right.at).localeCompare(String(left.at)))

  const canAdjust = Boolean(
    onChanged &&
    invoice.client_visible &&
    balance > 0 &&
    invoice.status !== "void" &&
    metadata.invoice_kind !== "earnest_deposit",
  )

  async function voidAdjustment(adjustment: ReceivableAdjustment) {
    if (!onChanged || !window.confirm(`Void this ${adjustment.adjustment_type === "write_off" ? "write-off" : "credit memo"}? The invoice balance will reopen.`)) return
    setVoidingAdjustmentId(adjustment.id)
    try {
      unwrapAction(await voidReceivableAdjustmentAction(adjustment.id))
      toast.success("Receivable adjustment voided")
      await onChanged()
    } catch (error) {
      toast.error("Could not void adjustment", { description: error instanceof Error ? error.message : "Please try again." })
    } finally {
      setVoidingAdjustmentId(null)
    }
  }

  const provenanceHref = sourceDrawId
    ? `/projects/${projectId}/financials/receivables?tab=draws`
    : sourceChangeOrderId
      ? `/projects/${projectId}/change-orders`
      : sourcePayAppId
        ? `/projects/${projectId}/financials/receivables?tab=payapps`
        : null
  const provenanceLabel = sourceDrawId
    ? "Draw schedule"
    : sourceChangeOrderId
      ? "Change order"
      : sourcePayAppId
        ? "Pay application"
        : sourceType === "from_costs"
          ? "Billable costs"
          : sourceType === "fee"
            ? "Fee billing"
            : "Manual invoice"

  return (
    <div className="flex h-full flex-col bg-muted/20">
      <div className="flex h-16 shrink-0 items-center border-b bg-background px-4">
        <span className="text-sm font-semibold">Details</span>
      </div>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-5">
        {/* Amounts */}
        <section className="space-y-1 border bg-card p-4">
          <Row label="Total">
            <span className="font-mono tabular-nums">{formatMoneyFromCents(total)}</span>
          </Row>
          <Row label="Collected">
            <span className="font-mono tabular-nums text-success">{formatMoneyFromCents(collected)}</span>
          </Row>
          {adjusted > 0 ? <Row label="Adjusted"><span className="font-mono tabular-nums">{formatMoneyFromCents(adjusted)}</span></Row> : null}
          <Row label="Balance">
            <span className={cn("font-mono tabular-nums", balance > 0 ? "text-foreground" : "text-muted-foreground")}>{formatMoneyFromCents(balance)}</span>
          </Row>
          {canAdjust ? (
            <Button type="button" variant="outline" size="sm" className="mt-3 w-full gap-1.5" onClick={() => setAdjusting(true)}>
              <MinusCircle className="h-3.5 w-3.5" />
              Credit or write off
            </Button>
          ) : null}
        </section>

        {postedAdjustments.length > 0 ? (
          <section className="space-y-2">
            <h3 className="microlabel">Credits &amp; write-offs</h3>
            <div className="divide-y border bg-card">
              {postedAdjustments.map((adjustment) => (
                <div key={adjustment.id} className="flex items-start justify-between gap-3 px-3 py-2 text-xs">
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">{adjustment.adjustment_type === "write_off" ? "Write-off" : "Credit memo"} · {formatMoneyFromCents(adjustment.amount_cents)}</p>
                    <p className="truncate text-muted-foreground">{adjustment.reason}</p>
                  </div>
                  <button type="button" className="shrink-0 text-muted-foreground hover:text-destructive disabled:opacity-50" disabled={voidingAdjustmentId === adjustment.id} onClick={() => void voidAdjustment(adjustment)}>
                    {voidingAdjustmentId === adjustment.id ? "Voiding…" : "Void"}
                  </button>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {/* Provenance */}
        <section className="space-y-2">
          <h3 className="microlabel">Source</h3>
          <div className="border bg-card p-3 text-sm">
            {provenanceHref ? (
              <a href={provenanceHref} className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline">
                {provenanceLabel}
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : (
              <span className="text-muted-foreground">{provenanceLabel}</span>
            )}
          </div>
        </section>

        {/* QuickBooks */}
        {invoice.qbo_sync_status ? (
          <section className="space-y-2">
            <h3 className="microlabel">QuickBooks</h3>
            <div className="space-y-2 border bg-card p-3">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="capitalize">{invoice.qbo_sync_status}</span>
                {qboUrl ? (
                  <a href={qboUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                    Open in QuickBooks <ExternalLink className="h-3 w-3" />
                  </a>
                ) : null}
              </div>
              {(syncHistory ?? []).slice(0, 4).map((log) => (
                <div key={log.id} className="border-t pt-2 text-xs text-muted-foreground">
                  <div className="flex items-center justify-between">
                    <span className="font-medium capitalize text-foreground">{log.status}</span>
                    <span>{log.last_synced_at ? new Date(log.last_synced_at).toLocaleDateString() : "—"}</span>
                  </div>
                  {log.error_message ? <p className="mt-0.5 text-destructive">{log.error_message}</p> : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {(booksEntries ?? []).length > 0 ? (
          <section className="space-y-2">
            <h3 className="microlabel">Arc Books impact</h3>
            <div className="space-y-2 border bg-card p-3">
              {(booksEntries ?? []).map((entry) => (
                <div key={entry.id} className="flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <p className="truncate font-medium capitalize text-foreground">{entry.status}</p>
                    <p className="truncate text-muted-foreground">{entry.posting_key.includes("receivable_adjustment") ? "AR adjustment" : "AR / contract billing"} · {entry.entry_date}</p>
                  </div>
                  <a href={`/books/ledger?entry=${entry.id}`} className="shrink-0 font-medium text-primary hover:underline">
                    View entry
                  </a>
                </div>
              ))}
            </div>
          </section>
        ) : invoice.client_visible ? (
          <section className="space-y-2">
            <h3 className="microlabel">Arc Books impact</h3>
            <div className="border bg-card p-3 text-xs text-muted-foreground">Waiting for the next Books projection.</div>
          </section>
        ) : null}

        {/* Payments applied */}
        {appliedPayments.length > 0 ? (
          <section className="space-y-2">
            <h3 className="microlabel">Payments applied</h3>
            <div className="divide-y border bg-card">
              {appliedPayments.map((payment) => (
                <div key={payment.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="truncate text-xs text-muted-foreground">
                    {payment.received_at ? format(new Date(payment.received_at), "MMM d, yyyy") : "—"}
                  </span>
                  <span className="shrink-0 font-mono tabular-nums text-success">{formatMoneyFromCents(payment.amount_cents)}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {/* Collection timeline */}
        <section className="space-y-2">
          <h3 className="microlabel">Collection timeline</h3>
          <div className="space-y-2 border bg-card p-3 text-sm">
            {activity.length === 0 && sentAt ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Sent</span>
                <span className="text-xs">{format(new Date(sentAt), "MMM d, yyyy")}</span>
              </div>
            ) : activity.length === 0 ? (
              <p className="text-xs text-muted-foreground">Not sent yet.</p>
            ) : null}
            {activity.slice(0, 15).map((entry) => (
              <div key={entry.id} className="flex items-start justify-between gap-2 border-t pt-2 first:border-t-0 first:pt-0">
                <div className="min-w-0">
                  <p className={cn("truncate text-xs font-medium", entry.tone === "positive" && "text-success", entry.tone === "destructive" && "text-destructive")}>{entry.label}</p>
                  {entry.detail ? <p className="truncate text-[11px] text-muted-foreground">{entry.detail}</p> : null}
                </div>
                <span className="shrink-0 text-[11px] text-muted-foreground">{format(new Date(entry.at), "MMM d, h:mm a")}</span>
              </div>
            ))}
          </div>
        </section>

        {link ? (
          <section className="space-y-2">
            <h3 className="microlabel">Client link</h3>
            <a href={link} target="_blank" rel="noreferrer" className="block truncate border bg-card p-3 text-xs text-primary hover:underline">
              {link}
            </a>
          </section>
        ) : null}
      </div>
      <ReceivableAdjustmentDialog invoice={invoice} open={adjusting} onOpenChange={setAdjusting} onPosted={async () => { if (onChanged) await onChanged() }} />
    </div>
  )
}
