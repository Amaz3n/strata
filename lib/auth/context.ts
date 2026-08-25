import "server-only"

import { cache } from "react"
import { cacheLife } from "next/cache"
import { cookies } from "next/headers"
import { after, connection } from "next/server"
import type { SupabaseClient, User } from "@supabase/supabase-js"
import { createServerSupabaseClient, createServiceSupabaseClient } from "@/lib/supabase/server"
import { isPlatformAdminUser } from "@/lib/auth/platform"
import { normalizeProductTier, type ProductTier } from "@/lib/product-tier"

export interface OrgMembership {
  id: string
  org_id: string
  role_id: string
  status: string
  role_key?: string
  last_active_at?: string | null
  org_product_tier: ProductTier
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

/**
 * Recover every serializable identity fact inside one private cache scope.
 *
 * Supabase Auth checks the clock while reading and validating its cookie-backed
 * session, and authenticated PostgREST requests obtain their token through the
 * same recovery path. Keeping only `getUser()` in the cache was therefore not
 * enough: the preferred-org and membership queries immediately below it still
 * called Auth's internal `getSession()` outside the scope during prerendering.
 * That produced both the unstable `Date.now()` insight and the insecure-user
 * warning even though Arc itself never trusted the session user.
 *
 * The Supabase client stays local to this function; only plain user/membership
 * data crosses the cache boundary. The profile is browser-private, never shared
 * server-side, and has the App Shell lifetime configured in next.config.mjs.
 */
async function loadAuthenticatedIdentity(): Promise<{
  user: User | null
  orgId: string | null
  membership: OrgMembership | null
}> {
  "use cache: private"
  cacheLife("session")

  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const orgId = user ? await getPreferredOrgId(supabase, user.id) : null
  const membership = user && orgId ? await fetchMembership(supabase, orgId, user.id) : null

  return { user, orgId, membership }
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
    .select("id, org_id, role_id, status, last_active_at, roles:roles!inner(key), orgs:orgs!inner(product_tier)")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .eq("status", "active")
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
    last_active_at: (data as { last_active_at?: string | null }).last_active_at ?? null,
    role_key: (data as { roles?: { key?: string } }).roles?.key,
    org_product_tier: normalizeProductTier(
      (data as { orgs?: { product_tier?: unknown } }).orgs?.product_tier,
    ),
  }
}

async function fetchMembershipWithServiceRole(orgId: string, userId: string): Promise<OrgMembership | null> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("memberships")
    .select("id, org_id, role_id, status, last_active_at, roles:roles!inner(key), orgs:orgs!inner(product_tier)")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle()

  if (error || !data) return null

  return {
    id: data.id as string,
    org_id: data.org_id as string,
    role_id: data.role_id as string,
    status: data.status as string,
    last_active_at: (data as { last_active_at?: string | null }).last_active_at ?? null,
    role_key: (data as { roles?: { key?: string } }).roles?.key,
    org_product_tier: normalizeProductTier(
      (data as { orgs?: { product_tier?: unknown } }).orgs?.product_tier,
    ),
  }
}

// Request-cached: several callers per request (org context, lock bypass, access state)
// need the same answer, and it never changes mid-request.
export const hasActivePlatformMembership = cache(async (userId: string) => {
  try {
    const supabase = createServiceSupabaseClient()
    const { data, error } = await supabase
      .from("platform_memberships")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "active")
      // Expiry is compared against Postgres' clock ("now" is a timestamptz
      // literal) so this stays callable from prerendered and cached scopes,
      // which cannot read a JS clock.
      .or("expires_at.is.null,expires_at.gt.now")
      .limit(1)
      .maybeSingle()

    if (error) {
      console.error("Unable to resolve platform membership", error)
      return false
    }

    return Boolean(data?.id)
  } catch (error) {
    console.error("Unable to resolve platform membership", error)
    return false
  }
})

/**
 * Last-active is telemetry, so it runs in `after()`: off the render's critical
 * path, and — because requireOrgMembership() is on the path of every page — out
 * of the prerender, where reading the clock to throttle the write would fail.
 */
function touchMembershipActivity(orgId: string, userId: string, lastActiveAt?: string | null) {
  after(async () => {
    const now = new Date()
    if (lastActiveAt) {
      const last = new Date(lastActiveAt)
      if (!Number.isNaN(last.getTime()) && now.getTime() - last.getTime() < 15 * 60 * 1000) {
        return
      }
    }

    try {
      const supabase = createServiceSupabaseClient()
      await supabase
        .from("memberships")
        .update({ last_active_at: now.toISOString() })
        .eq("org_id", orgId)
        .eq("user_id", userId)
    } catch (error) {
      console.error("Failed to update last active timestamp", error)
    }
  })
}

// Request-cached: getUser() is a network call to Supabase Auth and every service
// re-resolves this context; without the cache a single page render repeats the
// whole chain dozens of times.
export const getAuthContext = cache(async (): Promise<AuthContext> => {
  // Resolve identity first so callers already inside a private cache keep
  // Supabase's session recovery (and its token-expiry clock) in that scope.
  // Uncached render entry points must establish request time before calling
  // this function; the app chrome does that in getAppChromeContext(). Keeping
  // connection() out of this shared helper is essential because project and
  // directory read models legitimately call it from `use cache: private`.
  const identity = await loadAuthenticatedIdentity()
  const supabase = await createServerSupabaseClient()

  return { supabase, ...identity }
})

export async function requireAuth(): Promise<AuthContext & { user: User }> {
  const context = await getAuthContext()
  if (!context.user) {
    // Anonymous build samples cannot exercise authenticated routes. Defer the
    // decision to request time so prerendering emits the surrounding shell;
    // real anonymous requests still resolve connection() and fail normally.
    await connection()
    throw new Error("User is not authenticated")
  }
  return context as AuthContext & { user: User }
}

// Request-cached per orgId argument: dedupes the membership/platform lookups
// (and the org-cookie side effect) across the many service calls in one render.
export const requireOrgMembership = cache(async (
  orgId?: string,
): Promise<AuthContext & { user: User; orgId: string; membership: OrgMembership }> => {
  const context = await requireAuth()

  // Authorization must not trust the session-lifetime identity cache above.
  // Re-read through the privileged client once per request so a suspension or
  // revocation takes effect on the next request even if the browser still has
  // an active Supabase session and a cached app shell.
  //
  // The platform-membership probe and that membership re-read are keyed on the
  // same already-known (user, org) pair and neither decides the other, so they
  // travel together instead of costing two serial round trips on every
  // authenticated request. A configured superadmin still short-circuits both:
  // that check is a local env lookup, and neither answer would be used.
  const ambientOrgId = orgId ?? context.orgId
  const isSuperAdmin = isPlatformAdminUser(context.user)
  const [isPlatformOperator, ambientMembership]: [boolean, OrgMembership | null] = isSuperAdmin
    ? [true, null]
    : await Promise.all([
        hasActivePlatformMembership(context.user.id),
        ambientOrgId ? fetchMembershipWithServiceRole(ambientOrgId, context.user.id) : null,
      ])
  const isPlatformAdmin = isSuperAdmin || isPlatformOperator

  // Platform admin: allow bypassing membership, use service client, and pick any org.
  if (isPlatformAdmin) {
    const resolvedOrgId =
      orgId ??
      context.orgId ??
      (await (async () => {
        const cookieStore = await cookies()
        return cookieStore.get("org_id")?.value ?? null
      })()) ??
      (await (async () => {
        const svc = createServiceSupabaseClient()
        const { data } = await svc
          .from("orgs")
          .select("id")
          .order("created_at", { ascending: true })
          .limit(1)
        return data?.[0]?.id ?? null
      })())

    if (!resolvedOrgId) {
      throw new Error("No organizations available for platform admin")
    }

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

    const svc = createServiceSupabaseClient()
    const { data: platformOrg } = await svc
      .from("orgs")
      .select("product_tier")
      .eq("id", resolvedOrgId)
      .maybeSingle()

    const pseudoMembership: OrgMembership = {
      id: "platform-admin",
      org_id: resolvedOrgId,
      role_id: "platform-admin",
      status: "active",
      role_key: "owner",
      org_product_tier: normalizeProductTier(platformOrg?.product_tier),
    }

    return {
      ...context,
      supabase: svc,
      orgId: resolvedOrgId,
      membership: pseudoMembership,
    }
  }

  let resolvedOrgId = ambientOrgId
  let membership = ambientMembership

  // An explicit organization is an authorization boundary (for example, a
  // file's owning org). Never satisfy that check with membership in a
  // different organization. Only ambient cookie resolution may fall back.
  if (!membership && orgId) {
    throw new Error("You no longer have access to this organization")
  }

  // If an ambient cookie points at a revoked/missing membership, resolve a
  // different active organization without consulting that stale cookie again.
  if (!membership) {
    const serviceClient = createServiceSupabaseClient()
    resolvedOrgId = await fetchFirstMembershipOrg(serviceClient, context.user.id)
    if (resolvedOrgId) {
      membership = await fetchMembershipWithServiceRole(resolvedOrgId, context.user.id)
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

  if (membership.status === "active") {
    touchMembershipActivity(resolvedOrgId, context.user.id, membership.last_active_at)
  }

  return { ...context, orgId: resolvedOrgId, membership }
})
