import "server-only"

import { randomBytes } from "node:crypto"
import { compare, hash } from "bcryptjs"
import { cookies } from "next/headers"

import { recordAudit } from "@/lib/services/audit"
import { enforceAuthRateLimit } from "@/lib/services/auth-rate-limit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import {
  decryptPortalToken,
  generatePortalToken,
  hashBidToken,
  hashPortalToken,
  hashSessionToken,
  isLockedOut,
  nextLockoutState,
} from "@/lib/services/portal-credentials"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import type {
  ExternalIdentity,
  ExternalPortalWorkspaceContext,
  ExternalPortalWorkspaceItem,
  ExternalPortalWorkspaceOrg,
} from "@/lib/types"

const SESSION_COOKIE = "external_portal_session"
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30
const PASSWORD_SALT_ROUNDS = 10
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000
const RESET_TTL_MS = 60 * 60 * 1000
const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password"

type ExternalTokenType = "portal" | "bid"
type ExternalGrantStatus = "active" | "paused" | "revoked"

/** A session proves identity only. Which builder is being viewed comes from grants. */
interface ExternalPortalSession {
  id: string
  identity: ExternalIdentity
}

interface ExternalIdentityRow {
  id: string
  email: string
  full_name?: string | null
  password_hash: string
  status: "active" | "paused" | "revoked"
  email_verified_at?: string | null
  password_attempts?: number | null
  password_locked_until?: string | null
  last_login_at?: string | null
  paused_at?: string | null
  revoked_at?: string | null
  created_at: string
}

interface ResolvedExternalTokenContext {
  tokenId: string
  orgId: string
  expectedEmail?: string | null
  suggestedFullName?: string | null
  orgName?: string | null
  projectName?: string | null
}

export interface ExternalPortalGateContext {
  orgName: string
  projectName: string
  expectedEmail?: string | null
  suggestedFullName?: string | null
  emailLocked: boolean
}

const IDENTITY_COLUMNS =
  "id, email, full_name, password_hash, status, email_verified_at, password_attempts, password_locked_until, last_login_at, paused_at, revoked_at, created_at"

async function setSessionCookie(sessionToken: string) {
  const store = await cookies()
  store.set({
    name: SESSION_COOKIE,
    value: sessionToken,
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_SECONDS,
  })
}

async function clearSessionCookie() {
  const store = await cookies()
  store.set({
    name: SESSION_COOKIE,
    value: "",
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
  })
}

function mapIdentity(row: any): ExternalIdentity {
  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name ?? null,
    status: row.status,
    email_verified_at: row.email_verified_at ?? null,
    last_login_at: row.last_login_at ?? null,
    paused_at: row.paused_at ?? null,
    revoked_at: row.revoked_at ?? null,
    created_at: row.created_at,
  }
}

function mapIdentityRow(row: any): ExternalIdentityRow {
  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name ?? null,
    password_hash: row.password_hash,
    status: row.status,
    email_verified_at: row.email_verified_at ?? null,
    password_attempts: row.password_attempts ?? 0,
    password_locked_until: row.password_locked_until ?? null,
    last_login_at: row.last_login_at ?? null,
    paused_at: row.paused_at ?? null,
    revoked_at: row.revoked_at ?? null,
    created_at: row.created_at,
  }
}

function normalizeWorkspaceProjectStatus(status: unknown): ExternalPortalWorkspaceItem["project_status"] {
  switch (status) {
    case "planning":
    case "bidding":
    case "active":
    case "on_hold":
    case "completed":
    case "cancelled":
      return status
    default:
      return "active"
  }
}

function formatProjectLocation(location: unknown): string | null {
  if (!location) return null
  if (typeof location === "string") return location.trim() || null
  if (typeof location !== "object") return null

  const value = location as Record<string, unknown>
  const direct = value.address ?? value.formatted
  if (typeof direct === "string" && direct.trim()) return direct.trim()

  const cityState = [value.city, value.state].filter((part): part is string => typeof part === "string" && !!part.trim()).join(", ")
  const lines = [value.street1, value.street2, cityState, value.postal_code ?? value.zip]
    .filter((part): part is string => typeof part === "string" && !!part.trim())
    .map((part) => part.trim())

  return lines.length > 0 ? lines.join(", ") : null
}

function sortWorkspaceItems(a: ExternalPortalWorkspaceItem, b: ExternalPortalWorkspaceItem) {
  const projectComparison = a.project_name.localeCompare(b.project_name)
  if (projectComparison !== 0) return projectComparison
  const kindComparison = a.kind.localeCompare(b.kind)
  if (kindComparison !== 0) return kindComparison
  return a.subtitle.localeCompare(b.subtitle)
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

async function touchIdentityLogin(identityId: string) {
  const nowIso = new Date().toISOString()
  const supabase = createServiceSupabaseClient()
  await supabase
    .from("external_identities")
    .update({ last_login_at: nowIso, updated_at: nowIso })
    .eq("id", identityId)
}

async function resetPasswordAttempts(identityId: string) {
  const supabase = createServiceSupabaseClient()
  await supabase
    .from("external_identities")
    .update({ password_attempts: 0, password_locked_until: null, updated_at: new Date().toISOString() })
    .eq("id", identityId)
}

async function recordPasswordFailure(identity: ExternalIdentityRow) {
  if (isLockedOut({ attempts: identity.password_attempts, locked_until: identity.password_locked_until })) return
  const next = nextLockoutState({ attempts: identity.password_attempts, locked_until: identity.password_locked_until })
  const supabase = createServiceSupabaseClient()
  await supabase
    .from("external_identities")
    .update({
      password_attempts: next.attempts,
      password_locked_until: next.locked_until,
      updated_at: new Date().toISOString(),
    })
    .eq("id", identity.id)
}

async function createSession(identityId: string) {
  const supabase = createServiceSupabaseClient()
  const nowIso = new Date().toISOString()
  const rawSessionToken = randomBytes(32).toString("hex")
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString()

  const { error: sessionError } = await supabase.from("external_identity_sessions").insert({
    identity_id: identityId,
    session_token_hash: hashSessionToken(rawSessionToken),
    expires_at: expiresAt,
    last_seen_at: nowIso,
  })

  if (sessionError) {
    throw new Error(`Failed to create identity session: ${sessionError.message}`)
  }

  await setSessionCookie(rawSessionToken)
}

async function resolveTokenContext(
  tokenType: ExternalTokenType,
  token: string,
): Promise<ResolvedExternalTokenContext | null> {
  const supabase = createServiceSupabaseClient()

  if (tokenType === "portal") {
    const { data } = await supabase
      .from("portal_access_tokens")
      .select(
        `
        id, org_id, revoked_at,
        contact:contacts(full_name, email),
        project:projects(name),
        org:orgs(name)
      `,
      )
      .eq("token_hash", hashPortalToken(token))
      .maybeSingle()
    if (!data || data.revoked_at) return null
    const contact = firstRelation(data.contact as any)
    const project = firstRelation(data.project as any)
    const org = firstRelation(data.org as any)
    return {
      tokenId: data.id as string,
      orgId: data.org_id as string,
      expectedEmail: contact?.email ?? null,
      suggestedFullName: contact?.full_name ?? null,
      projectName: project?.name ?? null,
      orgName: org?.name ?? null,
    }
  }

  const { data } = await supabase
    .from("bid_access_tokens")
    .select(
      `
      id, org_id, revoked_at,
      bid_invite:bid_invites!bid_access_tokens_org_invite_fk(
        invite_email,
        contact:contacts!bid_invites_org_contact_fk(full_name, email),
        bid_package:bid_packages!bid_invites_org_package_fk(title, project:projects(name))
      ),
      org:orgs(name)
    `,
    )
    .eq("token_hash", hashBidToken(token))
    .maybeSingle()
  if (!data || data.revoked_at) return null
  const invite = firstRelation(data.bid_invite as any)
  const contact = firstRelation(invite?.contact)
  const bidPackage = firstRelation(invite?.bid_package)
  const project = firstRelation(bidPackage?.project)
  const org = firstRelation(data.org as any)

  return {
    tokenId: data.id as string,
    orgId: data.org_id as string,
    expectedEmail: invite?.invite_email ?? contact?.email ?? null,
    suggestedFullName: contact?.full_name ?? null,
    projectName: project?.name ?? bidPackage?.title ?? null,
    orgName: org?.name ?? null,
  }
}

/**
 * Gate copy for the claim/login screen. Deliberately does NOT report whether an
 * identity already exists for the invited email — that told any link holder
 * whether a given person already had an Arc account.
 */
export async function getExternalPortalGateContext({
  token,
  tokenType,
}: {
  token: string
  tokenType: ExternalTokenType
}): Promise<ExternalPortalGateContext | null> {
  const tokenContext = await resolveTokenContext(tokenType, token)
  if (!tokenContext) return null

  const normalizedExpectedEmail = tokenContext.expectedEmail?.trim().toLowerCase() ?? null

  return {
    orgName: tokenContext.orgName ?? "the builder",
    projectName: tokenContext.projectName ?? "this project",
    expectedEmail: normalizedExpectedEmail,
    suggestedFullName: tokenContext.suggestedFullName ?? null,
    emailLocked: !!normalizedExpectedEmail,
  }
}

async function findSession(): Promise<ExternalPortalSession | null> {
  const store = await cookies()
  const rawToken = store.get(SESSION_COOKIE)?.value
  if (!rawToken) return null

  const nowIso = new Date().toISOString()
  const supabase = createServiceSupabaseClient()

  const { data: sessionRow } = await supabase
    .from("external_identity_sessions")
    .select(
      `
      id,
      identity_id,
      expires_at,
      revoked_at,
      identity:external_identities!inner(
        id, email, full_name, status, email_verified_at, last_login_at, paused_at, revoked_at, created_at
      )
    `,
    )
    .eq("session_token_hash", hashSessionToken(rawToken))
    .maybeSingle()

  if (!sessionRow) {
    await clearSessionCookie()
    return null
  }

  if (sessionRow.revoked_at || new Date(sessionRow.expires_at) <= new Date()) {
    await clearSessionCookie()
    return null
  }

  const identity = mapIdentity(firstRelation(sessionRow.identity as any))
  if (identity.status !== "active") {
    await clearSessionCookie()
    return null
  }

  await supabase.from("external_identity_sessions").update({ last_seen_at: nowIso }).eq("id", sessionRow.id)

  return { id: sessionRow.id as string, identity }
}

export async function getCurrentExternalPortalSession() {
  return findSession()
}

/**
 * Does the signed-in identity hold a live grant for this specific token? This
 * is the only authorization question the external surface asks — there is no
 * ambient org on the session to compare against.
 */
export async function hasExternalPortalGrantForToken({
  orgId,
  tokenId,
  tokenType,
}: {
  orgId: string
  tokenId: string
  tokenType: ExternalTokenType
}) {
  const session = await findSession()
  if (!session) return false

  const supabase = createServiceSupabaseClient()
  let query = supabase
    .from("external_identity_grants")
    .select("id")
    .eq("org_id", orgId)
    .eq("identity_id", session.identity.id)
    .eq("status", "active")
    .is("paused_at", null)
    .is("revoked_at", null)

  query =
    tokenType === "portal"
      ? query.eq("portal_access_token_id", tokenId)
      : query.eq("bid_access_token_id", tokenId)

  const { data } = await query.maybeSingle()
  return !!data
}

/** Does the signed-in identity have any live grant with this builder at all? */
export async function externalIdentityHasOrgAccess(orgId: string): Promise<boolean> {
  const session = await findSession()
  if (!session) return false

  const supabase = createServiceSupabaseClient()
  const { data } = await supabase
    .from("external_identity_grants")
    .select("id")
    .eq("org_id", orgId)
    .eq("identity_id", session.identity.id)
    .eq("status", "active")
    .is("paused_at", null)
    .is("revoked_at", null)
    .limit(1)
    .maybeSingle()

  return !!data
}

async function loadIdentityByEmail(email: string): Promise<ExternalIdentityRow | null> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("external_identities")
    .select(IDENTITY_COLUMNS)
    .eq("email", email)
    .maybeSingle()

  if (error) {
    throw new Error(`Unable to load identity: ${error.message}`)
  }
  return data ? mapIdentityRow(data) : null
}

/**
 * Verifies a password without minting a session. The unified sign-in page needs
 * to know whether an identity authenticates before it can decide where to route.
 */
export async function verifyExternalIdentityPassword({
  email,
  password,
}: {
  email: string
  password: string
}): Promise<ExternalIdentity | null> {
  const normalizedEmail = email.trim().toLowerCase()
  await enforceAuthRateLimit("external_signin", normalizedEmail)

  const identity = await loadIdentityByEmail(normalizedEmail)
  if (!identity) return null
  if (isLockedOut({ attempts: identity.password_attempts, locked_until: identity.password_locked_until })) return null

  const validPassword = await compare(password, identity.password_hash)
  if (!validPassword) {
    await recordPasswordFailure(identity)
    return null
  }
  if (identity.status !== "active") {
    throw new Error("This account is paused or revoked. Contact the builder.")
  }

  return mapIdentity(identity)
}

/** Mints the session for an identity whose password was already verified. */
export async function startExternalPortalSession(identityId: string) {
  await resetPasswordAttempts(identityId)
  await touchIdentityLogin(identityId)
  await createSession(identityId)
}

export async function signInExternalPortalAccount({ email, password }: { email: string; password: string }) {
  const identity = await verifyExternalIdentityPassword({ email, password })
  if (!identity) {
    throw new Error(INVALID_CREDENTIALS_MESSAGE)
  }
  await startExternalPortalSession(identity.id)
}

async function upsertGrant({
  orgId,
  identityId,
  tokenType,
  tokenId,
}: {
  orgId: string
  identityId: string
  tokenType: ExternalTokenType
  tokenId: string
}) {
  const supabase = createServiceSupabaseClient()
  const payload: Record<string, any> = {
    org_id: orgId,
    identity_id: identityId,
    status: "active",
    paused_at: null,
    revoked_at: null,
    updated_at: new Date().toISOString(),
  }
  if (tokenType === "portal") {
    payload.portal_access_token_id = tokenId
  } else {
    payload.bid_access_token_id = tokenId
  }

  const { error } = await supabase.from("external_identity_grants").upsert(payload, {
    onConflict: tokenType === "portal" ? "identity_id,portal_access_token_id" : "identity_id,bid_access_token_id",
  })

  if (error) {
    throw new Error(`Failed to grant identity access: ${error.message}`)
  }
}

export async function authenticateExternalPortalAccountWithToken({
  token,
  tokenType,
  mode,
  email,
  fullName,
  password,
}: {
  token: string
  tokenType: ExternalTokenType
  mode: "claim" | "login"
  email: string
  fullName?: string
  password: string
}) {
  const tokenContext = await resolveTokenContext(tokenType, token)
  if (!tokenContext) {
    throw new Error("This access link is invalid or no longer active")
  }

  const normalizedEmail = email.trim().toLowerCase()
  const enforcedEmail = tokenContext.expectedEmail?.trim().toLowerCase() ?? null
  if (enforcedEmail && normalizedEmail !== enforcedEmail) {
    throw new Error(`Use the invited email ${enforcedEmail} to continue`)
  }

  const lookupEmail = enforcedEmail ?? normalizedEmail
  await enforceAuthRateLimit(mode === "claim" ? "external_claim" : "external_signin", lookupEmail)

  const supabase = createServiceSupabaseClient()
  const existing = await loadIdentityByEmail(lookupEmail)

  let identityId: string
  let created = false

  if (!existing) {
    if (mode !== "claim") {
      throw new Error(INVALID_CREDENTIALS_MESSAGE)
    }
    const passwordHash = await hash(password, PASSWORD_SALT_ROUNDS)
    const { data: inserted, error } = await supabase
      .from("external_identities")
      .insert({
        email: lookupEmail,
        full_name: fullName?.trim() || null,
        password_hash: passwordHash,
        status: "active",
      })
      .select("id")
      .single()
    if (error || !inserted) {
      throw new Error(`Unable to create account: ${error?.message}`)
    }
    identityId = inserted.id as string
    created = true
  } else {
    // An identity already exists — this builder's link never overrides it. The
    // holder must prove they own it, whether they arrived via claim or login.
    if (isLockedOut({ attempts: existing.password_attempts, locked_until: existing.password_locked_until })) {
      throw new Error(INVALID_CREDENTIALS_MESSAGE)
    }
    const validPassword = await compare(password, existing.password_hash)
    if (!validPassword) {
      await recordPasswordFailure(existing)
      throw new Error(INVALID_CREDENTIALS_MESSAGE)
    }
    if (existing.status !== "active") {
      throw new Error("This account is paused or revoked. Contact the builder.")
    }
    identityId = existing.id
    if (!existing.full_name && fullName?.trim()) {
      await supabase.from("external_identities").update({ full_name: fullName.trim() }).eq("id", identityId)
    }
  }

  await resetPasswordAttempts(identityId)
  await upsertGrant({ orgId: tokenContext.orgId, identityId, tokenType, tokenId: tokenContext.tokenId })

  await recordEvent({
    orgId: tokenContext.orgId,
    entityType: "external_identity",
    entityId: identityId,
    eventType: created ? "external_identity.claimed" : "external_identity.linked",
    payload: { email: lookupEmail, token_type: tokenType },
  })
  await recordAudit({
    orgId: tokenContext.orgId,
    entityType: "external_identity",
    entityId: identityId,
    action: created ? "insert" : "update",
    after: { email: lookupEmail, token_type: tokenType, mode },
    source: "external_portal",
  })

  await touchIdentityLogin(identityId)
  await createSession(identityId)

  return { identityId, created, orgId: tokenContext.orgId, email: lookupEmail }
}

export async function signOutExternalPortalAccount() {
  const store = await cookies()
  const rawToken = store.get(SESSION_COOKIE)?.value

  if (rawToken) {
    const supabase = createServiceSupabaseClient()
    await supabase
      .from("external_identity_sessions")
      .update({ revoked_at: new Date().toISOString() })
      .eq("session_token_hash", hashSessionToken(rawToken))
      .is("revoked_at", null)
  }

  await clearSessionCookie()
}

/**
 * Every builder this identity can reach, with their live portals. Previously
 * scoped to the one org baked into the session, which is what made a sub who
 * worked for two builders invisible to themselves.
 */
export async function getExternalPortalWorkspaceContext({
  orgId,
}: {
  orgId?: string
} = {}): Promise<ExternalPortalWorkspaceContext | null> {
  const session = await findSession()
  if (!session) return null

  const supabase = createServiceSupabaseClient()

  const buildGrantQuery = (relation: string) => {
    let query = supabase
      .from("external_identity_grants")
      .select(relation)
      .eq("identity_id", session.identity.id)
      .eq("status", "active")
      .is("paused_at", null)
      .is("revoked_at", null)
    if (orgId) query = query.eq("org_id", orgId)
    return query
  }

  const [{ data: portalGrantRows, error: portalError }, { data: bidGrantRows, error: bidError }] = await Promise.all([
    buildGrantQuery(
      `
      id,
      org_id,
      org:orgs(id, name),
      token:portal_access_tokens!inner(
        id, token_encrypted, portal_type, expires_at, max_access_count, access_count, last_accessed_at, pin_required, paused_at, revoked_at,
        project:projects(id, name, status, location),
        company:companies(id, name),
        contact:contacts(id, full_name, email)
      )
    `,
    ).not("portal_access_token_id", "is", null),
    buildGrantQuery(
      `
      id,
      org_id,
      org:orgs(id, name),
      token:bid_access_tokens!inner(
        id, expires_at, max_access_count, access_count, last_accessed_at, pin_required, paused_at, revoked_at,
        bid_invite:bid_invites!bid_access_tokens_org_invite_fk(
          id,
          invite_email,
          company:companies!bid_invites_org_company_fk(id, name),
          contact:contacts!bid_invites_org_contact_fk(id, full_name, email),
          bid_package:bid_packages!bid_invites_org_package_fk(id, title, due_at, status, project:projects(id, name, status, location))
        )
      )
    `,
    ).not("bid_access_token_id", "is", null),
  ])

  if (portalError) {
    throw new Error(`Failed to load external portal workspace: ${portalError.message}`)
  }
  if (bidError) {
    throw new Error(`Failed to load bid workspace access: ${bidError.message}`)
  }

  const now = new Date()
  const items: ExternalPortalWorkspaceItem[] = []

  const tokenIsLive = (token: any) => {
    if (token.revoked_at || token.paused_at) return false
    if (token.expires_at && new Date(token.expires_at) <= now) return false
    if (token.max_access_count && token.access_count >= token.max_access_count) return false
    return true
  }

  for (const row of (portalGrantRows ?? []) as any[]) {
    const token = firstRelation(row.token)
    const org = firstRelation(row.org)
    const project = firstRelation(token?.project)
    const company = firstRelation(token?.company)
    const contact = firstRelation(token?.contact)

    const plaintext = decryptPortalToken(token?.token_encrypted)
    if (!token || !plaintext || !project || !tokenIsLive(token)) continue

    const kind = token.portal_type === "sub" ? "sub" : token.portal_type === "reviewer" ? "reviewer" : "client"
    const contactName = contact?.full_name ?? contact?.email ?? null
    // Names the party the access belongs to, never the portal type. Externals
    // do not think of themselves as being in "a sub portal" — they are working
    // on a project for a builder.
    const subtitle = (kind === "sub" ? company?.name ?? contactName : contactName) ?? ""

    items.push({
      id: row.id,
      token_id: token.id,
      href: kind === "sub" ? `/s/${plaintext}` : kind === "reviewer" ? `/r/${plaintext}` : `/p/${plaintext}`,
      kind,
      subtitle,
      org_id: row.org_id,
      org_name: org?.name ?? "Arc",
      project_id: project.id,
      project_name: project.name,
      project_status: normalizeWorkspaceProjectStatus(project.status),
      project_address: formatProjectLocation(project.location),
      company_name: company?.name ?? null,
      contact_name: contactName,
      last_accessed_at: token.last_accessed_at ?? null,
    })
  }

  for (const row of (bidGrantRows ?? []) as any[]) {
    const token = firstRelation(row.token)
    const org = firstRelation(row.org)
    const invite = firstRelation(token?.bid_invite)
    const company = firstRelation(invite?.company)
    const contact = firstRelation(invite?.contact)
    const bidPackage = firstRelation(invite?.bid_package)
    const project = firstRelation(bidPackage?.project)

    if (!token || !bidPackage || !project || !tokenIsLive(token)) continue

    const inviteLabel = company?.name ?? contact?.full_name ?? invite?.invite_email ?? "Bid invite"

    items.push({
      id: row.id,
      token_id: token.id,
      href: `/b/grant_${row.id}`,
      kind: "bid",
      subtitle: `${bidPackage.title} for ${inviteLabel}`,
      org_id: row.org_id,
      org_name: org?.name ?? "Arc",
      project_id: project.id,
      project_name: project.name,
      project_status: normalizeWorkspaceProjectStatus(project.status),
      project_address: formatProjectLocation(project.location),
      company_name: company?.name ?? null,
      contact_name: contact?.full_name ?? contact?.email ?? null,
      due_at: bidPackage.due_at ?? null,
      last_accessed_at: token.last_accessed_at ?? null,
    })
  }

  items.sort(sortWorkspaceItems)

  const orgs = new Map<string, ExternalPortalWorkspaceOrg>()
  for (const item of items) {
    const existing = orgs.get(item.org_id)
    if (existing) {
      existing.items.push(item)
    } else {
      orgs.set(item.org_id, { id: item.org_id, name: item.org_name, items: [item] })
    }
  }

  return {
    identity: {
      id: session.identity.id,
      email: session.identity.email,
      full_name: session.identity.full_name ?? null,
      last_login_at: session.identity.last_login_at ?? null,
      email_verified_at: session.identity.email_verified_at ?? null,
    },
    orgs: Array.from(orgs.values()).sort((a, b) => a.name.localeCompare(b.name)),
    items,
  }
}

// ── Email verification ───────────────────────────────────────────────────────

export async function issueExternalIdentityVerification(identityId: string): Promise<string | null> {
  const supabase = createServiceSupabaseClient()
  const rawToken = generatePortalToken()

  const { error } = await supabase
    .from("external_identities")
    .update({
      verification_token_hash: hashPortalToken(rawToken),
      verification_sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", identityId)
    .is("email_verified_at", null)

  if (error) return null
  return rawToken
}

export async function confirmExternalIdentityVerification(token: string): Promise<boolean> {
  const supabase = createServiceSupabaseClient()
  const nowIso = new Date().toISOString()

  const { data } = await supabase
    .from("external_identities")
    .select("id, verification_sent_at")
    .eq("verification_token_hash", hashPortalToken(token))
    .maybeSingle()

  if (!data) return false
  if (data.verification_sent_at && Date.now() - new Date(data.verification_sent_at).getTime() > VERIFICATION_TTL_MS) {
    return false
  }

  const { error } = await supabase
    .from("external_identities")
    .update({ email_verified_at: nowIso, verification_token_hash: null, updated_at: nowIso })
    .eq("id", data.id)

  return !error
}

// ── Password reset ───────────────────────────────────────────────────────────

/**
 * Returns the reset token when the email resolves to an identity. Callers must
 * respond identically either way — whether an email is registered is not
 * something an unauthenticated request gets to learn.
 */
export async function issueExternalIdentityPasswordReset(email: string): Promise<{ token: string; identity: ExternalIdentity } | null> {
  const normalizedEmail = email.trim().toLowerCase()
  await enforceAuthRateLimit("external_reset_request", normalizedEmail)

  const identity = await loadIdentityByEmail(normalizedEmail)
  if (!identity || identity.status !== "active") return null

  const rawToken = generatePortalToken()
  const supabase = createServiceSupabaseClient()
  const { error } = await supabase
    .from("external_identities")
    .update({
      reset_token_hash: hashPortalToken(rawToken),
      reset_token_expires_at: new Date(Date.now() + RESET_TTL_MS).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", identity.id)

  if (error) return null
  return { token: rawToken, identity: mapIdentity(identity) }
}

export async function completeExternalIdentityPasswordReset({
  token,
  password,
}: {
  token: string
  password: string
}): Promise<boolean> {
  const supabase = createServiceSupabaseClient()
  const nowIso = new Date().toISOString()

  const { data } = await supabase
    .from("external_identities")
    .select("id, reset_token_expires_at")
    .eq("reset_token_hash", hashPortalToken(token))
    .maybeSingle()

  if (!data?.reset_token_expires_at || new Date(data.reset_token_expires_at) <= new Date()) {
    return false
  }

  const passwordHash = await hash(password, PASSWORD_SALT_ROUNDS)
  const { error } = await supabase
    .from("external_identities")
    .update({
      password_hash: passwordHash,
      reset_token_hash: null,
      reset_token_expires_at: null,
      password_attempts: 0,
      password_locked_until: null,
      email_verified_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", data.id)

  if (error) return false

  // A reset invalidates every existing session for that identity.
  await supabase
    .from("external_identity_sessions")
    .update({ revoked_at: nowIso })
    .eq("identity_id", data.id)
    .is("revoked_at", null)

  return true
}

/** Sweeps long-expired sessions and stale rate-limit windows. Cron-driven. */
export async function purgeExpiredExternalSessions(): Promise<number> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.rpc("purge_expired_external_sessions", { retain_days: 30 })
  if (error) {
    throw new Error(`Failed to purge expired sessions: ${error.message}`)
  }
  return typeof data === "number" ? data : 0
}

// ── Builder-side administration ──────────────────────────────────────────────

export async function listProjectExternalPortalAccounts(projectId: string, orgId?: string): Promise<ExternalIdentity[]> {
  const { orgId: resolvedOrgId, supabase, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })
  const serviceClient = createServiceSupabaseClient()

  const { data, error } = await serviceClient
    .from("external_identity_grants")
    .select(
      `
      status,
      identity:external_identities!inner(
        id, email, full_name, status, email_verified_at, last_login_at, paused_at, revoked_at, created_at
      ),
      token:portal_access_tokens!inner(id, project_id)
    `,
    )
    .eq("org_id", resolvedOrgId)
    .eq("token.project_id", projectId)

  if (error) {
    throw new Error(`Failed to list external portal accounts: ${error.message}`)
  }

  const byIdentityId = new Map<string, ExternalIdentity>()
  for (const row of (data ?? []) as any[]) {
    const identity = mapIdentity(firstRelation(row.identity))
    const existing = byIdentityId.get(identity.id)
    if (!existing) {
      byIdentityId.set(identity.id, { ...identity, grant_count: 1 })
    } else {
      existing.grant_count = (existing.grant_count ?? 0) + 1
    }
  }

  return Array.from(byIdentityId.values()).sort((a, b) => a.email.localeCompare(b.email))
}

/**
 * A builder can only change access *to their own org*. The identity itself is
 * shared across builders, so pausing it here would knock the person out of
 * every other builder's portals too — status now applies to this org's grants.
 */
export async function setExternalPortalAccountStatus({
  accountId,
  status,
  orgId,
}: {
  accountId: string
  status: ExternalGrantStatus
  orgId?: string
}) {
  const { orgId: resolvedOrgId, supabase, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })
  const serviceClient = createServiceSupabaseClient()
  const nowIso = new Date().toISOString()

  const { error } = await serviceClient
    .from("external_identity_grants")
    .update({
      status,
      updated_at: nowIso,
      paused_at: status === "paused" ? nowIso : null,
      revoked_at: status === "revoked" ? nowIso : null,
    })
    .eq("org_id", resolvedOrgId)
    .eq("identity_id", accountId)

  if (error) {
    throw new Error(`Failed to update external portal access: ${error.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    entityType: "external_identity",
    entityId: accountId,
    eventType: `external_identity.${status}`,
    payload: { status },
  })
  await recordAudit({
    orgId: resolvedOrgId,
    entityType: "external_identity",
    entityId: accountId,
    action: "update",
    after: { status, scope: "org_grants" },
    source: "external_portal",
  })
}

async function setBidInviteGrantStatus({
  inviteId,
  status,
  orgId,
}: {
  inviteId: string
  status: ExternalGrantStatus
  orgId?: string
}) {
  const { orgId: resolvedOrgId, supabase, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })
  const serviceClient = createServiceSupabaseClient()

  const { data: tokens, error: tokenError } = await serviceClient
    .from("bid_access_tokens")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("bid_invite_id", inviteId)

  if (tokenError) {
    throw new Error(`Failed to load bid access tokens for invite: ${tokenError.message}`)
  }

  const tokenIds = (tokens ?? []).map((row: any) => row.id)
  if (tokenIds.length === 0) return

  const nowIso = new Date().toISOString()
  const { error } = await serviceClient
    .from("external_identity_grants")
    .update({
      status,
      updated_at: nowIso,
      paused_at: status === "paused" ? nowIso : null,
      revoked_at: status === "revoked" ? nowIso : null,
    })
    .eq("org_id", resolvedOrgId)
    .in("bid_access_token_id", tokenIds)

  if (error) {
    throw new Error(`Failed to update bid invite account grants: ${error.message}`)
  }
}

export async function pauseBidInviteAccountGrants(inviteId: string, orgId?: string) {
  await setBidInviteGrantStatus({ inviteId, status: "paused", orgId })
}

export async function resumeBidInviteAccountGrants(inviteId: string, orgId?: string) {
  await setBidInviteGrantStatus({ inviteId, status: "active", orgId })
}

export async function revokeBidInviteAccountGrants(inviteId: string, orgId?: string) {
  await setBidInviteGrantStatus({ inviteId, status: "revoked", orgId })
}
