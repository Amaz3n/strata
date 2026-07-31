import { createChangeOrder } from "@/lib/services/change-orders"
import { recordAudit } from "@/lib/services/audit"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { insertWithProjectNumberRetry } from "@/lib/services/project-sequence"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { getOrgSenderEmail, renderStandardEmailLayout, sendEmail } from "@/lib/services/mailer"
import { validatePortalToken } from "@/lib/services/portal-access"
import { NotificationService } from "@/lib/services/notifications"
import {
  changeEventRfqResponseSchema,
  createChangeEventSchema,
  priceChangeEventSchema,
  sendChangeEventRfqsSchema,
  type ChangeEventRfqResponseInput,
  type CreateChangeEventInput,
  type PriceChangeEventInput,
  type SendChangeEventRfqsInput,
} from "@/lib/validation/change-events"

const CHANGE_EVENT_SELECT = "id,org_id,project_id,event_number,title,description,origin_type,origin_id,scope,status,rom_cents,latest_price_cents,created_by,created_at,updated_at"

export interface ChangeEventLine {
  id: string
  cost_code_id: string | null
  budget_line_id: string | null
  description: string
  quantity: number
  uom: string | null
  unit_cost_cents: number
  rom_cents: number
  sort_order: number
}

export interface ChangeEventRfq {
  id: string
  commitment_id: string
  status: "draft" | "sent" | "responded" | "declined" | "expired"
  due_date: string | null
  sent_at: string | null
  responded_at: string | null
  response_amount_cents: number | null
  response_notes: string | null
}

export interface ChangeEvent {
  id: string
  org_id: string
  project_id: string
  event_number: number
  title: string
  description: string | null
  origin_type: CreateChangeEventInput["origin_type"]
  origin_id: string | null
  scope: CreateChangeEventInput["scope"]
  status: "open" | "pricing" | "pending_approval" | "converted" | "void"
  rom_cents: number
  latest_price_cents: number
  created_by: string | null
  created_at: string
  updated_at: string
  lines: ChangeEventLine[]
  rfqs: ChangeEventRfq[]
}

function mapLine(row: Record<string, unknown>): ChangeEventLine {
  return {
    id: String(row.id),
    cost_code_id: typeof row.cost_code_id === "string" ? row.cost_code_id : null,
    budget_line_id: typeof row.budget_line_id === "string" ? row.budget_line_id : null,
    description: String(row.description ?? ""),
    quantity: Number(row.quantity ?? 1),
    uom: typeof row.uom === "string" ? row.uom : null,
    unit_cost_cents: Number(row.unit_cost_cents ?? 0),
    rom_cents: Number(row.rom_cents ?? 0),
    sort_order: Number(row.sort_order ?? 0),
  }
}

function mapRfq(row: Record<string, unknown>): ChangeEventRfq {
  return {
    id: String(row.id),
    commitment_id: String(row.commitment_id),
    status: String(row.status) as ChangeEventRfq["status"],
    due_date: typeof row.due_date === "string" ? row.due_date : null,
    sent_at: typeof row.sent_at === "string" ? row.sent_at : null,
    responded_at: typeof row.responded_at === "string" ? row.responded_at : null,
    response_amount_cents: row.response_amount_cents == null ? null : Number(row.response_amount_cents),
    response_notes: typeof row.response_notes === "string" ? row.response_notes : null,
  }
}

function mapEvent(row: Record<string, unknown>, lines: ChangeEventLine[] = [], rfqs: ChangeEventRfq[] = []): ChangeEvent {
  return {
    id: String(row.id), org_id: String(row.org_id), project_id: String(row.project_id),
    event_number: Number(row.event_number), title: String(row.title),
    description: typeof row.description === "string" ? row.description : null,
    origin_type: String(row.origin_type) as ChangeEvent["origin_type"],
    origin_id: typeof row.origin_id === "string" ? row.origin_id : null,
    scope: String(row.scope) as ChangeEvent["scope"], status: String(row.status) as ChangeEvent["status"],
    rom_cents: Number(row.rom_cents ?? 0), latest_price_cents: Number(row.latest_price_cents ?? 0),
    created_by: typeof row.created_by === "string" ? row.created_by : null,
    created_at: String(row.created_at), updated_at: String(row.updated_at), lines, rfqs,
  }
}

async function authorizeProject(permission: string, projectId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requireAuthorization({ permission, userId: context.userId, orgId: context.orgId, projectId, supabase: context.supabase, logDecision: true, resourceType: "project", resourceId: projectId })
  return context
}

async function loadEventRecord(id: string, orgId: string, projectId?: string) {
  const { supabase } = await requireOrgContext(orgId)
  let query = supabase.from("change_events").select(CHANGE_EVENT_SELECT).eq("org_id", orgId).eq("id", id)
  if (projectId) query = query.eq("project_id", projectId)
  const { data, error } = await query.maybeSingle()
  if (error) throw new Error(`Failed to load change event: ${error.message}`)
  if (!data) throw new Error("Change event not found")
  return data as Record<string, unknown>
}

export async function listChangeEvents(projectId: string, orgId?: string, limit = 200): Promise<ChangeEvent[]> {
  const { supabase, orgId: resolvedOrgId } = await authorizeProject("change_events.read", projectId, orgId)
  const { data, error } = await supabase.from("change_events").select(CHANGE_EVENT_SELECT).eq("org_id", resolvedOrgId).eq("project_id", projectId).order("event_number", { ascending: false }).limit(Math.min(Math.max(limit, 1), 500))
  if (error) throw new Error(`Failed to list change events: ${error.message}`)
  const rows = (data ?? []) as Record<string, unknown>[]
  if (rows.length === 0) return []
  const ids = rows.map((row) => String(row.id))
  const [{ data: lineRows, error: lineError }, { data: rfqRows, error: rfqError }] = await Promise.all([
    supabase.from("change_event_lines").select("*").eq("org_id", resolvedOrgId).in("change_event_id", ids).order("sort_order"),
    supabase.from("change_event_rfqs").select("*").eq("org_id", resolvedOrgId).in("change_event_id", ids),
  ])
  if (lineError || rfqError) throw new Error(`Failed to load change-event detail: ${lineError?.message ?? rfqError?.message}`)
  return rows.map((row) => mapEvent(row,
    (lineRows ?? []).filter((line) => line.change_event_id === row.id).map((line) => mapLine(line)),
    (rfqRows ?? []).filter((rfq) => rfq.change_event_id === row.id).map((rfq) => mapRfq(rfq))))
}

export async function createChangeEvent(input: CreateChangeEventInput, orgId?: string): Promise<ChangeEvent> {
  const parsed = createChangeEventSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await authorizeProject("change_events.write", parsed.project_id, orgId)
  const { data } = await insertWithProjectNumberRetry<Record<string, unknown>>({
    supabase, table: "change_events", numberColumn: "event_number", rpcName: "next_change_event_number",
    conflictConstraint: "change_events_project_id_event_number_key", projectId: parsed.project_id,
    payload: { org_id: resolvedOrgId, project_id: parsed.project_id, title: parsed.title, description: parsed.description ?? null, origin_type: parsed.origin_type, origin_id: parsed.origin_id ?? null, scope: parsed.scope, rom_cents: parsed.rom_cents, created_by: userId },
    select: CHANGE_EVENT_SELECT, entityLabel: "change event",
  })
  const lines = parsed.lines.map((line, sortOrder) => ({ org_id: resolvedOrgId, project_id: parsed.project_id, change_event_id: data.id, cost_code_id: line.cost_code_id ?? null, budget_line_id: line.budget_line_id ?? null, description: line.description, quantity: line.quantity, uom: line.uom ?? null, unit_cost_cents: line.unit_cost_cents, rom_cents: line.rom_cents, sort_order: sortOrder }))
  if (lines.length) {
    const { error } = await supabase.from("change_event_lines").insert(lines)
    if (error) throw new Error(`Failed to create change-event lines: ${error.message}`)
  }
  await Promise.all([
    recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "change_event_created", entityType: "change_event", entityId: String(data.id), payload: { project_id: parsed.project_id, title: parsed.title, origin_type: parsed.origin_type } }),
    recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "change_event", entityId: String(data.id), after: { ...data, lines } }),
  ])
  return mapEvent(data, lines.map((line, index) => mapLine({ ...line, id: `pending-${index}` })))
}

export async function createSystemChangeEvent(input: {
  orgId: string
  projectId: string
  title: string
  description?: string | null
  originType: Exclude<CreateChangeEventInput["origin_type"], "manual">
  originId: string
}): Promise<ChangeEvent> {
  const parsed = createChangeEventSchema.parse({ project_id: input.projectId, title: input.title, description: input.description, origin_type: input.originType, origin_id: input.originId, scope: "tbd", rom_cents: 0, lines: [] })
  const supabase = createServiceSupabaseClient()
  const { data: duplicate } = await supabase.from("change_events").select(CHANGE_EVENT_SELECT).eq("org_id", input.orgId).eq("project_id", parsed.project_id).eq("origin_type", parsed.origin_type).eq("origin_id", parsed.origin_id).neq("status", "void").maybeSingle()
  if (duplicate) return mapEvent(duplicate)
  const { data: project } = await supabase.from("projects").select("id").eq("org_id", input.orgId).eq("id", parsed.project_id).maybeSingle()
  if (!project) throw new Error("Project not found for system change event")
  const { data } = await insertWithProjectNumberRetry<Record<string, unknown>>({
    supabase, table: "change_events", numberColumn: "event_number", rpcName: "next_change_event_number",
    conflictConstraint: "change_events_project_id_event_number_key", projectId: parsed.project_id,
    payload: { org_id: input.orgId, project_id: parsed.project_id, title: parsed.title, description: parsed.description ?? null, origin_type: parsed.origin_type, origin_id: parsed.origin_id, scope: "tbd", rom_cents: 0, created_by: null },
    select: CHANGE_EVENT_SELECT, entityLabel: "change event",
  })
  await Promise.all([
    recordEvent({ orgId: input.orgId, actorId: null, eventType: "change_event_auto_caught", entityType: "change_event", entityId: String(data.id), payload: { project_id: parsed.project_id, origin_type: parsed.origin_type, origin_id: parsed.origin_id } }),
    recordAudit({ orgId: input.orgId, action: "insert", entityType: "change_event", entityId: String(data.id), after: data, source: "auto_catch" }),
  ])
  return mapEvent(data)
}

export async function priceChangeEvent(id: string, input: PriceChangeEventInput, orgId?: string): Promise<ChangeEvent> {
  const parsed = priceChangeEventSchema.parse(input)
  const existing = await loadEventRecord(id, orgId ?? (await requireOrgContext()).orgId)
  const projectId = String(existing.project_id)
  const { supabase, orgId: resolvedOrgId, userId } = await authorizeProject("change_events.write", projectId, orgId)
  if (["converted", "void"].includes(String(existing.status))) throw new Error("Closed change events cannot be repriced")
  const lines = parsed.lines.map((line, sortOrder) => ({ org_id: resolvedOrgId, project_id: projectId, change_event_id: id, cost_code_id: line.cost_code_id ?? null, budget_line_id: line.budget_line_id ?? null, description: line.description, quantity: line.quantity, uom: line.uom ?? null, unit_cost_cents: line.unit_cost_cents, rom_cents: line.rom_cents, sort_order: sortOrder }))
  const latestPriceCents = lines.reduce((sum, line) => sum + Math.round(line.quantity * line.unit_cost_cents), 0)
  const { error: deleteError } = await supabase.from("change_event_lines").delete().eq("org_id", resolvedOrgId).eq("change_event_id", id)
  if (deleteError) throw new Error(`Failed to replace change-event pricing: ${deleteError.message}`)
  const { error: insertError } = await supabase.from("change_event_lines").insert(lines)
  if (insertError) throw new Error(`Failed to save change-event pricing: ${insertError.message}`)
  const { data, error } = await supabase.from("change_events").update({ status: "pricing", latest_price_cents: latestPriceCents }).eq("org_id", resolvedOrgId).eq("id", id).select(CHANGE_EVENT_SELECT).single()
  if (error || !data) throw new Error(`Failed to price change event: ${error?.message}`)
  await Promise.all([
    recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "change_event_priced", entityType: "change_event", entityId: id, payload: { project_id: projectId, latest_price_cents: latestPriceCents } }),
    recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "change_event", entityId: id, before: existing, after: data }),
  ])
  return mapEvent(data, lines.map((line, index) => mapLine({ ...line, id: `pending-${index}` })))
}

export async function sendChangeEventRfqs(id: string, input: SendChangeEventRfqsInput, orgId?: string): Promise<ChangeEventRfq[]> {
  const parsed = sendChangeEventRfqsSchema.parse(input)
  const context = await requireOrgContext(orgId)
  const existing = await loadEventRecord(id, context.orgId)
  const projectId = String(existing.project_id)
  const { supabase, orgId: resolvedOrgId, userId } = await authorizeProject("change_events.write", projectId, context.orgId)
  const { data: commitments, error: commitmentError } = await supabase.from("commitments").select("id,company_id,company:companies(name,email)").eq("org_id", resolvedOrgId).eq("project_id", projectId).in("id", parsed.commitment_ids)
  if (commitmentError || commitments?.length !== new Set(parsed.commitment_ids).size) throw new Error("One or more RFQ recipients are not commitments on this project")
  const now = new Date().toISOString()
  const payload = parsed.commitment_ids.map((commitmentId) => ({ org_id: resolvedOrgId, project_id: projectId, change_event_id: id, commitment_id: commitmentId, status: "sent", due_date: parsed.due_date ?? null, sent_at: now, created_by: userId }))
  const { data, error } = await supabase.from("change_event_rfqs").upsert(payload, { onConflict: "change_event_id,commitment_id" }).select("*")
  if (error) throw new Error(`Failed to send RFQs: ${error.message}`)
  await supabase.from("change_events").update({ status: "pricing" }).eq("org_id", resolvedOrgId).eq("id", id)
  const service = createServiceSupabaseClient()
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "https://arcnaples.com").replace(/\/$/, "")
  for (const rfq of data ?? []) {
    const commitment = commitments?.find((item) => item.id === rfq.commitment_id) as any
    const company = Array.isArray(commitment?.company) ? commitment.company[0] : commitment?.company
    if (!commitment?.company_id || !company?.email) continue
    const { data: access } = await service.from("portal_access_tokens").insert({
      org_id: resolvedOrgId, project_id: projectId, portal_type: "sub", company_id: commitment.company_id,
      scoped_change_event_rfq_id: rfq.id, can_view_schedule: false, can_view_photos: false,
      can_view_documents: false, can_view_daily_logs: false, can_view_budget: false,
      can_approve_change_orders: false, can_submit_selections: false, can_create_punch_items: false,
      can_message: false, can_view_invoices: false, can_pay_invoices: false, can_view_rfis: false,
      can_respond_rfis: false, can_view_submittals: false, can_submit_submittals: false,
      can_download_files: true, can_submit_invoices: false, can_view_commitments: false,
      can_view_bills: false, can_upload_compliance_docs: false, require_account: false,
      expires_at: parsed.due_date ? new Date(`${parsed.due_date}T23:59:59.999Z`).toISOString() : new Date(Date.now() + 30 * 86_400_000).toISOString(), created_by: userId,
    }).select("token").single()
    if (!access?.token) continue
    const url = `${appUrl}/s/${access.token}/rfqs`
    const html = renderStandardEmailLayout({ title: `Pricing requested: ${String(existing.title)}`, messageHtml: `<p>Please review the scope and submit your price${parsed.due_date ? ` by ${parsed.due_date}` : ""}.</p>`, buttonText: "Submit pricing", buttonUrl: url, showManageSettings: false })
    await sendEmail({ from: getOrgSenderEmail(), to: [company.email], subject: `RFQ: ${String(existing.title)}`, html })
  }
  await recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "change_event_rfqs_sent", entityType: "change_event", entityId: id, payload: { project_id: projectId, commitment_ids: parsed.commitment_ids, due_date: parsed.due_date ?? null } })
  return (data ?? []).map((row) => mapRfq(row))
}

export async function getPortalChangeEventRfq(token: string) {
  const access = await validatePortalToken(token)
  if (!access?.scoped_change_event_rfq_id || access.portal_type !== "sub") return null
  const service = createServiceSupabaseClient()
  const { data } = await service.from("change_event_rfqs").select("id,change_event_id,status,due_date,response_amount_cents,response_notes,change_event:change_events(id,event_number,title,description,rom_cents,created_by),commitment:commitments(title)").eq("org_id", access.org_id).eq("project_id", access.project_id).eq("id", access.scoped_change_event_rfq_id).maybeSingle()
  return data ? { access, rfq: data } : null
}

export async function recordPortalChangeEventRfqResponse(token: string, input: ChangeEventRfqResponseInput) {
  const parsed = changeEventRfqResponseSchema.parse(input)
  const portal = await getPortalChangeEventRfq(token)
  if (!portal || !["sent", "draft"].includes(portal.rfq.status)) throw new Error("This RFQ is no longer open.")
  const service = createServiceSupabaseClient()
  const now = new Date().toISOString()
  const { data, error } = await service.from("change_event_rfqs").update({ status: parsed.declined ? "declined" : "responded", response_amount_cents: parsed.declined ? null : parsed.amount_cents, response_notes: parsed.notes ?? null, responded_at: now }).eq("org_id", portal.access.org_id).eq("project_id", portal.access.project_id).eq("id", portal.rfq.id).select("*").single()
  if (error || !data) throw new Error(`Failed to submit RFQ response: ${error?.message}`)
  const event = Array.isArray(portal.rfq.change_event) ? portal.rfq.change_event[0] : portal.rfq.change_event
  const { data: responses } = await service.from("change_event_rfqs").select("response_amount_cents").eq("org_id", portal.access.org_id).eq("change_event_id", portal.rfq.change_event_id).eq("status", "responded")
  const latestPriceCents = Math.max(0, ...(responses ?? []).map((row) => Number(row.response_amount_cents ?? 0)))
  await service.from("change_events").update({ status: "pending_approval", latest_price_cents: latestPriceCents }).eq("org_id", portal.access.org_id).eq("project_id", portal.access.project_id).eq("id", portal.rfq.change_event_id)
  await recordEvent({ orgId: portal.access.org_id, actorId: null, eventType: "change_event_rfq_responded", entityType: "change_event_rfq", entityId: portal.rfq.id, payload: { project_id: portal.access.project_id, amount_cents: parsed.declined ? null : parsed.amount_cents, declined: parsed.declined }, channel: "activity" })
  if (event?.created_by) {
    await new NotificationService().createAndQueue({
      orgId: portal.access.org_id,
      userId: event.created_by,
      type: "change_event_rfq_response",
      title: `RFQ response: ${event.title}`,
      message: parsed.declined ? "The subcontractor declined this pricing request." : `A price of $${(parsed.amount_cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} was submitted.`,
      projectId: portal.access.project_id,
      entityType: "change_event",
      entityId: event.id,
      metadata: { href: `/projects/${portal.access.project_id}/change-orders?event=${event.id}` },
    })
  }
  return data
}

export async function recordChangeEventRfqResponse(rfqId: string, input: ChangeEventRfqResponseInput, orgId?: string): Promise<ChangeEventRfq> {
  const parsed = changeEventRfqResponseSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: existing, error: existingError } = await supabase.from("change_event_rfqs").select("*").eq("org_id", resolvedOrgId).eq("id", rfqId).maybeSingle()
  if (existingError || !existing) throw new Error("Change-event RFQ not found")
  await requireAuthorization({ permission: "change_events.write", userId, orgId: resolvedOrgId, projectId: existing.project_id, supabase, logDecision: true, resourceType: "project", resourceId: existing.project_id })
  const { data, error } = await supabase.from("change_event_rfqs").update({ status: parsed.declined ? "declined" : "responded", response_amount_cents: parsed.declined ? null : parsed.amount_cents, response_notes: parsed.notes ?? null, responded_at: new Date().toISOString() }).eq("org_id", resolvedOrgId).eq("id", rfqId).select("*").single()
  if (error || !data) throw new Error(`Failed to record RFQ response: ${error?.message}`)
  const { data: responses } = await supabase.from("change_event_rfqs").select("response_amount_cents").eq("org_id", resolvedOrgId).eq("change_event_id", existing.change_event_id).eq("status", "responded")
  const latestPriceCents = Math.max(0, ...(responses ?? []).map((row) => Number(row.response_amount_cents ?? 0)))
  await supabase.from("change_events").update({ latest_price_cents: latestPriceCents, status: "pending_approval" }).eq("org_id", resolvedOrgId).eq("id", existing.change_event_id)
  await recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "change_event_rfq_responded", entityType: "change_event", entityId: existing.change_event_id, payload: { project_id: existing.project_id, rfq_id: rfqId, amount_cents: parsed.declined ? null : parsed.amount_cents, declined: parsed.declined } })
  return mapRfq(data)
}

export async function convertChangeEventToChangeOrder(id: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  const existing = await loadEventRecord(id, context.orgId)
  const projectId = String(existing.project_id)
  const { supabase, orgId: resolvedOrgId, userId } = await authorizeProject("change_events.convert", projectId, context.orgId)
  if (["converted", "void"].includes(String(existing.status))) throw new Error("Change event is already closed")
  const { data: rows, error } = await supabase.from("change_event_lines").select("*").eq("org_id", resolvedOrgId).eq("change_event_id", id).order("sort_order")
  if (error) throw new Error(`Failed to load change-event lines: ${error.message}`)
  const lines = (rows ?? []).map((row) => mapLine(row))
  if (lines.length === 0) throw new Error("Price at least one line before conversion")
  const changeOrder = await createChangeOrder({ orgId: resolvedOrgId, input: { project_id: projectId, title: String(existing.title), summary: String(existing.description ?? existing.title), description: typeof existing.description === "string" ? existing.description : undefined, requires_signature: true, tax_rate: 0, markup_percent: 0, markup_mode: "percent", pricing_display: "itemized", zero_dollar: false, client_visible: false, lifecycle: "draft", status: "draft", lines: lines.map((line) => ({ cost_code_id: line.cost_code_id ?? undefined, budget_line_id: line.budget_line_id ?? undefined, description: line.description, quantity: line.quantity, unit: line.uom ?? "unit", unit_cost: line.unit_cost_cents / 100, internal_cost_cents: line.unit_cost_cents, allowance: 0, taxable: true, gmp_classification: "inside_gmp", gmp_impact: "none" })) } })
  await Promise.all([
    supabase.from("change_orders").update({ change_event_id: id }).eq("org_id", resolvedOrgId).eq("id", changeOrder.id),
    supabase.from("change_events").update({ status: "converted" }).eq("org_id", resolvedOrgId).eq("id", id),
  ])
  await Promise.all([
    recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "change_event_converted", entityType: "change_event", entityId: id, payload: { project_id: projectId, change_order_id: changeOrder.id } }),
    recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "change_event", entityId: id, before: existing, after: { ...existing, status: "converted", change_order_id: changeOrder.id } }),
  ])
  return changeOrder
}

export async function voidChangeEvent(id: string, reason: string, orgId?: string): Promise<void> {
  if (reason.trim().length < 8) throw new Error("A reason of at least 8 characters is required")
  const context = await requireOrgContext(orgId)
  const existing = await loadEventRecord(id, context.orgId)
  const { supabase, orgId: resolvedOrgId, userId } = await authorizeProject("change_events.write", String(existing.project_id), context.orgId)
  if (existing.status === "converted") throw new Error("Converted change events cannot be voided")
  const { error } = await supabase.from("change_events").update({ status: "void" }).eq("org_id", resolvedOrgId).eq("id", id)
  if (error) throw new Error(`Failed to void change event: ${error.message}`)
  await Promise.all([
    recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "change_event_voided", entityType: "change_event", entityId: id, payload: { project_id: existing.project_id, reason } }),
    recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "change_event", entityId: id, before: existing, after: { ...existing, status: "void", void_reason: reason } }),
  ])
}
