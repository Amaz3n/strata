import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { createInvoice } from "@/lib/services/invoices"

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

  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
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
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const now = new Date().toISOString()

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
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

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
    orgId,
  })

  // Compute retainage from invoice total
  const retainageAmount = Math.round((invoice.total_cents ?? 0) * (retainage_percent / 100))
  if (retainageAmount > 0) {
    await applyRetainageToInvoice({
      invoiceId: invoice.id,
      contract_id,
      amount_cents: retainageAmount,
      project_id,
      orgId,
    })
  }

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
  const { orgId: resolvedOrgId } = await requireOrgContext(orgId)

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







