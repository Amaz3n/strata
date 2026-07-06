"use client"

import { format } from "date-fns"
import { ArrowRight, ReceiptText } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { ClientPortalData } from "@/lib/types"

interface PortalInvoicesTabProps {
  data: ClientPortalData
  token: string
}

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100)
}

function invoiceBalance(invoice: ClientPortalData["invoices"][number]) {
  return invoice.totals?.balance_due_cents ?? invoice.balance_due_cents ?? invoice.total_cents ?? 0
}

export function PortalInvoicesTab({ data, token }: PortalInvoicesTabProps) {
  const invoices = data.invoices ?? []
  const balanceDue = invoices.reduce((sum, invoice) => sum + Math.max(0, invoiceBalance(invoice)), 0)
  const totalPaid = invoices.reduce((sum, invoice) => {
    const total = invoice.totals?.total_cents ?? invoice.total_cents ?? 0
    return sum + Math.max(0, total - invoiceBalance(invoice))
  }, 0)

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
              <ReceiptText className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Balance Due</p>
              <p className="text-2xl font-semibold">{formatCurrency(balanceDue)}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-700">
              <ReceiptText className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Paid</p>
              <p className="text-2xl font-semibold">{formatCurrency(totalPaid)}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Invoices</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No invoices yet</p>
          ) : (
            invoices.map((invoice) => (
              <a
                key={invoice.id}
                href={`/p/${token}/invoices/${invoice.id}`}
                className="flex items-center justify-between gap-3 rounded-md border p-3 transition hover:bg-muted/50"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium">{invoice.title || `Invoice ${invoice.invoice_number ?? ""}`}</p>
                    <Badge variant={invoice.status === "paid" ? "secondary" : "outline"} className="capitalize text-[11px]">
                      {invoice.status}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {invoice.invoice_number ? `#${invoice.invoice_number}` : "Invoice"}
                    {invoice.due_date ? ` · Due ${format(new Date(invoice.due_date), "MMM d, yyyy")}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2 text-right">
                  <div>
                    <p className="text-sm font-semibold">{formatCurrency(invoiceBalance(invoice))}</p>
                    <p className="text-[11px] text-muted-foreground">balance</p>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground" />
                </div>
              </a>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}
