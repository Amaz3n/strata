import { createHmac } from "node:crypto"
import { compare } from "bcryptjs"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { buildFilesPublicUrl, ensureOrgScopedPath } from "@/lib/storage/files-storage"
import type { FileMetadata } from "@/lib/types"

const PIN_SALT_ROUNDS = 10
const MAX_PIN_ATTEMPTS = 5
const LOCKOUT_DURATION_MS = 15 * 60 * 1000

export interface BidPortalPackage {
  id: string
  project_id: string
  title: string
  trade?: string | null
  scope?: string | null
  instructions?: string | null
  due_at?: string | null
  status: string
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
}

export interface BidPortalData {
  packageFiles: FileMetadata[]
  addenda: BidPortalAddendum[]
  submissions: BidPortalSubmission[]
  currentSubmission?: BidPortalSubmission
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

function mapFile(file: any, orgId: string): FileMetadata {
  let url: string | undefined
  try {
    url = buildFilesPublicUrl(ensureOrgScopedPath(orgId, file.storage_path)) ?? undefined
  } catch {
    url = undefined
  }
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
  const tokenHash = hashBidToken(token)

  const { data: tokenRow, error } = await supabase
    .from("bid_access_tokens")
    .select(
      `
      id, org_id, bid_invite_id, expires_at, max_access_count, access_count, last_accessed_at,
      pin_required, pin_locked_until, revoked_at,
      bid_invite:bid_invites(
        id, bid_package_id, status, invite_email, sent_at, last_viewed_at, submitted_at,
        company:companies(id, name, email, phone),
        contact:contacts(id, full_name, email, phone)
      )
    `,
    )
    .eq("token_hash", tokenHash)
    .is("revoked_at", null)
    .maybeSingle()

  if (error || !tokenRow || !tokenRow.bid_invite) {
    return null
  }

  if (tokenRow.expires_at && new Date(tokenRow.expires_at) < new Date()) {
    return null
  }

  if (tokenRow.max_access_count && tokenRow.access_count >= tokenRow.max_access_count) {
    return null
  }

  const { data: bidPackage } = await supabase
    .from("bid_packages")
    .select("id, project_id, title, trade, scope, instructions, due_at, status")
    .eq("id", tokenRow.bid_invite.bid_package_id)
    .maybeSingle()

  if (!bidPackage) {
    return null
  }

  const [projectResult, orgResult] = await Promise.all([
    supabase.from("projects").select("id, name, status").eq("id", bidPackage.project_id).maybeSingle(),
    supabase.from("orgs").select("id, name, logo_url").eq("id", tokenRow.org_id).maybeSingle(),
  ])

  if (!projectResult.data || !orgResult.data) {
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
    pin_locked_until: tokenRow.pin_locked_until ?? null,
    invite: {
      id: tokenRow.bid_invite.id,
      bid_package_id: tokenRow.bid_invite.bid_package_id,
      status: tokenRow.bid_invite.status,
      invite_email: tokenRow.bid_invite.invite_email ?? null,
      sent_at: tokenRow.bid_invite.sent_at ?? null,
      last_viewed_at: tokenRow.bid_invite.last_viewed_at ?? null,
      submitted_at: tokenRow.bid_invite.submitted_at ?? null,
      company: tokenRow.bid_invite.company ?? null,
      contact: tokenRow.bid_invite.contact ?? null,
    },
    bidPackage: {
      id: bidPackage.id,
      project_id: bidPackage.project_id,
      title: bidPackage.title,
      trade: bidPackage.trade ?? null,
      scope: bidPackage.scope ?? null,
      instructions: bidPackage.instructions ?? null,
      due_at: bidPackage.due_at ?? null,
      status: bidPackage.status,
    },
    project: {
      id: projectResult.data.id,
      name: projectResult.data.name,
      status: projectResult.data.status,
    },
    org: {
      id: orgResult.data.id,
      name: orgResult.data.name,
      logo_url: orgResult.data.logo_url ?? null,
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
  const tokenHash = hashBidToken(token)

  const { data, error } = await supabase
    .from("bid_access_tokens")
    .select("id, pin_hash, pin_attempts, pin_locked_until")
    .eq("token_hash", tokenHash)
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

export async function loadBidPortalData(access: BidPortalAccess): Promise<BidPortalData> {
  const supabase = createServiceSupabaseClient()

  const [packageLinksResult, addendaResult, submissionsResult] = await Promise.all([
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
        exclusions, clarifications, notes, submitted_by_name, submitted_by_email, submitted_at, created_at
      `,
      )
      .eq("org_id", access.org_id)
      .eq("bid_invite_id", access.bid_invite_id)
      .order("version", { ascending: false }),
  ])

  const packageFiles = (packageLinksResult.data ?? [])
    .filter((link) => link.file)
    .map((link) => mapFile(link.file, access.org_id))

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
      acc[link.entity_id].push(mapFile(link.file, access.org_id))
      return acc
    }, {} as Record<string, FileMetadata[]>)
  }

  const submissions = (submissionsResult.data ?? []).map((row) => ({
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

  const { data: current } = await supabase
    .from("bid_submissions")
    .select("id, version")
    .eq("org_id", access.org_id)
    .eq("bid_invite_id", access.bid_invite_id)
    .eq("is_current", true)
    .maybeSingle()

  const nextVersion = (current?.version ?? 0) + 1
  const now = new Date().toISOString()

  if (current?.id) {
    await supabase
      .from("bid_submissions")
      .update({ is_current: false, updated_at: now })
      .eq("id", current.id)
  }

  const status = nextVersion > 1 ? "revised" : "submitted"

  const { data: created, error } = await supabase
    .from("bid_submissions")
    .insert({
      org_id: access.org_id,
      bid_invite_id: access.bid_invite_id,
      status,
      version: nextVersion,
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
    })
    .select(
      `
      id, status, version, is_current, total_cents, currency, valid_until, lead_time_days, duration_days, start_available_on,
      exclusions, clarifications, notes, submitted_by_name, submitted_by_email, submitted_at, created_at
    `,
    )
    .single()

  if (error || !created) {
    throw new Error(`Failed to submit bid: ${error?.message}`)
  }

  await supabase
    .from("bid_invites")
    .update({ status: "submitted", submitted_at: now })
    .eq("org_id", access.org_id)
    .eq("id", access.bid_invite_id)

  return {
    id: created.id,
    status: created.status,
    version: created.version,
    is_current: created.is_current,
    total_cents: created.total_cents ?? null,
    currency: created.currency ?? null,
    valid_until: created.valid_until ?? null,
    lead_time_days: created.lead_time_days ?? null,
    duration_days: created.duration_days ?? null,
    start_available_on: created.start_available_on ?? null,
    exclusions: created.exclusions ?? null,
    clarifications: created.clarifications ?? null,
    notes: created.notes ?? null,
    submitted_by_name: created.submitted_by_name ?? null,
    submitted_by_email: created.submitted_by_email ?? null,
    submitted_at: created.submitted_at ?? null,
    created_at: created.created_at,
  }
}
