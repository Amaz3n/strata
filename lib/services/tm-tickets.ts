import type { SupabaseClient } from "@supabase/supabase-js"
import { createHash, randomBytes } from "crypto"
import { z } from "zod"

import { resolveProjectBillingModel } from "@/lib/financials/billing-model"
import { requireAuthorization } from "@/lib/services/authorization"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { generateInvoiceFromCosts, getProjectCostContract } from "@/lib/services/cost-plus"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export type TmTicketStatus = "draft" | "submitted" | "client_signed" | "billed" | "voided"

export interface TmTicketItem {
  id: string
  ticket_id: string
  project_id: string
  source_type: "time_entry" | "project_expense" | "project_expense_line"
  source_id: string
  billable_cost_id?: string | null
  cost_code_id?: string | null
  occurred_on: string
  description?: string | null
  quantity: number
  cost_cents: number
  billable_cents: number
  sort_order: number
  metadata: Record<string, any>
}

export interface TmTicket {
  id: string
  org_id: string
  project_id: string
  contract_id?: string | null
  ticket_number: string
  work_date: string
  status: TmTicketStatus
  notes?: string | null
  submitted_at?: string | null
  client_signed_at?: string | null
  client_signer_name?: string | null
  client_signer_email?: string | null
  signature_token_expires_at?: string | null
  invoice_id?: string | null
  metadata: Record<string, any>
  created_at: string
  updated_at: string
  items: TmTicketItem[]
  totals: {
    cost_cents: number
    billable_cents: number
    item_count: number
  }
}

const createTmTicketSchema = z.object({
  projectId: z.string().uuid(),
  workDate: z.coerce.date(),
  billableCostIds: z.array(z.string().uuid()).optional(),
  notes: z.string().max(2000).optional().nullable(),
})

const signTmTicketSchema = z.object({
  token: z.string().min(20),
  signerName: z.string().trim().min(1).max(160),
  signerEmail: z.string().trim().email().optional().nullable(),
  signatureData: z.record(z.unknown()).optional().nullable(),
  signerIp: z.string().max(120).optional().nullable(),
})

export type CreateTmTicketInput = z.infer<typeof createTmTicketSchema>
export type SignTmTicketInput = z.infer<typeof signTmTicketSchema>

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

function toDateOnly(value?: Date | string | null) {
  if (!value) return new Date().toISOString().slice(0, 10)
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return value.slice(0, 10)
}

function mapTicket(row: any): TmTicket {
  const items: TmTicketItem[] = (row.items ?? row.tm_ticket_items ?? []).map(mapTicketItem)
  const totals = items.reduce(
    (sum, item) => ({
      cost_cents: sum.cost_cents + item.cost_cents,
      billable_cents: sum.billable_cents + item.billable_cents,
      item_count: sum.item_count + 1,
    }),
    { cost_cents: 0, billable_cents: 0, item_count: 0 },
  )

  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    contract_id: row.contract_id ?? null,
    ticket_number: row.ticket_number,
    work_date: row.work_date,
    status: row.status ?? "draft",
    notes: row.notes ?? null,
    submitted_at: row.submitted_at ?? null,
    client_signed_at: row.client_signed_at ?? null,
    client_signer_name: row.client_signer_name ?? null,
    client_signer_email: row.client_signer_email ?? null,
    signature_token_expires_at: row.signature_token_expires_at ?? null,
    invoice_id: row.invoice_id ?? null,
    metadata: row.metadata ?? {},
    created_at: row.created_at,
    updated_at: row.updated_at,
    items,
    totals,
  }
}

function auditSnapshot(value: unknown) {
  return value as Record<string, unknown>
}

function mapTicketItem(row: any): TmTicketItem {
  return {
    id: row.id,
    ticket_id: row.ticket_id,
    project_id: row.project_id,
    source_type: row.source_type,
    source_id: row.source_id,
    billable_cost_id: row.billable_cost_id ?? null,
    cost_code_id: row.cost_code_id ?? null,
    occurred_on: row.occurred_on,
    description: row.description ?? null,
    quantity: Number(row.quantity ?? 1),
    cost_cents: Number(row.cost_cents ?? 0),
    billable_cents: Number(row.billable_cents ?? 0),
    sort_order: Number(row.sort_order ?? 0),
    metadata: row.metadata ?? {},
  }
}

async function requireProjectAccess(args: {
  supabase: SupabaseClient
  orgId: string
  userId: string
  projectId: string
  permission: string
  resourceId?: string
}) {
  await requireAuthorization({
    permission: args.permission,
    userId: args.userId,
    orgId: args.orgId,
    projectId: args.projectId,
    supabase: args.supabase,
    logDecision: true,
    resourceType: "tm_ticket",
    resourceId: args.resourceId,
  })
}

async function requireTimeAndMaterialsContract(args: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
}) {
  const contract = await getProjectCostContract(args.supabase, args.orgId, args.projectId)
  if (resolveProjectBillingModel(contract as any) !== "time_and_materials") {
    throw new Error("T&M tickets are only available for time-and-materials projects.")
  }
  return contract
}

async function nextTicketNumber(args: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  workDate: string
}) {
  const prefix = `TM-${args.workDate.replaceAll("-", "")}`
  const { count, error } = await args.supabase
    .from("tm_tickets")
    .select("id", { count: "exact", head: true })
    .eq("org_id", args.orgId)
    .eq("project_id", args.projectId)
    .ilike("ticket_number", `${prefix}-%`)

  if (error) throw new Error(`Failed to allocate T&M ticket number: ${error.message}`)
  return `${prefix}-${String(Number(count ?? 0) + 1).padStart(2, "0")}`
}

async function loadTicketWithItems(args: {
  supabase: SupabaseClient
  orgId: string
  ticketId: string
}) {
  const { data, error } = await args.supabase
    .from("tm_tickets")
    .select("*, items:tm_ticket_items(*)")
    .eq("org_id", args.orgId)
    .eq("id", args.ticketId)
    .order("sort_order", { referencedTable: "tm_ticket_items", ascending: true })
    .maybeSingle()

  if (error) throw new Error(`Failed to load T&M ticket: ${error.message}`)
  return data ? mapTicket(data) : null
}

export async function listProjectTmTickets(projectId: string, orgId?: string): Promise<TmTicket[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectAccess({ supabase, orgId: resolvedOrgId, userId, projectId, permission: "invoice.read" })

  const { data, error } = await supabase
    .from("tm_tickets")
    .select("*, items:tm_ticket_items(*)")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("work_date", { ascending: false })
    .order("created_at", { ascending: false })

  if (error) throw new Error(`Failed to load T&M tickets: ${error.message}`)
  return (data ?? []).map(mapTicket).map((ticket) => ({
    ...ticket,
    items: [...ticket.items].sort((a, b) => a.sort_order - b.sort_order),
  }))
}

export async function getTmTicket(ticketId: string, orgId?: string): Promise<TmTicket | null> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const ticket = await loadTicketWithItems({ supabase, orgId: resolvedOrgId, ticketId })
  if (!ticket) return null
  await requireProjectAccess({
    supabase,
    orgId: resolvedOrgId,
    userId,
    projectId: ticket.project_id,
    permission: "invoice.read",
    resourceId: ticketId,
  })
  return ticket
}

export async function createTmTicket(input: CreateTmTicketInput, orgId?: string): Promise<TmTicket> {
  const parsed = createTmTicketSchema.parse(input)
  const workDate = toDateOnly(parsed.workDate)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectAccess({ supabase, orgId: resolvedOrgId, userId, projectId: parsed.projectId, permission: "invoice.write" })
  const contract = await requireTimeAndMaterialsContract({ supabase, orgId: resolvedOrgId, projectId: parsed.projectId })

  let costQuery = supabase
    .from("billable_costs")
    .select("*, cost_code:cost_codes(code, name)")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", parsed.projectId)
    .eq("status", "open")
    .eq("is_billable", true)
    .in("source_type", ["time_entry", "project_expense", "project_expense_line"])
    .order("occurred_on", { ascending: true })

  if (parsed.billableCostIds?.length) {
    costQuery = costQuery.in("id", parsed.billableCostIds)
  } else {
    costQuery = costQuery.eq("occurred_on", workDate)
  }

  const { data: costs, error: costError } = await costQuery
  if (costError) throw new Error(`Failed to load ticket costs: ${costError.message}`)
  if (!costs?.length) throw new Error("No open T&M costs are available for this ticket.")

  const billableCostIds = costs.map((cost: any) => cost.id as string)
  const { data: existingItems, error: existingItemsError } = await supabase
    .from("tm_ticket_items")
    .select("billable_cost_id, ticket:tm_tickets(ticket_number, status)")
    .eq("org_id", resolvedOrgId)
    .in("billable_cost_id", billableCostIds)
  if (existingItemsError) throw new Error(`Failed to check existing ticket items: ${existingItemsError.message}`)
  const activeTicketItem = (existingItems ?? []).find((item: any) => {
    const ticket = Array.isArray(item.ticket) ? item.ticket[0] : item.ticket
    return ticket?.status !== "voided"
  })
  if (activeTicketItem) {
    const ticket = Array.isArray((activeTicketItem as any).ticket) ? (activeTicketItem as any).ticket[0] : (activeTicketItem as any).ticket
    throw new Error(`One or more costs already belong to ticket ${ticket?.ticket_number ?? ""}`.trim())
  }

  const ticketNumber = await nextTicketNumber({ supabase, orgId: resolvedOrgId, projectId: parsed.projectId, workDate })
  const { data: ticketRow, error: ticketError } = await supabase
    .from("tm_tickets")
    .insert({
      org_id: resolvedOrgId,
      project_id: parsed.projectId,
      contract_id: contract?.id ?? null,
      ticket_number: ticketNumber,
      work_date: workDate,
      status: "draft",
      notes: parsed.notes ?? null,
      created_by: userId,
      updated_by: userId,
      metadata: {
        source: "financials_tm_tickets",
        rate_schedule_id: contract?.rate_schedule_id ?? contract?.snapshot?.rate_schedule_id ?? null,
      },
    })
    .select("*")
    .single()
  if (ticketError || !ticketRow) throw new Error(`Failed to create T&M ticket: ${ticketError?.message}`)

  const itemRows = costs.map((cost: any, index: number) => ({
    org_id: resolvedOrgId,
    ticket_id: ticketRow.id,
    project_id: parsed.projectId,
    source_type: cost.source_type,
    source_id: cost.source_id,
    billable_cost_id: cost.id,
    cost_code_id: cost.cost_code_id ?? null,
    occurred_on: cost.occurred_on,
    description: cost.description ?? null,
    quantity: Number(cost.metadata?.bill_quantity ?? cost.metadata?.hours ?? 1),
    cost_cents: Number(cost.cost_cents ?? 0),
    billable_cents: Number(cost.billable_cents ?? cost.cost_cents ?? 0),
    sort_order: index,
    metadata: {
      cost_code: cost.cost_code ? { code: cost.cost_code.code, name: cost.cost_code.name } : null,
      source_metadata: cost.metadata ?? {},
    },
  }))
  const { error: itemsError } = await supabase.from("tm_ticket_items").insert(itemRows)
  if (itemsError) throw new Error(`Failed to create T&M ticket items: ${itemsError.message}`)

  for (const cost of costs) {
    await supabase
      .from("billable_costs")
      .update({
        metadata: {
          ...(cost.metadata ?? {}),
          tm_ticket_id: ticketRow.id,
          tm_ticket_number: ticketNumber,
        },
      })
      .eq("org_id", resolvedOrgId)
      .eq("id", cost.id)
  }

  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "tm_ticket", entityId: ticketRow.id, after: { ...ticketRow, items: itemRows } })
  await recordEvent({ orgId: resolvedOrgId, eventType: "tm_ticket_created", entityType: "tm_ticket", entityId: ticketRow.id, payload: { project_id: parsed.projectId, ticket_number: ticketNumber, item_count: itemRows.length } })

  return (await loadTicketWithItems({ supabase, orgId: resolvedOrgId, ticketId: ticketRow.id }))!
}

export async function submitTmTicket(ticketId: string, orgId?: string): Promise<TmTicket> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const ticket = await loadTicketWithItems({ supabase, orgId: resolvedOrgId, ticketId })
  if (!ticket) throw new Error("T&M ticket not found")
  await requireProjectAccess({ supabase, orgId: resolvedOrgId, userId, projectId: ticket.project_id, permission: "invoice.write", resourceId: ticketId })
  if (!["draft", "submitted"].includes(ticket.status)) throw new Error("Only draft tickets can be submitted.")

  const { data, error } = await supabase
    .from("tm_tickets")
    .update({ status: "submitted", submitted_at: new Date().toISOString(), submitted_by: userId, updated_by: userId })
    .eq("org_id", resolvedOrgId)
    .eq("id", ticketId)
    .select("*")
    .single()
  if (error || !data) throw new Error(`Failed to submit T&M ticket: ${error?.message}`)

  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "tm_ticket", entityId: ticketId, before: auditSnapshot(ticket), after: data })
  await recordEvent({ orgId: resolvedOrgId, eventType: "tm_ticket_submitted", entityType: "tm_ticket", entityId: ticketId, payload: { project_id: ticket.project_id } })
  return (await loadTicketWithItems({ supabase, orgId: resolvedOrgId, ticketId }))!
}

export async function createTmTicketSignatureLink(ticketId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const ticket = await loadTicketWithItems({ supabase, orgId: resolvedOrgId, ticketId })
  if (!ticket) throw new Error("T&M ticket not found")
  await requireProjectAccess({ supabase, orgId: resolvedOrgId, userId, projectId: ticket.project_id, permission: "invoice.write", resourceId: ticketId })
  if (!["draft", "submitted"].includes(ticket.status)) throw new Error("Only draft or submitted tickets can be sent for signature.")

  const token = randomBytes(32).toString("hex")
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
  const { error } = await supabase
    .from("tm_tickets")
    .update({
      status: "submitted",
      submitted_at: ticket.submitted_at ?? new Date().toISOString(),
      submitted_by: ticket.metadata?.submitted_by ?? userId,
      signature_token_hash: hashToken(token),
      signature_token_expires_at: expiresAt,
      updated_by: userId,
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", ticketId)
  if (error) throw new Error(`Failed to create signature link: ${error.message}`)

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ""
  return {
    token,
    expiresAt,
    url: appUrl ? `${appUrl}/t/${token}` : `/t/${token}`,
  }
}

export async function getTmTicketBySignatureToken(token: string): Promise<TmTicket | null> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("tm_tickets")
    .select("*, items:tm_ticket_items(*)")
    .eq("signature_token_hash", hashToken(token))
    .maybeSingle()
  if (error) throw new Error(`Failed to load T&M ticket: ${error.message}`)
  return data ? mapTicket(data) : null
}

export async function signTmTicketByToken(input: SignTmTicketInput): Promise<TmTicket> {
  const parsed = signTmTicketSchema.parse(input)
  const supabase = createServiceSupabaseClient()
  const tokenHash = hashToken(parsed.token)
  const { data: before, error: beforeError } = await supabase
    .from("tm_tickets")
    .select("*")
    .eq("signature_token_hash", tokenHash)
    .maybeSingle()
  if (beforeError || !before) throw new Error("Signature link is invalid.")
  if (before.signature_token_expires_at && new Date(before.signature_token_expires_at) < new Date()) {
    throw new Error("Signature link has expired.")
  }
  if (before.status === "billed") throw new Error("This ticket has already been billed.")
  if (before.status === "voided") throw new Error("This ticket is no longer available.")

  const { data, error } = await supabase
    .from("tm_tickets")
    .update({
      status: "client_signed",
      client_signed_at: new Date().toISOString(),
      client_signer_name: parsed.signerName,
      client_signer_email: parsed.signerEmail ?? null,
      client_signer_ip: parsed.signerIp ?? null,
      signature_data: parsed.signatureData ?? { signer_name: parsed.signerName },
      signature_token_hash: null,
      signature_token_expires_at: null,
    })
    .eq("id", before.id)
    .select("*")
    .single()
  if (error || !data) throw new Error(`Failed to sign T&M ticket: ${error?.message}`)

  await recordAudit({ orgId: data.org_id, action: "update", entityType: "tm_ticket", entityId: data.id, before, after: data, source: "tm_ticket_public_signature" })
  await recordEvent({ orgId: data.org_id, eventType: "tm_ticket_client_signed", entityType: "tm_ticket", entityId: data.id, payload: { project_id: data.project_id, signer_name: parsed.signerName } })
  return (await loadTicketWithItems({ supabase, orgId: data.org_id, ticketId: data.id })) ?? mapTicket({ ...data, items: [] })
}

export async function generateInvoiceFromTmTicket(ticketId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const ticket = await loadTicketWithItems({ supabase, orgId: resolvedOrgId, ticketId })
  if (!ticket) throw new Error("T&M ticket not found")
  await requireProjectAccess({ supabase, orgId: resolvedOrgId, userId, projectId: ticket.project_id, permission: "invoice.write", resourceId: ticketId })
  if (ticket.status !== "client_signed") throw new Error("Only client-signed T&M tickets can be invoiced.")
  if (ticket.invoice_id) throw new Error("This T&M ticket is already linked to an invoice.")

  const billableCostIds = ticket.items.map((item) => item.billable_cost_id).filter((id): id is string => Boolean(id))
  if (billableCostIds.length === 0) throw new Error("This T&M ticket has no billable costs.")

  const result = await generateInvoiceFromCosts(
    {
      projectId: ticket.project_id,
      dateRange: {
        from: new Date(`${ticket.work_date}T00:00:00`),
        to: new Date(`${ticket.work_date}T00:00:00`),
      },
      billableCostIds,
      groupBy: "detail",
      includeAllowanceVariances: false,
      includeEarnedFee: false,
      overrideGmpCap: false,
      dryRun: false,
      idempotencyKey: `tm-ticket-${ticket.id}`,
    },
    resolvedOrgId,
  )

  const { data: invoice } = await supabase
    .from("invoices")
    .select("metadata")
    .eq("org_id", resolvedOrgId)
    .eq("id", result.invoiceId)
    .maybeSingle()
  await supabase
    .from("invoices")
    .update({
      metadata: {
        ...((invoice?.metadata as Record<string, any> | null) ?? {}),
        tm_ticket_id: ticket.id,
        tm_ticket_number: ticket.ticket_number,
        tm_ticket_signed_at: ticket.client_signed_at,
      },
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", result.invoiceId)

  const { data: updated, error } = await supabase
    .from("tm_tickets")
    .update({ status: "billed", invoice_id: result.invoiceId, updated_by: userId })
    .eq("org_id", resolvedOrgId)
    .eq("id", ticket.id)
    .select("*")
    .single()
  if (error || !updated) throw new Error(`Invoice was created, but ticket billing status could not be updated: ${error?.message}`)

  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "tm_ticket", entityId: ticket.id, before: auditSnapshot(ticket), after: updated })
  await recordEvent({ orgId: resolvedOrgId, eventType: "tm_ticket_billed", entityType: "tm_ticket", entityId: ticket.id, payload: { project_id: ticket.project_id, invoice_id: result.invoiceId } })

  return { ...result, ticketId: ticket.id }
}

export async function voidTmTicket(ticketId: string, orgId?: string): Promise<TmTicket> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const ticket = await loadTicketWithItems({ supabase, orgId: resolvedOrgId, ticketId })
  if (!ticket) throw new Error("T&M ticket not found")
  await requireProjectAccess({ supabase, orgId: resolvedOrgId, userId, projectId: ticket.project_id, permission: "invoice.write", resourceId: ticketId })
  if (ticket.status === "billed") throw new Error("Billed T&M tickets cannot be voided.")

  const { data, error } = await supabase
    .from("tm_tickets")
    .update({ status: "voided", signature_token_hash: null, signature_token_expires_at: null, updated_by: userId })
    .eq("org_id", resolvedOrgId)
    .eq("id", ticketId)
    .select("*")
    .single()
  if (error || !data) throw new Error(`Failed to void T&M ticket: ${error?.message}`)

  const billableCostIds = ticket.items.map((item) => item.billable_cost_id).filter((id): id is string => Boolean(id))
  if (billableCostIds.length > 0) {
    const { data: costs, error: costsError } = await supabase
      .from("billable_costs")
      .select("id, metadata")
      .eq("org_id", resolvedOrgId)
      .in("id", billableCostIds)
    if (costsError) throw new Error(`T&M ticket voided, but cost metadata could not be refreshed: ${costsError.message}`)

    for (const cost of costs ?? []) {
      const metadata = { ...((cost.metadata as Record<string, any> | null) ?? {}) }
      if (metadata.tm_ticket_id === ticket.id) {
        delete metadata.tm_ticket_id
        delete metadata.tm_ticket_number
        await supabase
          .from("billable_costs")
          .update({ metadata })
          .eq("org_id", resolvedOrgId)
          .eq("id", cost.id)
      }
    }
  }

  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "tm_ticket", entityId: ticketId, before: auditSnapshot(ticket), after: data })
  return (await loadTicketWithItems({ supabase, orgId: resolvedOrgId, ticketId }))!
}
