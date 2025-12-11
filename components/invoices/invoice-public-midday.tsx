"use client"

import { useMemo } from "react"

import type { Invoice as CoreInvoice } from "@/lib/types"
import type { Invoice as MiddayInvoice, LineItem, Template } from "@/packages/invoice/src/types"
import { HtmlTemplate } from "@/packages/invoice/src/templates/html"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

type Props = {
  invoice: CoreInvoice
}

const defaultTemplate: Template = {
  title: "Invoice",
  customerLabel: "Bill to",
  fromLabel: "From",
  invoiceNoLabel: "Invoice #",
  issueDateLabel: "Issue date",
  dueDateLabel: "Due date",
  descriptionLabel: "Description",
  priceLabel: "Price",
  quantityLabel: "Qty",
  totalLabel: "Total",
  totalSummaryLabel: "Total",
  vatLabel: "VAT",
  subtotalLabel: "Subtotal",
  taxLabel: "Tax",
  discountLabel: "Discount",
  timezone: "America/New_York",
  paymentLabel: "Payment details",
  noteLabel: "Notes",
  logoUrl: null,
  currency: "USD",
  paymentDetails: null,
  fromDetails: null,
  noteDetails: null,
  dateFormat: "MM/dd/yyyy",
  includeVat: false,
  includeTax: true,
  includeDiscount: false,
  includeDecimals: true,
  includeUnits: true,
  includeQr: false,
  taxRate: 0,
  vatRate: 0,
  size: "letter",
  deliveryType: "create",
  locale: "en-US",
}

function mapStatus(status?: string | null): MiddayInvoice["status"] {
  switch (status) {
    case "paid":
      return "paid"
    case "overdue":
      return "overdue"
    case "void":
      return "canceled"
    case "sent":
      return "unpaid"
    default:
      return "draft"
  }
}

function mapLineItems(invoice: CoreInvoice): LineItem[] {
  const source = invoice.lines && invoice.lines.length > 0 ? invoice.lines : (invoice.metadata as any)?.lines ?? []

  return (source ?? []).map((line: any) => ({
    name: line.description ?? line.name ?? "Item",
    quantity: Number(line.quantity ?? 0),
    unit: line.unit ?? undefined,
    price: typeof line.unit_cost_cents === "number" ? line.unit_cost_cents / 100 : Number(line.price ?? 0),
    productId: line.productId ?? undefined,
  }))
}

function toMiddayInvoice(invoice: CoreInvoice): MiddayInvoice {
  const lineItems = mapLineItems(invoice)
  const totalCents = invoice.total_cents ?? invoice.totals?.total_cents ?? 0
  const amount = totalCents ? totalCents / 100 : null

  const template: Template = {
    ...defaultTemplate,
    taxRate: (invoice.totals?.tax_rate ?? (invoice.metadata as any)?.tax_rate ?? 0) || 0,
    includeTax: true,
    includeVat: false,
    currency: "USD",
  }

  return {
    id: invoice.id,
    token: invoice.token ?? "",
    invoiceNumber: invoice.invoice_number,
    issueDate: invoice.issue_date ?? null,
    dueDate: invoice.due_date ?? null,
    createdAt: invoice.created_at ?? new Date().toISOString(),
    updatedAt: invoice.updated_at ?? null,
    amount,
    currency: "USD",
    lineItems,
    paymentDetails: null,
    customerDetails: null,
    fromDetails: null,
    noteDetails: null,
    reminderSentAt: null,
    note: invoice.notes ?? null,
    internalNote: null,
    paidAt: invoice.status === "paid" ? invoice.updated_at ?? invoice.created_at ?? null : null,
    vat: null,
    tax: null,
    filePath: null,
    status: mapStatus(invoice.status),
    viewedAt: null,
    template,
    customerName: (invoice.metadata as any)?.customer_name ?? "Customer",
    sentTo: null,
    discount: null,
    topBlock: null,
    bottomBlock: null,
    customer: {
      name: (invoice.metadata as any)?.customer_name ?? null,
      website: null,
      email: null,
    },
    customerId: null,
    team: {
      name: (invoice.metadata as any)?.org_name ?? null,
    },
  }
}

export function InvoicePublicMiddayView({ invoice }: Props) {
  const mapped = useMemo(() => toMiddayInvoice(invoice), [invoice])

  const width = mapped.template.size === "letter" ? 750 : 595
  const height = mapped.template.size === "letter" ? 1056 : 842

  const shareUrl =
    typeof window !== "undefined"
      ? window.location.href
      : `${process.env.NEXT_PUBLIC_APP_URL || "https://app.strata.build"}/i/${invoice.token}`

  return (
    <div className="invoice-grid-bg min-h-screen flex flex-col items-center p-4 sm:p-6">
      <div className="flex flex-col w-full" style={{ maxWidth: width }}>
        <div className="flex justify-between items-center mb-4">
          <div className="flex flex-col gap-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Invoice</p>
            <div className="text-sm text-muted-foreground">
              {mapped.invoiceNumber} • {mapped.customerName ?? "Customer"}
            </div>
          </div>
          <Badge variant="secondary" className="capitalize">
            {mapped.status}
          </Badge>
        </div>

        <div className="shadow-[0_24px_48px_-12px_rgba(0,0,0,0.12)] dark:shadow-[0_24px_48px_-12px_rgba(0,0,0,0.35)] rounded-lg overflow-hidden border bg-background">
          <HtmlTemplate data={mapped} width={width} height={height} />
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-6 flex justify-center pointer-events-none">
        <div className="pointer-events-auto backdrop-blur-lg bg-background/85 border px-3 py-2 rounded-full shadow-sm flex items-center gap-2 shadow-[0_12px_30px_-12px_rgba(0,0,0,0.3)]">
          <Button
            variant="ghost"
            size="sm"
            className="rounded-full"
            onClick={() => {
              // Simple fallback: let the browser print/save-as-PDF
              if (typeof window !== "undefined") {
                window.print()
              }
            }}
          >
            Download
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="rounded-full"
            onClick={async () => {
              try {
                if (typeof navigator !== "undefined" && navigator.clipboard && shareUrl) {
                  await navigator.clipboard.writeText(shareUrl)
                }
              } catch (err) {
                console.error("Failed to copy link", err)
              }
            }}
          >
            Copy link
          </Button>
        </div>
      </div>

      <style jsx global>{`
        .invoice-grid-bg {
          background-color: var(--background);
          background-image: radial-gradient(circle at 1px 1px, rgba(0, 0, 0, 0.05) 1px, transparent 0);
          background-size: 24px 24px;
        }
        .dark .invoice-grid-bg {
          background-color: var(--background);
          background-image: radial-gradient(circle at 1px 1px, rgba(255, 255, 255, 0.08) 1px, transparent 0);
        }
      `}</style>
    </div>
  )
}

