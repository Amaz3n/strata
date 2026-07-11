import { createHmac } from "node:crypto"
import { compare, hash } from "bcryptjs"
import { cookies } from "next/headers"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import type {
  ChangeOrder,
  ClientPortalData,
  DailyLog,
  DrawSchedule,
  Invoice,
  PortalAccessToken,
  PortalFinancialSummary,
  PortalPermissions,
  PortalType,
  PunchItem,
  ReviewerPortalData,
  ReviewerRole,
  Rfi,
  Selection,
  Submittal,
  SubPortalData,
  SubPortalCommitment,
  SubPortalBill,
  SubPortalFinancialSummary,
  WarrantyRequest,
} from "@/lib/types"

import { listProjectScheduleItemsWithClient } from "@/lib/services/schedule"
import { listDecisionsForPortal } from "@/lib/services/decisions"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { hasExternalPortalGrantForToken } from "@/lib/services/external-portal-auth"

const PIN_SALT_ROUNDS = 10
const MAX_PIN_ATTEMPTS = 5
const LOCKOUT_DURATION_MS = 15 * 60 * 1000
const PORTAL_PIN_COOKIE_PREFIX = "portal_pin"
const PORTAL_PIN_COOKIE_TTL_SECONDS = 60 * 60 * 12

function getPortalAccessSecret() {
  const secret =
    process.env.PORTAL_ACCESS_SECRET ??
    process.env.BID_PORTAL_SECRET ??
    process.env.DOCUMENT_SIGNING_SECRET ??
    process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) {
    throw new Error("Missing PORTAL_ACCESS_SECRET or another server-side portal secret")
  }
  return secret
}

function getPortalPinCookieName(token: string) {
  const hash = createHmac("sha256", getPortalAccessSecret()).update(`portal:${token}`).digest("hex")
  return `${PORTAL_PIN_COOKIE_PREFIX}_${hash.slice(0, 16)}`
}

function signPortalPinCookie(token: string) {
  return createHmac("sha256", getPortalAccessSecret()).update(`portal-pin:${token}`).digest("hex")
}

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
    can_view_warranty: row.can_view_warranty ?? true,
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
    can_submit_time: row.can_submit_time ?? true,
    can_submit_expenses: row.can_submit_expenses ?? true,
    can_submit_daily_logs: row.can_submit_daily_logs ?? false,
    can_upload_compliance_docs: row.can_upload_compliance_docs ?? true,
    can_view_punch_items: row.can_view_punch_items ?? false,
    // Reviewer-specific permissions
    can_review_submittals: row.can_review_submittals ?? false,
  }
}

function mapAccessToken(row: any): PortalAccessToken {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    contact_id: row.contact_id ?? null,
    company_id: row.company_id ?? null,
    scoped_rfi_id: row.scoped_rfi_id ?? null,
    token: row.token,
    name: row.name,
    portal_type: row.portal_type,
    reviewer_role: row.reviewer_role ?? null,
    permissions: mapPermissions(row),
    pin_required: !!row.pin_required,
    pin_locked_until: row.pin_locked_until ?? null,
    require_account: row.require_account ?? false,
    expires_at: row.expires_at ?? null,
    access_count: row.access_count ?? 0,
    max_access_count: row.max_access_count ?? null,
    last_accessed_at: row.last_accessed_at ?? null,
    paused_at: row.paused_at ?? null,
    revoked_at: row.revoked_at ?? null,
    created_at: row.created_at,
  }
}

export async function createPortalAccessToken({
  projectId,
  portalType,
  contactId,
  companyId,
  scopedRfiId,
  reviewerRole,
  permissions,
  expiresAt,
  requireAccount,
  orgId,
}: {
  projectId: string
  portalType: PortalType
  contactId?: string
  companyId?: string
  scopedRfiId?: string | null
  reviewerRole?: ReviewerRole | null
  permissions?: Partial<PortalPermissions>
  expiresAt?: string | null
  requireAccount?: boolean
  orgId?: string
}): Promise<PortalAccessToken> {
  const { orgId: resolvedOrgId, userId, supabase } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })
  const serviceClient = createServiceSupabaseClient()

  const payload: Record<string, unknown> = {
    org_id: resolvedOrgId,
    project_id: projectId,
    portal_type: portalType,
    contact_id: contactId ?? null,
    company_id: companyId ?? null,
    reviewer_role: reviewerRole ?? null,
    expires_at: expiresAt ?? null,
    require_account: requireAccount ?? false,
    created_by: userId,
    ...permissionsToColumns(permissions),
  }

  if (scopedRfiId) {
    payload.scoped_rfi_id = scopedRfiId
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

export async function findReusablePortalAccessToken({
  projectId,
  portalType,
  contactId,
  companyId,
  orgId,
}: {
  projectId: string
  portalType: PortalType
  contactId?: string
  companyId?: string
  orgId?: string
}): Promise<PortalAccessToken | null> {
  const { orgId: resolvedOrgId, userId, supabase } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })
  const serviceClient = createServiceSupabaseClient()

  let query = serviceClient
    .from("portal_access_tokens")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .eq("portal_type", portalType)
    .is("revoked_at", null)
    .is("paused_at", null)
    .order("created_at", { ascending: false })

  query = contactId ? query.eq("contact_id", contactId) : query.is("contact_id", null)
  query = companyId ? query.eq("company_id", companyId) : query.is("company_id", null)

  const { data, error } = await query

  if (error) {
    throw new Error(`Failed to find reusable portal access token: ${error.message}`)
  }

  const now = new Date()
  const reusable = (data ?? []).find((row: any) => {
    if (row.expires_at && new Date(row.expires_at) <= now) return false
    if (row.max_access_count && row.access_count >= row.max_access_count) return false
    return true
  })

  return reusable ? mapAccessToken(reusable) : null
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

  if (data.paused_at) {
    return null
  }

  if (data.max_access_count && (data.access_count ?? 0) >= data.max_access_count) {
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

export async function pausePortalToken(tokenId: string, orgId?: string) {
  const { orgId: resolvedOrgId, supabase, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })
  const serviceClient = createServiceSupabaseClient()
  const { error } = await serviceClient
    .from("portal_access_tokens")
    .update({ paused_at: new Date().toISOString() })
    .eq("id", tokenId)
    .eq("org_id", resolvedOrgId)
    .is("revoked_at", null)

  if (error) {
    throw new Error(`Failed to pause portal token: ${error.message}`)
  }
}

export async function resumePortalToken(tokenId: string, orgId?: string) {
  const { orgId: resolvedOrgId, supabase, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })
  const serviceClient = createServiceSupabaseClient()
  const { error } = await serviceClient
    .from("portal_access_tokens")
    .update({ paused_at: null })
    .eq("id", tokenId)
    .eq("org_id", resolvedOrgId)
    .is("revoked_at", null)

  if (error) {
    throw new Error(`Failed to resume portal token: ${error.message}`)
  }
}

export async function setPortalTokenRequireAccount({
  tokenId,
  requireAccount,
  orgId,
}: {
  tokenId: string
  requireAccount: boolean
  orgId?: string
}) {
  const { orgId: resolvedOrgId, supabase, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })
  const serviceClient = createServiceSupabaseClient()
  const { error } = await serviceClient
    .from("portal_access_tokens")
    .update({ require_account: requireAccount })
    .eq("id", tokenId)
    .eq("org_id", resolvedOrgId)

  if (error) {
    throw new Error(`Failed to update portal token account requirement: ${error.message}`)
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
  const { data, error } = await supabase.rpc("record_portal_access", { token_id_input: tokenId })

  if (!error) {
    if (data !== true) {
      throw new Error("Portal access limit has been reached")
    }
    return
  }

  console.warn("record_portal_access RPC unavailable; falling back to legacy increment", error.message)
  await supabase.rpc("increment_portal_access", { token_id_input: tokenId })
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
    .select("id, pin_hash, pin_attempts, pin_locked_until, paused_at, revoked_at")
    .eq("token", token)
    .is("revoked_at", null)
    .maybeSingle()

  if (error || !data || !data.pin_hash || data.paused_at || data.revoked_at) {
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

export async function markPortalPinVerified(token: string) {
  const store = await cookies()
  store.set({
    name: getPortalPinCookieName(token),
    value: signPortalPinCookie(token),
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: PORTAL_PIN_COOKIE_TTL_SECONDS,
  })
}

export async function clearPortalPinVerification(token: string) {
  const store = await cookies()
  store.set({
    name: getPortalPinCookieName(token),
    value: "",
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
  })
}

export async function isPortalPinVerified(token: string): Promise<boolean> {
  const store = await cookies()
  const cookieValue = store.get(getPortalPinCookieName(token))?.value
  return !!cookieValue && cookieValue === signPortalPinCookie(token)
}

export async function assertPortalActionAccess(
  token: string,
  options: {
    portalType?: PortalType | PortalType[]
    requireCompany?: boolean
    permission?: keyof PortalPermissions
  } = {},
): Promise<PortalAccessToken> {
  const access = await validatePortalToken(token)
  if (!access) {
    throw new Error("Invalid or expired portal access")
  }

  if (options.portalType) {
    const allowed = Array.isArray(options.portalType) ? options.portalType : [options.portalType]
    if (!allowed.includes(access.portal_type)) {
      throw new Error("This portal link cannot access that resource")
    }
  }

  if (options.requireCompany && !access.company_id) {
    throw new Error("This portal link is missing subcontractor access")
  }

  if (options.permission && access.permissions[options.permission] !== true) {
    throw new Error("This portal link does not have permission for that action")
  }

  if (access.require_account) {
    const hasAccountAccess = await hasExternalPortalGrantForToken({
      orgId: access.org_id,
      tokenId: access.id,
      tokenType: "portal",
    })
    if (!hasAccountAccess) {
      throw new Error("Account access is required for this portal link")
    }
  }

  if (access.pin_required) {
    const pinVerified = await isPortalPinVerified(token)
    if (!pinVerified) {
      throw new Error("PIN verification is required for this portal link")
    }
  }

  return access
}

async function loadPortalFinancialSummary({
  orgId,
  projectId,
}: {
  orgId: string
  projectId: string
}): Promise<PortalFinancialSummary> {
  const supabase = createServiceSupabaseClient()

  const [contractResult, projectResult, approvedCosResult, paymentsResult, allocationResult, nextDrawResult, drawsResult] = await Promise.all([
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
      .from("payment_allocations")
      .select("amount_cents, payment:payments!inner(status)")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .not("invoice_id", "is", null)
      .eq("payment.status", "succeeded"),
    supabase
      .from("draw_schedules")
      .select("id, draw_number, title, amount_cents, percent_of_contract, due_date, status, invoice_id, invoice:invoices(id, client_visible, status, balance_due_cents)")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .in("status", ["pending", "invoiced", "partial"])
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
  const totalPaid =
    (paymentsResult.data ?? []).reduce((sum, p) => sum + (p.amount_cents ?? 0), 0) +
    (allocationResult.data ?? []).reduce((sum, p) => sum + (p.amount_cents ?? 0), 0)

  const draws = (drawsResult.data ?? []) as DrawSchedule[]
  const normalizedDraws = draws.map((draw) => {
    const percent = (draw as any).percent_of_contract
    if (typeof percent === "number" && contractTotal > 0) {
      return { ...draw, amount_cents: Math.round((contractTotal * percent) / 100) }
    }
    return draw
  })

  const nextDrawInvoice = Array.isArray((nextDrawResult.data as any)?.invoice)
    ? (nextDrawResult.data as any)?.invoice[0]
    : (nextDrawResult.data as any)?.invoice
  const nextDrawBalanceDue =
    typeof nextDrawInvoice?.balance_due_cents === "number"
      ? nextDrawInvoice.balance_due_cents
      : null
  const nextDrawPaymentAvailable = Boolean(
    nextDrawResult.data?.invoice_id &&
      nextDrawInvoice?.client_visible === true &&
      nextDrawInvoice?.status !== "void" &&
      (nextDrawBalanceDue ?? 0) > 0,
  )

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
      invoice_id: nextDrawResult.data.invoice_id ?? null,
      invoice_balance_due_cents: nextDrawBalanceDue,
      payment_available: nextDrawPaymentAvailable,
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
    date: row.log_date ?? row.report_date,
    weather: weatherText || undefined,
    notes: summary,
    daily_report_id: row.daily_report_id ?? undefined,
    created_by: row.created_by ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

async function fetchSharedDailyLogsForPortal(supabase: any, orgId: string, projectId: string): Promise<DailyLog[]> {
  const [sharedLinksResult, sharedReportsResult] = await Promise.all([
    supabase
      .from("file_links")
      .select("entity_id, files!inner(share_with_clients)")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("entity_type", "daily_log")
      .eq("files.share_with_clients", true),
    supabase
      .from("daily_reports")
      .select("id, org_id, project_id, report_date, weather, day_type, created_at, updated_at")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("status", "submitted")
      .eq("share_with_client", true)
      .order("report_date", { ascending: false })
      .limit(50),
  ])

  if (sharedLinksResult.error) {
    console.error("Failed to load shared daily log links for portal", sharedLinksResult.error)
  }
  if (sharedReportsResult.error) {
    console.error("Failed to load shared daily reports for portal", sharedReportsResult.error)
  }

  const dailyLogIds = Array.from(
    new Set((sharedLinksResult.data ?? []).map((row: any) => row.entity_id).filter(Boolean)),
  )
  const sharedReports = sharedReportsResult.data ?? []
  const sharedReportIds = sharedReports.map((row: any) => row.id).filter(Boolean)

  if (dailyLogIds.length === 0 && sharedReportIds.length === 0) return []

  const [linkedLogsResult, reportLogsResult] = await Promise.all([
    dailyLogIds.length
      ? supabase
          .from("daily_logs")
          .select("id, org_id, project_id, log_date, summary, weather, daily_report_id, created_by, created_at, updated_at")
          .eq("org_id", orgId)
          .eq("project_id", projectId)
          .in("id", dailyLogIds)
          .order("log_date", { ascending: false })
          .limit(50)
      : Promise.resolve({ data: [], error: null }),
    sharedReportIds.length
      ? supabase
          .from("daily_logs")
          .select("id, org_id, project_id, log_date, summary, weather, daily_report_id, created_by, created_at, updated_at")
          .eq("org_id", orgId)
          .eq("project_id", projectId)
          .in("daily_report_id", sharedReportIds)
          .order("log_date", { ascending: false })
          .limit(50)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (linkedLogsResult.error) {
    console.error("Failed to load file-shared daily logs for portal", linkedLogsResult.error)
  }
  if (reportLogsResult.error) {
    console.error("Failed to load report-shared daily logs for portal", reportLogsResult.error)
  }

  const rowsById = new Map<string, any>()
  for (const row of [...(linkedLogsResult.data ?? []), ...(reportLogsResult.data ?? [])]) {
    rowsById.set(row.id, row)
  }

  const reportsWithLogs = new Set(
    Array.from(rowsById.values()).map((row: any) => row.daily_report_id).filter(Boolean),
  )
  for (const report of sharedReports) {
    if (!reportsWithLogs.has(report.id)) {
      rowsById.set(`daily-report:${report.id}`, {
        ...report,
        id: `daily-report:${report.id}`,
        log_date: report.report_date,
        daily_report_id: report.id,
        summary: report.day_type ? `Day type: ${String(report.day_type).replaceAll("_", " ")}` : undefined,
      })
    }
  }

  return Array.from(rowsById.values())
    .map(mapPortalDailyLog)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 50)
}

export async function loadClientPortalData({
  orgId,
  projectId,
  permissions,
  companyId,
  contactId,
  scopedRfiId,
  portalToken,
}: {
  orgId: string
  projectId: string
  permissions: PortalPermissions
  companyId?: string | null
  contactId?: string | null
  scopedRfiId?: string | null
  portalToken?: string
}): Promise<ClientPortalData> {
  const supabase = createServiceSupabaseClient()

  const [orgRow, projectRow, pmRow, scheduleItems, dailyLogs, filesResult, financialSummary] = await Promise.all([
    supabase.from("orgs").select("id, name, logo_url").eq("id", orgId).single(),
    supabase
      .from("projects")
      .select("id, org_id, name, status, start_date, end_date, location, created_at, updated_at")
      .eq("id", projectId)
      .single(),
    supabase
      .from("project_members")
      .select("user_id, role_id, roles!inner(key), app_users(id, full_name, email, phone, avatar_url)")
      .eq("project_id", projectId)
      .in("roles.key", ["pm", "project_manager"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    permissions.can_view_schedule ? listProjectScheduleItemsWithClient(supabase, orgId, projectId) : Promise.resolve([]),
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
  const rfis = permissions.can_view_rfis ? await fetchRfis(supabase, orgId, projectId, scopedRfiId ?? null) : []
  const submittals = permissions.can_view_submittals ? await fetchSubmittals(supabase, orgId, projectId) : []

  const selections = permissions.can_submit_selections ? await fetchSelections(supabase, orgId, projectId) : []
  const pendingDecisions = permissions.can_submit_selections
    ? (await listDecisionsForPortal(orgId, projectId, contactId ?? null)).filter(
        (decision) => decision.status === "pending",
      )
    : []
  const punchItems = permissions.can_create_punch_items ? await fetchPunchItems(supabase, orgId, projectId) : []
  const photos = permissions.can_view_photos ? await fetchPhotoTimeline(supabase, orgId, projectId) : []
  const warrantyRequests = permissions.can_view_warranty ? await fetchWarrantyRequests(supabase, orgId, projectId) : []

  return {
    org: {
      name: orgRow.data.name,
      logo_url: orgRow.data.logo_url ?? undefined,
    },
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
    schedule: scheduleItems ?? [],
    photos,
    pendingChangeOrders,
    pendingSelections: selections,
    pendingDecisions,
    warrantyRequests,
    invoices,
    rfis,
    submittals,
    recentLogs: (dailyLogs ?? []).filter((log) => log.project_id === projectId).slice(0, 5),
    // Shared drawing sheets are NOT injected here — the portal documents tab
    // renders them via /api/portal/drawings/[token] in the tiled viewer.
    sharedFiles: (filesResult.data ?? [])
      .map((file: any) => mapFileMetadata(file, portalToken))
      .slice(0, 50),
    punchItems,
    financialSummary,
  }
}

export async function loadSubPortalData({
  orgId,
  projectId,
  companyId,
  permissions,
  scopedRfiId,
  portalToken,
}: {
  orgId: string
  projectId: string
  companyId: string
  permissions: PortalPermissions
  scopedRfiId?: string | null
  portalToken?: string
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
    punchResult,
    filesResult,
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
      .select("id, name, metadata")
      .eq("id", companyId)
      .single(),

    // Project manager
    supabase
      .from("project_members")
      .select(`
        user_id,
        role_id,
        roles!inner(key),
        users:user_id (
          id, full_name, email, phone, avatar_url
        )
      `)
      .eq("project_id", projectId)
      .in("roles.key", ["pm", "project_manager"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),

    // Commitments for this company + project
    supabase
      .from("commitments")
      .select(`
        id, title, status, total_cents, currency,
        start_date, end_date, executed_at, source_document_id,
        signature_envelope_id, created_at
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
        created_at, paid_at, payment_reference, lien_waiver_status,
        lien_waiver_received_at, metadata,
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
          .eq("org_id", orgId)
          .eq("project_id", projectId)
          .eq("company_id", companyId)
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [] }),

    // RFIs assigned to this company
    permissions.can_view_rfis
      ? (() => {
          let query = supabase
            .from("rfis")
            .select("*")
            .eq("org_id", orgId)
            .eq("project_id", projectId)
            .eq("assigned_company_id", companyId)
            .neq("status", "draft")
            .order("created_at", { ascending: false })
          if (scopedRfiId) {
            query = query.eq("id", scopedRfiId)
          }
          return query
        })()
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

    // Punch items dispatched to this company
    permissions.can_view_punch_items
      ? supabase
          .from("punch_items")
          .select("id, org_id, project_id, title, description, status, due_date, severity, location, resolved_at, assigned_company_id, dispatched_at, sub_completed_at, verification_notes")
          .eq("org_id", orgId)
          .eq("project_id", projectId)
          .eq("assigned_company_id", companyId)
          .neq("status", "closed")
          .order("due_date", { ascending: true, nullsFirst: false })
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

  ])

  // Filter bills to only those belonging to this company's commitments
  const commitmentIds = new Set((commitmentsResult.data ?? []).map(c => c.id))
  const companyBills = (billsResult.data ?? []).filter(b =>
    commitmentIds.has(b.commitment_id)
  )

  const { data: approvedCommitmentChangeOrders } =
    commitmentIds.size > 0
      ? await supabase
          .from("commitment_change_orders")
          .select("commitment_id, total_cents")
          .eq("org_id", orgId)
          .eq("project_id", projectId)
          .eq("company_id", companyId)
          .eq("status", "approved")
          .in("commitment_id", Array.from(commitmentIds))
      : { data: [] }

  const approvedCcoByCommitment = new Map<string, number>()
  for (const changeOrder of approvedCommitmentChangeOrders ?? []) {
    const commitmentId = changeOrder.commitment_id as string | null
    if (!commitmentId) continue
    approvedCcoByCommitment.set(
      commitmentId,
      (approvedCcoByCommitment.get(commitmentId) ?? 0) + (changeOrder.total_cents ?? 0),
    )
  }

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
    const approvedChangeOrdersCents = approvedCcoByCommitment.get(c.id) ?? 0
    const revisedTotalCents = (c.total_cents ?? 0) + approvedChangeOrdersCents
    return {
      id: c.id,
      title: c.title,
      status: c.status,
      total_cents: c.total_cents ?? 0,
      approved_change_orders_cents: approvedChangeOrdersCents,
      revised_total_cents: revisedTotalCents,
      billed_cents: billTotals.billed,
      paid_cents: billTotals.paid,
      remaining_cents: revisedTotalCents - billTotals.billed,
      start_date: c.start_date,
      end_date: c.end_date,
      executed_at: c.executed_at ?? null,
      source_document_id: c.source_document_id ?? null,
      signature_envelope_id: c.signature_envelope_id ?? null,
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
    lien_waiver_status: b.lien_waiver_status ?? null,
    lien_waiver_received_at: b.lien_waiver_received_at ?? null,
  }))

  // Calculate financial summary
  const financialSummary: SubPortalFinancialSummary = {
    total_committed: commitments.reduce((sum, c) => sum + (c.revised_total_cents ?? c.total_cents), 0),
    total_billed: commitments.reduce((sum, c) => sum + c.billed_cents, 0),
    total_paid: commitments.reduce((sum, c) => sum + c.paid_cents, 0),
    total_remaining: commitments.reduce((sum, c) => sum + c.remaining_cents, 0),
    pending_approval: bills
      .filter(b => b.status === "pending")
      .reduce((sum, b) => sum + b.total_cents, 0),
    approved_unpaid: bills
      .filter(b => b.status === "approved" || b.status === "partial")
      .reduce((sum, b) => sum + Math.max(0, b.total_cents - (b.paid_cents ?? 0)), 0),
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
  const punchItems = (punchResult.data ?? []) as PunchItem[]
  const pendingPunchCount = punchItems.filter(item => item.status !== "ready_for_review").length

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
    punchItems,
    // Shared drawing sheets are NOT injected here — the portal documents tab
    // renders them via /api/portal/drawings/[token] in the tiled viewer.
    sharedFiles: (filesResult.data ?? []).map((file: any) => mapFileMetadata(file, portalToken)),
    pendingRfiCount,
    pendingSubmittalCount,
    pendingPunchCount,
  }
}

/**
 * Reviewer seats (architects/engineers/owner's reps) get the project header,
 * their RFI queue, and drawings via /api/portal/drawings/[token] like other
 * portals. Submittal review steps load through the reviewer portal actions
 * once routing exists (workstream 04 phase 2+).
 */
export async function loadReviewerPortalData({
  orgId,
  projectId,
  contactId,
  companyId,
  reviewerRole,
  scopedRfiId,
}: {
  orgId: string
  projectId: string
  contactId?: string | null
  companyId?: string | null
  reviewerRole?: ReviewerRole | null
  scopedRfiId?: string | null
}): Promise<ReviewerPortalData> {
  const supabase = createServiceSupabaseClient()

  const [orgResult, projectResult, contactResult, companyResult, pmResult, rfisResult] = await Promise.all([
    supabase.from("orgs").select("id, name, logo_url").eq("id", orgId).single(),
    supabase.from("projects").select("*").eq("id", projectId).single(),
    contactId
      ? supabase.from("contacts").select("id, full_name").eq("id", contactId).maybeSingle()
      : Promise.resolve({ data: null }),
    companyId
      ? supabase.from("companies").select("id, name").eq("id", companyId).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("project_members")
      .select("user_id, role_id, roles!inner(key), app_users(id, full_name, email, phone, avatar_url)")
      .eq("project_id", projectId)
      .in("roles.key", ["pm", "project_manager"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    (() => {
      let query = supabase
        .from("rfis")
        .select(RFI_PORTAL_SELECT)
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .neq("status", "draft")
        .order("rfi_number", { ascending: true })
      if (scopedRfiId) {
        query = query.eq("id", scopedRfiId)
      } else if (companyId && contactId) {
        query = query.or(`assigned_company_id.eq.${companyId},notify_contact_id.eq.${contactId}`)
      } else if (companyId) {
        query = query.eq("assigned_company_id", companyId)
      } else if (contactId) {
        query = query.eq("notify_contact_id", contactId)
      }
      return query
    })(),
  ])

  if (orgResult.error || !orgResult.data) throw new Error("Org not found for portal")
  if (projectResult.error || !projectResult.data) throw new Error("Project not found for portal")
  if (rfisResult.error) throw new Error(`Failed to load RFIs for reviewer portal: ${rfisResult.error.message}`)

  const pmUser = (pmResult.data as any)?.app_users
  const pm = Array.isArray(pmUser) ? pmUser[0] : pmUser
  const rfis = (rfisResult.data ?? []).map(mapRfi)

  return {
    org: {
      id: orgResult.data.id,
      name: orgResult.data.name,
      logo_url: orgResult.data.logo_url ?? undefined,
    },
    project: mapProject(projectResult.data),
    reviewer: {
      contact_id: contactId ?? null,
      contact_name: (contactResult.data as any)?.full_name ?? null,
      company_id: companyId ?? null,
      company_name: (companyResult.data as any)?.name ?? null,
      role: reviewerRole ?? null,
    },
    projectManager: pm
      ? {
          id: pm.id,
          full_name: pm.full_name ?? "",
          email: pm.email ?? undefined,
          phone: pm.phone ?? undefined,
          avatar_url: pm.avatar_url ?? undefined,
          role_label: "Project Manager",
        }
      : undefined,
    rfis,
    pendingRfiCount: rfis.filter((rfi) => rfi.status === "open" || rfi.status === "pending").length,
  }
}

const RFI_PORTAL_SELECT =
  "id, org_id, project_id, rfi_number, subject, question, status, priority, due_date, answered_at, attachment_file_id, last_response_at, decision_status, decision_note, decided_by_user_id, decided_by_contact_id, decided_at, decided_via_portal, decision_portal_token_id, created_at, updated_at"

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
    can_view_warranty: overrides?.can_view_warranty ?? true,
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
    can_submit_time: overrides?.can_submit_time ?? true,
    can_submit_expenses: overrides?.can_submit_expenses ?? true,
    can_submit_daily_logs: overrides?.can_submit_daily_logs ?? false,
    can_upload_compliance_docs: overrides?.can_upload_compliance_docs ?? true,
    can_view_punch_items: overrides?.can_view_punch_items ?? false,
    // Reviewer-specific permissions (least-privilege: opt-in only)
    can_review_submittals: overrides?.can_review_submittals ?? false,
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
    .in("status", ["pending", "sent", "approved", "requested_changes"])
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
    .select(
      `
        id, org_id, project_id, category_id, selected_option_id, status, due_date, selected_at, confirmed_at,
        category:selection_categories!project_selections_category_id_fkey(id, name, description),
        selected_option:selection_options!project_selections_selected_option_id_fkey(
          id, org_id, category_id, name, description, price_cents, price_type,
          price_delta_cents, image_url, sku, vendor, lead_time_days, sort_order, is_default
        )
      `,
    )
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
    .eq("client_visible", true)
    .in("status", ["sent", "partial", "paid", "overdue"])
    .order("issue_date", { ascending: false })

  const { data, error } = await query

  if (error) {
    console.error("Failed to load invoices for portal", error)
    return []
  }

  return data ?? []
}

async function fetchRfis(
  supabase: any,
  orgId: string,
  projectId: string,
  scopedRfiId?: string | null,
): Promise<Rfi[]> {
  let query = supabase
    .from("rfis")
    .select(
      "id, org_id, project_id, rfi_number, subject, question, status, priority, due_date, answered_at, attachment_file_id, last_response_at, decision_status, decision_note, decided_by_user_id, decided_by_contact_id, decided_at, decided_via_portal, decision_portal_token_id",
    )
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .neq("status", "draft")
    .order("rfi_number", { ascending: true })

  if (scopedRfiId) {
    query = query.eq("id", scopedRfiId)
  }

  const { data, error } = await query

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
      "id, org_id, project_id, submittal_number, revision, superseded_by_id, title, description, status, spec_section, submittal_type, due_date, reviewed_at, attachment_file_id, last_item_submitted_at, decision_status, decision_note, decision_by_user_id, decision_by_contact_id, decision_at, decision_via_portal, decision_portal_token_id",
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
    created_at: data.created_at ?? "",
    updated_at: data.updated_at ?? undefined,
  }
}

function mapSubmittal(data: any): Submittal {
  return {
    id: data.id,
    org_id: data.org_id,
    project_id: data.project_id,
    submittal_number: data.submittal_number,
    revision: data.revision ?? 0,
    superseded_by_id: data.superseded_by_id ?? null,
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
    ball_in_court: data.ball_in_court ?? undefined,
    stamped_file_id: data.stamped_file_id ?? undefined,
    created_at: data.created_at ?? "",
    updated_at: data.updated_at ?? undefined,
  }
}

function mapFileMetadata(data: any, portalToken?: string) {
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
    url: data.url ?? (portalToken ? `/api/portal/files/${portalToken}/${data.id}` : undefined),
  }
}
