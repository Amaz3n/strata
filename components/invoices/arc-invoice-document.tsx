import type { Invoice } from "@/lib/types"

/**
 * HTML rendition of the canonical Arc invoice PDF (`lib/pdfs/invoice.tsx`). Kept visually in sync
 * with that template so the on-page preview at /i/[token] matches the downloaded / emailed PDF.
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
  subtotalCents: number
  taxCents: number
  totalCents: number
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
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
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
    subtotalCents: invoice.subtotal_cents ?? invoice.totals?.subtotal_cents ?? 0,
    taxCents: invoice.tax_cents ?? invoice.totals?.tax_cents ?? 0,
    totalCents: invoice.total_cents ?? invoice.totals?.total_cents ?? 0,
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
  const notesText = data.notes?.trim() || "-"

  return (
    <div
      className="flex flex-col bg-white text-[#111111]"
      style={{ width, height, paddingTop: 44, paddingBottom: 42, paddingLeft: 52, paddingRight: 52, fontSize: 13 }}
    >
      {/* Header */}
      <div className="flex items-end justify-between">
        <div className="flex min-h-[100px] flex-col justify-end" style={{ width: "58%" }}>
          <h1 className="font-bold leading-none tracking-tight" style={{ fontSize: 42 }}>
            Invoice
          </h1>
          {data.projectName ? <p className="mt-2 text-[15px] text-[#4B5563]">{data.projectName}</p> : null}
        </div>
        <div className="flex min-h-[100px] items-end justify-end" style={{ width: "42%" }}>
          {data.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={data.logoUrl} alt="" className="max-h-[100px] w-auto object-contain" style={{ maxWidth: 260 }} />
          ) : null}
        </div>
      </div>

      {/* From / To */}
      <div className="mt-8 flex justify-between gap-8">
        <div style={{ width: "47%" }}>
          <p className="mb-2 text-[12px] text-[#4B5563]">From</p>
          {fromLines.map((line, idx) => (
            <p key={`from-${idx}`} className="mb-0.5 text-[13.5px] leading-snug">
              {line}
            </p>
          ))}
        </div>
        <div className="flex flex-col items-end text-right" style={{ width: "47%" }}>
          <p className="mb-2 text-[12px] text-[#4B5563]">To</p>
          {billToLines.map((line, idx) => (
            <p key={`to-${idx}`} className="mb-0.5 text-[13.5px] leading-snug">
              {line}
            </p>
          ))}
        </div>
      </div>

      {/* Meta */}
      <div className="mt-6 flex justify-between gap-8">
        <div className="flex-1">
          <p className="mb-1.5 text-[12px] text-[#4B5563]">Invoice #</p>
          <p className="text-[14px]">{data.invoiceNumber || "-"}</p>
        </div>
        <div className="flex-1">
          <p className="mb-1.5 text-[12px] text-[#4B5563]">Issue date</p>
          <p className="text-[14px]">{formatDate(data.issueDate)}</p>
        </div>
        <div className="flex flex-1 flex-col items-end text-right">
          <p className="mb-1.5 text-[12px] text-[#4B5563]">Due date</p>
          <p className="text-[14px]">{formatDate(data.dueDate)}</p>
        </div>
      </div>

      {/* Line items */}
      <div className="mt-8">
        <div className="flex items-center border-b border-[#E5E7EB] pb-2.5 text-[12px] text-[#4B5563]">
          <span style={{ flex: 2.25 }}>Description</span>
          <span className="text-right" style={{ flex: 0.55 }}>
            Qty
          </span>
          <span className="text-right" style={{ flex: 0.85 }}>
            Rate
          </span>
          <span className="text-right" style={{ flex: 0.9 }}>
            Amount
          </span>
        </div>
        {lines.map((line, idx) => (
          <div key={`line-${idx}`} className="flex items-center border-b border-[#E5E7EB] py-2.5 text-[14px]">
            <span style={{ flex: 2.25 }}>{line.description || "-"}</span>
            <span className="text-right" style={{ flex: 0.55 }}>
              {line.quantity}
            </span>
            <span className="text-right" style={{ flex: 0.85 }}>
              {money(line.unitCostCents)}
            </span>
            <span className="text-right" style={{ flex: 0.9 }}>
              {money(line.lineTotalCents)}
            </span>
          </div>
        ))}

        {/* Totals */}
        <div className="ml-auto mt-3" style={{ width: 280 }}>
          <div className="mt-2.5 flex justify-between text-[13px]">
            <span className="text-[#4B5563]">Subtotal</span>
            <span>{money(data.subtotalCents)}</span>
          </div>
          {data.discountCents && data.discountCents > 0 ? (
            <div className="mt-2.5 flex justify-between text-[13px]">
              <span className="text-[#4B5563]">
                Discount{typeof data.discountPercent === "number" ? ` (${data.discountPercent}%)` : ""}
              </span>
              <span>-{money(data.discountCents)}</span>
            </div>
          ) : null}
          <div className="mt-2.5 flex justify-between text-[13px]">
            <span className="text-[#4B5563]">Tax{typeof data.taxRate === "number" ? ` (${data.taxRate}%)` : ""}</span>
            <span>{money(data.taxCents)}</span>
          </div>
          <div className="mt-3 flex justify-between border-t border-[#E5E7EB] pt-2.5">
            <span className="font-bold text-[#4B5563]">Total</span>
            <span className="text-[16px] font-bold">{money(data.totalCents)}</span>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="mt-auto pt-6">
        <div className="border-t border-[#E5E7EB]" />
        <div className="mt-3 flex items-center justify-between gap-4">
          <div className="flex-1">
            <p className="text-[12px] text-[#4B5563]">Payment details</p>
            <p className="mt-1 whitespace-pre-line text-[13.5px] leading-relaxed">{notesText}</p>
          </div>
          {data.payUrl ? (
            <a
              href={data.payUrl}
              className="w-[130px] border border-[#93C5FD] bg-[#EFF6FF] py-1.5 text-center text-[13px] font-bold text-[#1D4ED8] no-underline"
            >
              Pay online
            </a>
          ) : null}
        </div>
        <div className="mt-3.5 border-t border-[#E5E7EB]" />
      </div>
    </div>
  )
}
