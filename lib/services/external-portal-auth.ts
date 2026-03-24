import "server-only"

import { createHash, createHmac, randomBytes } from "node:crypto"
import { compare, hash } from "bcryptjs"
import { cookies } from "next/headers"

import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import type { ExternalPortalAccount, ExternalPortalWorkspaceContext, ExternalPortalWorkspaceItem } from "@/lib/types"

const EXTERNAL_PORTAL_SESSION_COOKIE = "external_portal_session"
const EXTERNAL_PORTAL_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30
const PASSWORD_SALT_ROUNDS = 10

type ExternalTokenType = "portal" | "bid"
type ExternalGrantStatus = "active" | "paused" | "revoked"

interface ExternalPortalSession {
  id: string
  org_id: string
  account: ExternalPortalAccount
}

interface ExternalPortalAccountRow {
  id: string
  org_id: string
  email: string
  full_name?: string | null
  password_hash: string
  status: "active" | "paused" | "revoked"
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
  defaultMode: "claim" | "login"
  emailLocked: boolean
  hasExistingAccount: boolean
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex")
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

async function setExternalPortalSessionCookie(sessionToken: string) {
  const store = await cookies()
  store.set({
    name: EXTERNAL_PORTAL_SESSION_COOKIE,
    value: sessionToken,
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: EXTERNAL_PORTAL_SESSION_TTL_SECONDS,
  })
}

async function clearExternalPortalSessionCookie() {
  const store = await cookies()
  store.set({
    name: EXTERNAL_PORTAL_SESSION_COOKIE,
    value: "",
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
  })
}

function mapExternalAccount(row: any): ExternalPortalAccount {
  return {
    id: row.id,
    org_id: row.org_id,
    email: row.email,
    full_name: row.full_name ?? null,
    status: row.status,
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

function sortWorkspaceItems(a: ExternalPortalWorkspaceItem, b: ExternalPortalWorkspaceItem) {
  const projectComparison = a.project_name.localeCompare(b.project_name)
  if (projectComparison !== 0) return projectComparison
  const kindComparison = a.kind.localeCompare(b.kind)
  if (kindComparison !== 0) return kindComparison
  return a.subtitle.localeCompare(b.subtitle)
}

async function touchExternalPortalAccountLogin(accountId: string) {
  const nowIso = new Date().toISOString()
  const supabase = createServiceSupabaseClient()
  await supabase
    .from("external_portal_accounts")
    .update({ last_login_at: nowIso, updated_at: nowIso })
    .eq("id", accountId)
}

async function createExternalPortalSession({
  accountId,
  orgId,
}: {
  accountId: string
  orgId: string
}) {
  const supabase = createServiceSupabaseClient()
  const nowIso = new Date().toISOString()
  const rawSessionToken = randomBytes(32).toString("hex")
  const sessionTokenHash = sha256(rawSessionToken)
  const expiresAt = new Date(Date.now() + EXTERNAL_PORTAL_SESSION_TTL_SECONDS * 1000).toISOString()

  const { data: sessionRow, error: sessionError } = await supabase
    .from("external_portal_sessions")
    .insert({
      org_id: orgId,
      account_id: accountId,
      session_token_hash: sessionTokenHash,
      expires_at: expiresAt,
      last_seen_at: nowIso,
    })
    .select("id")
    .single()

  if (sessionError || !sessionRow) {
    throw new Error(`Failed to create account session: ${sessionError?.message}`)
  }

  await setExternalPortalSessionCookie(rawSessionToken)
}

function mapExternalAccountRow(row: any): ExternalPortalAccountRow {
  return {
    id: row.id,
    org_id: row.org_id,
    email: row.email,
    full_name: row.full_name ?? null,
    password_hash: row.password_hash,
    status: row.status,
    last_login_at: row.last_login_at ?? null,
    paused_at: row.paused_at ?? null,
    revoked_at: row.revoked_at ?? null,
    created_at: row.created_at,
  }
}

async function resolveTokenContext(tokenType: ExternalTokenType, token: string): Promise<ResolvedExternalTokenContext | null> {
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
      .eq("token", token)
      .maybeSingle()
    if (!data || data.revoked_at) return null
    const contact = Array.isArray(data.contact) ? data.contact[0] : data.contact
    const project = Array.isArray(data.project) ? data.project[0] : data.project
    const org = Array.isArray(data.org) ? data.org[0] : data.org
    return {
      tokenId: data.id as string,
      orgId: data.org_id as string,
      expectedEmail: contact?.email ?? null,
      suggestedFullName: contact?.full_name ?? null,
      projectName: project?.name ?? null,
      orgName: org?.name ?? null,
    }
  }

  const tokenHash = hashBidToken(token)
  const { data } = await supabase
    .from("bid_access_tokens")
    .select(
      `
      id, org_id, revoked_at,
      bid_invite:bid_invites!bid_access_tokens_org_invite_fk(
        invite_email,
        contact:contacts!bid_invites_org_contact_fk(full_name, email),
        bid_package:bid_packages(title, project:projects(name))
      ),
      org:orgs(name)
    `,
    )
    .eq("token_hash", tokenHash)
    .maybeSingle()
  if (!data || data.revoked_at) return null
  const invite = Array.isArray(data.bid_invite) ? data.bid_invite[0] : data.bid_invite
  const contact = Array.isArray(invite?.contact) ? invite.contact[0] : invite?.contact
  const bidPackage = Array.isArray(invite?.bid_package) ? invite.bid_package[0] : invite?.bid_package
  const project = Array.isArray(bidPackage?.project) ? bidPackage.project[0] : bidPackage?.project
  const org = Array.isArray(data.org) ? data.org[0] : data.org

  return {
    tokenId: data.id as string,
    orgId: data.org_id as string,
    expectedEmail: invite?.invite_email ?? contact?.email ?? null,
    suggestedFullName: contact?.full_name ?? null,
    projectName: project?.name ?? bidPackage?.title ?? null,
    orgName: org?.name ?? null,
  }
}

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
  let hasExistingAccount = false

  if (normalizedExpectedEmail) {
    const supabase = createServiceSupabaseClient()
    const { data } = await supabase
      .from("external_portal_accounts")
      .select("id")
      .eq("org_id", tokenContext.orgId)
      .ilike("email", normalizedExpectedEmail)
      .maybeSingle()
    hasExistingAccount = !!data
  }

  return {
    orgName: tokenContext.orgName ?? "the builder",
    projectName: tokenContext.projectName ?? "this project",
    expectedEmail: normalizedExpectedEmail,
    suggestedFullName: tokenContext.suggestedFullName ?? null,
    defaultMode: hasExistingAccount ? "login" : "claim",
    emailLocked: !!normalizedExpectedEmail,
    hasExistingAccount,
  }
}

async function findExternalSession(): Promise<ExternalPortalSession | null> {
  const store = await cookies()
  const rawToken = store.get(EXTERNAL_PORTAL_SESSION_COOKIE)?.value
  if (!rawToken) return null

  const sessionTokenHash = sha256(rawToken)
  const nowIso = new Date().toISOString()
  const supabase = createServiceSupabaseClient()

  const { data: sessionRow } = await supabase
    .from("external_portal_sessions")
    .select(
      `
      id,
      org_id,
      account_id,
      expires_at,
      revoked_at,
      account:external_portal_accounts!inner(
        id, org_id, email, full_name, status, last_login_at, paused_at, revoked_at, created_at
      )
    `,
    )
    .eq("session_token_hash", sessionTokenHash)
    .maybeSingle()

  if (!sessionRow) {
    await clearExternalPortalSessionCookie()
    return null
  }

  if (sessionRow.revoked_at || new Date(sessionRow.expires_at) <= new Date()) {
    await clearExternalPortalSessionCookie()
    return null
  }

  const account = mapExternalAccount(sessionRow.account)
  if (account.status !== "active") {
    await clearExternalPortalSessionCookie()
    return null
  }

  await supabase
    .from("external_portal_sessions")
    .update({ last_seen_at: nowIso })
    .eq("id", sessionRow.id)

  return {
    id: sessionRow.id as string,
    org_id: sessionRow.org_id as string,
    account,
  }
}

export async function getCurrentExternalPortalSession() {
  return findExternalSession()
}

export async function hasExternalPortalGrantForToken({
  orgId,
  tokenId,
  tokenType,
}: {
  orgId: string
  tokenId: string
  tokenType: ExternalTokenType
}) {
  const session = await findExternalSession()
  if (!session || session.org_id !== orgId) return false

  const supabase = createServiceSupabaseClient()
  let query = supabase
    .from("external_portal_account_grants")
    .select("id")
    .eq("org_id", orgId)
    .eq("account_id", session.account.id)
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

export async function signInExternalPortalAccount({
  email,
  password,
}: {
  email: string
  password: string
}) {
  const normalizedEmail = email.trim().toLowerCase()
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("external_portal_accounts")
    .select("id, org_id, email, full_name, password_hash, status, last_login_at, paused_at, revoked_at, created_at")
    .ilike("email", normalizedEmail)
    .order("last_login_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Unable to sign in: ${error.message}`)
  }

  const candidates = (data ?? []).map(mapExternalAccountRow)
  if (candidates.length === 0) {
    throw new Error("Account not found for this email")
  }

  let matchedAccount: ExternalPortalAccountRow | null = null
  let matchedPausedAccount = false

  for (const account of candidates) {
    const validPassword = await compare(password, account.password_hash)
    if (!validPassword) continue
    if (account.status === "active") {
      matchedAccount = account
      break
    }
    matchedPausedAccount = true
  }

  if (!matchedAccount) {
    if (matchedPausedAccount) {
      throw new Error("This account is paused or revoked. Contact the builder.")
    }
    throw new Error("Invalid email or password")
  }

  await touchExternalPortalAccountLogin(matchedAccount.id)
  await createExternalPortalSession({
    accountId: matchedAccount.id,
    orgId: matchedAccount.org_id,
  })
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
  const supabase = createServiceSupabaseClient()
  const { data: existing } = await supabase
    .from("external_portal_accounts")
    .select("id, org_id, email, full_name, password_hash, status, last_login_at, paused_at, revoked_at, created_at")
    .eq("org_id", tokenContext.orgId)
    .ilike("email", lookupEmail)
    .maybeSingle()

  let accountId = existing?.id as string | undefined

  if (mode === "claim") {
    if (!existing) {
      const passwordHash = await hash(password, PASSWORD_SALT_ROUNDS)
      const { data: created, error } = await supabase
        .from("external_portal_accounts")
        .insert({
          org_id: tokenContext.orgId,
          email: lookupEmail,
          full_name: fullName?.trim() || null,
          password_hash: passwordHash,
          status: "active",
        })
        .select("id")
        .single()
      if (error || !created) {
        throw new Error(`Unable to create account: ${error?.message}`)
      }
      accountId = created.id as string
    } else {
      const validPassword = await compare(password, existing.password_hash as string)
      if (!validPassword) {
        throw new Error("Incorrect password for this email")
      }
      accountId = existing.id as string
      if (!existing.full_name && fullName?.trim()) {
        await supabase
          .from("external_portal_accounts")
          .update({ full_name: fullName.trim() })
          .eq("id", accountId)
      }
    }
  } else {
    if (!existing) {
      throw new Error("Account not found for this email")
    }
    const validPassword = await compare(password, existing.password_hash as string)
    if (!validPassword) {
      throw new Error("Invalid email or password")
    }
    accountId = existing.id as string
  }

  if (!accountId) {
    throw new Error("Unable to authenticate account")
  }

  const accountStatus = existing?.status ?? "active"
  if (accountStatus !== "active") {
    throw new Error("This account is paused or revoked. Contact the builder.")
  }

  let grantQuery = supabase
    .from("external_portal_account_grants")
    .select("id, status")
    .eq("org_id", tokenContext.orgId)
    .eq("account_id", accountId)

  grantQuery =
    tokenType === "portal"
      ? grantQuery.eq("portal_access_token_id", tokenContext.tokenId)
      : grantQuery.eq("bid_access_token_id", tokenContext.tokenId)

  const { data: existingGrant } = await grantQuery.maybeSingle()

  if (existingGrant) {
    if (existingGrant.status !== "active") {
      await supabase
        .from("external_portal_account_grants")
        .update({
          status: "active",
          paused_at: null,
          revoked_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingGrant.id)
    }
  } else {
    const grantPayload: Record<string, any> = {
      org_id: tokenContext.orgId,
      account_id: accountId,
      status: "active",
    }
    if (tokenType === "portal") {
      grantPayload.portal_access_token_id = tokenContext.tokenId
    } else {
      grantPayload.bid_access_token_id = tokenContext.tokenId
    }
    const { error: grantError } = await supabase.from("external_portal_account_grants").insert(grantPayload)
    if (grantError) {
      throw new Error(`Failed to grant account access: ${grantError.message}`)
    }
  }

  await touchExternalPortalAccountLogin(accountId)
  await createExternalPortalSession({
    accountId,
    orgId: tokenContext.orgId,
  })
}

export async function signOutExternalPortalAccount() {
  const store = await cookies()
  const rawToken = store.get(EXTERNAL_PORTAL_SESSION_COOKIE)?.value

  if (rawToken) {
    const supabase = createServiceSupabaseClient()
    const sessionTokenHash = sha256(rawToken)
    await supabase
      .from("external_portal_sessions")
      .update({ revoked_at: new Date().toISOString() })
      .eq("session_token_hash", sessionTokenHash)
      .is("revoked_at", null)
  }

  await clearExternalPortalSessionCookie()
}

export async function getExternalPortalWorkspaceContext({
  orgId,
}: {
  orgId?: string
} = {}): Promise<ExternalPortalWorkspaceContext | null> {
  const session = await findExternalSession()
  if (!session) return null
  if (orgId && session.org_id !== orgId) return null

  const supabase = createServiceSupabaseClient()

  const [{ data: orgRow }, { data: portalGrantRows, error: portalError }, { data: bidGrantRows, error: bidError }] =
    await Promise.all([
      supabase.from("orgs").select("id, name").eq("id", session.org_id).maybeSingle(),
      supabase
        .from("external_portal_account_grants")
        .select(
          `
          id,
          token:portal_access_tokens!inner(
            id, token, portal_type, expires_at, max_access_count, access_count, last_accessed_at, pin_required, paused_at, revoked_at,
            project:projects(id, name, status, address),
            company:companies(id, name),
            contact:contacts(id, full_name, email)
          )
        `,
        )
        .eq("org_id", session.org_id)
        .eq("account_id", session.account.id)
        .eq("status", "active")
        .is("paused_at", null)
        .is("revoked_at", null)
        .not("portal_access_token_id", "is", null),
      supabase
        .from("external_portal_account_grants")
        .select(
          `
          id,
          token:bid_access_tokens!inner(
            id, expires_at, max_access_count, access_count, last_accessed_at, pin_required, paused_at, revoked_at,
            bid_invite:bid_invites!bid_access_tokens_org_invite_fk(
              id,
              invite_email,
              company:companies!bid_invites_org_company_fk(id, name),
              contact:contacts!bid_invites_org_contact_fk(id, full_name, email),
              bid_package:bid_packages(id, title, due_at, status, project:projects(id, name, status, address))
            )
          )
        `,
        )
        .eq("org_id", session.org_id)
        .eq("account_id", session.account.id)
        .eq("status", "active")
        .is("paused_at", null)
        .is("revoked_at", null)
        .not("bid_access_token_id", "is", null),
    ])

  if (portalError) {
    throw new Error(`Failed to load external portal workspace: ${portalError.message}`)
  }

  if (bidError) {
    throw new Error(`Failed to load bid workspace access: ${bidError.message}`)
  }

  const now = new Date()
  const items: ExternalPortalWorkspaceItem[] = []

  for (const row of portalGrantRows ?? []) {
    const token = (row as any).token
    const resolvedToken = Array.isArray(token) ? token[0] : token
    const project = Array.isArray(resolvedToken?.project) ? resolvedToken.project[0] : resolvedToken?.project
    const company = Array.isArray(resolvedToken?.company) ? resolvedToken.company[0] : resolvedToken?.company
    const contact = Array.isArray(resolvedToken?.contact) ? resolvedToken.contact[0] : resolvedToken?.contact

    if (!resolvedToken?.token || !project) continue
    if (resolvedToken.revoked_at || resolvedToken.paused_at) continue
    if (resolvedToken.expires_at && new Date(resolvedToken.expires_at) <= now) continue
    if (resolvedToken.max_access_count && resolvedToken.access_count >= resolvedToken.max_access_count) continue

    const kind = resolvedToken.portal_type === "sub" ? "sub" : "client"
    const contactName = contact?.full_name ?? contact?.email ?? null
    const subtitle =
      kind === "sub"
        ? company?.name
          ? `Sub portal for ${company.name}`
          : "Sub portal"
        : contactName
          ? `Client portal for ${contactName}`
          : "Client portal"

    items.push({
      id: row.id,
      token_id: resolvedToken.id,
      href: kind === "sub" ? `/s/${resolvedToken.token}` : `/p/${resolvedToken.token}`,
      kind,
      label: kind === "sub" ? "Sub portal" : "Client portal",
      subtitle,
      org_id: session.org_id,
      org_name: orgRow?.name ?? "Arc",
      project_id: project.id,
      project_name: project.name,
      project_status: normalizeWorkspaceProjectStatus(project.status),
      project_address: project.address ?? null,
      company_name: company?.name ?? null,
      contact_name: contactName,
      last_accessed_at: resolvedToken.last_accessed_at ?? null,
    })
  }

  for (const row of bidGrantRows ?? []) {
    const token = (row as any).token
    const resolvedToken = Array.isArray(token) ? token[0] : token
    const invite = Array.isArray(resolvedToken?.bid_invite) ? resolvedToken.bid_invite[0] : resolvedToken?.bid_invite
    const company = Array.isArray(invite?.company) ? invite.company[0] : invite?.company
    const contact = Array.isArray(invite?.contact) ? invite.contact[0] : invite?.contact
    const bidPackage = Array.isArray(invite?.bid_package) ? invite.bid_package[0] : invite?.bid_package
    const project = Array.isArray(bidPackage?.project) ? bidPackage.project[0] : bidPackage?.project

    if (!resolvedToken?.id || !bidPackage || !project) continue
    if (resolvedToken.revoked_at || resolvedToken.paused_at) continue
    if (resolvedToken.expires_at && new Date(resolvedToken.expires_at) <= now) continue
    if (resolvedToken.max_access_count && resolvedToken.access_count >= resolvedToken.max_access_count) continue

    const inviteLabel = company?.name ?? contact?.full_name ?? invite?.invite_email ?? "Bid invite"

    items.push({
      id: row.id,
      token_id: resolvedToken.id,
      href: `/b/grant_${row.id}`,
      kind: "bid",
      label: "Bid portal",
      subtitle: `${bidPackage.title} for ${inviteLabel}`,
      org_id: session.org_id,
      org_name: orgRow?.name ?? "Arc",
      project_id: project.id,
      project_name: project.name,
      project_status: normalizeWorkspaceProjectStatus(project.status),
      project_address: project.address ?? null,
      company_name: company?.name ?? null,
      contact_name: contact?.full_name ?? contact?.email ?? null,
      due_at: bidPackage.due_at ?? null,
      last_accessed_at: resolvedToken.last_accessed_at ?? null,
    })
  }

  items.sort(sortWorkspaceItems)

  return {
    account: {
      id: session.account.id,
      email: session.account.email,
      full_name: session.account.full_name ?? null,
      last_login_at: session.account.last_login_at ?? null,
    },
    org: {
      id: session.org_id,
      name: orgRow?.name ?? "Arc",
    },
    items,
  }
}

export async function listProjectExternalPortalAccounts(projectId: string, orgId?: string): Promise<ExternalPortalAccount[]> {
  const { orgId: resolvedOrgId, supabase, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })
  const serviceClient = createServiceSupabaseClient()

  const { data, error } = await serviceClient
    .from("external_portal_account_grants")
    .select(
      `
      status,
      account:external_portal_accounts!inner(
        id, org_id, email, full_name, status, last_login_at, paused_at, revoked_at, created_at
      ),
      token:portal_access_tokens!inner(id, project_id)
    `,
    )
    .eq("org_id", resolvedOrgId)
    .eq("token.project_id", projectId)

  if (error) {
    throw new Error(`Failed to list external portal accounts: ${error.message}`)
  }

  const byAccountId = new Map<string, ExternalPortalAccount>()
  for (const row of data ?? []) {
    const account = mapExternalAccount((row as any).account)
    const existing = byAccountId.get(account.id)
    if (!existing) {
      byAccountId.set(account.id, { ...account, grant_count: 1 })
    } else {
      existing.grant_count = (existing.grant_count ?? 0) + 1
    }
  }

  return Array.from(byAccountId.values()).sort((a, b) => a.email.localeCompare(b.email))
}

export async function setExternalPortalAccountStatus({
  accountId,
  status,
  orgId,
}: {
  accountId: string
  status: "active" | "paused" | "revoked"
  orgId?: string
}) {
  const { orgId: resolvedOrgId, supabase, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })
  const serviceClient = createServiceSupabaseClient()
  const nowIso = new Date().toISOString()

  const patch: Record<string, any> = {
    status,
    updated_at: nowIso,
    paused_at: status === "paused" ? nowIso : null,
    revoked_at: status === "revoked" ? nowIso : null,
  }

  const { error } = await serviceClient
    .from("external_portal_accounts")
    .update(patch)
    .eq("org_id", resolvedOrgId)
    .eq("id", accountId)

  if (error) {
    throw new Error(`Failed to update external portal account status: ${error.message}`)
  }

  if (status !== "active") {
    await serviceClient
      .from("external_portal_sessions")
      .update({ revoked_at: nowIso })
      .eq("org_id", resolvedOrgId)
      .eq("account_id", accountId)
      .is("revoked_at", null)
  }
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
  const patch: Record<string, any> = {
    status,
    updated_at: nowIso,
    paused_at: status === "paused" ? nowIso : null,
    revoked_at: status === "revoked" ? nowIso : null,
  }

  const { error } = await serviceClient
    .from("external_portal_account_grants")
    .update(patch)
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
