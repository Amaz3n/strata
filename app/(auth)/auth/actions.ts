"use server"

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { z } from "zod"

import { createServerSupabaseClient, createServiceSupabaseClient } from "@/lib/supabase/server"

export interface AuthState {
  error?: string
  message?: string
}

const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
})

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

const updatePasswordSchema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters"),
  confirmPassword: z.string().min(8),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords must match",
  path: ["confirmPassword"],
})

export async function signInAction(prevState: AuthState, formData: FormData): Promise<AuthState> {
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
  }

  redirect("/")
}

export async function signUpAction(prevState: AuthState, formData: FormData): Promise<AuthState> {
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

export async function requestPasswordResetAction(prevState: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = resetRequestSchema.safeParse({
    email: formData.get("email"),
  })

  if (!parsed.success) {
    return { error: "Enter a valid email address." }
  }

  const supabase = await createServerSupabaseClient()
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${getSiteUrl()}/auth/reset`,
  })

  if (error) {
    return { error: error.message }
  }

  return { message: "Password reset email sent. Check your inbox for the link." }
}

export async function updatePasswordAction(prevState: AuthState, formData: FormData): Promise<AuthState> {
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

async function fetchOwnerRoleId(serviceClient: ReturnType<typeof createServiceSupabaseClient>) {
  const { data, error } = await serviceClient.from("roles").select("id").eq("key", "owner").limit(1).maybeSingle()
  if (error) {
    console.error("Unable to load owner role", error)
    return null
  }
  return data?.id ?? null
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
