"use client"

import { format } from "date-fns"
import { ExternalLink } from "lucide-react"

import type { Invoice, InvoiceView, Payment } from "@/lib/types"
import { qboTxnUrl } from "@/lib/integrations/accounting/qbo/links"
import { cn } from "@/lib/utils"

import { balanceCentsOf } from "./receivables-filters"
import { formatMoneyFromCents } from "./invoice-ui"

type SyncRecord = { id: string; status: string; last_synced_at: string; error_message?: string | null; qbo_id?: string | null }

interface InvoiceContextPaneProps {
  projectId: string
  invoice: Invoice | null
  link?: string
  views?: InvoiceView[]
  syncHistory?: SyncRecord[]
  payments?: Payment[]
  loading?: boolean
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

export function InvoiceContextPane({ projectId, invoice, link, views, syncHistory, payments, loading }: InvoiceContextPaneProps) {
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
  const paid = Math.max(total - balance, 0)

  const sourceDrawId = metadata.source_draw_id as string | undefined
  const sourceChangeOrderId = metadata.source_change_order_id as string | undefined
  const sourcePayAppId = metadata.source_pay_application_id as string | undefined
  const sourceType = metadata.source_type as string | undefined

  const sentAt = (invoice.sent_at ?? metadata.sent_at) as string | undefined
  const qboUrl = invoice.qbo_id ? qboTxnUrl("invoice", invoice.qbo_id) : null
  const appliedPayments = (payments ?? []).filter((p) => p.status === "succeeded")

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
          <Row label="Paid">
            <span className="font-mono tabular-nums text-success">{formatMoneyFromCents(paid)}</span>
          </Row>
          <Row label="Balance">
            <span className={cn("font-mono tabular-nums", balance > 0 ? "text-foreground" : "text-muted-foreground")}>{formatMoneyFromCents(balance)}</span>
          </Row>
        </section>

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

        {/* Client activity */}
        <section className="space-y-2">
          <h3 className="microlabel">Client activity</h3>
          <div className="space-y-2 border bg-card p-3 text-sm">
            {sentAt ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Sent</span>
                <span className="text-xs">{format(new Date(sentAt), "MMM d, yyyy")}</span>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Not sent yet.</p>
            )}
            {(views ?? []).slice(0, 6).map((view) => (
              <div key={view.id} className="flex items-center justify-between gap-2 border-t pt-2 text-xs text-muted-foreground">
                <span>Viewed{describeUserAgent(view.user_agent) ? ` · ${describeUserAgent(view.user_agent)}` : ""}</span>
                <span>{view.viewed_at ? format(new Date(view.viewed_at), "MMM d") : ""}</span>
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
    </div>
  )
}
