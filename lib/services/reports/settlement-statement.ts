import { buildSettlementStatementLines } from "@/lib/financials/purchase-agreement-pricing"
import { renderSettlementStatementPdf, type SettlementStatementData } from "@/lib/pdfs/settlement-statement"
import { getClosing } from "@/lib/services/closings"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"

export type SettlementStatementReport = {
  file_name: string
  data: SettlementStatementData
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** Supabase returns an embedded to-one relation as either a row or a one-row array. */
function relationRecord(value: unknown): Record<string, unknown> {
  return Array.isArray(value) ? record(value[0]) : record(value)
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function centsValue(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed) : 0
}

/** Mirrors the billing page's address formatting so the PDF names the builder the same way an invoice does. */
function addressLines(value: unknown): string[] {
  const address = record(value)
  const structured = [
    [text(address.street1), text(address.street2)].filter(Boolean).join(" ").trim(),
    [text(address.city), text(address.state), text(address.postal_code)].filter(Boolean).join(" ").trim(),
    text(address.country) ?? "",
  ].filter(Boolean)
  if (structured.length > 0) return structured
  const formatted = text(address.formatted)
  return formatted ? formatted.split("\n") : []
}

function locationLine(location: unknown): string | null {
  if (typeof location === "string") return text(location)
  const value = record(location)
  const direct = text(value.address) ?? text(value.formatted)
  if (direct) return direct
  const joined = [value.street1, value.city, value.state, value.postal_code]
    .map((part) => text(part))
    .filter((part): part is string => part !== null)
    .join(", ")
  return joined || null
}

function safeFileSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "home"
}

/**
 * The settlement statement for one home: the price the buyer agreed to, what
 * moved after the agreement, the deposits already credited, and the balance
 * they wire at the table. It is a preview until the closing settles, at which
 * point the same document is the record of what was collected.
 */
export async function getSettlementStatementReport(
  projectId: string,
  orgId?: string,
): Promise<SettlementStatementReport> {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  const detail = await getClosing(projectId, context.orgId)
  if (!detail) throw new Error("Closing not found")

  const closing = record(detail.closing)
  const closingId = String(closing.id)
  // The same pricing snapshot the closing invoice bills from, so the statement
  // and the invoice can never describe the sale differently.
  const pricing = detail.settlementPreview.pricing
  if (!pricing) throw new Error("Purchase agreement pricing snapshot is missing")

  const closingInvoiceId = text(closing.closing_invoice_id)
  const [{ data: project }, { data: org }, paymentResult] = await Promise.all([
    context.supabase
      .from("projects")
      .select("location, client:contacts(full_name, email, phone)")
      .eq("org_id", context.orgId)
      .eq("id", projectId)
      .maybeSingle(),
    context.supabase.from("orgs").select("name, address").eq("id", context.orgId).maybeSingle(),
    closingInvoiceId
      ? context.supabase
          .from("payments")
          .select("method, reference, amount_cents, created_at")
          .eq("org_id", context.orgId)
          .eq("invoice_id", closingInvoiceId)
          .eq("provider_payment_id", `closing:${closingId}`)
          .in("status", ["succeeded", "completed"])
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const client = relationRecord(record(project).client)
  const lot = relationRecord(closing.lot)
  const plan = relationRecord(lot.plan)
  const lotNumber = text(lot.lot_number) ?? "—"
  const communityName = text(relationRecord(closing.community).name)
  const planName = text(plan.name) ?? "Home"

  const settlement = buildSettlementStatementLines({
    pricing,
    lotLabel: lotNumber,
    planLabel: planName,
    approvedChangeOrders: (detail.settlementPreview.changeOrders ?? []).map((row: unknown) => {
      const changeOrder = record(row)
      return {
        id: String(changeOrder.id),
        title: text(changeOrder.title) ?? "Change order",
        totalCents: centsValue(changeOrder.total_cents),
        number: numberOrNull(record(changeOrder.metadata).number),
      }
    }),
    adjustments: detail.settlementPreview.adjustments,
    deposits: detail.settlementPreview.depositsApplied,
  })

  const status: "preview" | "final" = closing.status === "closed" ? "final" : "preview"
  const payment = record(paymentResult.data)
  const buyerName = text(client.full_name) ?? "Buyer"

  const data: SettlementStatementData = {
    builderName: text(record(org).name) ?? "Builder",
    builderAddressLines: addressLines(record(org).address),
    buyerName,
    buyerLines: [text(client.email), text(client.phone)].filter(
      (line): line is string => line !== null,
    ),
    propertyLines: [
      text(lot.address) ?? locationLine(record(project).location),
      communityName ? `Lot ${lotNumber} · ${communityName}` : `Lot ${lotNumber}`,
      planName,
    ].filter((line): line is string => line !== null),
    agreementNumber: text(detail.agreement?.number),
    agreementDate: text(detail.agreement?.signed_at),
    closingDate: text(closing.actual_date) ?? text(closing.scheduled_date),
    status,
    purchasePrice: settlement.purchasePrice,
    changeOrders: settlement.changeOrders,
    adjustments: settlement.adjustments,
    finalPriceCents: settlement.finalPriceCents,
    deposits: settlement.deposits,
    depositsAppliedCents: settlement.depositsAppliedCents,
    balanceDueCents: settlement.balanceDueCents,
    payment: paymentResult.data
      ? {
          method: text(payment.method) ?? "Manual",
          reference: text(payment.reference),
          receivedAt: text(closing.actual_date) ?? text(payment.created_at),
          amountCents: centsValue(payment.amount_cents),
        }
      : null,
    generatedAt: new Date().toISOString(),
  }

  return {
    file_name: `settlement-statement-lot-${safeFileSegment(lotNumber)}.pdf`,
    data,
  }
}

export async function generateSettlementStatementPdf(
  projectId: string,
  orgId?: string,
): Promise<{ fileName: string; pdf: Buffer }> {
  const report = await getSettlementStatementReport(projectId, orgId)
  const pdf = await renderSettlementStatementPdf(report.data)
  return { fileName: report.file_name, pdf }
}
