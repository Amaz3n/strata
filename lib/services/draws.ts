import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { createInvoice } from "@/lib/services/invoices"

export async function listDueDraws(projectId?: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const today = new Date().toISOString().split("T")[0]

  let query = supabase
    .from("draw_schedules")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("status", "pending")
    .lte("due_date", today)
    .order("due_date", { ascending: true })

  if (projectId) {
    query = query.eq("project_id", projectId)
  }

  const { data, error } = await query
  if (error) {
    throw new Error(`Failed to load due draws: ${error.message}`)
  }

  return data ?? []
}

export async function invoiceDrawSchedule({
  drawId,
  invoice_number,
  issue_date,
  due_date,
  orgId,
}: {
  drawId: string
  invoice_number: string
  issue_date?: string
  due_date?: string
  orgId?: string
}) {
  const supabase = createServiceSupabaseClient()
  const { orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data: draw, error: drawError } = await supabase
    .from("draw_schedules")
    .select("*")
    .eq("id", drawId)
    .eq("org_id", resolvedOrgId)
    .single()

  if (drawError || !draw) {
    throw new Error("Draw not found")
  }

  const invoice = await createInvoice({
    input: {
      project_id: draw.project_id,
      invoice_number,
      title: `Draw ${draw.draw_number}: ${draw.title}`,
      status: "sent",
      issue_date,
      due_date: due_date ?? draw.due_date ?? undefined,
      notes: draw.description ?? undefined,
      client_visible: true,
      tax_rate: 0,
      lines: [
        {
          description: draw.title,
          quantity: 1,
          unit: "draw",
          unit_cost: (draw.amount_cents ?? 0) / 100,
          taxable: false,
        },
      ],
    },
    orgId: resolvedOrgId,
  })

  const { error: updateError } = await supabase
    .from("draw_schedules")
    .update({
      invoice_id: invoice.id,
      status: "invoiced",
      invoiced_at: new Date().toISOString(),
    })
    .eq("id", drawId)
    .eq("org_id", resolvedOrgId)

  if (updateError) {
    throw new Error(`Failed to mark draw invoiced: ${updateError.message}`)
  }

  return { draw: { ...draw, status: "invoiced", invoice_id: invoice.id }, invoice }
}

export async function markDrawPaid(drawId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { error } = await supabase
    .from("draw_schedules")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
    })
    .eq("id", drawId)
    .eq("org_id", resolvedOrgId)

  if (error) {
    throw new Error(`Failed to mark draw paid: ${error.message}`)
  }

  return { success: true }
}

