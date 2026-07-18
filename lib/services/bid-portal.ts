import { createHmac } from "node:crypto"
import { compare } from "bcryptjs"
import { cookies } from "next/headers"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import type { FileMetadata, Rfi } from "@/lib/types"
import { getCurrentExternalPortalSession, hasExternalPortalGrantForToken } from "@/lib/services/external-portal-auth"
import { recordEvent } from "@/lib/services/events"
import { enqueueOutboxJob } from "@/lib/services/outbox"

const MAX_PIN_ATTEMPTS = 5
const LOCKOUT_DURATION_MS = 15 * 60 * 1000
const BID_PORTAL_PIN_COOKIE_PREFIX = "bid_portal_pin"
const BID_PORTAL_PIN_COOKIE_TTL_SECONDS = 60 * 60 * 12
const BID_PORTAL_GRANT_ACCESS_PREFIX = "grant_"

const BID_PORTAL_ACCESS_SELECT = `
  id, org_id, bid_invite_id, expires_at, max_access_count, access_count, last_accessed_at,
  pin_required, require_account, pin_locked_until, paused_at, revoked_at,
  bid_invite:bid_invites!bid_access_tokens_org_invite_fk(
    id, bid_package_id, status, invite_email, sent_at, last_viewed_at, submitted_at,
    company:companies!bid_invites_org_company_fk(id, name, email, phone),
    contact:contacts!bid_invites_org_contact_fk(id, full_name, email, phone)
  )
`

const BID_PORTAL_PIN_SELECT = `
  id, org_id, bid_invite_id, pin_hash, pin_attempts, pin_locked_until, revoked_at, paused_at
`

export interface BidPortalPackage {
  id: string
  project_id?: string | null
  prospect_id?: string | null
  title: string
  trade?: string | null
  scope?: string | null
  instructions?: string | null
  due_at?: string | null
  due_tz?: string | null
  mode: "quote" | "tender"
  bond_required: boolean
  status: string
}

export interface BidPortalScopeItem {
  id: string
  position: number
  item_type: "base" | "alternate" | "allowance" | "unit_price"
  description: string
  details?: string | null
  quantity?: number | null
  unit?: string | null
}

export interface BidPortalSubmissionItem {
  id: string
  bid_scope_item_id?: string | null
  description: string
  response: "priced" | "excluded" | "no_bid"
  amount_cents?: number | null
  unit_rate_cents?: number | null
  quantity?: number | null
  notes?: string | null
}

export interface BidPortalInvite {
  id: string
  bid_package_id: string
  status: string
  invite_email?: string | null
  company?: { id: string; name: string; email?: string | null; phone?: string | null } | null
  contact?: { id: string; full_name: string; email?: string | null; phone?: string | null } | null
  sent_at?: string | null
  last_viewed_at?: string | null
  submitted_at?: string | null
}

export interface BidPortalAccess {
  id: string
  org_id: string
  bid_invite_id: string
  expires_at?: string | null
  max_access_count?: number | null
  access_count: number
  last_accessed_at?: string | null
  pin_required: boolean
  require_account?: boolean
  pin_locked_until?: string | null
  invite: BidPortalInvite
  bidPackage: BidPortalPackage
  project: { id: string; name: string; status: string }
  org: { id: string; name: string; logo_url?: string | null }
}

export interface BidPortalAddendum {
  id: string
  number: number
  title?: string | null
  message?: string | null
  issued_at: string
  files: FileMetadata[]
  acknowledged_at?: string | null
}

export interface BidPortalSubmission {
  id: string
  status: string
  version: number
  is_current: boolean
  total_cents?: number | null
  currency?: string | null
  valid_until?: string | null
  lead_time_days?: number | null
  duration_days?: number | null
  start_available_on?: string | null
  exclusions?: string | null
  clarifications?: string | null
  notes?: string | null
  submitted_by_name?: string | null
  submitted_by_email?: string | null
  submitted_at?: string | null
  created_at: string
  items?: BidPortalSubmissionItem[]
}

export interface BidPriceBenchmarkSignal {
  has_benchmark: boolean
  signal: "below_range" | "in_range" | "above_range" | "insufficient_data"
  message: string
  match_level: string
  sample_size: number
  org_count: number
  median_cents?: number | null
  p25_cents?: number | null
  p75_cents?: number | null
  submitted_total_cents?: number | null
  deviation_pct?: number | null
}

export interface BidPortalData {
  packageFiles: FileMetadata[]
  addenda: BidPortalAddendum[]
  submissions: BidPortalSubmission[]
  currentSubmission?: BidPortalSubmission
  rfis: Rfi[]
  scopeItems: BidPortalScopeItem[]
  draft: Record<string, unknown> | null
}

function getBidPortalSecret() {
  const secret = process.env.BID_PORTAL_SECRET
  if (!secret) {
    throw new Error("Missing BID_PORTAL_SECRET environment variable")
  }
  return secret
}

function hashBidToken(token: string) {
  return createHmac("sha256", getBidPortalSecret()).update(token).digest("hex")
}

function getBidPortalGrantId(token: string) {
  return token.startsWith(BID_PORTAL_GRANT_ACCESS_PREFIX)
    ? token.slice(BID_PORTAL_GRANT_ACCESS_PREFIX.length)
    : null
}

function resolveBidPortalPinScope(token: string) {
  const grantId = getBidPortalGrantId(token)
  return grantId ? `grant:${grantId}` : `token:${hashBidToken(token)}`
}

function getBidPortalPinCookieName(scope: string) {
  const scopeHash = createHmac("sha256", getBidPortalSecret()).update(scope).digest("hex")
  return `${BID_PORTAL_PIN_COOKIE_PREFIX}_${scopeHash.slice(0, 16)}`
}

function signBidPortalPinCookie(scope: string) {
  return createHmac("sha256", getBidPortalSecret()).update(`pin:${scope}`).digest("hex")
}

function resolveRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

async function loadBidPortalTokenRecord<T>(token: string, selectClause: string): Promise<T | null> {
  const supabase = createServiceSupabaseClient()
  const grantId = getBidPortalGrantId(token)

  if (grantId) {
    const session = await getCurrentExternalPortalSession()
    if (!session) return null

    const { data } = await supabase
      .from("external_portal_account_grants")
      .select(`token:bid_access_tokens!inner(${selectClause})`)
      .eq("id", grantId)
      .eq("org_id", session.org_id)
      .eq("account_id", session.account.id)
      .eq("status", "active")
      .is("paused_at", null)
      .is("revoked_at", null)
      .not("bid_access_token_id", "is", null)
      .maybeSingle()

    return resolveRelation<T>((data as any)?.token)
  }

  const tokenHash = hashBidToken(token)
  const { data } = await supabase
    .from("bid_access_tokens")
    .select(selectClause)
    .eq("token_hash", tokenHash)
    .maybeSingle()

  return (data as T | null) ?? null
}

export async function markBidPortalPinVerified(token: string) {
  const scope = resolveBidPortalPinScope(token)
  const store = await cookies()
  store.set({
    name: getBidPortalPinCookieName(scope),
    value: signBidPortalPinCookie(scope),
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: BID_PORTAL_PIN_COOKIE_TTL_SECONDS,
  })
}

export async function clearBidPortalPinVerification(token: string) {
  const scope = resolveBidPortalPinScope(token)
  const store = await cookies()
  store.set({
    name: getBidPortalPinCookieName(scope),
    value: "",
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
  })
}

export async function isBidPortalPinVerified(token: string): Promise<boolean> {
  const scope = resolveBidPortalPinScope(token)
  const store = await cookies()
  const cookieValue = store.get(getBidPortalPinCookieName(scope))?.value
  if (!cookieValue) return false
  return cookieValue === signBidPortalPinCookie(scope)
}

export async function assertBidPortalActionAccess(token: string): Promise<BidPortalAccess> {
  const access = await validateBidPortalToken(token)
  if (!access) {
    throw new Error("Invalid or expired bid link")
  }

  if (access.require_account) {
    const hasAccountAccess = await hasExternalPortalGrantForToken({
      orgId: access.org_id,
      tokenId: access.id,
      tokenType: "bid",
    })
    if (!hasAccountAccess) {
      throw new Error("Account access is required for this bid link")
    }
  }

  if (access.pin_required) {
    const pinVerified = await isBidPortalPinVerified(token)
    if (!pinVerified) {
      throw new Error("PIN verification is required for this bid link")
    }
  }

  return access
}

function mapFile(file: any, token: string): FileMetadata {
  // Files are served through the token-authenticated portal route, never as
  // permanent public URLs — access dies with the token.
  const url = `/api/portal/b/${encodeURIComponent(token)}/files/${file.id}`
  return {
    id: file.id,
    org_id: file.org_id,
    project_id: file.project_id ?? undefined,
    file_name: file.file_name,
    storage_path: file.storage_path,
    mime_type: file.mime_type ?? undefined,
    size_bytes: file.size_bytes ?? undefined,
    visibility: file.visibility,
    category: file.category ?? undefined,
    tags: file.tags ?? undefined,
    folder_path: file.folder_path ?? undefined,
    created_at: file.created_at,
    url,
  }
}

export async function validateBidPortalToken(token: string): Promise<BidPortalAccess | null> {
  const supabase = createServiceSupabaseClient()
  const tokenRow = await loadBidPortalTokenRecord<any>(token, BID_PORTAL_ACCESS_SELECT)

  if (!tokenRow || !tokenRow.bid_invite) {
    console.warn("Bid portal token validation failed", {
      accessKeyPrefix: token.slice(0, 12),
      hasGrantAccessKey: !!getBidPortalGrantId(token),
      hasSecret: !!process.env.BID_PORTAL_SECRET,
      found: !!tokenRow,
    })
    return null
  }

  const inviteRow = Array.isArray(tokenRow.bid_invite) ? tokenRow.bid_invite[0] : tokenRow.bid_invite
  if (!inviteRow) {
    return null
  }

  if (tokenRow.expires_at && new Date(tokenRow.expires_at) < new Date()) {
    console.warn("Bid portal token expired", {
      tokenPrefix: token.slice(0, 6),
      expiresAt: tokenRow.expires_at,
    })
    return null
  }

  if (tokenRow.max_access_count && tokenRow.access_count >= tokenRow.max_access_count) {
    console.warn("Bid portal token max access reached", {
      tokenPrefix: token.slice(0, 6),
      accessCount: tokenRow.access_count,
      maxAccessCount: tokenRow.max_access_count,
    })
    return null
  }

  if (tokenRow.paused_at) {
    console.warn("Bid portal token paused", {
      tokenPrefix: token.slice(0, 6),
      pausedAt: tokenRow.paused_at,
    })
    return null
  }

  if (tokenRow.revoked_at) {
    console.warn("Bid portal token revoked", {
      tokenPrefix: token.slice(0, 6),
      revokedAt: tokenRow.revoked_at,
    })
    return null
  }

  const { data: bidPackage } = await supabase
    .from("bid_packages")
    .select("id, project_id, prospect_id, title, trade, scope, instructions, due_at, due_tz, mode, bond_required, status")
    .eq("id", inviteRow.bid_package_id)
    .maybeSingle()

  if (!bidPackage) {
    console.warn("Bid portal token missing package", {
      tokenPrefix: token.slice(0, 6),
      packageId: inviteRow.bid_package_id,
    })
    return null
  }

  let job: { id: string; org_id: string; name: string; status: string } | null = null

  if (bidPackage.project_id) {
    const projectResult = await supabase
      .from("projects")
      .select("id, org_id, name, status")
      .eq("id", bidPackage.project_id)
      .maybeSingle()
    job = projectResult.data
  } else if (bidPackage.prospect_id) {
    const prospectResult = await supabase
      .from("prospects")
      .select("id, org_id, name, status")
      .eq("id", bidPackage.prospect_id)
      .maybeSingle()
    job = prospectResult.data
      ? {
          id: prospectResult.data.id,
          org_id: prospectResult.data.org_id,
          name: prospectResult.data.name,
          status: "planning",
        }
      : null
  }

  if (!job) {
    console.warn("Bid portal token missing job context", {
      tokenPrefix: token.slice(0, 6),
      projectId: bidPackage.project_id,
      prospectId: bidPackage.prospect_id,
      orgId: tokenRow.org_id,
    })
    return null
  }

  const resolvedOrgId = job.org_id ?? tokenRow.org_id
  const { data: orgResult, error: orgError } = await supabase
    .from("orgs")
    .select("id, name, logo_url")
    .eq("id", resolvedOrgId)
    .maybeSingle()

  if (!orgResult) {
    console.warn("Bid portal token missing org", {
      tokenPrefix: token.slice(0, 6),
      tokenOrgId: tokenRow.org_id,
      projectOrgId: job.org_id,
      orgError: orgError?.message,
    })
    return null
  }

  return {
    id: tokenRow.id,
    org_id: tokenRow.org_id,
    bid_invite_id: tokenRow.bid_invite_id,
    expires_at: tokenRow.expires_at ?? null,
    max_access_count: tokenRow.max_access_count ?? null,
    access_count: tokenRow.access_count ?? 0,
    last_accessed_at: tokenRow.last_accessed_at ?? null,
    pin_required: !!tokenRow.pin_required,
    require_account: !!tokenRow.require_account,
    pin_locked_until: tokenRow.pin_locked_until ?? null,
    invite: {
      id: inviteRow.id,
      bid_package_id: inviteRow.bid_package_id,
      status: inviteRow.status,
      invite_email: inviteRow.invite_email ?? null,
      sent_at: inviteRow.sent_at ?? null,
      last_viewed_at: inviteRow.last_viewed_at ?? null,
      submitted_at: inviteRow.submitted_at ?? null,
      company: Array.isArray(inviteRow.company) ? inviteRow.company[0] ?? null : inviteRow.company ?? null,
      contact: Array.isArray(inviteRow.contact) ? inviteRow.contact[0] ?? null : inviteRow.contact ?? null,
    },
    bidPackage: {
      id: bidPackage.id,
      project_id: bidPackage.project_id ?? null,
      prospect_id: bidPackage.prospect_id ?? null,
      title: bidPackage.title,
      trade: bidPackage.trade ?? null,
      scope: bidPackage.scope ?? null,
      instructions: bidPackage.instructions ?? null,
      due_at: bidPackage.due_at ?? null,
      due_tz: bidPackage.due_tz ?? null,
      mode: (bidPackage.mode as "quote" | "tender") ?? "quote",
      bond_required: !!bidPackage.bond_required,
      status: bidPackage.status,
    },
    project: {
      id: job.id,
      name: job.name,
      status: job.status,
    },
    org: {
      id: orgResult.id,
      name: orgResult.name,
      logo_url: orgResult.logo_url ?? null,
    },
  }
}

export async function recordBidPortalAccess(accessId: string, inviteId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()
  const now = new Date().toISOString()

  const { data: tokenRow } = await supabase
    .from("bid_access_tokens")
    .select("access_count, max_access_count")
    .eq("id", accessId)
    .maybeSingle()

  const currentCount = tokenRow?.access_count ?? 0
  if (tokenRow?.max_access_count && currentCount >= tokenRow.max_access_count) {
    return
  }

  await supabase
    .from("bid_access_tokens")
    .update({ last_accessed_at: now, access_count: currentCount + 1 })
    .eq("id", accessId)

  await supabase
    .from("bid_invites")
    .update({ last_viewed_at: now })
    .eq("org_id", orgId)
    .eq("id", inviteId)

  await supabase
    .from("bid_invites")
    .update({ status: "viewed", last_viewed_at: now })
    .eq("org_id", orgId)
    .eq("id", inviteId)
    .in("status", ["draft", "sent"])
}

export async function validateBidPortalPin({
  token,
  pin,
}: {
  token: string
  pin: string
}): Promise<{ valid: boolean; attemptsRemaining?: number; lockedUntil?: string }> {
  const supabase = createServiceSupabaseClient()
  const data = await loadBidPortalTokenRecord<any>(token, BID_PORTAL_PIN_SELECT)

  if (!data || !data.pin_hash || data.revoked_at || data.paused_at) {
    return { valid: false }
  }

  if (data.pin_locked_until && new Date(data.pin_locked_until) > new Date()) {
    return { valid: false, lockedUntil: data.pin_locked_until }
  }

  const isValid = await compare(pin, data.pin_hash)

  if (isValid) {
    await supabase
      .from("bid_access_tokens")
      .update({ pin_attempts: 0, pin_locked_until: null })
      .eq("id", data.id)
    return { valid: true }
  }

  const newAttempts = (data.pin_attempts ?? 0) + 1
  const lockoutTime = newAttempts >= MAX_PIN_ATTEMPTS
    ? new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString()
    : null

  await supabase
    .from("bid_access_tokens")
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

export async function loadBidPortalData(access: BidPortalAccess, token: string): Promise<BidPortalData> {
  const supabase = createServiceSupabaseClient()

  const [packageLinksResult, addendaResult, submissionsResult, scopeItemsResult, draftResult, rfisResult] = await Promise.all([
    supabase
      .from("file_links")
      .select(
        `
        id, created_at,
        file:files(id, org_id, project_id, file_name, storage_path, mime_type, size_bytes, visibility, category, tags, folder_path, created_at)
      `,
      )
      .eq("org_id", access.org_id)
      .eq("entity_type", "bid_package")
      .eq("entity_id", access.bidPackage.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("bid_addenda")
      .select("id, number, title, message, issued_at")
      .eq("org_id", access.org_id)
      .eq("bid_package_id", access.bidPackage.id)
      .order("number", { ascending: true }),
    supabase
      .from("bid_submissions")
      .select(
        `
        id, status, version, is_current, total_cents, currency, valid_until, lead_time_days, duration_days, start_available_on,
        exclusions, clarifications, notes, submitted_by_name, submitted_by_email, submitted_at, created_at,
        items:bid_submission_items!bid_submission_items_org_submission_fk(
          id, bid_scope_item_id, description, response, amount_cents, unit_rate_cents, quantity, notes
        )
      `,
      )
      .eq("org_id", access.org_id)
      .eq("bid_invite_id", access.bid_invite_id)
      .order("version", { ascending: false }),
    supabase
      .from("bid_scope_items")
      .select("id, position, item_type, description, details, quantity, unit")
      .eq("org_id", access.org_id)
      .eq("bid_package_id", access.bidPackage.id)
      .order("position", { ascending: true }),
    supabase
      .from("bid_portal_drafts")
      .select("payload")
      .eq("org_id", access.org_id)
      .eq("bid_invite_id", access.bid_invite_id)
      .maybeSingle(),
    access.bidPackage.project_id
      ? supabase
          .from("rfis")
          .select(
            "id, org_id, project_id, bid_package_id, rfi_number, subject, question, status, priority, submitted_by, submitted_by_company_id, assigned_to, assigned_company_id, submitted_at, due_date, answered_at, closed_at, cost_impact_cents, schedule_impact_days, drawing_reference, spec_reference, location, attachment_file_id, last_response_at, decision_status, decision_note, decided_by_user_id, decided_by_contact_id, decided_at, decided_via_portal, decision_portal_token_id, created_at, updated_at",
          )
          .eq("org_id", access.org_id)
          .eq("project_id", access.bidPackage.project_id)
          .eq("bid_package_id", access.bidPackage.id)
          .neq("status", "draft")
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),
  ])

  const packageFiles = (packageLinksResult.data ?? [])
    .filter((link) => link.file)
    .map((link) => mapFile(link.file, token))

  const addenda = addendaResult.data ?? []
  const addendaIds = addenda.map((item) => item.id)

  let addendumFilesById: Record<string, FileMetadata[]> = {}
  let addendumAcknowledgements: Record<string, string | null> = {}
  if (addendaIds.length > 0) {
    const { data: acknowledgements } = await supabase
      .from("bid_addendum_acknowledgements")
      .select("bid_addendum_id, acknowledged_at")
      .eq("org_id", access.org_id)
      .eq("bid_invite_id", access.bid_invite_id)
      .in("bid_addendum_id", addendaIds)

    addendumAcknowledgements = (acknowledgements ?? []).reduce((acc, row: any) => {
      acc[row.bid_addendum_id] = row.acknowledged_at ?? null
      return acc
    }, {} as Record<string, string | null>)

    const { data: addendumLinks } = await supabase
      .from("file_links")
      .select(
        `
        id, entity_id,
        file:files(id, org_id, project_id, file_name, storage_path, mime_type, size_bytes, visibility, category, tags, folder_path, created_at)
      `,
      )
      .eq("org_id", access.org_id)
      .eq("entity_type", "bid_addendum")
      .in("entity_id", addendaIds)

    addendumFilesById = (addendumLinks ?? []).reduce((acc, link: any) => {
      if (!link.entity_id || !link.file) return acc
      if (!acc[link.entity_id]) acc[link.entity_id] = []
      acc[link.entity_id].push(mapFile(link.file, token))
      return acc
    }, {} as Record<string, FileMetadata[]>)
  }

  const submissions = (submissionsResult.data ?? []).map((row: any) => ({
    id: row.id,
    status: row.status,
    version: row.version,
    is_current: row.is_current,
    total_cents: row.total_cents ?? null,
    currency: row.currency ?? null,
    valid_until: row.valid_until ?? null,
    lead_time_days: row.lead_time_days ?? null,
    duration_days: row.duration_days ?? null,
    start_available_on: row.start_available_on ?? null,
    exclusions: row.exclusions ?? null,
    clarifications: row.clarifications ?? null,
    notes: row.notes ?? null,
    submitted_by_name: row.submitted_by_name ?? null,
    submitted_by_email: row.submitted_by_email ?? null,
    submitted_at: row.submitted_at ?? null,
    created_at: row.created_at,
    items: Array.isArray(row.items)
      ? row.items.map((item: any) => ({
          id: item.id,
          bid_scope_item_id: item.bid_scope_item_id ?? null,
          description: item.description,
          response: item.response ?? "priced",
          amount_cents: item.amount_cents != null ? Number(item.amount_cents) : null,
          unit_rate_cents: item.unit_rate_cents != null ? Number(item.unit_rate_cents) : null,
          quantity: item.quantity != null ? Number(item.quantity) : null,
          notes: item.notes ?? null,
        }))
      : [],
  }))

  return {
    packageFiles,
    addenda: addenda.map((addendum) => ({
      id: addendum.id,
      number: addendum.number,
      title: addendum.title ?? null,
      message: addendum.message ?? null,
      issued_at: addendum.issued_at,
      files: addendumFilesById[addendum.id] ?? [],
      acknowledged_at: addendumAcknowledgements[addendum.id] ?? null,
    })),
    submissions,
    currentSubmission: submissions.find((item) => item.is_current),
    rfis: (rfisResult.data ?? []) as Rfi[],
    scopeItems: (scopeItemsResult.data ?? []).map((item: any) => ({
      id: item.id,
      position: Number(item.position ?? 0),
      item_type: item.item_type ?? "base",
      description: item.description,
      details: item.details ?? null,
      quantity: item.quantity != null ? Number(item.quantity) : null,
      unit: item.unit ?? null,
    })),
    draft: (draftResult.data?.payload as Record<string, unknown> | undefined) ?? null,
  }
}

export async function acknowledgeBidAddendum({
  access,
  addendumId,
}: {
  access: BidPortalAccess
  addendumId: string
}): Promise<{ acknowledged_at: string }> {
  const supabase = createServiceSupabaseClient()

  const { data: addendum } = await supabase
    .from("bid_addenda")
    .select("id, bid_package_id")
    .eq("org_id", access.org_id)
    .eq("id", addendumId)
    .maybeSingle()

  if (!addendum || addendum.bid_package_id !== access.bidPackage.id) {
    throw new Error("Addendum not found")
  }

  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from("bid_addendum_acknowledgements")
    .upsert(
      {
        org_id: access.org_id,
        bid_addendum_id: addendumId,
        bid_invite_id: access.bid_invite_id,
        acknowledged_at: now,
      },
      { onConflict: "bid_addendum_id,bid_invite_id" },
    )
    .select("acknowledged_at")
    .single()

  if (error || !data) {
    throw new Error(`Failed to acknowledge addendum: ${error?.message}`)
  }

  return { acknowledged_at: data.acknowledged_at ?? now }
}

async function recordBidSubmissionBenchmarkSignal(submissionId: string): Promise<BidPriceBenchmarkSignal | undefined> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.rpc("record_bid_submission_benchmark", {
    p_bid_submission_id: submissionId,
  })

  if (error) {
    throw new Error(`Failed to compute bid benchmark signal: ${error.message}`)
  }

  const row = Array.isArray(data) ? data[0] : data
  if (!row) return undefined

  // Persist the snapshot so workbench reads carry the signal without recomputing
  await supabase.from("bid_submissions").update({ benchmark: row }).eq("id", submissionId)

  return {
    has_benchmark: !!row.has_benchmark,
    signal: (row.signal ?? "insufficient_data") as BidPriceBenchmarkSignal["signal"],
    message: row.message ?? "Benchmark unavailable.",
    match_level: row.match_level ?? "none",
    sample_size: Number(row.sample_size ?? 0),
    org_count: Number(row.org_count ?? 0),
    median_cents: row.median_cents ?? null,
    p25_cents: row.p25_cents ?? null,
    p75_cents: row.p75_cents ?? null,
    submitted_total_cents: row.submitted_total_cents ?? null,
    deviation_pct: row.deviation_pct ?? null,
  }
}

export async function submitBidFromPortal({
  access,
  input,
}: {
  access: BidPortalAccess
  input: {
    total_cents: number
    currency?: string | null
    valid_until?: string | null
    lead_time_days?: number | null
    duration_days?: number | null
    start_available_on?: string | null
    exclusions?: string | null
    clarifications?: string | null
    notes?: string | null
    submitted_by_name?: string | null
    submitted_by_email?: string | null
    file_ids?: string[]
    items?: Array<{
      bid_scope_item_id: string
      response: "priced" | "excluded" | "no_bid"
      amount_cents?: number | null
      unit_rate_cents?: number | null
      quantity?: number | null
      notes?: string | null
    }>
  }
}): Promise<BidPortalSubmission> {
  const supabase = createServiceSupabaseClient()

  const disallowedStatuses = ["closed", "awarded", "cancelled"]
  if (disallowedStatuses.includes(access.bidPackage.status)) {
    throw new Error("Bidding is closed for this package")
  }

  if (["declined", "withdrawn"].includes(access.invite.status)) {
    throw new Error("This invite is no longer active")
  }

  const { data: addenda } = await supabase
    .from("bid_addenda")
    .select("id")
    .eq("org_id", access.org_id)
    .eq("bid_package_id", access.bidPackage.id)

  const addendumIds = (addenda ?? []).map((addendum: any) => addendum.id as string)
  if (addendumIds.length > 0) {
    const { data: acknowledgements } = await supabase
      .from("bid_addendum_acknowledgements")
      .select("bid_addendum_id")
      .eq("org_id", access.org_id)
      .eq("bid_invite_id", access.bid_invite_id)
      .in("bid_addendum_id", addendumIds)

    const acknowledgedIds = new Set((acknowledgements ?? []).map((row: any) => row.bid_addendum_id as string))
    const missingCount = addendumIds.filter((id) => !acknowledgedIds.has(id)).length
    if (missingCount > 0) {
      throw new Error(`Acknowledge ${missingCount} outstanding addendum${missingCount === 1 ? "" : "a"} before submitting.`)
    }
  }

  // Structured pricing: when the package has a scope schedule, every base
  // and allowance line needs a response, and priced base lines must sum to
  // the submitted total — the bid tab depends on this reconciliation.
  const { data: scopeRows } = await supabase
    .from("bid_scope_items")
    .select("id, item_type, description, quantity, unit")
    .eq("org_id", access.org_id)
    .eq("bid_package_id", access.bidPackage.id)
    .order("position", { ascending: true })

  const scopeById = new Map((scopeRows ?? []).map((row: any) => [row.id as string, row]))
  const inputItems = input.items ?? []
  let rpcItems: Array<Record<string, unknown>> = []

  if ((scopeRows ?? []).length > 0) {
    const responsesByScopeId = new Map(inputItems.map((item) => [item.bid_scope_item_id, item]))

    for (const scopeRow of scopeRows ?? []) {
      const isRequired = scopeRow.item_type === "base" || scopeRow.item_type === "allowance"
      const response = responsesByScopeId.get(scopeRow.id as string)
      if (isRequired && !response) {
        throw new Error(`Missing a response for scope line "${scopeRow.description}"`)
      }
      if (response?.response === "priced") {
        const amount =
          response.amount_cents ??
          (response.unit_rate_cents != null && response.quantity != null
            ? Math.round(response.unit_rate_cents * response.quantity)
            : null)
        if (amount == null || amount < 0) {
          throw new Error(`A price is required for scope line "${scopeRow.description}"`)
        }
      }
    }

    for (const item of inputItems) {
      if (!scopeById.has(item.bid_scope_item_id)) {
        throw new Error("Bid response references an unknown scope line")
      }
    }

    const baseSum = inputItems.reduce((sum, item) => {
      const scopeRow = scopeById.get(item.bid_scope_item_id)
      if (!scopeRow || scopeRow.item_type === "alternate") return sum
      if (item.response !== "priced") return sum
      const amount =
        item.amount_cents ??
        (item.unit_rate_cents != null && item.quantity != null
          ? Math.round(item.unit_rate_cents * item.quantity)
          : 0)
      return sum + (amount ?? 0)
    }, 0)

    if (baseSum !== input.total_cents) {
      throw new Error("Line items do not add up to the submitted total")
    }

    rpcItems = inputItems.map((item) => {
      const scopeRow = scopeById.get(item.bid_scope_item_id)
      const amount =
        item.amount_cents ??
        (item.unit_rate_cents != null && item.quantity != null
          ? Math.round(item.unit_rate_cents * item.quantity)
          : null)
      return {
        bid_scope_item_id: item.bid_scope_item_id,
        description: scopeRow?.description ?? "Scope item",
        response: item.response,
        amount_cents: item.response === "priced" ? amount : null,
        unit_rate_cents: item.unit_rate_cents ?? null,
        quantity: item.quantity ?? scopeRow?.quantity ?? null,
        notes: item.notes ?? null,
      }
    })
  }

  const { data: rpcResult, error: rpcError } = await supabase.rpc("create_bid_submission_version", {
    p_org_id: access.org_id,
    p_bid_invite_id: access.bid_invite_id,
    p_payload: {
      total_cents: input.total_cents,
      currency: input.currency ?? "usd",
      valid_until: input.valid_until ?? null,
      lead_time_days: input.lead_time_days ?? null,
      duration_days: input.duration_days ?? null,
      start_available_on: input.start_available_on ?? null,
      exclusions: input.exclusions ?? null,
      clarifications: input.clarifications ?? null,
      notes: input.notes ?? null,
      submitted_by_name: input.submitted_by_name ?? null,
      submitted_by_email: input.submitted_by_email ?? null,
      line_items: [],
    },
    p_items: rpcItems,
    p_source: "portal",
    p_entered_by: null,
  })

  if (rpcError || !rpcResult) {
    throw new Error(`Failed to submit bid: ${rpcError?.message}`)
  }

  const createdId = (rpcResult as any).submission_id as string
  const createdVersion = Number((rpcResult as any).version ?? 1)
  const createdStatus = ((rpcResult as any).status as string) ?? "submitted"
  const now = new Date().toISOString()

  // Link uploaded files to the submission
  if (input.file_ids && input.file_ids.length > 0) {
    const fileLinks = input.file_ids.map((fileId) => ({
      org_id: access.org_id,
      file_id: fileId,
      entity_type: "bid_submission",
      entity_id: createdId,
    }))
    await supabase.from("file_links").insert(fileLinks)
  }

  const submission: BidPortalSubmission = {
    id: createdId,
    status: createdStatus,
    version: createdVersion,
    is_current: true,
    total_cents: input.total_cents,
    currency: input.currency ?? "usd",
    valid_until: input.valid_until ?? null,
    lead_time_days: input.lead_time_days ?? null,
    duration_days: input.duration_days ?? null,
    start_available_on: input.start_available_on ?? null,
    exclusions: input.exclusions ?? null,
    clarifications: input.clarifications ?? null,
    notes: input.notes ?? null,
    submitted_by_name: input.submitted_by_name ?? null,
    submitted_by_email: input.submitted_by_email ?? null,
    submitted_at: now,
    created_at: now,
  }

  const created = { id: createdId }

  try {
    await recordBidSubmissionBenchmarkSignal(created.id)
  } catch (benchmarkError) {
    console.warn("Bid benchmark signal computation failed", {
      submissionId: created.id,
      error: (benchmarkError as Error)?.message,
    })
  }

  try {
    await recordEvent({
      orgId: access.org_id,
      eventType: "bid_submission_received",
      entityType: "bid_submission",
      entityId: created.id,
      payload: {
        bid_package_id: access.bidPackage.id,
        bid_invite_id: access.bid_invite_id,
        company_name: access.invite.company?.name ?? access.invite.invite_email ?? null,
        total_cents: submission.total_cents ?? null,
        version: submission.version,
      },
    })
  } catch (eventError) {
    console.warn("Failed to record bid submission event", {
      submissionId: created.id,
      error: (eventError as Error)?.message,
    })
  }

  // Submission receipt: subs keep proof of what they bid and when
  try {
    const receiptTo = input.submitted_by_email ?? access.invite.invite_email ?? access.invite.contact?.email
    if (receiptTo) {
      await enqueueOutboxJob({
        orgId: access.org_id,
        jobType: "send_bid_email",
        payload: {
          kind: "receipt",
          to: receiptTo,
          companyName: access.invite.company?.name,
          contactName: access.invite.contact?.full_name ?? input.submitted_by_name,
          projectName: access.project.name,
          bidPackageTitle: access.bidPackage.title,
          orgName: access.org.name,
          totalCents: submission.total_cents,
          version: submission.version,
          submittedAt: submission.submitted_at,
          validUntil: submission.valid_until,
          bidPackageId: access.bidPackage.id,
          inviteId: access.bid_invite_id,
          submissionId: created.id,
        },
      })
    }
  } catch (receiptError) {
    console.warn("Failed to queue bid receipt email", {
      submissionId: created.id,
      error: (receiptError as Error)?.message,
    })
  }

  return submission
}

/** Autosaved portal draft — one per invite, replaced on every save, deleted on
 * submit by the versioning RPC. */
export async function saveBidPortalDraft({
  access,
  payload,
}: {
  access: BidPortalAccess
  payload: Record<string, unknown>
}) {
  const supabase = createServiceSupabaseClient()
  const { error } = await supabase
    .from("bid_portal_drafts")
    .upsert(
      {
        org_id: access.org_id,
        bid_invite_id: access.bid_invite_id,
        payload,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "bid_invite_id" },
    )

  if (error) {
    throw new Error(`Failed to save draft: ${error.message}`)
  }
}

/** A sub retracts their current bid before award. The submission history is
 * kept; the invite drops to withdrawn and the GC sees it in the bid tab. */
export async function withdrawBidFromPortal({
  access,
  reason,
}: {
  access: BidPortalAccess
  reason?: string | null
}) {
  const supabase = createServiceSupabaseClient()
  const now = new Date().toISOString()

  if (["closed", "awarded", "cancelled"].includes(access.bidPackage.status)) {
    throw new Error("Bidding is closed for this package")
  }

  if (access.invite.status !== "submitted") {
    throw new Error("There is no submitted bid to withdraw")
  }

  const { error: inviteError } = await supabase
    .from("bid_invites")
    .update({ status: "withdrawn", updated_at: now })
    .eq("org_id", access.org_id)
    .eq("id", access.bid_invite_id)

  if (inviteError) {
    throw new Error(`Failed to withdraw bid: ${inviteError.message}`)
  }

  await supabase
    .from("bid_submissions")
    .update({ status: "withdrawn", updated_at: now })
    .eq("org_id", access.org_id)
    .eq("bid_invite_id", access.bid_invite_id)
    .eq("is_current", true)

  await recordEvent({
    orgId: access.org_id,
    eventType: "bid_submission_withdrawn",
    entityType: "bid_invite",
    entityId: access.bid_invite_id,
    payload: {
      bid_package_id: access.bidPackage.id,
      company_name: access.invite.company?.name ?? access.invite.invite_email ?? null,
      reason: reason ?? null,
    },
  })

  return { withdrawn_at: now }
}

export async function declineBidFromPortal({
  access,
  reason,
}: {
  access: BidPortalAccess
  reason?: string | null
}) {
  const supabase = createServiceSupabaseClient()
  const now = new Date().toISOString()

  const disallowedStatuses = ["closed", "awarded", "cancelled"]
  if (disallowedStatuses.includes(access.bidPackage.status)) {
    throw new Error("Bidding is closed for this package")
  }

  const { error } = await supabase
    .from("bid_invites")
    .update({
      status: "declined",
      declined_at: now,
      updated_at: now,
    })
    .eq("org_id", access.org_id)
    .eq("id", access.bid_invite_id)

  if (error) {
    throw new Error(`Failed to decline bid: ${error.message}`)
  }

  await recordEvent({
    orgId: access.org_id,
    actorId: access.invite.contact?.id ?? null,
    eventType: "bid_invite_declined",
    entityType: "bid_invite",
    entityId: access.bid_invite_id,
    payload: {
      bid_package_id: access.bidPackage.id,
      company_id: access.invite.company?.id ?? null,
      reason: reason?.trim() || null,
      via_portal: true,
    },
  })

  return { declined_at: now }
}
