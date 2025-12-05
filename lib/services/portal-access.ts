import { createServiceSupabaseClient } from "@/lib/supabase/server"
import type {
  ChangeOrder,
  ClientPortalData,
  Invoice,
  PortalAccessToken,
  PortalMessage,
  PortalPermissions,
  PunchItem,
  Rfi,
  Selection,
  Submittal,
} from "@/lib/types"
import { listScheduleItemsWithClient } from "@/lib/services/schedule"
import { listDailyLogs } from "@/lib/services/daily-logs"
import { listFiles } from "@/lib/services/files"
import { requireOrgContext } from "@/lib/services/context"

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
    portal_type: row.portal_type,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    expires_at: row.expires_at ?? null,
    last_accessed_at: row.last_accessed_at ?? null,
    revoked_at: row.revoked_at ?? null,
    access_count: row.access_count ?? 0,
    max_access_count: row.max_access_count ?? null,
    permissions: mapPermissions(row),
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
  const { orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const supabase = createServiceSupabaseClient()

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

  const { data, error } = await supabase
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
  const { orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const supabase = createServiceSupabaseClient()
  const { error } = await supabase
    .from("portal_access_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", tokenId)
    .eq("org_id", resolvedOrgId)

  if (error) {
    throw new Error(`Failed to revoke portal token: ${error.message}`)
  }
}

export async function listPortalTokens(projectId: string, orgId?: string): Promise<PortalAccessToken[]> {
  const { orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
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

async function getOrCreatePortalConversation({
  orgId,
  projectId,
  channel,
}: {
  orgId: string
  projectId: string
  channel: "client" | "sub"
}) {
  const supabase = createServiceSupabaseClient()
  const { data: existing } = await supabase
    .from("conversations")
    .select("id")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("channel", channel)
    .maybeSingle()

  if (existing) return existing.id

  const { data, error } = await supabase
    .from("conversations")
    .insert({
      org_id: orgId,
      project_id: projectId,
      channel,
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
}: {
  orgId: string
  projectId: string
  channel: "client" | "sub"
}): Promise<PortalMessage[]> {
  const supabase = createServiceSupabaseClient()
  const conversationId = await getOrCreatePortalConversation({ orgId, projectId, channel })

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
}: {
  orgId: string
  projectId: string
  channel: "client" | "sub"
  entityType: "rfi" | "submittal"
  entityId: string
}): Promise<PortalMessage[]> {
  const supabase = createServiceSupabaseClient()
  const conversationId = await getOrCreatePortalConversation({ orgId, projectId, channel })

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
}: {
  orgId: string
  projectId: string
  channel: "client" | "sub"
  body: string
  senderName?: string
  portalTokenId?: string
}) {
  const supabase = createServiceSupabaseClient()
  const conversationId = await getOrCreatePortalConversation({ orgId, projectId, channel })

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
}: {
  orgId: string
  projectId: string
  channel: "client" | "sub"
  body: string
  senderName?: string
  portalTokenId?: string
  entityType: "rfi" | "submittal"
  entityId: string
}) {
  const supabase = createServiceSupabaseClient()
  const conversationId = await getOrCreatePortalConversation({ orgId, projectId, channel })

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

export async function loadClientPortalData({
  orgId,
  projectId,
  permissions,
  portalType = "client",
}: {
  orgId: string
  projectId: string
  permissions: PortalPermissions
  portalType?: "client" | "sub"
}): Promise<ClientPortalData> {
  const supabase = createServiceSupabaseClient()

  const [orgRow, projectRow, scheduleItems, dailyLogs, files, messages] = await Promise.all([
    supabase.from("orgs").select("id, name").eq("id", orgId).single(),
    supabase
      .from("projects")
      .select("id, org_id, name, status, start_date, end_date, location, created_at, updated_at")
      .eq("id", projectId)
      .single(),
    permissions.can_view_schedule ? listScheduleItemsWithClient(supabase, orgId) : Promise.resolve([]),
    permissions.can_view_daily_logs ? listDailyLogs(orgId) : Promise.resolve([]),
    permissions.can_view_documents ? listFiles(orgId) : Promise.resolve([]),
    permissions.can_message ? listPortalMessages({ orgId, projectId, channel: portalType }) : Promise.resolve([]),
  ])

  if (orgRow.error || !orgRow.data) throw new Error("Org not found for portal")
  if (projectRow.error || !projectRow.data) throw new Error("Project not found for portal")

  const pendingChangeOrders = permissions.can_approve_change_orders
    ? await fetchChangeOrders(supabase, orgId, projectId)
    : []

  const invoices = permissions.can_view_invoices ? await fetchInvoices(supabase, orgId, projectId) : []
  const rfis = permissions.can_view_rfis ? await fetchRfis(supabase, orgId, projectId) : []
  const submittals = permissions.can_view_submittals ? await fetchSubmittals(supabase, orgId, projectId) : []

  const selections = permissions.can_submit_selections ? await fetchSelections(supabase, orgId, projectId) : []
  const punchItems = permissions.can_create_punch_items ? await fetchPunchItems(supabase, orgId, projectId) : []
  const photos = permissions.can_view_photos ? await fetchPhotoTimeline(supabase, orgId, projectId) : []

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
    schedule: (scheduleItems ?? []).filter((item) => item.project_id === projectId).slice(0, 10),
    photos,
    pendingChangeOrders,
    pendingSelections: selections,
    invoices,
    rfis,
    submittals,
    recentLogs: (dailyLogs ?? []).filter((log) => log.project_id === projectId).slice(0, 5),
    sharedFiles: (files ?? []).filter((file) => file.project_id === projectId).slice(0, 10),
    messages: messages ?? [],
    punchItems,
  }
}

export async function loadSubPortalData({
  orgId,
  projectId,
  permissions,
}: {
  orgId: string
  projectId: string
  permissions: PortalPermissions
}) {
  return loadClientPortalData({ orgId, projectId, permissions, portalType: "sub" })
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

async function fetchInvoices(supabase: any, orgId: string, projectId: string): Promise<Invoice[]> {
  const { data, error } = await supabase
    .from("invoices")
    .select(
      "id, org_id, project_id, invoice_number, title, status, issue_date, due_date, subtotal_cents, tax_cents, total_cents, balance_due_cents, metadata",
    )
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("client_visible", true)
    .order("issue_date", { ascending: false })

  if (error) {
    console.error("Failed to load invoices for portal", error)
    return []
  }
  return data ?? []
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

