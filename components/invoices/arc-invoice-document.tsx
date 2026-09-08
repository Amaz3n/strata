import type { Invoice } from "@/lib/types"

/**
 * HTML rendition of the canonical Arc invoice PDF (`lib/pdfs/invoice.tsx`). Kept visually in sync
 * with that template so the on-page preview at /i/[token], the portal, and the composer's live
 * preview all match the downloaded / emailed PDF. The invoice memo is the builder's own note and
 * never appears here.
 */

export type ArcInvoiceLine = {
  description: string
  quantity: number
  unit?: string | null
  unitCostCents: number
  lineTotalCents: number
}

export type ArcInvoiceDocumentData = {
  invoiceNumber: string
  projectName?: string | null
  logoUrl?: string | null
  issueDate?: string | null
  dueDate?: string | null
  fromLines: string[]
  billToLines: string[]
  notes?: string | null
  payUrl?: string | null
  /** Ways the customer can pay online, as printed labels. Empty hides the line. */
  paymentMethods?: string[] | null
  subtotalCents: number
  taxCents: number
  totalCents: number
  amountDueCents?: number | null
  taxRate?: number | null
  discountCents?: number | null
  discountPercent?: number | null
}

export type ArcInvoiceBranding = {
  name?: string | null
  email?: string | null
  address?: any
  logoUrl?: string | null
  projectName?: string | null
  payUrl?: string | null
}

/** The labels printed for each online payment method the invoice allows. */
export const PAYMENT_METHOD_LABELS = { ach: "Bank transfer (ACH)", card: "Card" } as const

/** Which online methods an invoice allows; both unless it says otherwise. */
export function invoicePaymentMethods(metadata: Record<string, unknown> | null | undefined): { ach: boolean; card: boolean } {
  const raw = metadata?.payment_methods
  if (!raw || typeof raw !== "object") return { ach: true, card: true }
  const record = raw as Record<string, unknown>
  return { ach: record.ach !== false, card: record.card !== false }
}

export function paymentMethodLabels(methods: { ach: boolean; card: boolean }): string[] {
  const labels: string[] = []
  if (methods.ach) labels.push(PAYMENT_METHOD_LABELS.ach)
  if (methods.card) labels.push(PAYMENT_METHOD_LABELS.card)
  return labels
}

function money(cents: number) {
  return ((cents ?? 0) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function formatDate(value?: string | null) {
  if (!value) return "-"
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
}

// Matches `cleanLines` in lib/pdfs/invoice.tsx so From/To blocks break identically.
function cleanLines(lines: string[]) {
  const cleaned = lines
    .flatMap((line) => String(line ?? "").split(/\n|,/g))
    .map((line) => line.trim())
    .filter(Boolean)
  return cleaned.length > 0 ? cleaned : ["-"]
}

function addressToLines(address: any): string[] {
  if (!address) return []
  if (typeof address === "string") return [address]
  if (address.formatted) return [address.formatted]
  return [
    address.street1,
    address.street2,
    [address.city, address.state, address.postal_code].filter(Boolean).join(" "),
    address.country,
  ]
    .filter(Boolean)
    .map((v: any) => String(v))
}

/**
 * Pure, client-safe mapper that mirrors the field assembly in `buildInvoicePdfData`
 * (lib/pdfs/invoice-data.ts) minus server-only logo normalization. The logo is passed through
 * as a plain URL from the public org-logos bucket.
 */
export function toArcInvoiceData(invoice: Invoice, branding?: ArcInvoiceBranding | null): ArcInvoiceDocumentData {
  const metadata = (invoice.metadata ?? {}) as Record<string, any>

  const fromAddress =
    typeof metadata.from_address === "string" && metadata.from_address.trim().length > 0
      ? [metadata.from_address]
      : addressToLines(branding?.address)

  const fromLines = [
    (metadata.from_name as string | undefined) ?? branding?.name ?? "Arc Builder",
    (metadata.from_email as string | undefined) ?? branding?.email ?? "",
    ...fromAddress,
  ]
    .map((line) => (typeof line === "string" ? line.trim() : ""))
    .filter((line) => line.length > 0)

  const customerAddress =
    typeof metadata.customer_address === "string" ? [metadata.customer_address] : addressToLines(metadata.customer_address)

  const billToLines = [
    invoice.customer_name ?? metadata.customer_name ?? "Client",
    typeof metadata.customer_email === "string" ? metadata.customer_email : (invoice.sent_to_emails?.[0] ?? ""),
    ...customerAddress,
  ]
    .map((line) => String(line ?? "").trim())
    .filter((line) => line.length > 0)

  return {
    invoiceNumber: invoice.invoice_number,
    projectName: branding?.projectName ?? (metadata.project_name as string | undefined) ?? null,
    logoUrl: branding?.logoUrl ?? null,
    issueDate: invoice.issue_date ?? null,
    dueDate: invoice.due_date ?? null,
    fromLines,
    billToLines,
    notes:
      (typeof invoice.notes === "string" && invoice.notes.trim().length > 0 ? invoice.notes : (metadata.payment_details as string | undefined)) ||
      null,
    payUrl: branding?.payUrl ?? null,
    paymentMethods: paymentMethodLabels(invoicePaymentMethods(metadata)),
    subtotalCents: invoice.subtotal_cents ?? invoice.totals?.subtotal_cents ?? 0,
    taxCents: invoice.tax_cents ?? invoice.totals?.tax_cents ?? 0,
    totalCents: invoice.total_cents ?? invoice.totals?.total_cents ?? 0,
    amountDueCents: invoice.balance_due_cents ?? invoice.totals?.balance_due_cents ?? null,
    taxRate: invoice.totals?.tax_rate ?? (metadata.tax_rate as number | undefined) ?? null,
    discountCents: invoice.totals?.discount_cents ?? null,
    discountPercent: invoice.totals?.discount_type === "percent" ? invoice.totals?.discount_value ?? null : null,
  }
}

// Mirrors the line mapping in buildInvoicePdfData so preview rows match the PDF.
export function toArcInvoiceLines(invoice: Invoice): ArcInvoiceLine[] {
  const source = invoice.lines && invoice.lines.length > 0 ? invoice.lines : ((invoice.metadata as any)?.lines ?? [])
  return (source ?? []).map((line: any) => {
    const qty = Number(line.quantity ?? 0)
    const unitCost = Number(line.unit_cost_cents ?? line.unit_price_cents ?? 0)
    const safeQty = Number.isFinite(qty) ? qty : 0
    const safeUnit = Number.isFinite(unitCost) ? unitCost : 0
    return {
      description: line.description ?? line.name ?? "",
      quantity: safeQty,
      unit: line.unit ?? "ea",
      unitCostCents: safeUnit,
      lineTotalCents: Math.round(safeQty * safeUnit),
    }
  })
}

export function ArcInvoiceDocument({
  data,
  lines,
  width,
  height,
}: {
  data: ArcInvoiceDocumentData
  lines: ArcInvoiceLine[]
  width: number
  height: number
}) {
  const fromLines = cleanLines(data.fromLines)
  const billToLines = cleanLines(data.billToLines)
  const amountDue = data.amountDueCents ?? data.totalCents
  const subtitle = data.projectName?.trim() || ""
  const notes = data.notes?.trim() ?? ""
  const methods = (data.paymentMethods ?? []).filter(Boolean)
  const showTax = data.taxCents > 0 || (typeof data.taxRate === "number" && data.taxRate > 0)

  return (
    <div
      className="flex flex-col bg-white text-[#111111]"
      style={{ width, height, paddingTop: 58, paddingBottom: 52, paddingLeft: 64, paddingRight: 64, fontSize: 13 }}
    >
      {/* Title + memo, logo */}
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0 flex-1">
          <h1 className="text-[29px] font-bold leading-none tracking-tight">Invoice</h1>
          {subtitle ? <p className="mt-1.5 text-[14px] leading-snug text-[#6B7280]">{subtitle}</p> : null}
        </div>
        {data.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={data.logoUrl} alt="" className="max-h-[74px] w-auto object-contain" style={{ maxWidth: 212 }} />
        ) : null}
      </div>

      {/* Meta as label/value rows */}
      <div className="mt-7 space-y-1.5 text-[13px]">
        <div className="flex">
          <span className="w-32 text-[12.5px] text-[#6B7280]">Invoice number</span>
          <span>{data.invoiceNumber || "-"}</span>
        </div>
        <div className="flex">
          <span className="w-32 text-[12.5px] text-[#6B7280]">Date of issue</span>
          <span>{formatDate(data.issueDate)}</span>
        </div>
        <div className="flex">
          <span className="w-32 text-[12.5px] text-[#6B7280]">Date due</span>
          <span>{formatDate(data.dueDate)}</span>
        </div>
      </div>

      {/* From / Bill to */}
      <div className="mt-9 flex gap-10">
        <div className="flex-1">
          <p className="mb-1.5 text-[12.5px] text-[#6B7280]">From</p>
          {fromLines.map((line, idx) => (
            <p key={`from-${idx}`} className="text-[13px] leading-snug">
              {line}
            </p>
          ))}
        </div>
        <div className="flex-1">
          <p className="mb-1.5 text-[12.5px] text-[#6B7280]">Bill to</p>
          {billToLines.map((line, idx) => (
            <p key={`to-${idx}`} className="text-[13px] leading-snug">
              {line}
            </p>
          ))}
        </div>
      </div>

      {/* Headline */}
      <p className="mt-11 text-[21px] font-bold tracking-tight">
        {money(amountDue)} due {data.dueDate ? formatDate(data.dueDate) : "on receipt"}
      </p>

      {/* Line items */}
      <div className="mt-4">
        <div className="flex border-b border-[#111111] pb-2 text-[12px] text-[#6B7280]">
          <span style={{ flex: 2.4 }}>Description</span>
          <span className="text-right" style={{ flex: 0.5 }}>
            Qty
          </span>
          <span className="text-right" style={{ flex: 0.9 }}>
            Unit price
          </span>
          <span className="text-right" style={{ flex: 0.9 }}>
            Amount
          </span>
        </div>
        {lines.map((line, idx) => (
          <div key={`line-${idx}`} className="flex border-b border-[#E5E7EB] py-2.5 text-[13px]">
            <span style={{ flex: 2.4 }}>{line.description || "-"}</span>
            <span className="text-right" style={{ flex: 0.5 }}>
              {line.quantity}
            </span>
            <span className="text-right" style={{ flex: 0.9 }}>
              {money(line.unitCostCents)}
            </span>
            <span className="text-right" style={{ flex: 0.9 }}>
              {money(line.lineTotalCents)}
            </span>
          </div>
        ))}
      </div>

      {/* Totals */}
      <div className="ml-auto mt-4 w-[320px] text-[13px]">
        <div className="flex justify-between py-1">
          <span className="text-[12.5px] text-[#6B7280]">Subtotal</span>
          <span>{money(data.subtotalCents)}</span>
        </div>
        {data.discountCents && data.discountCents > 0 ? (
          <div className="flex justify-between py-1">
            <span className="text-[12.5px] text-[#6B7280]">
              Discount{typeof data.discountPercent === "number" ? ` (${data.discountPercent}%)` : ""}
            </span>
            <span>-{money(data.discountCents)}</span>
          </div>
        ) : null}
        {showTax ? (
          <div className="flex justify-between py-1">
            <span className="text-[12.5px] text-[#6B7280]">Tax{typeof data.taxRate === "number" ? ` (${data.taxRate}%)` : ""}</span>
            <span>{money(data.taxCents)}</span>
          </div>
        ) : null}
        <div className="flex justify-between py-1">
          <span className="text-[12.5px] text-[#6B7280]">Total</span>
          <span>{money(data.totalCents)}</span>
        </div>
        <div className="mt-1.5 flex justify-between border-t border-[#111111] pt-2 font-bold">
          <span>Amount due</span>
          <span className="text-[14px]">{money(amountDue)} USD</span>
        </div>
      </div>

      {/* Footer */}
      <div className="mt-auto pt-6">
        {notes ? (
          <div className="mb-4">
            <p className="text-[12.5px] font-bold">Payment details</p>
            <p className="mt-1 whitespace-pre-line text-[12.5px] leading-relaxed">{notes}</p>
          </div>
        ) : null}
        {data.payUrl ? (
          <div className="flex items-center gap-3">
            <a
              href={data.payUrl}
              className="border border-[#111111] px-3.5 py-1.5 text-[12.5px] font-bold text-[#111111] no-underline"
            >
              Pay online
            </a>
            {methods.length > 0 ? <span className="text-[12px] text-[#6B7280]">{methods.join(" · ")}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
