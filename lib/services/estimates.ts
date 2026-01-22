import { z } from "zod"

import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createProposal } from "@/lib/services/proposals"
import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const estimateLineSchema = z.object({
  cost_code_id: z.string().uuid().optional(),
  item_type: z.enum(["line", "group"]).default("line"),
  description: z.string().min(1),
  quantity: z.number().default(1),
  unit: z.string().optional(),
  unit_cost_cents: z.number().int().default(0),
  markup_pct: z.number().default(0),
  sort_order: z.number().int().default(0),
  metadata: z.record(z.any()).optional(),
})

function calculateTotals(
  lines: z.infer<typeof estimateLineSchema>[],
  taxRate = 0,
): { subtotal: number; tax: number; total: number } {
  const subtotal = lines.reduce((sum, line) => {
    const base = (line.unit_cost_cents ?? 0) * (line.quantity ?? 1)
    const markup = Math.round(base * (line.markup_pct ?? 0) / 100)
    return sum + base + markup
  }, 0)

  const tax = Math.round(subtotal * (taxRate ?? 0) / 100)
  return { subtotal, tax, total: subtotal + tax }
}

export async function createEstimateFromTemplate({
  templateId,
  projectId,
  title,
  tax_rate,
  orgId,
}: {
  templateId: string
  projectId: string
  title: string
  tax_rate?: number
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: template, error: templateError } = await supabase
    .from("estimate_templates")
    .select("id, org_id, name, lines")
    .eq("id", templateId)
    .eq("org_id", resolvedOrgId)
    .maybeSingle()

  if (templateError || !template) {
    throw new Error("Template not found")
  }

  const parsedLines = estimateLineSchema.array().parse(template.lines ?? [])
  const totals = calculateTotals(parsedLines, tax_rate ?? 0)

  const { data: estimate, error: estimateError } = await supabase
    .from("estimates")
    .insert({
      org_id: resolvedOrgId,
      project_id: projectId,
      title,
      status: "draft",
      version: 1,
      subtotal_cents: totals.subtotal,
      tax_cents: totals.tax,
      total_cents: totals.total,
      metadata: { tax_rate: tax_rate ?? 0, template_id: templateId },
      created_by: userId,
    })
    .select("*")
    .single()

  if (estimateError || !estimate) {
    throw new Error(`Failed to create estimate: ${estimateError?.message}`)
  }

  const itemsPayload = parsedLines.map((line, idx) => ({
    org_id: resolvedOrgId,
    estimate_id: estimate.id,
    cost_code_id: line.cost_code_id ?? null,
    item_type: line.item_type ?? "line",
    description: line.description,
    quantity: line.quantity ?? 1,
    unit: line.unit ?? null,
    unit_cost_cents: line.unit_cost_cents ?? 0,
    markup_pct: line.markup_pct ?? 0,
    sort_order: line.sort_order ?? idx,
    metadata: line.metadata ?? {},
  }))

  const { error: lineError } = await supabase.from("estimate_items").insert(itemsPayload)
  if (lineError) {
    throw new Error(`Failed to create estimate lines: ${lineError.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "estimate",
    entityId: estimate.id,
    after: { ...estimate, items: itemsPayload },
  })

  return { estimate, items: itemsPayload }
}

export async function createEstimate({
  project_id,
  recipient_contact_id,
  title,
  summary,
  terms,
  valid_until,
  tax_rate,
  markup_percent,
  lines,
  orgId,
}: {
  project_id?: string | null
  recipient_contact_id?: string | null
  title: string
  summary?: string
  terms?: string
  valid_until?: string
  tax_rate?: number
  markup_percent?: number
  lines: z.infer<typeof estimateLineSchema>[]
  orgId?: string
}) {
  const parsedLines = estimateLineSchema.array().min(1).parse(lines)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const totals = calculateTotals(parsedLines, tax_rate ?? 0)

  const { data: estimate, error: estimateError } = await supabase
    .from("estimates")
    .insert({
      org_id: resolvedOrgId,
      project_id: project_id ?? null,
      recipient_contact_id: recipient_contact_id ?? null,
      title,
      status: "draft",
      version: 1,
      subtotal_cents: totals.subtotal,
      tax_cents: totals.tax,
      total_cents: totals.total,
      valid_until: valid_until ?? null,
      metadata: {
        tax_rate: tax_rate ?? 0,
        markup_percent: markup_percent ?? 0,
        summary: summary ?? null,
        terms: terms ?? null,
      },
      created_by: userId,
    })
    .select("*")
    .single()

  if (estimateError || !estimate) {
    throw new Error(`Failed to create estimate: ${estimateError?.message}`)
  }

  const itemsPayload = parsedLines.map((line, idx) => ({
    org_id: resolvedOrgId,
    estimate_id: estimate.id,
    cost_code_id: line.cost_code_id ?? null,
    item_type: line.item_type ?? "line",
    description: line.description,
    quantity: line.quantity ?? 1,
    unit: line.unit ?? null,
    unit_cost_cents: line.unit_cost_cents ?? 0,
    markup_pct: line.markup_pct ?? 0,
    sort_order: line.sort_order ?? idx,
    metadata: line.metadata ?? {},
  }))

  const { error: lineError } = await supabase.from("estimate_items").insert(itemsPayload)
  if (lineError) {
    throw new Error(`Failed to create estimate lines: ${lineError.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "estimate",
    entityId: estimate.id,
    after: { ...estimate, items: itemsPayload },
  })

  // CRM automation: If estimate has a recipient contact, update their lead status to "estimating"
  if (recipient_contact_id) {
    await updateProspectStatusOnEstimateCreation({
      supabase,
      orgId: resolvedOrgId,
      contactId: recipient_contact_id,
      estimateId: estimate.id,
      estimateTitle: title,
    })
  }

  return { estimate, items: itemsPayload }
}

// Helper function to update prospect status when estimate is created
async function updateProspectStatusOnEstimateCreation({
  supabase,
  orgId,
  contactId,
  estimateId,
  estimateTitle,
}: {
  supabase: any
  orgId: string
  contactId: string
  estimateId: string
  estimateTitle: string
}) {
  try {
    // Get the contact
    const { data: contact } = await supabase
      .from("contacts")
      .select("id, full_name, contact_type, metadata")
      .eq("org_id", orgId)
      .eq("id", contactId)
      .maybeSingle()

    if (!contact) return

    // Only update if this is a client contact (CRM prospect)
    if (contact.contact_type !== "client") return

    const existingMetadata = contact.metadata ?? {}
    const currentStatus = existingMetadata.lead_status

    // Only update if status is before "estimating" in the pipeline
    // Don't downgrade from won/lost or already estimating
    const statusesToUpdate = ["new", "contacted", "qualified", undefined]
    if (!statusesToUpdate.includes(currentStatus)) return

    // Update the contact's lead status to "estimating"
    const metadata = {
      ...existingMetadata,
      lead_status: "estimating",
    }

    await supabase
      .from("contacts")
      .update({ metadata })
      .eq("org_id", orgId)
      .eq("id", contactId)

    // Record the CRM event
    await recordEvent({
      orgId,
      eventType: "crm_estimate_created",
      entityType: "contact",
      entityId: contactId,
      payload: {
        name: contact.full_name,
        estimate_id: estimateId,
        estimate_title: estimateTitle,
        old_status: currentStatus ?? "new",
        new_status: "estimating",
      },
    })
  } catch (error) {
    // Don't fail estimate creation if CRM update fails
    console.error("Failed to update prospect status on estimate creation:", error)
  }
}

export async function updateEstimateLines({
  estimateId,
  lines,
  tax_rate,
  orgId,
}: {
  estimateId: string
  lines: z.infer<typeof estimateLineSchema>[]
  tax_rate?: number
  orgId?: string
}) {
  const parsedLines = estimateLineSchema.array().min(1).parse(lines)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const totals = calculateTotals(parsedLines, tax_rate ?? 0)

  await supabase.from("estimate_items").delete().eq("estimate_id", estimateId).eq("org_id", resolvedOrgId)

  const itemsPayload = parsedLines.map((line, idx) => ({
    org_id: resolvedOrgId,
    estimate_id: estimateId,
    cost_code_id: line.cost_code_id ?? null,
    item_type: line.item_type ?? "line",
    description: line.description,
    quantity: line.quantity ?? 1,
    unit: line.unit ?? null,
    unit_cost_cents: line.unit_cost_cents ?? 0,
    markup_pct: line.markup_pct ?? 0,
    sort_order: line.sort_order ?? idx,
    metadata: line.metadata ?? {},
  }))

  const { error: lineError } = await supabase.from("estimate_items").insert(itemsPayload)
  if (lineError) {
    throw new Error(`Failed to update estimate lines: ${lineError.message}`)
  }

  const { data: existing } = await supabase
    .from("estimates")
    .select("metadata")
    .eq("id", estimateId)
    .eq("org_id", resolvedOrgId)
    .maybeSingle()

  const { error: estimateError } = await supabase
    .from("estimates")
    .update({
      subtotal_cents: totals.subtotal,
      tax_cents: totals.tax,
      total_cents: totals.total,
      metadata: {
        ...(existing?.metadata ?? {}),
        tax_rate: tax_rate ?? (existing?.metadata as any)?.tax_rate ?? 0,
      },
    })
    .eq("id", estimateId)
    .eq("org_id", resolvedOrgId)

  if (estimateError) {
    throw new Error(`Failed to update estimate totals: ${estimateError.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "estimate",
    entityId: estimateId,
    after: { totals, items: itemsPayload },
  })

  return { totals, items: itemsPayload }
}

export async function updateEstimateStatus({
  estimateId,
  status,
  orgId,
}: {
  estimateId: string
  status: "draft" | "sent" | "approved" | "rejected"
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("estimates")
    .update({ status })
    .eq("id", estimateId)
    .eq("org_id", resolvedOrgId)
    .select("*")
    .single()

  if (error || !data) {
    throw new Error(`Failed to update estimate status: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "estimate",
    entityId: estimateId,
    after: data,
  })

  return data
}

export async function duplicateEstimate({ estimateId, orgId }: { estimateId: string; orgId?: string }) {
  const supabase = createServiceSupabaseClient()
  const { supabase: scoped, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: existing } = await supabase
    .from("estimates")
    .select("*, items:estimate_items(*)")
    .eq("id", estimateId)
    .eq("org_id", resolvedOrgId)
    .single()

  if (!existing) {
    throw new Error("Estimate not found")
  }

  const newVersion = (existing.version ?? 1) + 1

  const { data: newEstimate, error: estimateError } = await scoped
    .from("estimates")
    .insert({
      org_id: resolvedOrgId,
      project_id: existing.project_id,
      title: `${existing.title} (v${newVersion})`,
      status: "draft",
      version: newVersion,
      subtotal_cents: existing.subtotal_cents,
      tax_cents: existing.tax_cents,
      total_cents: existing.total_cents,
      currency: existing.currency,
      metadata: { ...existing.metadata, duplicated_from: estimateId },
      created_by: userId,
    })
    .select("*")
    .single()

  if (estimateError || !newEstimate) {
    throw new Error(`Failed to duplicate estimate: ${estimateError?.message}`)
  }

  const items = (existing as any).items ?? []
  if (items.length > 0) {
    const insertItems = items.map((item: any) => ({
      org_id: resolvedOrgId,
      estimate_id: newEstimate.id,
      cost_code_id: item.cost_code_id ?? null,
      item_type: item.item_type ?? "line",
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unit_cost_cents: item.unit_cost_cents,
      markup_pct: item.markup_pct,
      sort_order: item.sort_order,
      metadata: item.metadata ?? {},
    }))
    const { error: itemError } = await scoped.from("estimate_items").insert(insertItems)
    if (itemError) {
      throw new Error(`Failed to duplicate estimate lines: ${itemError.message}`)
    }
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "estimate",
    entityId: newEstimate.id,
    after: newEstimate,
  })

  return newEstimate
}

export async function convertEstimateToProposal({
  estimateId,
  recipient_contact_id,
  title,
  summary,
  terms,
  valid_until,
  orgId,
}: {
  estimateId: string
  recipient_contact_id?: string
  title?: string
  summary?: string
  terms?: string
  valid_until?: string
  orgId?: string
}) {
  const supabase = createServiceSupabaseClient()
  const { orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data: estimate, error } = await supabase
    .from("estimates")
    .select("*, items:estimate_items(*), recipient:contacts(id, full_name, email)")
    .eq("id", estimateId)
    .eq("org_id", resolvedOrgId)
    .single()

  if (error || !estimate) {
    throw new Error("Estimate not found")
  }

  const lines = (estimate as any).items?.map((item: any, idx: number) => ({
    cost_code_id: item.cost_code_id ?? undefined,
    line_type: item.item_type === "group" ? "section" : "item",
    description: item.description,
    quantity: item.quantity ?? 1,
    unit: item.unit ?? undefined,
    unit_cost_cents: item.unit_cost_cents ?? 0,
    markup_percent: item.markup_pct ?? 0,
    is_optional: false,
    is_selected: true,
    allowance_cents: undefined,
    notes: (item.metadata as any)?.notes ?? undefined,
    sort_order: item.sort_order ?? idx,
  })) ?? []

  return await createProposal(
    {
      project_id: estimate.project_id ?? undefined,
      estimate_id: estimate.id,
      recipient_contact_id: recipient_contact_id ?? estimate.recipient_contact_id ?? undefined,
      title: title ?? estimate.title,
      summary: summary ?? (estimate.metadata as any)?.summary,
      terms: terms ?? (estimate.metadata as any)?.terms,
      valid_until,
      lines,
      markup_percent: (estimate.metadata as any)?.markup_percent,
      tax_rate: (estimate.metadata as any)?.tax_rate,
    },
    resolvedOrgId,
  )
}





