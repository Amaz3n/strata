"use server"

import { cookies, headers } from "next/headers"
import { randomBytes } from "node:crypto"
import { redirect } from "next/navigation"
import { z } from "zod"

import { createServerSupabaseClient, createServiceSupabaseClient } from "@/lib/supabase/server"
import { sendInviteEmail, sendPasswordResetEmail } from "@/lib/services/mailer"

export interface AuthState {
  error?: string
  message?: string
  mfaRequired?: boolean
}

export type SignInAccountStatus = "password" | "setup" | "missing" | "inactive"

export interface SignInAccountState {
  status: SignInAccountStatus
  email: string
  orgName?: string | null
  message?: string
}

const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
})

const TRACKED_DEMO_EMAILS = (process.env.DEMO_USAGE_TRACKING_EMAILS ?? "demo@arcnaples.com")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean)

const signUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  fullName: z.string().min(2, "Name is required"),
  orgName: z.string().min(2, "Company name is required"),
  inviteCode: z.string().optional(),
})

const resetRequestSchema = z.object({
  email: z.string().email(),
})

const lookupAccountSchema = z.object({
  email: z.string().email(),
})

const updatePasswordSchema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters"),
  confirmPassword: z.string().min(8),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords must match",
  path: ["confirmPassword"],
})

export async function signInAction(_prevState: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = signInSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  })

  if (!parsed.success) {
    return { error: "Enter a valid email and password." }
  }

  const supabase = await createServerSupabaseClient()
  const { error } = await supabase.auth.signInWithPassword(parsed.data)

  if (error) {
    return { error: error.message }
  }

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (user) {
    const membershipState = await resolveMembershipState(supabase, user.id)
    if (!membershipState.activeOrgId) {
      await supabase.auth.signOut()
      await clearOrgCookie()
      if (membershipState.hasSuspendedMembership) {
        return { error: "This account has been archived. Contact your organization admin to restore access." }
      }
      return { error: "No active organization is assigned to this account. Contact support for access." }
    }

    await setOrgCookie(membershipState.activeOrgId)
    await recordDemoLoginIfTracked({
      orgId: membershipState.activeOrgId,
      userId: user.id,
      email: user.email ?? parsed.data.email,
    })

    const { data: aalData, error: aalError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aalError) {
      console.error("Failed to load MFA assurance level", aalError)
    }

    const requiresMfa = aalData?.nextLevel === "aal2" && aalData?.currentLevel !== "aal2"
    if (requiresMfa) {
      return { mfaRequired: true }
    }
  }

  redirect("/")
}

export async function lookupSignInAccountAction(emailInput: string): Promise<SignInAccountState> {
  const parsed = lookupAccountSchema.safeParse({ email: emailInput })

  if (!parsed.success) {
    return {
      status: "missing",
      email: "",
      message: "Enter a valid work email.",
    }
  }

  const email = parsed.data.email.trim().toLowerCase()
  const serviceClient = createServiceSupabaseClient()

  const { data: userRow, error: userError } = await serviceClient
    .from("app_users")
    .select("id, email")
    .ilike("email", email)
    .maybeSingle()

  if (userError) {
    console.error("Failed to look up sign-in account", userError)
    return {
      status: "missing",
      email,
      message: "We could not check that account. Try again.",
    }
  }

  if (!userRow?.id) {
    return {
      status: "missing",
      email,
      message: "No Arc account was found for that email.",
    }
  }

  const { data: memberships, error: membershipError } = await serviceClient
    .from("memberships")
    .select("status, invite_token_expires_at, org:orgs(name)")
    .eq("user_id", userRow.id)
    .in("status", ["active", "invited", "suspended"])
    .order("created_at", { ascending: true })

  if (membershipError) {
    console.error("Failed to load sign-in memberships", membershipError)
    return {
      status: "missing",
      email,
      message: "We could not check that account. Try again.",
    }
  }

  const activeMembership = memberships?.find((membership) => membership.status === "active")
  if (activeMembership) {
    return {
      status: "password",
      email,
      orgName: resolveMembershipOrgName(activeMembership),
    }
  }

  const invitedMembership = memberships?.find((membership) => membership.status === "invited")
  if (invitedMembership) {
    return {
      status: "setup",
      email,
      orgName: resolveMembershipOrgName(invitedMembership),
    }
  }

  const suspendedMembership = memberships?.find((membership) => membership.status === "suspended")
  if (suspendedMembership) {
    return {
      status: "inactive",
      email,
      orgName: resolveMembershipOrgName(suspendedMembership),
      message: "This account has been archived. Contact your organization admin to restore access.",
    }
  }

  return {
    status: "missing",
    email,
    message: "No active Arc workspace is assigned to that email.",
  }
}

export async function sendFirstPasswordSetupAction(emailInput: string): Promise<AuthState> {
  const parsed = lookupAccountSchema.safeParse({ email: emailInput })

  if (!parsed.success) {
    return { error: "Enter a valid work email." }
  }

  const email = parsed.data.email.trim().toLowerCase()
  const serviceClient = createServiceSupabaseClient()

  try {
    const { data: userRow, error: userError } = await serviceClient
      .from("app_users")
      .select("id")
      .ilike("email", email)
      .maybeSingle()

    if (userError || !userRow?.id) {
      if (userError) console.error("Failed to resolve setup user", userError)
      return { message: "If setup is available for that account, we sent a secure setup link." }
    }

    const { data: membership, error: membershipError } = await serviceClient
      .from("memberships")
      .select("id, org_id, org:orgs(name, logo_url, slug)")
      .eq("user_id", userRow.id)
      .eq("status", "invited")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle()

    if (membershipError || !membership?.id) {
      if (membershipError) console.error("Failed to resolve setup membership", membershipError)
      return { message: "If setup is available for that account, we sent a secure setup link." }
    }

    const inviteToken = randomBytes(32).toString("base64url")
    const inviteTokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    const { error: updateError } = await serviceClient
      .from("memberships")
      .update({
        invite_token: inviteToken,
        invite_token_expires_at: inviteTokenExpiresAt.toISOString(),
      })
      .eq("id", membership.id)

    if (updateError) {
      console.error("Failed to create first-password setup token", updateError)
      return { error: "We could not send the setup link. Try again." }
    }

    const org = Array.isArray(membership.org) ? membership.org[0] : membership.org
    await sendInviteEmail({
      to: email,
      inviteLink: `${getSiteUrl()}/auth/accept-invite?token=${inviteToken}`,
      orgName: org?.name ?? null,
      orgLogoUrl: org?.logo_url ?? null,
      orgSlug: org?.slug ?? null,
    })

    return { message: "Check your email for a secure setup link." }
  } catch (error) {
    console.error("Failed to send first-password setup link", error)
    return { error: "We could not send the setup link. Try again." }
  }
}

async function recordDemoLoginIfTracked(input: { orgId: string; userId: string; email: string }) {
  if (!TRACKED_DEMO_EMAILS.includes(input.email.toLowerCase())) return

  try {
    const headerStore = await headers()
    const supabase = createServiceSupabaseClient()
    const { error } = await supabase.from("events").insert({
      org_id: input.orgId,
      event_type: "demo_login",
      entity_type: "usage",
      payload: {
        actor_id: input.userId,
        actor_email: input.email,
        user_agent: headerStore.get("user-agent"),
        referer: headerStore.get("referer"),
      },
      channel: "activity",
    })

    if (error) {
      console.error("Failed to record demo login", error)
    }
  } catch (error) {
    console.error("Failed to record demo login", error)
  }
}

export async function signUpAction(_prevState: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = signUpSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    fullName: formData.get("fullName"),
    orgName: formData.get("orgName"),
    inviteCode: formData.get("inviteCode") ?? undefined,
  })

  if (!parsed.success) {
    const firstError = parsed.error.errors.at(0)?.message ?? "Please check the form fields."
    return { error: firstError }
  }

  const allowSelfSignup = (process.env.ALLOW_SELF_SIGNUP ?? "false").toLowerCase() === "true"
  const inviteCode = (process.env.SIGNUP_INVITE_CODE ?? "").trim()

  if (!allowSelfSignup) {
    if (!inviteCode || parsed.data.inviteCode !== inviteCode) {
      return { error: "Signup is currently invite-only. Please contact support to join." }
    }
  }

  const supabase = await createServerSupabaseClient()
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: { full_name: parsed.data.fullName },
      emailRedirectTo: `${getSiteUrl()}/auth/reset`,
    },
  })

  if (error) {
    return { error: error.message }
  }

  const userId = data.user?.id
  if (!userId) {
    return { error: "Account created, but we could not start your session. Please check your email." }
  }

  const serviceClient = createServiceSupabaseClient()
  const ownerRoleId = await fetchOwnerRoleId(serviceClient)
  if (!ownerRoleId) {
    return { error: "Owner role is missing in the database." }
  }

  let orgId: string | null = null
  try {
    const org = await createOrgWithMembership({
      serviceClient,
      userId,
      email: parsed.data.email,
      fullName: parsed.data.fullName,
      orgName: parsed.data.orgName,
      roleId: ownerRoleId,
    })
    orgId = org.id
  } catch (creationError) {
    console.error("Failed to create org for new user", creationError)
    return { error: "Account created, but we could not set up your workspace. Please contact support." }
  }

  if (orgId) {
    await setOrgCookie(orgId)
  }

  if (data.session) {
    redirect("/")
  }

  return {
    message: "Check your email to confirm your account. Once confirmed, you can sign in.",
  }
}

export async function signOutAction() {
  const supabase = await createServerSupabaseClient()
  await supabase.auth.signOut()
  await clearOrgCookie()
  redirect("/auth/signin")
}

export async function requestPasswordResetAction(_prevState: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = resetRequestSchema.safeParse({
    email: formData.get("email"),
  })

  if (!parsed.success) {
    return { error: "Enter a valid email address." }
  }

  const email = parsed.data.email.trim().toLowerCase()
  const serviceClient = createServiceSupabaseClient()
  const genericMessage = "If an account exists for that email, we sent a password reset link."

  try {
    const { data, error } = await serviceClient.auth.admin.generateLink({
      type: "recovery",
      email,
      options: {
        redirectTo: `${getSiteUrl()}/auth/reset`,
      },
    })

    if (error || !data?.properties) {
      console.error("Failed to generate password recovery link", error)
      return { message: genericMessage }
    }

    const tokenHash = data.properties.hashed_token
    const actionLink = data.properties.action_link

    const resetUrl = tokenHash
      ? (() => {
          const url = new URL("/auth/reset", getSiteUrl())
          url.searchParams.set("token_hash", tokenHash)
          url.searchParams.set("type", "recovery")
          return url.toString()
        })()
      : actionLink

    if (!resetUrl) {
      console.error("Recovery link generation did not return a usable URL")
      return { message: genericMessage }
    }

    const orgBrand = await resolveOrgBrandForEmail(serviceClient, email)

    await sendPasswordResetEmail({
      to: email,
      resetLink: resetUrl,
      orgName: orgBrand.name,
      orgLogoUrl: orgBrand.logoUrl,
      orgSlug: orgBrand.orgSlug,
    })
  } catch (error) {
    console.error("Failed to send password reset email", error)
  }

  return { message: genericMessage }
}

export async function updatePasswordAction(_prevState: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = updatePasswordSchema.safeParse({
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  })

  if (!parsed.success) {
    const firstError = parsed.error.errors.at(0)?.message ?? "Please check the form fields."
    return { error: firstError }
  }

  const supabase = await createServerSupabaseClient()
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password })

  if (error) {
    return { error: error.message }
  }

  redirect("/")
}

async function setOrgCookie(orgId: string) {
  const cookieStore = await cookies()
  if (typeof cookieStore.set === "function") {
    cookieStore.set({
      name: "org_id",
      value: orgId,
      path: "/",
      httpOnly: false,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30,
    })
  }
}

async function clearOrgCookie() {
  const cookieStore = await cookies()
  if (typeof cookieStore.set === "function") {
    cookieStore.set({
      name: "org_id",
      value: "",
      path: "/",
      httpOnly: false,
      sameSite: "lax",
      maxAge: 0,
    })
  }
}

async function resolveMembershipState(supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>, userId: string) {
  const { data: activeMembership, error: activeError } = await supabase
    .from("memberships")
    .select("org_id")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()

  if (activeError) {
    console.error("Failed to load active membership", activeError)
  }

  if (activeMembership?.org_id) {
    return {
      activeOrgId: activeMembership.org_id as string,
      hasSuspendedMembership: false,
    }
  }

  const { data: suspendedMembership, error: suspendedError } = await supabase
    .from("memberships")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "suspended")
    .limit(1)
    .maybeSingle()

  if (suspendedError) {
    console.error("Failed to check suspended membership", suspendedError)
  }

  return {
    activeOrgId: null,
    hasSuspendedMembership: Boolean(suspendedMembership?.id),
  }
}

function resolveMembershipOrgName(row: { org?: unknown }) {
  const org = Array.isArray(row.org) ? row.org[0] : row.org
  return typeof org === "object" && org && "name" in org ? (org.name as string | null) : null
}

async function fetchOwnerRoleId(serviceClient: ReturnType<typeof createServiceSupabaseClient>) {
  const roleKeys = ["org_owner"]

  for (const roleKey of roleKeys) {
    const { data, error } = await serviceClient.from("roles").select("id").eq("key", roleKey).limit(1).maybeSingle()
    if (!error && data?.id) {
      return data.id
    }
    if (error) {
      console.error(`Unable to load ${roleKey} role`, error)
    }
  }

  return null
}

async function createOrgWithMembership(params: {
  serviceClient: ReturnType<typeof createServiceSupabaseClient>
  userId: string
  email: string
  fullName: string
  orgName: string
  roleId: string
}) {
  const { serviceClient, userId, email, fullName, orgName, roleId } = params

  const { data: userData, error: userError } = await serviceClient
    .from("app_users")
    .upsert({ id: userId, email, full_name: fullName })
    .select("id")
    .single()

  if (userError || !userData) {
    throw new Error(userError?.message ?? "Failed to create user profile")
  }

  const { data: orgData, error: orgError } = await serviceClient
    .from("orgs")
    .insert({ name: orgName, created_by: userId })
    .select("id")
    .single()

  if (orgError || !orgData) {
    throw new Error(orgError?.message ?? "Failed to create organization")
  }

  const { error: membershipError } = await serviceClient.from("memberships").upsert({
    org_id: orgData.id,
    user_id: userId,
    role_id: roleId,
    status: "active",
  })

  if (membershipError) {
    throw new Error(membershipError.message)
  }

  await serviceClient.from("org_settings").upsert({ org_id: orgData.id })

  return { id: orgData.id }
}

function getSiteUrl() {
  const url =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.APP_URL ||
    process.env.VERCEL_URL ||
    "http://localhost:3000"

  if (url.startsWith("http")) return url.replace(/\/$/, "")
  return `https://${url}`.replace(/\/$/, "")
}

async function resolveOrgBrandForEmail(serviceClient: ReturnType<typeof createServiceSupabaseClient>, email: string) {
  const fallback = { name: "Arc" as string | null, logoUrl: null as string | null, orgSlug: null as string | null }

  const { data: userRow, error: userError } = await serviceClient
    .from("app_users")
    .select("id")
    .ilike("email", email)
    .maybeSingle()

  if (userError) {
    console.error("Failed to resolve user for password reset brand", userError)
    return fallback
  }

  if (!userRow?.id) {
    return fallback
  }

  const { data: membershipRow, error: membershipError } = await serviceClient
    .from("memberships")
    .select("org:orgs(name, logo_url, slug)")
    .eq("user_id", userRow.id)
    .in("status", ["active", "invited"])
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()

  if (membershipError) {
    console.error("Failed to resolve org brand for password reset email", membershipError)
    return fallback
  }

  const rawOrg = membershipRow?.org as
    | { name?: string | null; logo_url?: string | null; slug?: string | null }
    | Array<{ name?: string | null; logo_url?: string | null; slug?: string | null }>
    | null
  const org = Array.isArray(rawOrg) ? (rawOrg[0] ?? null) : rawOrg
  if (!org) {
    return fallback
  }

  return {
    name: org.name ?? "Arc",
    logoUrl: org.logo_url ?? null,
    orgSlug: org.slug ?? null,
  }
}
