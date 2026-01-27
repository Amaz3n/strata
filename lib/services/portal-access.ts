import { randomBytes } from "node:crypto"
import { compare, hash } from "bcryptjs"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import type {
  ChangeOrder,
  ClientPortalData,
  DailyLog,
  DrawSchedule,
  Invoice,
  PortalAccessToken,
  PortalFinancialSummary,
  PortalMessage,
  PortalPermissions,
  PunchItem,
  Rfi,
  Selection,
  Submittal,
  SubPortalData,
  SubPortalCommitment,
  SubPortalBill,
  SubPortalFinancialSummary,
  WarrantyRequest,
} from "@/lib/types"

import { listScheduleItemsWithClient } from "@/lib/services/schedule"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"

const PIN_SALT_ROUNDS = 10
const MAX_PIN_ATTEMPTS = 5
const LOCKOUT_DURATION_MS = 15 * 60 * 1000

function mapPermissions(row: any): PortalPermissions {
  return {
    can_view_schedule: !!row.can_view_schedule,
    can_view_photos: !!row.can_view_photos,
    can_view_documents: !!row.can_view_documents,
    can_download_files: row.can_download_files ?? true,
    can_view_daily_logs: !!row.can_view_daily_logs,
    can_view_budget: !!row.can_view_budget,
    can_approve_change_orders: !!row.can_approve_change_orders,
    can_submit_selections: !!row.can_submit_selections,
    can_create_punch_items: !!row.can_create_punch_items,
    can_message: !!row.can_message,
    can_view_invoices: row.can_view_invoices ?? true,
    can_pay_invoices: row.can_pay_invoices ?? false,
    can_view_rfis: row.can_view_rfis ?? true,
    can_view_submittals: row.can_view_submittals ?? true,
    can_respond_rfis: row.can_respond_rfis ?? true,
    can_submit_submittals: row.can_submit_submittals ?? true,
    // Sub-specific permissions
    can_view_commitments: row.can_view_commitments ?? true,
    can_view_bills: row.can_view_bills ?? true,
    can_submit_invoices: row.can_submit_invoices ?? true,
    can_upload_compliance_docs: row.can_upload_compliance_docs ?? true,
  }
}

function mapAccessToken(row: any): PortalAccessToken {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    contact_id: row.contact_id ?? null,
    company_id: row.company_id ?? null,
    token: row.token,
    name: row.name,
    portal_type: row.portal_type,
    permissions: mapPermissions(row),
    pin_required: !!row.pin_required,
    pin_locked_until: row.pin_locked_until ?? null,
    expires_at: row.expires_at ?? null,
    access_count: row.access_count ?? 0,
    max_access_count: row.max_access_count ?? null,
    last_accessed_at: row.last_accessed_at ?? null,
    revoked_at: row.revoked_at ?? null,
    created_at: row.created_at,
  }
}

export async function createPortalAccessToken({
  projectId,
  portalType,
  contactId,
  companyId,
  permissions,
  expiresAt,
  orgId,
}: {
  projectId: string
  portalType: "client" | "sub"
  contactId?: string
  companyId?: string
  permissions?: Partial<PortalPermissions>
  expiresAt?: string | null
  orgId?: string
}): Promise<PortalAccessToken> {
  const { orgId: resolvedOrgId, userId, supabase } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })
  const serviceClient = createServiceSupabaseClient()

  const payload = {
    org_id: resolvedOrgId,
    project_id: projectId,
    portal_type: portalType,
    contact_id: contactId ?? null,
    company_id: companyId ?? null,
    expires_at: expiresAt ?? null,
    created_by: userId,
    ...permissionsToColumns(permissions),
  }

  const { data, error } = await serviceClient
    .from("portal_access_tokens")
    .insert(payload)
    .select("*")
    .single()

  if (error || !data) {
    throw new Error(`Failed to create portal access token: ${error?.message}`)
  }

  return mapAccessToken(data)
}

export async function validatePortalToken(token: string) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("portal_access_tokens")
    .select("*, contact:contacts(id, full_name, email), company:companies(id, name, company_type)")
    .eq("token", token)
    .is("revoked_at", null)
    .maybeSingle()

  if (error) {
    console.error("Failed to validate portal token", error)
    return null
  }

  if (!data) return null

  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    return null
  }

  return mapAccessToken(data)
}

export async function revokePortalToken(tokenId: string, orgId?: string) {
  const { orgId: resolvedOrgId, supabase, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })
  const serviceClient = createServiceSupabaseClient()
  const { error } = await serviceClient
    .from("portal_access_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", tokenId)
    .eq("org_id", resolvedOrgId)

  if (error) {
    throw new Error(`Failed to revoke portal token: ${error.message}`)
  }
}

export async function listPortalTokens(projectId: string, orgId?: string): Promise<PortalAccessToken[]> {
  const { orgId: resolvedOrgId, supabase, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })
  const serviceClient = createServiceSupabaseClient()
  const { data, error } = await serviceClient
    .from("portal_access_tokens")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to list portal tokens: ${error.message}`)
  }

  return (data ?? []).map(mapAccessToken)
}

export async function recordPortalAccess(tokenId: string) {
  const supabase = createServiceSupabaseClient()
  const { data: tokenRow, error } = await supabase
    .from("portal_access_tokens")
    .select("access_count, max_access_count")
    .eq("id", tokenId)
    .maybeSingle()

  if (error) {
    console.error("Failed to fetch portal access token for access count", error)
    return
  }

  const currentCount = tokenRow?.access_count ?? 0
  if (tokenRow?.max_access_count && currentCount >= tokenRow.max_access_count) {
    console.warn("Portal token max access count reached", tokenId)
    return
  }

  await supabase
    .from("portal_access_tokens")
    .update({
      last_accessed_at: new Date().toISOString(),
      access_count: currentCount + 1,
    })
    .eq("id", tokenId)
}

export async function setPortalTokenPin({
  tokenId,
  pin,
  orgId,
}: {
  tokenId: string
  pin: string
  orgId?: string
}): Promise<void> {
  const { orgId: resolvedOrgId, supabase, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })
  const serviceClient = createServiceSupabaseClient()

  const pinHash = await hash(pin, PIN_SALT_ROUNDS)

  const { error } = await serviceClient
    .from("portal_access_tokens")
    .update({
      pin_hash: pinHash,
      pin_required: true,
      pin_attempts: 0,
      pin_locked_until: null,
    })
    .eq("id", tokenId)
    .eq("org_id", resolvedOrgId)

  if (error) throw new Error(`Failed to set PIN: ${error.message}`)
}

export async function removePortalTokenPin({
  tokenId,
  orgId,
}: {
  tokenId: string
  orgId?: string
}): Promise<void> {
  const { orgId: resolvedOrgId, supabase, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })
  const serviceClient = createServiceSupabaseClient()

  const { error } = await serviceClient
    .from("portal_access_tokens")
    .update({
      pin_hash: null,
      pin_required: false,
      pin_attempts: 0,
      pin_locked_until: null,
    })
    .eq("id", tokenId)
    .eq("org_id", resolvedOrgId)

  if (error) throw new Error(`Failed to remove PIN: ${error.message}`)
}

export async function validatePortalPin({
  token,
  pin,
}: {
  token: string
  pin: string
}): Promise<{ valid: boolean; attemptsRemaining?: number; lockedUntil?: string }> {
  const supabase = createServiceSupabaseClient()

  const { data, error } = await supabase
    .from("portal_access_tokens")
    .select("id, pin_hash, pin_attempts, pin_locked_until")
    .eq("token", token)
    .is("revoked_at", null)
    .maybeSingle()

  if (error || !data || !data.pin_hash) {
    return { valid: false }
  }

  if (data.pin_locked_until && new Date(data.pin_locked_until) > new Date()) {
    return { valid: false, lockedUntil: data.pin_locked_until }
  }

  const isValid = await compare(pin, data.pin_hash)

  if (isValid) {
    await supabase
      .from("portal_access_tokens")
      .update({ pin_attempts: 0, pin_locked_until: null })
      .eq("id", data.id)
    return { valid: true }
  }

  const newAttempts = (data.pin_attempts ?? 0) + 1
  const lockoutTime = newAttempts >= MAX_PIN_ATTEMPTS
    ? new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString()
    : null

  await supabase
    .from("portal_access_tokens")
    .update({
      pin_attempts: newAttempts,
      pin_locked_until: lockoutTime,
    })
    .eq("id", data.id)

  return {
    valid: false,
    attemptsRemaining: Math.max(0, MAX_PIN_ATTEMPTS - newAttempts),
    lockedUntil: lockoutTime ?? undefined,
  }
}

async function getOrCreatePortalConversation({
  orgId,
  projectId,
  channel,
  audienceCompanyId,
}: {
  orgId: string
  projectId: string
  channel: "client" | "sub"
  audienceCompanyId?: string | null
}) {
  const supabase = createServiceSupabaseClient()

  // Build query with audience_company_id for proper scoping
  let query = supabase
    .from("conversations")
    .select("id")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("channel", channel)

  // For sub conversations, require audience_company_id match
  // For client conversations, also match by company if provided
  if (audienceCompanyId) {
    query = query.eq("audience_company_id", audienceCompanyId)
  } else {
    query = query.is("audience_company_id", null)
  }

  const { data: existing } = await query.maybeSingle()

  if (existing) return existing.id

  const { data, error } = await supabase
    .from("conversations")
    .insert({
      org_id: orgId,
      project_id: projectId,
      channel,
      audience_company_id: audienceCompanyId ?? null,
    })
    .select("id")
    .single()

  if (error) throw new Error(`Failed to create conversation: ${error.message}`)
  return data.id as string
}

export async function listPortalMessages({
  orgId,
  projectId,
  channel,
  audienceCompanyId,
}: {
  orgId: string
  projectId: string
  channel: "client" | "sub"
  audienceCompanyId?: string | null
}): Promise<PortalMessage[]> {
  const supabase = createServiceSupabaseClient()
  const conversationId = await getOrCreatePortalConversation({ orgId, projectId, channel, audienceCompanyId })

  const { data, error } = await supabase
    .from("messages")
    .select("id, org_id, conversation_id, sender_id, message_type, body, payload, sent_at, sender:app_users(full_name, avatar_url)")
    .eq("org_id", orgId)
    .eq("conversation_id", conversationId)
    .order("sent_at", { ascending: true })

  if (error) throw new Error(`Failed to load portal messages: ${error.message}`)

  return (data ?? []).map((row: any) => ({
    id: row.id,
    org_id: row.org_id,
    conversation_id: row.conversation_id,
    sender_id: row.sender_id ?? undefined,
    message_type: row.message_type,
    body: row.body,
    payload: row.payload ?? {},
    sent_at: row.sent_at,
    sender_name: row.sender?.full_name ?? row.payload?.sender_name ?? "Portal user",
    sender_avatar_url: row.sender?.avatar_url ?? undefined,
  }))
}

export async function listPortalEntityMessages({
  orgId,
  projectId,
  channel,
  entityType,
  entityId,
  audienceCompanyId,
}: {
  orgId: string
  projectId: string
  channel: "client" | "sub"
  entityType: "rfi" | "submittal"
  entityId: string
  audienceCompanyId?: string | null
}): Promise<PortalMessage[]> {
  const supabase = createServiceSupabaseClient()
  const conversationId = await getOrCreatePortalConversation({ orgId, projectId, channel, audienceCompanyId })

  const { data, error } = await supabase
    .from("messages")
    .select("id, org_id, conversation_id, sender_id, message_type, body, payload, sent_at, sender:app_users(full_name, avatar_url)")
    .eq("org_id", orgId)
    .eq("conversation_id", conversationId)
    .eq("payload->>entity_type", entityType)
    .eq("payload->>entity_id", entityId)
    .order("sent_at", { ascending: true })

  if (error) throw new Error(`Failed to load portal messages: ${error.message}`)

  return (data ?? []).map((row: any) => ({
    id: row.id,
    org_id: row.org_id,
    conversation_id: row.conversation_id,
    sender_id: row.sender_id ?? undefined,
    message_type: row.message_type,
    body: row.body,
    payload: row.payload ?? {},
    sent_at: row.sent_at,
    sender_name: row.sender?.full_name ?? row.payload?.sender_name ?? "Portal user",
    sender_avatar_url: row.sender?.avatar_url ?? undefined,
  }))
}

export async function postPortalMessage({
  orgId,
  projectId,
  channel,
  body,
  senderName,
  portalTokenId,
  audienceCompanyId,
}: {
  orgId: string
  projectId: string
  channel: "client" | "sub"
  body: string
  senderName?: string
  portalTokenId?: string
  audienceCompanyId?: string | null
}) {
  const supabase = createServiceSupabaseClient()
  const conversationId = await getOrCreatePortalConversation({ orgId, projectId, channel, audienceCompanyId })

  const { data, error } = await supabase
    .from("messages")
    .insert({
      org_id: orgId,
      conversation_id: conversationId,
      sender_id: null,
      message_type: "text",
      body,
      payload: { sender_name: senderName ?? "Portal user", portal_token_id: portalTokenId },
    })
    .select("id, org_id, conversation_id, sender_id, message_type, body, payload, sent_at")
    .single()

  if (error || !data) {
    throw new Error(`Failed to send portal message: ${error?.message}`)
  }

  return {
    id: data.id,
    org_id: data.org_id,
    conversation_id: data.conversation_id,
    sender_id: data.sender_id ?? undefined,
    message_type: data.message_type,
    body: data.body,
    payload: data.payload ?? {},
    sent_at: data.sent_at,
    sender_name: data.payload?.sender_name ?? "Portal user",
    sender_avatar_url: undefined,
  } as PortalMessage
}

export async function postPortalEntityMessage({
  orgId,
  projectId,
  channel,
  body,
  senderName,
  portalTokenId,
  entityType,
  entityId,
  audienceCompanyId,
}: {
  orgId: string
  projectId: string
  channel: "client" | "sub"
  body: string
  senderName?: string
  portalTokenId?: string
  entityType: "rfi" | "submittal"
  entityId: string
  audienceCompanyId?: string | null
}) {
  const supabase = createServiceSupabaseClient()
  const conversationId = await getOrCreatePortalConversation({ orgId, projectId, channel, audienceCompanyId })

  const { data, error } = await supabase
    .from("messages")
    .insert({
      org_id: orgId,
      conversation_id: conversationId,
      sender_id: null,
      message_type: "text",
      body,
      payload: {
        sender_name: senderName ?? "Portal user",
        portal_token_id: portalTokenId,
        entity_type: entityType,
        entity_id: entityId,
      },
    })
    .select("id, org_id, conversation_id, sender_id, message_type, body, payload, sent_at")
    .single()

  if (error || !data) {
    throw new Error(`Failed to send portal message: ${error?.message}`)
  }

  return {
    id: data.id,
    org_id: data.org_id,
    conversation_id: data.conversation_id,
    sender_id: data.sender_id ?? undefined,
    message_type: data.message_type,
    body: data.body,
    payload: data.payload ?? {},
    sent_at: data.sent_at,
    sender_name: data.payload?.sender_name ?? "Portal user",
    sender_avatar_url: undefined,
  } as PortalMessage
}

async function loadPortalFinancialSummary({
  orgId,
  projectId,
}: {
  orgId: string
  projectId: string
}): Promise<PortalFinancialSummary> {
  const supabase = createServiceSupabaseClient()

  const [contractResult, projectResult, approvedCosResult, paymentsResult, nextDrawResult, drawsResult] = await Promise.all([
    supabase
      .from("contracts")
      .select("total_cents")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("status", "active")
      .maybeSingle(),
    supabase
      .from("projects")
      .select("total_value")
      .eq("id", projectId)
      .single(),
    supabase
      .from("change_orders")
      .select("total_cents")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("status", "approved")
      .eq("client_visible", true),
    supabase
      .from("payments")
      .select("amount_cents")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .not("invoice_id", "is", null)
      .eq("status", "succeeded"),
    supabase
      .from("draw_schedules")
      .select("id, draw_number, title, amount_cents, percent_of_contract, due_date, status")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("status", "pending")
      .order("due_date", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("draw_schedules")
      .select("*")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .order("draw_number", { ascending: true }),
  ])

  const baseContractTotal = contractResult.data?.total_cents ??
    (projectResult.data?.total_value ? projectResult.data.total_value * 100 : 0)
  const approvedChangesTotal = (approvedCosResult.data ?? []).reduce((sum, row) => sum + (row.total_cents ?? 0), 0)
  const contractTotal = baseContractTotal + approvedChangesTotal
  const totalPaid = (paymentsResult.data ?? []).reduce((sum, p) => sum + (p.amount_cents ?? 0), 0)

  const draws = (drawsResult.data ?? []) as DrawSchedule[]
  const normalizedDraws = draws.map((draw) => {
    const percent = (draw as any).percent_of_contract
    if (typeof percent === "number" && contractTotal > 0) {
      return { ...draw, amount_cents: Math.round((contractTotal * percent) / 100) }
    }
    return draw
  })

  return {
    contractTotal,
    totalPaid,
    balanceRemaining: contractTotal - totalPaid,
    nextDraw: nextDrawResult.data ? {
      id: nextDrawResult.data.id,
      draw_number: nextDrawResult.data.draw_number,
      title: nextDrawResult.data.title,
      amount_cents: typeof (nextDrawResult.data as any).percent_of_contract === "number" && contractTotal > 0
        ? Math.round((contractTotal * (nextDrawResult.data as any).percent_of_contract) / 100)
        : nextDrawResult.data.amount_cents,
      due_date: nextDrawResult.data.due_date,
      status: nextDrawResult.data.status,
    } : undefined,
    draws: normalizedDraws,
  }
}

function mapPortalDailyLog(row: any): DailyLog {
  const weather = row.weather ?? {}
  const summary = row.summary ?? undefined
  const weatherText =
    typeof weather === "string"
      ? weather
      : [weather.conditions, weather.temperature, weather.notes].filter(Boolean).join(" • ")

  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    date: row.log_date,
    weather: weatherText || undefined,
    notes: summary,
    created_by: row.created_by ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

async function fetchSharedDailyLogsForPortal(supabase: any, orgId: string, projectId: string): Promise<DailyLog[]> {
  const { data: sharedLinks, error: sharedError } = await supabase
    .from("file_links")
    .select("entity_id, files!inner(share_with_clients)")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("entity_type", "daily_log")
    .eq("files.share_with_clients", true)

  if (sharedError) {
    console.error("Failed to load shared daily log links for portal", sharedError)
    return []
  }

  const dailyLogIds = Array.from(
    new Set((sharedLinks ?? []).map((row: any) => row.entity_id).filter(Boolean)),
  )

  if (dailyLogIds.length === 0) return []

  const { data: logs, error } = await supabase
    .from("daily_logs")
    .select("id, org_id, project_id, log_date, summary, weather, created_by, created_at, updated_at")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .in("id", dailyLogIds)
    .order("log_date", { ascending: false })
    .limit(50)

  if (error) {
    console.error("Failed to load shared daily logs for portal", error)
    return []
  }

  return (logs ?? []).map(mapPortalDailyLog)
}

export async function loadClientPortalData({
  orgId,
  projectId,
  permissions,
  portalType = "client",
  companyId,
}: {
  orgId: string
  projectId: string
  permissions: PortalPermissions
  portalType?: "client" | "sub"
  companyId?: string | null
}): Promise<ClientPortalData> {
  const supabase = createServiceSupabaseClient()

  const [orgRow, projectRow, pmRow, scheduleItems, dailyLogs, filesResult, messages, financialSummary] = await Promise.all([
    supabase.from("orgs").select("id, name").eq("id", orgId).single(),
    supabase
      .from("projects")
      .select("id, org_id, name, status, start_date, end_date, location, created_at, updated_at")
      .eq("id", projectId)
      .single(),
    supabase
      .from("project_members")
      .select("user_id, role, app_users(id, full_name, email, phone, avatar_url)")
      .eq("project_id", projectId)
      .in("role", ["pm", "project_manager"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    permissions.can_view_schedule ? listScheduleItemsWithClient(supabase, orgId) : Promise.resolve([]),
    permissions.can_view_daily_logs ? fetchSharedDailyLogsForPortal(supabase, orgId, projectId) : Promise.resolve([]),
    permissions.can_view_documents
      ? supabase
          .from("files")
          .select("*")
          .eq("org_id", orgId)
          .eq("project_id", projectId)
          .eq("share_with_clients", true)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),
    permissions.can_message ? listPortalMessages({ orgId, projectId, channel: portalType, audienceCompanyId: companyId }) : Promise.resolve([]),
    permissions.can_view_budget ? loadPortalFinancialSummary({ orgId, projectId }) : Promise.resolve(undefined),
  ])

  if (orgRow.error || !orgRow.data) throw new Error("Org not found for portal")
  if (projectRow.error || !projectRow.data) throw new Error("Project not found for portal")

  const pmUser = pmRow.data?.app_users as any
  const projectManager = pmUser ? {
    id: pmUser.id,
    full_name: pmUser.full_name,
    email: pmUser.email ?? undefined,
    phone: pmUser.phone ?? undefined,
    avatar_url: pmUser.avatar_url ?? undefined,
    role_label: "Project Manager",
  } : undefined

  const pendingChangeOrders = permissions.can_approve_change_orders
    ? await fetchChangeOrders(supabase, orgId, projectId)
    : []

  const invoices = permissions.can_view_invoices
    ? await fetchInvoices(supabase, orgId, projectId, permissions.can_pay_invoices ?? false)
    : []
  const rfis = permissions.can_view_rfis ? await fetchRfis(supabase, orgId, projectId) : []
  const submittals = permissions.can_view_submittals ? await fetchSubmittals(supabase, orgId, projectId) : []

  const selections = permissions.can_submit_selections ? await fetchSelections(supabase, orgId, projectId) : []
  const punchItems = permissions.can_create_punch_items ? await fetchPunchItems(supabase, orgId, projectId) : []
  const photos = permissions.can_view_photos ? await fetchPhotoTimeline(supabase, orgId, projectId) : []
  const warrantyRequests = await fetchWarrantyRequests(supabase, orgId, projectId)

  return {
    org: { name: orgRow.data.name },
    project: {
      id: projectRow.data.id,
      org_id: projectRow.data.org_id,
      name: projectRow.data.name,
      status: projectRow.data.status,
      start_date: projectRow.data.start_date ?? undefined,
      end_date: projectRow.data.end_date ?? undefined,
      address: (projectRow.data.location as any)?.address,
      created_at: projectRow.data.created_at,
      updated_at: projectRow.data.updated_at,
    },
    projectManager,
    schedule: (scheduleItems ?? []).filter((item) => item.project_id === projectId).slice(0, 10),
    photos,
    pendingChangeOrders,
    pendingSelections: selections,
    warrantyRequests,
    invoices,
    rfis,
    submittals,
    recentLogs: (dailyLogs ?? []).filter((log) => log.project_id === projectId).slice(0, 5),
    sharedFiles: (filesResult.data ?? []).map(mapFileMetadata).slice(0, 10),
    messages: messages ?? [],
    punchItems,
    financialSummary,
  }
}

export async function loadSubPortalData({
  orgId,
  projectId,
  companyId,
  permissions,
}: {
  orgId: string
  projectId: string
  companyId: string
  permissions: PortalPermissions
}): Promise<SubPortalData> {
  const supabase = createServiceSupabaseClient()

  // Parallel data loading
  const [
    orgResult,
    projectResult,
    companyResult,
    pmResult,
    commitmentsResult,
    billsResult,
    scheduleResult,
    rfisResult,
    submittalsResult,
    filesResult,
    messagesResult,
  ] = await Promise.all([
    // Org info
    supabase
      .from("orgs")
      .select("id, name, logo_url")
      .eq("id", orgId)
      .single(),

    // Project info
    supabase
      .from("projects")
      .select("*")
      .eq("id", projectId)
      .single(),

    // Company info
    supabase
      .from("companies")
      .select("id, name, insurance_expiry, license_expiry, w9_on_file, metadata")
      .eq("id", companyId)
      .single(),

    // Project manager
    supabase
      .from("project_members")
      .select(`
        user_id,
        role,
        users:user_id (
          id, full_name, email, phone, avatar_url
        )
      `)
      .eq("project_id", projectId)
      .in("role", ["pm", "project_manager"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),

    // Commitments for this company + project
    supabase
      .from("commitments")
      .select(`
        id, title, status, total_cents, currency,
        start_date, end_date, created_at
      `)
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("company_id", companyId)
      .neq("status", "canceled")
      .order("created_at", { ascending: false }),

    // Vendor bills for this company's commitments
    supabase
      .from("vendor_bills")
      .select(`
        id, bill_number, commitment_id, status,
        total_cents, paid_cents, bill_date, due_date,
        created_at, paid_at, payment_reference, metadata,
        commitments:commitment_id (title)
      `)
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .order("created_at", { ascending: false }),

    // Schedule items assigned to this company
    permissions.can_view_schedule
      ? supabase
          .from("schedule_assignments")
          .select(`
            schedule_items:schedule_item_id (
              id, name, status, start_date, end_date,
              duration_days, percent_complete
            )
          `)
          .eq("company_id", companyId)
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [] }),

    // RFIs assigned to this company
    permissions.can_view_rfis
      ? supabase
          .from("rfis")
          .select("*")
          .eq("org_id", orgId)
          .eq("project_id", projectId)
          .eq("assigned_company_id", companyId)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),

    // Submittals assigned to this company
    permissions.can_view_submittals
      ? supabase
          .from("submittals")
          .select("*")
          .eq("org_id", orgId)
          .eq("project_id", projectId)
          .eq("assigned_company_id", companyId)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),

    // Shared files (drawings, specs, etc.)
    permissions.can_view_documents
      ? supabase
          .from("files")
          .select("*")
          .eq("org_id", orgId)
          .eq("project_id", projectId)
          .eq("share_with_subs", true)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),

    // Messages - scoped to this subcontractor company
    permissions.can_message
      ? listPortalMessages({ orgId, projectId, channel: "sub", audienceCompanyId: companyId })
      : Promise.resolve([]),
  ])

  // Filter bills to only those belonging to this company's commitments
  const commitmentIds = new Set((commitmentsResult.data ?? []).map(c => c.id))
  const companyBills = (billsResult.data ?? []).filter(b =>
    commitmentIds.has(b.commitment_id)
  )

  // Aggregate bill amounts per commitment
  const billsByCommitment = new Map<string, { billed: number; paid: number }>()
  for (const bill of companyBills) {
    const existing = billsByCommitment.get(bill.commitment_id) ?? { billed: 0, paid: 0 }
    existing.billed += bill.total_cents ?? 0
    if (typeof bill.paid_cents === "number") {
      existing.paid += bill.paid_cents
    } else if (bill.status === "paid") {
      existing.paid += bill.total_cents ?? 0
    }
    billsByCommitment.set(bill.commitment_id, existing)
  }

  // Map commitments with aggregated amounts
  const commitments: SubPortalCommitment[] = (commitmentsResult.data ?? []).map(c => {
    const billTotals = billsByCommitment.get(c.id) ?? { billed: 0, paid: 0 }
    return {
      id: c.id,
      title: c.title,
      status: c.status,
      total_cents: c.total_cents ?? 0,
      billed_cents: billTotals.billed,
      paid_cents: billTotals.paid,
      remaining_cents: (c.total_cents ?? 0) - billTotals.billed,
      start_date: c.start_date,
      end_date: c.end_date,
      project_name: projectResult.data?.name ?? "",
    }
  })

  // Map bills
  const bills: SubPortalBill[] = companyBills.map(b => ({
    id: b.id,
    bill_number: b.bill_number,
    commitment_id: b.commitment_id,
    commitment_title: (b.commitments as any)?.title ?? "",
    status: b.status,
    total_cents: b.total_cents ?? 0,
    paid_cents: typeof b.paid_cents === "number"
      ? b.paid_cents
      : b.status === "paid"
        ? b.total_cents ?? 0
        : 0,
    bill_date: b.bill_date,
    due_date: b.due_date,
    submitted_at: b.created_at,
    paid_at: b.paid_at ?? b.metadata?.paid_at ?? null,
    payment_reference: b.payment_reference ?? b.metadata?.payment_reference ?? null,
  }))

  // Calculate financial summary
  const financialSummary: SubPortalFinancialSummary = {
    total_committed: commitments.reduce((sum, c) => sum + c.total_cents, 0),
    total_billed: commitments.reduce((sum, c) => sum + c.billed_cents, 0),
    total_paid: commitments.reduce((sum, c) => sum + c.paid_cents, 0),
    total_remaining: commitments.reduce((sum, c) => sum + c.remaining_cents, 0),
    pending_approval: bills
      .filter(b => b.status === "pending")
      .reduce((sum, b) => sum + b.total_cents, 0),
    approved_unpaid: bills
      .filter(b => b.status === "approved" || b.status === "partial")
      .reduce((sum, b) => sum + b.total_cents, 0),
  }

  // Extract schedule items from assignments
  const schedule = (scheduleResult.data ?? [])
    .map((a: any) => a.schedule_items)
    .filter(Boolean)

  // Count pending items
  const pendingRfiCount = (rfisResult.data ?? [])
    .filter(r => r.status === "open" || r.status === "pending")
    .length
  const pendingSubmittalCount = (submittalsResult.data ?? [])
    .filter(s => s.status === "pending" || s.status === "in_review")
    .length

  return {
    org: {
      id: orgResult.data?.id ?? orgId,
      name: orgResult.data?.name ?? "",
      logo_url: orgResult.data?.logo_url,
    },
    project: mapProject(projectResult.data),
    company: {
      id: companyResult.data?.id ?? companyId,
      name: companyResult.data?.name ?? "",
      trade: companyResult.data?.metadata?.trade,
      insurance_expiry: companyResult.data?.insurance_expiry ?? companyResult.data?.metadata?.insurance_expiry ?? null,
      license_expiry: companyResult.data?.license_expiry ?? companyResult.data?.metadata?.license_expiry ?? null,
      w9_on_file: companyResult.data?.w9_on_file ?? companyResult.data?.metadata?.w9_on_file ?? null,
    },
    projectManager: (() => {
      const candidate = (pmResult.data as any)?.users
      const user = Array.isArray(candidate) ? candidate[0] : candidate
      if (!user) return undefined
      return {
        id: user.id,
        full_name: user.full_name ?? "",
        email: user.email ?? undefined,
        phone: user.phone ?? undefined,
        avatar_url: user.avatar_url ?? undefined,
        role_label: "Project Manager",
      }
    })(),
    commitments,
    bills,
    financialSummary,
    schedule,
    rfis: (rfisResult.data ?? []).map(mapRfi),
    submittals: (submittalsResult.data ?? []).map(mapSubmittal),
    sharedFiles: (filesResult.data ?? []).map(mapFileMetadata),
    messages: messagesResult ?? [],
    pendingRfiCount,
    pendingSubmittalCount,
  }
}

function permissionsToColumns(overrides?: Partial<PortalPermissions>) {
  return {
    can_view_schedule: overrides?.can_view_schedule ?? true,
    can_view_photos: overrides?.can_view_photos ?? true,
    can_view_documents: overrides?.can_view_documents ?? true,
    can_download_files: overrides?.can_download_files ?? true,
    can_view_daily_logs: overrides?.can_view_daily_logs ?? false,
    can_view_budget: overrides?.can_view_budget ?? false,
    can_approve_change_orders: overrides?.can_approve_change_orders ?? true,
    can_submit_selections: overrides?.can_submit_selections ?? true,
    can_create_punch_items: overrides?.can_create_punch_items ?? false,
    can_message: overrides?.can_message ?? true,
    can_view_invoices: overrides?.can_view_invoices ?? true,
    can_pay_invoices: overrides?.can_pay_invoices ?? false,
    can_view_rfis: overrides?.can_view_rfis ?? true,
    can_view_submittals: overrides?.can_view_submittals ?? true,
    can_respond_rfis: overrides?.can_respond_rfis ?? true,
    can_submit_submittals: overrides?.can_submit_submittals ?? true,
    // Sub-specific permissions
    can_view_commitments: overrides?.can_view_commitments ?? true,
    can_view_bills: overrides?.can_view_bills ?? true,
    can_submit_invoices: overrides?.can_submit_invoices ?? true,
    can_upload_compliance_docs: overrides?.can_upload_compliance_docs ?? true,
  }
}

async function fetchChangeOrders(supabase: any, orgId: string, projectId: string): Promise<ChangeOrder[]> {
  const { data, error } = await supabase
    .from("change_orders")
    .select(
      "id, org_id, project_id, title, description, status, reason, total_cents, approved_by, approved_at, summary, days_impact",
    )
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("client_visible", true)
    .in("status", ["pending", "draft", "sent", "approved"])
    .order("created_at", { ascending: false })

  if (error) {
    console.error("Failed to load change orders for portal", error)
    return []
  }
  return data ?? []
}

async function fetchSelections(supabase: any, orgId: string, projectId: string): Promise<Selection[]> {
  const { data, error } = await supabase
    .from("project_selections")
    .select("id, org_id, project_id, category_id, selected_option_id, status, due_date, selected_at, confirmed_at")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("due_date", { ascending: true })

  if (error) {
    console.error("Failed to load selections for portal", error)
    return []
  }
  return data ?? []
}

async function fetchPunchItems(supabase: any, orgId: string, projectId: string): Promise<PunchItem[]> {
  const { data, error } = await supabase
    .from("punch_items")
    .select("id, org_id, project_id, title, description, status, due_date, severity, location, resolved_at")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("Failed to load punch items for portal", error)
    return []
  }
  return data ?? []
}

async function fetchWarrantyRequests(
  supabase: any,
  orgId: string,
  projectId: string,
): Promise<WarrantyRequest[]> {
  const { data, error } = await supabase
    .from("warranty_requests")
    .select("id, org_id, project_id, title, description, status, priority, requested_by, created_at, closed_at")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("Failed to load warranty requests for portal", error)
    return []
  }
  return data ?? []
}

async function fetchInvoices(
  supabase: any,
  orgId: string,
  projectId: string,
  includeAllForPayments: boolean,
): Promise<Invoice[]> {
  const query = supabase
    .from("invoices")
    .select(
      "id, org_id, project_id, token, invoice_number, title, status, issue_date, due_date, subtotal_cents, tax_cents, total_cents, balance_due_cents, metadata",
    )
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("issue_date", { ascending: false })

  const { data, error } = await query

  if (error) {
    console.error("Failed to load invoices for portal", error)
    return []
  }

  const invoices = data ?? []

  // Ensure each invoice has a public token; generate if missing.
  for (const inv of invoices) {
    if (!inv.token) {
      const newToken = randomBytes(32).toString("hex")
      const { error: updateError } = await supabase
        .from("invoices")
        .update({ token: newToken })
        .eq("id", inv.id)
        .eq("org_id", orgId)
      if (!updateError) {
        inv.token = newToken
      } else {
        console.error("Failed to set invoice token for portal", inv.id, updateError.message)
      }
    }
  }

  return invoices
}

async function fetchRfis(supabase: any, orgId: string, projectId: string): Promise<Rfi[]> {
  const { data, error } = await supabase
    .from("rfis")
    .select(
      "id, org_id, project_id, rfi_number, subject, question, status, priority, due_date, answered_at, attachment_file_id, last_response_at, decision_status, decision_note, decided_by_user_id, decided_by_contact_id, decided_at, decided_via_portal, decision_portal_token_id",
    )
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("rfi_number", { ascending: true })

  if (error) {
    console.error("Failed to load RFIs for portal", error)
    return []
  }
  return data ?? []
}

async function fetchSubmittals(supabase: any, orgId: string, projectId: string): Promise<Submittal[]> {
  const { data, error } = await supabase
    .from("submittals")
    .select(
      "id, org_id, project_id, submittal_number, title, description, status, spec_section, submittal_type, due_date, reviewed_at, attachment_file_id, last_item_submitted_at, decision_status, decision_note, decision_by_user_id, decision_by_contact_id, decision_at, decision_via_portal, decision_portal_token_id",
    )
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("submittal_number", { ascending: true })

  if (error) {
    console.error("Failed to load submittals for portal", error)
    return []
  }
  return data ?? []
}

async function fetchPhotoTimeline(supabase: any, orgId: string, projectId: string) {
  const { data, error } = await supabase.rpc("photo_timeline_for_portal", {
    p_project_id: projectId,
    p_org_id: orgId,
  })

  if (error) {
    console.error("Failed to load photo timeline for portal", error)
    return []
  }

  return (
    data?.map((row: any) => ({
      week_start: row.week_start,
      week_end: row.week_end,
      photos: (row.photos ?? []).map((p: any) => ({
        id: p.id,
        url: p.url,
        taken_at: p.taken_at,
        tags: p.tags,
      })),
      log_summaries: row.summaries ?? [],
    })) ?? []
  )
}

// Helper functions for sub portal data mapping
function mapProject(data: any) {
  return {
    id: data.id,
    org_id: data.org_id,
    name: data.name,
    status: data.status,
    start_date: data.start_date ?? undefined,
    end_date: data.end_date ?? undefined,
    address: (data.location as any)?.address,
    budget: data.budget ?? undefined,
    total_value: data.total_value ?? undefined,
    property_type: data.property_type ?? undefined,
    project_type: data.project_type ?? undefined,
    description: data.description ?? undefined,
    created_at: data.created_at,
    updated_at: data.updated_at,
  }
}

function mapRfi(data: any): Rfi {
  return {
    id: data.id,
    org_id: data.org_id,
    project_id: data.project_id,
    rfi_number: data.rfi_number,
    subject: data.subject,
    question: data.question,
    status: data.status,
    priority: data.priority ?? undefined,
    due_date: data.due_date ?? undefined,
    answered_at: data.answered_at ?? undefined,
    attachment_file_id: data.attachment_file_id ?? undefined,
    last_response_at: data.last_response_at ?? undefined,
    decision_status: data.decision_status ?? undefined,
    decision_note: data.decision_note ?? undefined,
    decided_by_user_id: data.decided_by_user_id ?? undefined,
    decided_by_contact_id: data.decided_by_contact_id ?? undefined,
    decided_at: data.decided_at ?? undefined,
    decided_via_portal: data.decided_via_portal ?? undefined,
    decision_portal_token_id: data.decision_portal_token_id ?? undefined,
  }
}

function mapSubmittal(data: any): Submittal {
  return {
    id: data.id,
    org_id: data.org_id,
    project_id: data.project_id,
    submittal_number: data.submittal_number,
    title: data.title,
    description: data.description ?? undefined,
    status: data.status,
    spec_section: data.spec_section ?? undefined,
    submittal_type: data.submittal_type ?? undefined,
    due_date: data.due_date ?? undefined,
    reviewed_at: data.reviewed_at ?? undefined,
    attachment_file_id: data.attachment_file_id ?? undefined,
    last_item_submitted_at: data.last_item_submitted_at ?? undefined,
    decision_status: data.decision_status ?? undefined,
    decision_note: data.decision_note ?? undefined,
    decision_by_user_id: data.decision_by_user_id ?? undefined,
    decision_by_contact_id: data.decision_by_contact_id ?? undefined,
    decision_at: data.decision_at ?? undefined,
    decision_via_portal: data.decision_via_portal ?? undefined,
    decision_portal_token_id: data.decision_portal_token_id ?? undefined,
  }
}

function mapFileMetadata(data: any) {
  return {
    id: data.id,
    org_id: data.org_id,
    project_id: data.project_id ?? undefined,
    file_name: data.file_name,
    storage_path: data.storage_path,
    mime_type: data.mime_type ?? undefined,
    size_bytes: data.size_bytes ?? undefined,
    visibility: data.visibility,
    category: data.category ?? undefined,
    tags: data.tags ?? undefined,
    folder_path: data.folder_path ?? undefined,
    created_at: data.created_at,
  }
}

function mapPortalMessage(data: any): PortalMessage {
  return {
    id: data.id,
    org_id: data.org_id,
    conversation_id: data.conversation_id,
    sender_id: data.sender_id ?? undefined,
    message_type: data.message_type,
    body: data.body ?? undefined,
    payload: data.payload ?? {},
    sent_at: data.sent_at,
    sender_name: data.payload?.sender_name ?? "Portal user",
    sender_avatar_url: undefined,
  }
}
