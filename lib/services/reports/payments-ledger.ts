import { requireOrgContext } from "@/lib/services/context"
import { todayIsoDateOnly } from "@/lib/services/reports/dates"

export type PaymentsLedgerKind = "ar" | "ap"

export type PaymentsLedgerRow = {
  payment_id: string
  kind: PaymentsLedgerKind
  project_id: string | null
  project_name: string | null
  invoice_id: string | null
  invoice_number: string | null
  bill_id: string | null
  bill_number: string | null
  amount_cents: number
  currency: string | null
  status: string | null
  received_at: string | null
  method: string | null
  reference: string | null
  provider: string | null
  provider_payment_id: string | null
}

export type PaymentsLedgerReport = {
  as_of: string
  project_id?: string
  kind: PaymentsLedgerKind
  rows: PaymentsLedgerRow[]
}

export async function getPaymentsLedgerReport({
  projectId,
  asOf,
  kind,
  orgId,
}: {
  projectId?: string
  asOf?: string
  kind: PaymentsLedgerKind
  orgId?: string
}): Promise<PaymentsLedgerReport> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const asOfDate = asOf ?? todayIsoDateOnly()

  let query = supabase
    .from("payments")
    .select(
      "id, org_id, project_id, invoice_id, bill_id, amount_cents, currency, status, received_at, method, reference, provider, provider_payment_id, project:projects(name), invoice:invoices(invoice_number), bill:vendor_bills(bill_number)",
    )
    .eq("org_id", resolvedOrgId)
    .order("received_at", { ascending: false })

  if (projectId) {
    query = query.eq("project_id", projectId)
  }

  if (kind === "ar") {
    query = query.not("invoice_id", "is", null)
  } else {
    query = query.not("bill_id", "is", null)
  }

  const { data, error } = await query
  if (error) {
    throw new Error(`Failed to load payments ledger (${kind}): ${error.message}`)
  }

  const rows: PaymentsLedgerRow[] = (data ?? []).map((row: any) => ({
    payment_id: row.id,
    kind,
    project_id: row.project_id ?? null,
    project_name: row.project?.name ?? null,
    invoice_id: row.invoice_id ?? null,
    invoice_number: row.invoice?.invoice_number ?? null,
    bill_id: row.bill_id ?? null,
    bill_number: row.bill?.bill_number ?? null,
    amount_cents: typeof row.amount_cents === "number" ? row.amount_cents : 0,
    currency: row.currency ?? null,
    status: row.status ?? null,
    received_at: row.received_at ?? row.created_at ?? null,
    method: row.method ?? null,
    reference: row.reference ?? null,
    provider: row.provider ?? null,
    provider_payment_id: row.provider_payment_id ?? null,
  }))

  return { as_of: asOfDate, project_id: projectId, kind, rows }
}

