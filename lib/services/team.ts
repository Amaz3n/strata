import type { SupabaseClient } from "@supabase/supabase-js"

import { randomBytes } from "node:crypto"

import type { MemberPermissionOverride, PermissionOption, TeamMember, OrgRole, OrgRoleOption } from "@/lib/types"
import {
  inviteMemberSchema,
  memberStatusSchema,
  updateMemberLaborSettingsSchema,
  updateMemberRoleSchema,
  type InviteMemberInput,
  type UpdateMemberLaborSettingsInput,
} from "@/lib/validation/team"
import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordEvent } from "@/lib/services/events"
import { recordAudit } from "@/lib/services/audit"
import { sendInviteEmail } from "@/lib/services/mailer"
import { authorize, requireAuthorization } from "@/lib/services/authorization"

async function resolveRoleId(client: SupabaseClient, role: OrgRole) {
  const { data, error } = await client.from("roles").select("id").eq("scope", "org").eq("key", role).maybeSingle()
  if (error || !data?.id) {
    throw new Error(`Role ${role} not found`)
  }
  return data.id as string
}

function normalizeRoleLabel(label: string | null | undefined, roleKey: string) {
  const candidate = (label ?? "")
    .replace(/^org[\s_-]+/i, "")
    .trim()
  if (candidate) return candidate
  return roleKey
    .replace(/^org_/, "")
    .split("_")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ")
}

function defaultRoleDescription(roleKey: string) {
  const descriptions: Record<string, string> = {
    org_admin: "Full company access, including settings, billing, team, all projects, approvals, and financial workflows.",
    org_user: "Internal team member. Access is scoped by project assignments and optional permission overrides.",
  }

  return descriptions[roleKey]
}

export const TEAM_PERMISSION_OPTIONS: PermissionOption[] = [
  { key: "project.create", label: "Create projects", category: "Project Access" },
  { key: "project.archive", label: "Archive projects", category: "Project Access" },
  { key: "project.settings.update", label: "Manage project settings", category: "Project Access" },
  { key: "docs.share", label: "Share documents", category: "Documents & Sharing" },
  { key: "docs.delete", label: "Delete documents", category: "Documents & Sharing" },
  { key: "portal.access.manage", label: "Manage client/sub access", category: "Documents & Sharing" },
  { key: "drawing.upload", label: "Upload drawings", category: "Field Operations" },
  { key: "schedule.publish", label: "Publish schedule", category: "Field Operations" },
  { key: "daily_log.approve", label: "Approve daily logs", category: "Field Operations" },
  { key: "rfi.close", label: "Close RFIs", category: "Field Operations" },
  { key: "submittal.review", label: "Review submittals", category: "Field Operations" },
  { key: "submittal.approve", label: "Approve submittals", category: "Field Operations" },
  { key: "punch.close", label: "Close punch items", category: "Field Operations" },
  { key: "budget.read", label: "View budgets", category: "Financials" },
  { key: "budget.write", label: "Edit budgets", category: "Financials" },
  { key: "commitment.read", label: "View commitments", category: "Financials" },
  { key: "commitment.write", label: "Manage commitments", category: "Financials" },
  { key: "commitment.approve", label: "Approve commitments", category: "Financials" },
  { key: "change_order.approve", label: "Approve change orders", category: "Financials" },
  { key: "invoice.read", label: "View invoices", category: "Financials" },
  { key: "invoice.write", label: "Create/edit invoices", category: "Financials" },
  { key: "invoice.approve", label: "Approve invoices", category: "Financials" },
  { key: "invoice.send", label: "Send invoices", category: "Financials" },
  { key: "bill.read", label: "View bills/payables", category: "Financials" },
  { key: "bill.write", label: "Create/edit bills", category: "Financials" },
  { key: "bill.approve", label: "Approve bills", category: "Financials" },
  { key: "payment.release", label: "Release payments", category: "Financials" },
  { key: "draw.approve", label: "Approve draws", category: "Financials" },
  { key: "retainage.manage", label: "Manage retainage", category: "Financials" },
  { key: "pipeline.read", label: "View pipeline", category: "Business Ops" },
  { key: "pipeline.write", label: "Manage pipeline", category: "Business Ops" },
  { key: "directory.write", label: "Manage directory", category: "Business Ops" },
  { key: "bid.read", label: "View bids", category: "Business Ops" },
  { key: "bid.write", label: "Manage bids", category: "Business Ops" },
  { key: "proposal.read", label: "View proposals", category: "Business Ops" },
  { key: "proposal.write", label: "Manage proposals", category: "Business Ops" },
  { key: "signature.read", label: "View signatures", category: "Business Ops" },
  { key: "signature.send", label: "Send signatures", category: "Business Ops" },
  { key: "report.read", label: "View reports", category: "Business Ops" },
]

const CUSTOMIZABLE_PERMISSION_KEYS = new Set(TEAM_PERMISSION_OPTIONS.map((option) => option.key))

export async function listAssignableOrgRoles(orgId?: string): Promise<OrgRoleOption[]> {
  const { orgId: resolvedOrgId, userId, supabase } = await requireOrgContext(orgId)
  const adminDecision = await authorize({
    permission: "org.admin",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "org",
    resourceId: resolvedOrgId,
  })

  if (!adminDecision.allowed) {
    await requireAuthorization({
      permission: "members.manage",
      userId,
      orgId: resolvedOrgId,
      supabase,
      logDecision: true,
      resourceType: "org",
      resourceId: resolvedOrgId,
    })
  }

  const serviceClient = createServiceSupabaseClient()
  const { data, error } = await serviceClient
    .from("roles")
    .select("key, label, description")
    .eq("scope", "org")
    .order("label", { ascending: true })

  if (error) {
    throw new Error(`Failed to load assignable org roles: ${error.message}`)
  }

  const allowedRoleKeys = new Set(["org_admin", "org_user"])
  const options = (data ?? [])
    .filter((row: any) => typeof row?.key === "string" && allowedRoleKeys.has(row.key))
    .map((row: any) => ({
      key: row.key as string,
      label: normalizeRoleLabel((row.label as string | null) ?? null, row.key as string),
      description: ((row.description as string | null) ?? undefined) ?? defaultRoleDescription(row.key as string),
    }))

  if (options.length > 0) {
    return Array.from(allowedRoleKeys)
      .map((key) => options.find((option) => option.key === key))
      .filter((option) => option != null) as OrgRoleOption[]
  }

  return [
    {
      key: "org_admin",
      label: "Admin",
      description: defaultRoleDescription("org_admin"),
    },
    { key: "org_user", label: "User", description: defaultRoleDescription("org_user") },
  ]
}

function getAuthRedirectBaseUrl() {
  const url =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.APP_URL ||
    process.env.VERCEL_URL ||
    "http://localhost:3000"

  if (url.startsWith("http")) return url.replace(/\/$/, "")
  return `https://${url}`.replace(/\/$/, "")
}

function generateInviteToken() {
  return randomBytes(32).toString("base64url")
}

function getInviteLink(token: string) {
  const baseUrl = getAuthRedirectBaseUrl()
  return `${baseUrl}/auth/accept-invite?token=${token}`
}

// Token expires in 7 days
function getInviteTokenExpiry() {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
}

async function mapProjectCounts(supabase: SupabaseClient, orgId: string) {
  const { data, error } = await supabase.from("project_members").select("user_id").eq("org_id", orgId)
  if (error) {
    console.error("Failed to load project membership counts", error)
    return {}
  }

  return (data ?? []).reduce<Record<string, number>>((acc, row) => {
    if (!row.user_id) return acc
    acc[row.user_id] = (acc[row.user_id] ?? 0) + 1
    return acc
  }, {})
}

export async function createOrgMemberInvite(input: {
  supabase: SupabaseClient
  orgId: string
  actorUserId: string
  email: string
  role: OrgRole
  fullName?: string | null
  sendEmail?: boolean
}) {
  const email = input.email.trim().toLowerCase()
  const { data: existingUser } = await input.supabase
    .from("app_users")
    .select("id, email, full_name, avatar_url")
    .ilike("email", email)
    .maybeSingle()

  let targetUserId = existingUser?.id as string | undefined
  if (!targetUserId) {
    const result = await createUserForInvite(input.supabase, email)
    targetUserId = result.userId
  }

  if (!targetUserId) {
    throw new Error(`Unable to resolve invited user id for ${email}`)
  }

  const { error: profileError } = await input.supabase.from("app_users").upsert({
    id: targetUserId,
    email,
    full_name: existingUser?.full_name ?? input.fullName?.trim() ?? null,
  })

  if (profileError) {
    throw new Error(`Failed to create invited user profile for ${email}: ${profileError.message}`)
  }

  const roleId = await resolveRoleId(input.supabase, input.role)
  const inviteToken = generateInviteToken()
  const inviteTokenExpiresAt = getInviteTokenExpiry()

  const { data, error } = await input.supabase
    .from("memberships")
    .upsert({
      org_id: input.orgId,
      user_id: targetUserId,
      role_id: roleId,
      status: "invited",
      invited_by: input.actorUserId,
      invite_token: inviteToken,
      invite_token_expires_at: inviteTokenExpiresAt.toISOString(),
    })
    .select(
      `
      id, org_id, user_id, role_id, status, last_active_at, created_at, invited_by,
      user:app_users!memberships_user_id_fkey(id, email, full_name, avatar_url),
      role:roles!memberships_role_id_fkey(key, label),
      invited_by_user:app_users!memberships_invited_by_fkey(id, email, full_name, avatar_url)
    `,
    )
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Failed to create membership for ${email}: ${error?.message}`)
  }

  if (input.sendEmail !== false) {
    const orgBrand = await getOrgBrand(input.supabase, input.orgId)
    const inviteLink = getInviteLink(inviteToken)
    const inviter = data.invited_by_user as { full_name?: string | null; email?: string | null } | null
    await sendInviteEmail({
      to: email,
      inviteLink,
      orgName: orgBrand.name,
      orgLogoUrl: orgBrand.logoUrl,
      inviterName: inviter?.full_name ?? null,
      inviterEmail: inviter?.email ?? null,
    })
  }

  return data
}

async function mapMfaEnabledByUser(serviceClient: SupabaseClient, userIds: string[]) {
  if (userIds.length === 0) return {}
  const output: Record<string, boolean> = {}

  await Promise.all(
    userIds.map(async (memberUserId) => {
      const { data, error } = await serviceClient.auth.admin.mfa.listFactors({ userId: memberUserId })
      if (error) {
        console.error("Failed to load member MFA factors", { memberUserId, error })
        output[memberUserId] = false
        return
      }

      output[memberUserId] = (data.factors ?? []).some((factor) => factor.status === "verified")
    }),
  )

  return output
}

async function mapPermissionOverrides(serviceClient: SupabaseClient, membershipIds: string[]) {
  if (membershipIds.length === 0) return {}

  const { data, error } = await serviceClient
    .from("membership_permission_overrides")
    .select("membership_id, permission_key, effect")
    .in("membership_id", membershipIds)

  if (error) {
    const message = String(error.message ?? "")
    if (message.includes("membership_permission_overrides")) {
      return {}
    }
    throw new Error(`Failed to load permission overrides: ${error.message}`)
  }

  return (data ?? []).reduce<Record<string, MemberPermissionOverride[]>>((acc, row: any) => {
    if (!row.membership_id || !CUSTOMIZABLE_PERMISSION_KEYS.has(row.permission_key)) return acc
    acc[row.membership_id] = acc[row.membership_id] ?? []
    acc[row.membership_id].push({ permission_key: row.permission_key, effect: row.effect })
    return acc
  }, {})
}

function normalizePermissionOverrides(input: MemberPermissionOverride[] | undefined) {
  const byKey = new Map<string, MemberPermissionOverride>()
  for (const override of input ?? []) {
    if (!CUSTOMIZABLE_PERMISSION_KEYS.has(override.permission_key)) continue
    if (override.effect !== "grant" && override.effect !== "deny") continue
    byKey.set(override.permission_key, override)
  }
  return Array.from(byKey.values())
}

async function replacePermissionOverrides(
  client: SupabaseClient,
  membershipId: string,
  overrides: MemberPermissionOverride[] | undefined,
) {
  const normalized = normalizePermissionOverrides(overrides)
  const { error: deleteError } = await client
    .from("membership_permission_overrides")
    .delete()
    .eq("membership_id", membershipId)

  if (deleteError) {
    const message = String(deleteError.message ?? "")
    if (!message.includes("membership_permission_overrides")) {
      throw new Error(`Failed to clear permission overrides: ${deleteError.message}`)
    }
  }

  if (normalized.length === 0) return []

  const { data, error } = await client
    .from("membership_permission_overrides")
    .insert(normalized.map((override) => ({ membership_id: membershipId, ...override })))
    .select("permission_key, effect")

  if (error) {
    throw new Error(`Failed to save permission overrides: ${error.message}`)
  }

  return (data ?? []) as MemberPermissionOverride[]
}

function generateTempPassword() {
  return randomBytes(12).toString("base64url").slice(0, 16)
}

function shouldBypassInviteRateLimit(message: string) {
  return process.env.NODE_ENV === "development" && /rate limit/i.test(message)
}

async function getOrgBrand(client: SupabaseClient, orgId: string) {
  const { data, error } = await client.from("orgs").select("name, logo_url").eq("id", orgId).maybeSingle()
  if (error) {
    console.error("Failed to load org brand", error)
    return { name: null, logoUrl: null }
  }
  return { name: data?.name ?? null, logoUrl: data?.logo_url ?? null }
}

async function createUserForInvite(client: SupabaseClient, email: string) {
  // Create user with a temporary password - they'll set their real password when accepting
  const tempPassword = generateTempPassword()
  const { data, error } = await client.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true, // Skip email confirmation since we're handling invite flow ourselves
  })
  if (error) {
    // User might already exist
    if (error.message.includes("already been registered")) {
      const { data: existingUser } = await client
        .from("app_users")
        .select("id")
        .ilike("email", email)
        .maybeSingle()
      return { userId: existingUser?.id as string | undefined, isExisting: true }
    }
    throw new Error(error.message)
  }
  return { userId: data?.user?.id, isExisting: false }
}

function mapTeamMember(
  row: any,
  projectCounts: Record<string, number>,
  mfaEnabledByUser: Record<string, boolean>,
  permissionOverridesByMembership: Record<string, MemberPermissionOverride[]> = {},
): TeamMember {
  const user = row.user || row.users
  const invitedBy = row.invited_by_user || row.invited_by
  const roleKey = row.role?.key ?? "org_project_lead"

  return {
    id: row.id,
    user: {
      id: user?.id,
      email: user?.email,
      full_name: user?.full_name ?? user?.email ?? "Unknown",
      avatar_url: user?.avatar_url ?? undefined,
    },
    role: roleKey,
    role_label: normalizeRoleLabel((row.role?.label as string | null) ?? null, roleKey),
    permission_overrides: permissionOverridesByMembership[row.id] ?? [],
    status: row.status ?? "invited",
    labor_cost_rate_cents: row.labor_cost_rate_cents ?? 0,
    labor_bill_rate_cents: row.labor_bill_rate_cents ?? 0,
    labor_burden_multiplier: Number(row.labor_burden_multiplier ?? 1),
    labor_is_billable_default: row.labor_is_billable_default ?? true,
    mfa_enabled: Boolean(user?.id ? mfaEnabledByUser[user.id] : false),
    project_count: projectCounts[user?.id] ?? 0,
    last_active_at: row.last_active_at ?? undefined,
    invited_by: invitedBy
      ? {
          id: invitedBy.id,
          email: invitedBy.email,
          full_name: invitedBy.full_name ?? invitedBy.email ?? "Unknown",
          avatar_url: invitedBy.avatar_url ?? undefined,
        }
      : undefined,
    created_at: row.created_at,
  }
}

export async function listTeamMembers(
  orgId?: string,
  options?: { includeProjectCounts?: boolean },
): Promise<TeamMember[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const memberDecision = await authorize({
    permission: "org.member",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "org",
    resourceId: resolvedOrgId,
  })
  if (!memberDecision.allowed) {
    await requireAuthorization({
      permission: "org.read",
      userId,
      orgId: resolvedOrgId,
      supabase,
      logDecision: true,
      resourceType: "org",
      resourceId: resolvedOrgId,
    })
  }
  const serviceClient = createServiceSupabaseClient()
  const includeProjectCounts = options?.includeProjectCounts ?? true
  const projectCounts = includeProjectCounts ? await mapProjectCounts(serviceClient, resolvedOrgId) : {}

  const { data, error } = await serviceClient
    .from("memberships")
    .select(
      `
      id, org_id, user_id, role_id, status, last_active_at, created_at, invited_by,
      labor_cost_rate_cents, labor_bill_rate_cents, labor_burden_multiplier, labor_is_billable_default,
      user:app_users!memberships_user_id_fkey(id, email, full_name, avatar_url),
      role:roles!memberships_role_id_fkey(key, label),
      invited_by_user:app_users!memberships_invited_by_fkey(id, email, full_name, avatar_url)
    `,
    )
    .eq("org_id", resolvedOrgId)
    .order("created_at", { ascending: true })

  if (error) {
    throw new Error(`Failed to list team members: ${error.message}`)
  }

  const userIds = (data ?? [])
    .map((row: any) => {
      const user = row.user || row.users
      return user?.id as string | undefined
    })
    .filter((id: string | undefined): id is string => Boolean(id))
  const mfaEnabledByUser = await mapMfaEnabledByUser(serviceClient, userIds)
  const membershipIds = (data ?? []).map((row: any) => row.id).filter(Boolean)
  const permissionOverridesByMembership = await mapPermissionOverrides(serviceClient, membershipIds)

  return (data ?? []).map((row) => mapTeamMember(row, projectCounts, mfaEnabledByUser, permissionOverridesByMembership))
}

export async function updateMemberLaborSettings({
  membershipId,
  input,
  orgId,
}: {
  membershipId: string
  input: UpdateMemberLaborSettingsInput
  orgId?: string
}) {
  const parsed = updateMemberLaborSettingsSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "members.manage",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "membership",
    resourceId: membershipId,
  })

  const serviceClient = createServiceSupabaseClient()
  const { data: before, error: beforeError } = await serviceClient
    .from("memberships")
    .select("id, org_id, user_id, labor_cost_rate_cents, labor_bill_rate_cents, labor_burden_multiplier, labor_is_billable_default")
    .eq("org_id", resolvedOrgId)
    .eq("id", membershipId)
    .maybeSingle()

  if (beforeError || !before) {
    throw new Error("Membership not found")
  }

  const { data, error } = await serviceClient
    .from("memberships")
    .update(parsed)
    .eq("org_id", resolvedOrgId)
    .eq("id", membershipId)
    .select("id, org_id, user_id, labor_cost_rate_cents, labor_bill_rate_cents, labor_burden_multiplier, labor_is_billable_default")
    .single()

  if (error || !data) {
    throw new Error(`Failed to update labor settings: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "membership",
    entityId: membershipId,
    before,
    after: data,
  })

  return data
}

export async function updateMemberProfile({
  userId: targetUserId,
  fullName,
  orgId,
}: {
  userId: string
  fullName: string
  orgId?: string
}) {
  const normalizedName = fullName.trim()
  if (!normalizedName) {
    throw new Error("Name is required")
  }

  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "members.manage",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "app_user",
    resourceId: targetUserId,
  })

  const serviceClient = createServiceSupabaseClient()

  const { data: membership, error: membershipError } = await serviceClient
    .from("memberships")
    .select("id, org_id, user_id")
    .eq("org_id", resolvedOrgId)
    .eq("user_id", targetUserId)
    .maybeSingle()

  if (membershipError || !membership) {
    throw new Error("Membership not found")
  }

  const { data: existingUser } = await serviceClient
    .from("app_users")
    .select("id, full_name, email, avatar_url")
    .eq("id", targetUserId)
    .maybeSingle()

  const { data, error } = await serviceClient
    .from("app_users")
    .update({ full_name: normalizedName })
    .eq("id", targetUserId)
    .select("id, full_name, email, avatar_url")
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Failed to update member profile: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "app_user",
    entityId: data.id as string,
    before: existingUser,
    after: data,
  })

  return data
}

export async function inviteTeamMember({
  input,
  orgId,
}: {
  input: InviteMemberInput
  orgId?: string
}): Promise<TeamMember & { tempPassword?: string }> {
  const parsed = inviteMemberSchema.parse(input)
  const { orgId: resolvedOrgId, userId, supabase } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "members.manage",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "org",
    resourceId: resolvedOrgId,
  })
  const serviceClient = createServiceSupabaseClient()

  const { data: existingUser } = await serviceClient
    .from("app_users")
    .select("id, email, full_name, avatar_url")
    .ilike("email", parsed.email)
    .maybeSingle()

  let targetUserId = existingUser?.id as string | undefined

  // Create user if they don't exist
  if (!targetUserId) {
    const result = await createUserForInvite(serviceClient, parsed.email)
    targetUserId = result.userId
  }

  if (!targetUserId) {
    throw new Error("Unable to resolve invited user id")
  }

  const { error: profileError } = await serviceClient
    .from("app_users")
    .upsert({
      id: targetUserId,
      email: parsed.email,
      full_name: existingUser?.full_name ?? null,
    })

  if (profileError) {
    console.error("Failed to create user profile for invite", profileError)
    throw new Error("Failed to create invited user profile")
  }

  const roleId = await resolveRoleId(serviceClient, parsed.role)

  // Generate invite token
  const inviteToken = generateInviteToken()
  const inviteTokenExpiresAt = getInviteTokenExpiry()

  const { data, error } = await serviceClient
    .from("memberships")
    .upsert({
      org_id: resolvedOrgId,
      user_id: targetUserId,
      role_id: roleId,
      status: "invited",
      invited_by: userId,
      invite_token: inviteToken,
      invite_token_expires_at: inviteTokenExpiresAt.toISOString(),
    })
    .select(
      `
      id, org_id, user_id, role_id, status, last_active_at, created_at, invited_by,
      user:app_users!memberships_user_id_fkey(id, email, full_name, avatar_url),
      role:roles!memberships_role_id_fkey(key, label),
      invited_by_user:app_users!memberships_invited_by_fkey(id, email, full_name, avatar_url)
    `,
    )
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Failed to create membership: ${error?.message}`)
  }

  const savedOverrides = await replacePermissionOverrides(serviceClient, data.id as string, parsed.permissionOverrides)

  // Send invite email with our token-based link
  const orgBrand = await getOrgBrand(serviceClient, resolvedOrgId)
  const inviteLink = getInviteLink(inviteToken)
  const inviter = data.invited_by_user as { full_name?: string | null; email?: string | null } | null
  await sendInviteEmail({
    to: parsed.email,
    inviteLink,
    orgName: orgBrand.name,
    orgLogoUrl: orgBrand.logoUrl,
    inviterName: inviter?.full_name ?? null,
    inviterEmail: inviter?.email ?? null,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "team_member_invited",
    entityType: "membership",
    entityId: data.id as string,
    payload: { email: parsed.email, role: parsed.role },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "membership",
    entityId: data.id as string,
    after: data,
  })

  const projectCounts = await mapProjectCounts(serviceClient, resolvedOrgId)
  const selectedUser = Array.isArray((data as any).user) ? (data as any).user[0] : (data as any).user
  const mfaEnabledByUser = await mapMfaEnabledByUser(serviceClient, [selectedUser?.id].filter(Boolean))
  return mapTeamMember(data, projectCounts, mfaEnabledByUser, { [data.id as string]: savedOverrides })
}

export async function updateMemberRole({
  membershipId,
  role,
  permissionOverrides,
  orgId,
}: {
  membershipId: string
  role: OrgRole
  permissionOverrides?: MemberPermissionOverride[]
  orgId?: string
}) {
  const parsed = updateMemberRoleSchema.parse({ role, permissionOverrides })
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "org.admin",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "membership",
    resourceId: membershipId,
  })
  const serviceClient = createServiceSupabaseClient()
  const roleId = await resolveRoleId(serviceClient, parsed.role)

  const { data: existing, error: fetchError } = await supabase
    .from("memberships")
    .select("id, org_id, user_id, role_id, status, created_at")
    .eq("org_id", resolvedOrgId)
    .eq("id", membershipId)
    .maybeSingle()

  if (fetchError || !existing) {
    throw new Error("Membership not found")
  }

  const { data, error } = await supabase
    .from("memberships")
    .update({ role_id: roleId })
    .eq("org_id", resolvedOrgId)
    .eq("id", membershipId)
    .select(
      `
      id, org_id, user_id, role_id, status, last_active_at, created_at, invited_by,
      user:app_users!memberships_user_id_fkey(id, email, full_name, avatar_url),
      role:roles!memberships_role_id_fkey(key, label)
    `,
    )
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Failed to update member role: ${error?.message}`)
  }

  const savedOverrides =
    parsed.permissionOverrides === undefined
      ? await mapPermissionOverrides(serviceClient, [data.id as string]).then((map) => map[data.id as string] ?? [])
      : await replacePermissionOverrides(serviceClient, data.id as string, parsed.permissionOverrides)

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "membership",
    entityId: data.id as string,
    before: existing,
    after: data,
  })

  const projectCounts = await mapProjectCounts(supabase, resolvedOrgId)
  const selectedUser = Array.isArray((data as any).user) ? (data as any).user[0] : (data as any).user
  const mfaEnabledByUser = await mapMfaEnabledByUser(serviceClient, [selectedUser?.id].filter(Boolean))
  return mapTeamMember(data, projectCounts, mfaEnabledByUser, { [data.id as string]: savedOverrides })
}

async function updateMemberStatus(membershipId: string, status: "active" | "invited" | "suspended", orgId?: string) {
  memberStatusSchema.parse({ status })
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "members.manage",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "membership",
    resourceId: membershipId,
  })

  const { data: existing, error: fetchError } = await supabase
    .from("memberships")
    .select("id, org_id, user_id, role_id, status, created_at")
    .eq("org_id", resolvedOrgId)
    .eq("id", membershipId)
    .maybeSingle()

  if (fetchError || !existing) {
    throw new Error("Membership not found")
  }

  const { data, error } = await supabase
    .from("memberships")
    .update({ status })
    .eq("org_id", resolvedOrgId)
    .eq("id", membershipId)
    .select(
      `
      id, org_id, user_id, role_id, status, last_active_at, created_at, invited_by,
      user:app_users!memberships_user_id_fkey(id, email, full_name, avatar_url),
      role:roles!memberships_role_id_fkey(key, label)
    `,
    )
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Failed to update member status: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "membership",
    entityId: data.id as string,
    before: existing,
    after: data,
  })

  const projectCounts = await mapProjectCounts(supabase, resolvedOrgId)
  const selectedUser = Array.isArray((data as any).user) ? (data as any).user[0] : (data as any).user
  const mfaEnabledByUser = await mapMfaEnabledByUser(createServiceSupabaseClient(), [selectedUser?.id].filter(Boolean))
  return mapTeamMember(data, projectCounts, mfaEnabledByUser)
}

export function suspendMember(membershipId: string, orgId?: string) {
  return updateMemberStatus(membershipId, "suspended", orgId)
}

export function reactivateMember(membershipId: string, orgId?: string) {
  return updateMemberStatus(membershipId, "active", orgId)
}

export async function removeMember(membershipId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "members.manage",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "membership",
    resourceId: membershipId,
  })

  const { data: membership, error: fetchError } = await supabase
    .from("memberships")
    .select("id, org_id, user_id, role_id, status")
    .eq("org_id", resolvedOrgId)
    .eq("id", membershipId)
    .maybeSingle()

  if (fetchError || !membership) {
    throw new Error("Membership not found")
  }

  const { count: projectAssignments, error: projectError } = await supabase
    .from("project_members")
    .select("id", { count: "exact", head: true })
    .eq("org_id", resolvedOrgId)
    .eq("user_id", membership.user_id)

  if (projectError) {
    console.error("Failed to check project assignments", projectError)
  } else if ((projectAssignments ?? 0) > 0) {
    throw new Error("Cannot remove member with active project assignments")
  }

  const { error } = await supabase.from("memberships").delete().eq("org_id", resolvedOrgId).eq("id", membershipId)

  if (error) {
    throw new Error(`Failed to remove member: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "membership",
    entityId: membershipId,
    before: membership,
    after: null,
  })

  return true
}

export async function resendInvite(membershipId: string, orgId?: string) {
  const { orgId: resolvedOrgId, supabase, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "members.manage",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "membership",
    resourceId: membershipId,
  })
  const serviceClient = createServiceSupabaseClient()

  const { data, error } = await serviceClient
    .from("memberships")
    .select("id, org_id, user_id, status, user:app_users(id, email)")
    .eq("org_id", resolvedOrgId)
    .eq("id", membershipId)
    .maybeSingle()

  if (error || !data) {
    throw new Error("Membership not found for resend")
  }

  const user = Array.isArray(data.user) ? data.user[0] : data.user
  const email = user?.email
  if (!email) {
    throw new Error("Membership user email missing")
  }

  // Get the current user's info (the person resending the invite)
  const { data: inviterData } = await serviceClient
    .from("app_users")
    .select("full_name, email")
    .eq("id", userId)
    .maybeSingle()

  // Generate new invite token
  const inviteToken = generateInviteToken()
  const inviteTokenExpiresAt = getInviteTokenExpiry()

  // Update membership with new token
  const { error: updateError } = await serviceClient
    .from("memberships")
    .update({
      invite_token: inviteToken,
      invite_token_expires_at: inviteTokenExpiresAt.toISOString(),
    })
    .eq("id", membershipId)

  if (updateError) {
    throw new Error(`Failed to generate new invite token: ${updateError.message}`)
  }

  const orgBrand = await getOrgBrand(serviceClient, resolvedOrgId)
  const inviteLink = getInviteLink(inviteToken)
  await sendInviteEmail({
    to: email,
    inviteLink,
    orgName: orgBrand.name,
    orgLogoUrl: orgBrand.logoUrl,
    inviterName: inviterData?.full_name ?? null,
    inviterEmail: inviterData?.email ?? null,
  })

  return true
}

export async function resetMemberMfa(membershipId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "members.manage",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "membership",
    resourceId: membershipId,
  })
  const serviceClient = createServiceSupabaseClient()

  const { data: membership, error: membershipError } = await serviceClient
    .from("memberships")
    .select("id, org_id, user_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", membershipId)
    .maybeSingle()

  if (membershipError || !membership?.user_id) {
    throw new Error("Membership not found")
  }

  const { data: factorData, error: factorError } = await serviceClient.auth.admin.mfa.listFactors({
    userId: membership.user_id,
  })

  if (factorError) {
    throw new Error(`Failed to load MFA factors: ${factorError.message}`)
  }

  const factors = (factorData?.factors ?? []).filter((factor) => factor.status === "verified")
  if (factors.length === 0) {
    return { reset: false }
  }

  for (const factor of factors) {
    const { error: deleteError } = await serviceClient.auth.admin.mfa.deleteFactor({
      userId: membership.user_id,
      id: factor.id,
    })
    if (deleteError) {
      throw new Error(`Failed to reset MFA: ${deleteError.message}`)
    }
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "membership",
    entityId: membershipId,
    before: { mfa_factor_count: factors.length },
    after: { mfa_factor_count: 0 },
  })

  return { reset: true, deletedFactors: factors.length }
}

export async function getInviteDetailsByToken(token: string): Promise<{
  membershipId: string
  userId: string
  orgId: string
  orgName: string
  email: string
} | null> {
  const serviceClient = createServiceSupabaseClient()

  const { data, error } = await serviceClient
    .from("memberships")
    .select(`
      id, user_id, org_id, status, invite_token_expires_at,
      orgs!inner(name),
      user:app_users!memberships_user_id_fkey(email)
    `)
    .eq("invite_token", token)
    .eq("status", "invited")
    .maybeSingle()

  if (error || !data) {
    return null
  }

  // Check if token is expired
  if (data.invite_token_expires_at) {
    const expiresAt = new Date(data.invite_token_expires_at)
    if (expiresAt < new Date()) {
      return null
    }
  }

  const org = data.orgs as unknown as { name: string }
  const user = data.user as unknown as { email: string }

  return {
    membershipId: data.id,
    userId: data.user_id,
    orgId: data.org_id,
    orgName: org.name,
    email: user.email,
  }
}

export async function acceptInviteByToken(
  token: string,
  password: string,
  fullName: string
): Promise<{
  orgId: string
  orgName: string
} | null> {
  const serviceClient = createServiceSupabaseClient()

  // Get invite details
  const inviteDetails = await getInviteDetailsByToken(token)
  if (!inviteDetails) {
    return null
  }

  // Update user's password
  const { error: passwordError } = await serviceClient.auth.admin.updateUserById(
    inviteDetails.userId,
    { password }
  )

  if (passwordError) {
    throw new Error(`Failed to set password: ${passwordError.message}`)
  }

  // Update user profile with full name
  const { error: profileError } = await serviceClient
    .from("app_users")
    .update({ full_name: fullName })
    .eq("id", inviteDetails.userId)

  if (profileError) {
    console.error("Failed to update user profile", profileError)
  }

  // Activate membership and clear invite token
  const { error: membershipError } = await serviceClient
    .from("memberships")
    .update({
      status: "active",
      invite_token: null,
      invite_token_expires_at: null,
    })
    .eq("id", inviteDetails.membershipId)

  if (membershipError) {
    throw new Error(`Failed to activate membership: ${membershipError.message}`)
  }

  return {
    orgId: inviteDetails.orgId,
    orgName: inviteDetails.orgName,
  }
}
