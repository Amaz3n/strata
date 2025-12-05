"use client"

import { format } from "date-fns"

import type { Invoice } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"

interface Props {
  invoice: Invoice
  portalType?: "client" | "sub"
}

function formatMoneyFromCents(cents?: number | null) {
  const value = cents ?? 0
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

export function InvoicePortalClient({ invoice, portalType = "client" }: Props) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted px-4 py-8">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="text-center space-y-2">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Invoice</p>
          <h1 className="text-2xl font-bold">{invoice.title}</h1>
          <div className="flex justify-center gap-2 flex-wrap">
            <Badge variant="secondary" className="capitalize">
              {invoice.status}
            </Badge>
            {invoice.due_date && (
              <Badge variant="outline">Due {format(new Date(invoice.due_date), "MMM d, yyyy")}</Badge>
            )}
            <Badge variant="outline" className="capitalize">
              {portalType}
            </Badge>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <div className="flex items-center justify-between">
              <span>Invoice #</span>
              <span className="font-semibold text-foreground">{invoice.invoice_number}</span>
            </div>
            {invoice.issue_date && (
              <div className="flex items-center justify-between">
                <span>Issued</span>
                <span>{format(new Date(invoice.issue_date), "MMM d, yyyy")}</span>
              </div>
            )}
            {invoice.due_date && (
              <div className="flex items-center justify-between">
                <span>Due</span>
                <span>{format(new Date(invoice.due_date), "MMM d, yyyy")}</span>
              </div>
            )}
            {invoice.notes && <p className="mt-2 whitespace-pre-line">{invoice.notes}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Line items</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {invoice.lines && invoice.lines.length > 0 ? (
              invoice.lines.map((line, idx) => (
                <div key={idx} className="rounded-lg border bg-muted/30 p-3 space-y-1">
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-sm">{line.description}</p>
                    <p className="text-sm">{formatMoneyFromCents(line.unit_cost_cents)}</p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Qty {line.quantity} {line.unit ? line.unit : ""}
                    {line.taxable === false ? " • Non-taxable" : ""}
                  </p>
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
              <span className="font-semibold">
                {formatMoneyFromCents(invoice.totals?.subtotal_cents ?? invoice.subtotal_cents)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Tax</span>
              <span className="font-semibold">
                {formatMoneyFromCents(invoice.totals?.tax_cents ?? invoice.tax_cents)}
              </span>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Total</span>
              <span className="text-lg font-bold">
                {formatMoneyFromCents(invoice.totals?.total_cents ?? invoice.total_cents)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Balance due</span>
              <span className="text-base font-semibold">
                {formatMoneyFromCents(invoice.totals?.balance_due_cents ?? invoice.balance_due_cents)}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
