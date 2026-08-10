import type { SupabaseClient } from "@supabase/supabase-js"

import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { createInvoice } from "@/lib/services/invoices"
import { requireAuthorization } from "@/lib/services/authorization"

/**
 * Both loaders below page with `.range()`, so both impose a total order.
 * PostgREST resolves a range as `limit/offset` over whatever order the planner
 * chose; without an ordered key a second page can repeat a row it already
 * returned and skip another, which silently changes how much retainage an
 * invoice is recorded as withholding.
 */
const RETAINAGE_PAGE_SIZE = 1000

/**
 * AR retainage withheld per invoice, keyed by invoice id.
 *
 * `retainage` is the authoritative home for AR retainage. The other two
 * representations — `invoices.metadata.retainage_amount_cents` and the negative
 * `unit = 'retainage'` invoice line — are presentation artifacts and do not agree with
 * it or each other. Read retainage from here and nowhere else.
 *
 * **AR and AP store retainage in opposite directions.** `vendor_bills.total_cents` is
 * GROSS with retainage in its own column, but `invoices.total_cents` is already NET —
 * the hold is a negative line inside the invoice. A caller that needs the gross AR
 * billing must add this value back; a caller measuring what the customer still owes
 * must not subtract it again.
 *
 * Rows are counted whatever their status: releasing retainage is a separate economic
 * event with its own entry, so it does not change what the original invoice withheld.
 */
/**
 * Invoices that exist only to release retainage, mapped to the amount they release.
 *
 * A release invoice bills no new work: its total is retainage that was already billed
 * and withheld on an earlier invoice, now becoming collectible. Posting it as an
 * ordinary invoice would credit contract liabilities a second time for the same work
 * and leave `1110 Retainage receivable` never relieved.
 */
export async function loadRetainageReleaseInvoiceCents(args: {
  supabase: SupabaseClient
  orgId: string
}): Promise<Map<string, number>> {
  const byInvoice = new Map<string, number>()
  for (let page = 0; ; page += 1) {
    const from = page * RETAINAGE_PAGE_SIZE
    const { data, error } = await args.supabase
      .from("retainage")
      .select("release_invoice_id, amount_cents")
      .eq("org_id", args.orgId)
      .not("release_invoice_id", "is", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + RETAINAGE_PAGE_SIZE - 1)

    if (error) throw new Error(`Failed to load retainage release invoices: ${error.message}`)
    for (const row of data ?? []) {
      const invoiceId = String(row.release_invoice_id)
      byInvoice.set(invoiceId, (byInvoice.get(invoiceId) ?? 0) + Number(row.amount_cents ?? 0))
    }
    if ((data ?? []).length < RETAINAGE_PAGE_SIZE) return byInvoice
  }
}

export async function loadInvoiceRetainageCents(args: {
  supabase: SupabaseClient
  orgId: string
}): Promise<Map<string, number>> {
  const byInvoice = new Map<string, number>()
  for (let page = 0; ; page += 1) {
    const from = page * RETAINAGE_PAGE_SIZE
    const { data, error } = await args.supabase
      .from("retainage")
      .select("invoice_id, amount_cents")
      .eq("org_id", args.orgId)
      .not("invoice_id", "is", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + RETAINAGE_PAGE_SIZE - 1)

    if (error) throw new Error(`Failed to load invoice retainage: ${error.message}`)
    for (const row of data ?? []) {
      const invoiceId = String(row.invoice_id)
      byInvoice.set(invoiceId, (byInvoice.get(invoiceId) ?? 0) + Number(row.amount_cents ?? 0))
    }
    if ((data ?? []).length < RETAINAGE_PAGE_SIZE) return byInvoice
  }
}

export async function createRetainageRecord({
  project_id,
  contract_id,
  invoice_id,
  amount_cents,
  orgId,
}: {
  project_id: string
  contract_id: string
  invoice_id?: string | null
  amount_cents: number
  orgId?: string
}) {
  if (amount_cents <= 0) {
    throw new Error("Retainage amount must be positive")
  }

  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "invoice.write",
    userId,
    orgId: resolvedOrgId,
    projectId: project_id,
    supabase,
    logDecision: true,
    resourceType: "project",
    resourceId: project_id,
  })

  const { data, error } = await supabase
    .from("retainage")
    .insert({
      org_id: resolvedOrgId,
      project_id,
      contract_id,
      invoice_id: invoice_id ?? null,
      amount_cents,
      status: "held",
    })
    .select("*")
    .single()

  if (error) {
    throw new Error(`Failed to create retainage record: ${error.message}`)
  }

  return data
}

export async function releaseRetainage({
  retainageId,
  release_invoice_id,
  status = "released",
  orgId,
}: {
  retainageId: string
  release_invoice_id?: string | null
  status?: "released" | "invoiced" | "paid"
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const now = new Date().toISOString()
  if (status === "paid") {
    throw new Error("Use the payment workflow to mark retainage paid")
  }
  if (status === "invoiced" && !release_invoice_id) {
    throw new Error("Invoiced retainage requires a release invoice")
  }

  const { data: existing, error: existingError } = await supabase
    .from("retainage")
    .select("id, project_id")
    .eq("id", retainageId)
    .eq("org_id", resolvedOrgId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Retainage record not found")
  }

  await requireAuthorization({
    permission: "invoice.write",
    userId,
    orgId: resolvedOrgId,
    projectId: existing.project_id,
    supabase,
    logDecision: true,
    resourceType: "retainage",
    resourceId: retainageId,
  })

  if (release_invoice_id) {
    const { data: releaseInvoice, error: releaseInvoiceError } = await supabase
      .from("invoices")
      .select("id, project_id, status")
      .eq("org_id", resolvedOrgId)
      .eq("id", release_invoice_id)
      .maybeSingle()
    if (releaseInvoiceError || !releaseInvoice || releaseInvoice.project_id !== existing.project_id || releaseInvoice.status === "void") {
      throw new Error("Release invoice is missing, void, or belongs to another project")
    }
  }

  const { error } = await supabase
    .from("retainage")
    .update({
      status,
      released_at: now,
      release_invoice_id: release_invoice_id ?? null,
    })
    .eq("id", retainageId)
    .eq("org_id", resolvedOrgId)

  if (error) {
    throw new Error(`Failed to release retainage: ${error.message}`)
  }

  return { success: true }
}

export async function markRetainagePaid(retainageId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: existing, error: existingError } = await supabase
    .from("retainage")
    .select("id, project_id")
    .eq("id", retainageId)
    .eq("org_id", resolvedOrgId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Retainage record not found")
  }

  await requireAuthorization({
    permission: "payment.release",
    userId,
    orgId: resolvedOrgId,
    projectId: existing.project_id,
    supabase,
    logDecision: true,
    resourceType: "retainage",
    resourceId: retainageId,
  })

  const { data: retainage, error: retainageError } = await supabase
    .from("retainage")
    .select("id, release_invoice_id")
    .eq("id", retainageId)
    .eq("org_id", resolvedOrgId)
    .maybeSingle()
  if (retainageError || !retainage?.release_invoice_id) {
    throw new Error("Retainage must have a release invoice before it can be marked paid")
  }

  const { data: releaseInvoice, error: invoiceError } = await supabase
    .from("invoices")
    .select("id, status, balance_due_cents")
    .eq("id", retainage.release_invoice_id)
    .eq("org_id", resolvedOrgId)
    .maybeSingle()
  if (invoiceError || !releaseInvoice || (releaseInvoice.status !== "paid" && releaseInvoice.balance_due_cents !== 0)) {
    throw new Error("Retainage cannot be marked paid until its release invoice is paid")
  }

  const { error } = await supabase
    .from("retainage")
    .update({
      status: "paid",
      released_at: new Date().toISOString(),
    })
    .eq("id", retainageId)
    .eq("org_id", resolvedOrgId)

  if (error) {
    throw new Error(`Failed to mark retainage paid: ${error.message}`)
  }

  return { success: true }
}

export async function applyRetainageToInvoice({
  invoiceId,
  contract_id,
  amount_cents,
  project_id,
  orgId,
}: {
  invoiceId: string
  contract_id: string
  amount_cents: number
  project_id: string
  orgId?: string
}) {
  // Create a held retainage record linked to the invoice
  return createRetainageRecord({
    project_id,
    contract_id,
    invoice_id: invoiceId,
    amount_cents,
    orgId,
  })
}

export async function createInvoiceWithRetainage({
  contract_id,
  project_id,
  invoice_number,
  retainage_percent,
  base_lines,
  tax_rate = 0,
  orgId,
}: {
  contract_id: string
  project_id: string
  invoice_number: string
  retainage_percent: number
  base_lines: {
    description: string
    quantity: number
    unit_cost: number
    unit?: string
    taxable?: boolean
    cost_code_id?: string
  }[]
  tax_rate?: number
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "invoice.write",
    userId,
    orgId: resolvedOrgId,
    projectId: project_id,
    supabase,
    logDecision: true,
    resourceType: "project",
    resourceId: project_id,
  })

  const invoice = await createInvoice({
    input: {
      project_id,
      invoice_number,
      title: `Invoice ${invoice_number}`,
      status: "sent",
      issue_date: new Date().toISOString().split("T")[0],
      due_date: undefined,
      notes: undefined,
      client_visible: true,
      tax_rate,
      lines: base_lines.map((line) => ({
        cost_code_id: line.cost_code_id,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit ?? "unit",
        unit_cost: line.unit_cost,
        taxable: line.taxable ?? true,
      })),
    },
    orgId: resolvedOrgId,
  })

  const { data: retainageRow } = await supabase
    .from("retainage")
    .select("amount_cents")
    .eq("org_id", resolvedOrgId)
    .eq("invoice_id", invoice.id)
    .maybeSingle()
  const retainageAmount = Number(retainageRow?.amount_cents ?? 0)

  return { invoice, retainage_amount_cents: retainageAmount }
}

export async function releaseRetainageForContract({
  contract_id,
  orgId,
  release_invoice_id,
}: {
  contract_id: string
  orgId?: string
  release_invoice_id?: string | null
}) {
  const supabase = createServiceSupabaseClient()
  const { orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: contract, error: contractError } = await supabase
    .from("contracts")
    .select("id, project_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", contract_id)
    .maybeSingle()
  if (contractError || !contract) throw new Error("Contract not found")

  await requireAuthorization({
    permission: "invoice.write",
    userId,
    orgId: resolvedOrgId,
    projectId: contract.project_id,
    supabase,
    logDecision: true,
    resourceType: "contract",
    resourceId: contract_id,
  })

  const { data: held } = await supabase
    .from("retainage")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("contract_id", contract_id)
    .eq("status", "held")

  for (const row of held ?? []) {
    await releaseRetainage({
      retainageId: row.id,
      release_invoice_id,
      status: release_invoice_id ? "invoiced" : "released",
      orgId: resolvedOrgId,
    })
  }

  return { released: (held ?? []).length }
}




