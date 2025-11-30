import { cookies } from "next/headers"
import type { SupabaseClient, User } from "@supabase/supabase-js"
import { createServerSupabaseClient, createServiceSupabaseClient } from "@/lib/supabase/server"

export interface OrgMembership {
  id: string
  org_id: string
  role_id: string
  status: string
  role_key?: string
}

export interface AuthContext {
  supabase: SupabaseClient
  user: User | null
  orgId: string | null
  membership: OrgMembership | null
}

async function getPreferredOrgId(supabase: SupabaseClient, userId?: string | null) {
  const cookieStore = await cookies()
  const cookieOrgId = cookieStore.get("org_id")?.value
  if (cookieOrgId) return cookieOrgId

  if (!userId) return null

  // Try with the scoped client first; fall back to service role to avoid RLS edge cases.
  const membership = await fetchFirstMembershipOrg(supabase, userId)
  if (membership) return membership

  try {
    const serviceClient = createServiceSupabaseClient()
    return await fetchFirstMembershipOrg(serviceClient, userId)
  } catch (error) {
    console.error("Unable to resolve default org with service role", error)
    return null
  }
}

async function fetchFirstMembershipOrg(client: SupabaseClient, userId: string) {
  const { data, error } = await client
    .from("memberships")
    .select("org_id")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error("Unable to resolve default org", error)
    return null
  }

  return data?.org_id ?? null
}

async function fetchMembership(
  supabase: SupabaseClient,
  orgId: string,
  userId: string,
): Promise<OrgMembership | null> {
  const { data, error } = await supabase
    .from("memberships")
    .select("id, org_id, role_id, status, roles:roles!inner(key)")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle()

  if (error) {
    console.error("Failed to load membership", error)
    return null
  }

  if (!data) return null

  return {
    id: data.id as string,
    org_id: data.org_id as string,
    role_id: data.role_id as string,
    status: data.status as string,
    role_key: (data as { roles?: { key?: string } }).roles?.key,
  }
}

async function fetchMembershipWithServiceRole(orgId: string, userId: string): Promise<OrgMembership | null> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("memberships")
    .select("id, org_id, role_id, status, roles:roles!inner(key)")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle()

  if (error || !data) return null

  return {
    id: data.id as string,
    org_id: data.org_id as string,
    role_id: data.role_id as string,
    status: data.status as string,
    role_key: (data as { roles?: { key?: string } }).roles?.key,
  }
}

export async function getAuthContext(): Promise<AuthContext> {
  const supabase = createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const orgId = user ? await getPreferredOrgId(supabase, user.id) : null
  const membership = user && orgId ? await fetchMembership(supabase, orgId, user.id) : null

  return { supabase, user, orgId, membership }
}

export async function requireAuth(): Promise<AuthContext & { user: User }> {
  const context = await getAuthContext()
  if (!context.user) {
    throw new Error("User is not authenticated")
  }
  return context as AuthContext & { user: User }
}

export async function requireOrgMembership(
  orgId?: string,
): Promise<AuthContext & { user: User; orgId: string; membership: OrgMembership }> {
  const context = await requireAuth()
  let resolvedOrgId =
    orgId ?? context.orgId ?? (await getPreferredOrgId(context.supabase, context.user.id))

  let membership =
    resolvedOrgId && context.membership && context.membership.org_id === resolvedOrgId
      ? context.membership
      : resolvedOrgId
        ? await fetchMembership(context.supabase, resolvedOrgId, context.user.id)
        : null

  // If we couldn't resolve membership (bad/missing cookie), fall back to first active org.
  if (!membership) {
    resolvedOrgId = await getPreferredOrgId(context.supabase, context.user.id)
    if (resolvedOrgId) {
      membership = await fetchMembership(context.supabase, resolvedOrgId, context.user.id)
      // Final fallback: service role to bypass RLS if anon query fails.
      if (!membership) {
        membership = await fetchMembershipWithServiceRole(resolvedOrgId, context.user.id)
      }
    }
  }

  if (!resolvedOrgId || !membership) {
    throw new Error("No active organization found for this user")
  }

  // Persist org cookie when we successfully resolve membership.
  const cookieStore = await cookies()
  const cookieOrgId = cookieStore.get("org_id")?.value
  if (!cookieOrgId || cookieOrgId !== resolvedOrgId) {
    cookieStore.set({
      name: "org_id",
      value: resolvedOrgId,
      path: "/",
      httpOnly: false,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30,
    })
  }

  return { ...context, orgId: resolvedOrgId, membership }
}
