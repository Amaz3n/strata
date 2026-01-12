import { format } from "date-fns"

import type { Invoice } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"

type Props = {
  invoice: Invoice
}

function formatMoneyFromCents(cents?: number | null) {
  const value = cents ?? 0
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function getShareUrl(token?: string | null) {
  if (!token) return null
  const base = process.env.NEXT_PUBLIC_APP_URL || "https://app.strata.build"
  return `${base}/i/${token}`
}

export function InvoicePublicView({ invoice }: Props) {
  const shareUrl = getShareUrl(invoice.token)
  const subtotal = invoice.totals?.subtotal_cents ?? invoice.subtotal_cents ?? 0
  const tax = invoice.totals?.tax_cents ?? invoice.tax_cents ?? 0
  const total = invoice.totals?.total_cents ?? invoice.total_cents ?? subtotal + tax
  const balanceDue = invoice.totals?.balance_due_cents ?? invoice.balance_due_cents ?? total

  return (
    <div className="min-h-screen bg-gradient-to-b from-muted/40 to-background">
      <div className="mx-auto max-w-4xl space-y-6 px-4 py-8">
        <div className="rounded-2xl border bg-[#f7f7f7] dark:bg-[#0f0f0f] p-6 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Invoice</p>
              <h1 className="text-3xl font-bold leading-tight">{invoice.title}</h1>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-mono">{invoice.invoice_number}</span>
                {invoice.issue_date && <span>• Issued {format(new Date(invoice.issue_date), "MMM d, yyyy")}</span>}
                {invoice.due_date && <span>• Due {format(new Date(invoice.due_date), "MMM d, yyyy")}</span>}
              </div>
            </div>

            <div className="flex flex-col items-start gap-2 sm:items-end">
              <Badge variant="secondary" className="capitalize">
                {invoice.status}
              </Badge>
              {shareUrl && (
                <a
                  href={shareUrl}
                  className="text-xs text-primary hover:underline break-all text-right"
                  rel="noreferrer"
                  target="_blank"
                >
                  {shareUrl}
                </a>
              )}
            </div>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Line items</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {invoice.lines && invoice.lines.length > 0 ? (
              invoice.lines.map((line, idx) => (
                <div key={idx} className="rounded-xl border bg-muted/30 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-1">
                      <p className="font-medium text-sm">{line.description}</p>
                      <p className="text-xs text-muted-foreground">
                        Qty {line.quantity} {line.unit ? line.unit : ""}
                        {line.taxable === false ? " • Non-taxable" : ""}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold">{formatMoneyFromCents(line.unit_cost_cents)}</p>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No line items.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Totals</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="font-semibold">{formatMoneyFromCents(subtotal)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Tax</span>
              <span className="font-semibold">{formatMoneyFromCents(tax)}</span>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Total</span>
              <span className="text-lg font-bold">{formatMoneyFromCents(total)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Balance due</span>
              <span className="text-base font-semibold">{formatMoneyFromCents(balanceDue)}</span>
            </div>
          </CardContent>
        </Card>

        {invoice.notes && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Notes</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-line text-sm text-muted-foreground">{invoice.notes}</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}






