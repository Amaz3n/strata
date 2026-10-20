import "server-only"

import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { logger } from "@/lib/logging/logger"
import { getOrgAccessStateForOrg } from "@/lib/services/access"
import { normalizeProductTier } from "@/lib/product-tier"
import { businessBrand, resolveBusinessProfile } from "@/lib/business-profile"
import { terminology } from "@/lib/terminology"
import { hasPlatformAccessByUserId } from "@/lib/services/platform-access"
import type { OrgServiceContext } from "@/lib/services/context"
import { MobileAPIError } from "@/lib/mobile/api"
import { ORG_MFA_REQUIRED_MESSAGE, assuranceLevelFromAccessToken, orgMfaPolicyBlocks } from "@/lib/auth/org-mfa-policy"
import type { MobileOrganizationDTO, MobileUserDTO } from "@/lib/mobile/contracts"

export interface MobileUserContext {
  token: string
  user: User
  serviceSupabase: SupabaseClient
  isPlatformAdmin: boolean
}

export interface MobileOrgContext extends MobileUserContext {
  orgId: string
  serviceContext: OrgServiceContext
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization")
  const match = authorization?.match(/^Bearer\s+(.+)$/i)
  const token = match?.[1]?.trim()
  if (!token) {
    throw new MobileAPIError(401, "missing_access_token", "An access token is required.")
  }
  return token
}

function createTokenValidationClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) {
    throw new MobileAPIError(500, "auth_configuration_error", "Mobile authentication is unavailable.")
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  })
}

export async function requireMobileUser(request: Request): Promise<MobileUserContext> {
  const token = bearerToken(request)
  const authClient = createTokenValidationClient()
  const { data, error } = await authClient.auth.getUser(token)
  if (error || !data.user) {
    throw new MobileAPIError(401, "invalid_access_token", "Your Arc session has expired.")
  }

  const serviceSupabase = createServiceSupabaseClient()
  const isPlatformAdmin = await hasPlatformAccessByUserId(data.user.id, data.user.email)
  return { token, user: data.user, serviceSupabase, isPlatformAdmin }
}

export function mapMobileUser(user: User): MobileUserDTO {
  const metadata = user.user_metadata ?? {}
  const displayName = metadata.full_name ?? metadata.name
  return {
    id: user.id,
    email: user.email ?? "",
    display_name: typeof displayName === "string" ? displayName : null,
    avatar_url: typeof metadata.avatar_url === "string" ? metadata.avatar_url : null,
  }
}

type MobileOrganizationRow = Pick<MobileOrganizationDTO, "id" | "name" | "slug" | "logo_url" | "role"> & { product_tier: unknown }

/** Adds what the app needs to shape each workspace: business profile, brand and project nouns. */
async function withWorkspaceShape(context: MobileUserContext, rows: MobileOrganizationRow[]): Promise<MobileOrganizationDTO[]> {
  const settings = new Map<string, Record<string, unknown>>()
  for (let offset = 0; offset < rows.length; offset += 200) {
    const { data, error } = await context.serviceSupabase.from("org_settings").select("org_id, settings")
      .in("org_id", rows.slice(offset, offset + 200).map((row) => row.id))
    if (error) throw new MobileAPIError(500, "organizations_unavailable", "Organizations could not be loaded.")
    for (const row of data ?? []) settings.set(row.org_id, row.settings && typeof row.settings === "object" ? row.settings : {})
  }
  return rows.map(({ product_tier, ...row }) => {
    const tier = normalizeProductTier(product_tier)
    const profile = resolveBusinessProfile(settings.get(row.id) ?? {})
    const terms = terminology(tier, profile)
    return { ...row, business_profile: profile, brand: businessBrand(profile, tier), terms: { project: terms.project, projects: terms.projects } }
  })
}

export async function listMobileOrganizations(context: MobileUserContext): Promise<MobileOrganizationDTO[]> {
  if (context.isPlatformAdmin) {
    const { data, error } = await context.serviceSupabase
      .from("orgs")
      .select("id, name, slug, logo_url, product_tier")
      .order("name", { ascending: true })
    if (error) throw new MobileAPIError(500, "organizations_unavailable", "Organizations could not be loaded.")
    return withWorkspaceShape(context, (data ?? []).map((row: any) => ({
      id: row.id,
      name: row.name,
      slug: row.slug ?? null,
      logo_url: row.logo_url ?? null,
      role: "platform",
      product_tier: row.product_tier,
    })))
  }

  const { data, error } = await context.serviceSupabase
    .from("memberships")
    .select("org_id, role:roles!memberships_role_id_fkey(key), org:orgs!inner(id, name, slug, logo_url, product_tier)")
    .eq("user_id", context.user.id)
    .eq("status", "active")
    .order("created_at", { ascending: true })

  if (error) throw new MobileAPIError(500, "organizations_unavailable", "Organizations could not be loaded.")

  return withWorkspaceShape(context, (data ?? []).map((row: any) => ({
    id: row.org_id,
    name: row.org?.name ?? "Organization",
    slug: row.org?.slug ?? null,
    logo_url: row.org?.logo_url ?? null,
    role: row.role?.key ?? null,
    product_tier: row.org?.product_tier,
  })))
}

export async function requireMobileOrg(request: Request): Promise<MobileOrgContext> {
  const context = await requireMobileUser(request)
  const orgId = request.headers.get("x-arc-organization-id")?.trim()
  if (!orgId) {
    throw new MobileAPIError(400, "missing_organization", "Select an organization before continuing.")
  }

  if (!context.isPlatformAdmin) {
    const { data, error } = await context.serviceSupabase
      .from("memberships")
      .select("id")
      .eq("org_id", orgId)
      .eq("user_id", context.user.id)
      .eq("status", "active")
      .maybeSingle()
    if (error || !data) {
      throw new MobileAPIError(403, "organization_forbidden", "You do not have access to this organization.")
    }
  }

  const [access, orgResult, policyResult] = await Promise.all([
    getOrgAccessStateForOrg(orgId, context.isPlatformAdmin),
    context.serviceSupabase.from("orgs").select("product_tier").eq("id", orgId).maybeSingle(),
    context.isPlatformAdmin
      ? null
      : context.serviceSupabase.from("org_security_policies").select("require_mfa").eq("org_id", orgId).maybeSingle(),
  ])
  // Fails open like the web proxy: an unreadable policy must not take the whole
  // mobile API down, and membership is still enforced above.
  if (policyResult?.error) logger.error("mobile.org_security_policy_unreadable", { error: new Error(policyResult.error.message), domain: "auth" })
  if (
    orgMfaPolicyBlocks({
      policyRequiresMfa: policyResult?.data?.require_mfa === true,
      assuranceLevel: assuranceLevelFromAccessToken(context.token),
    })
  ) {
    throw new MobileAPIError(403, "mfa_required", ORG_MFA_REQUIRED_MESSAGE)
  }
  if (access.locked) {
    throw new MobileAPIError(423, "organization_locked", access.reason ?? "This organization is locked.")
  }

  return {
    ...context,
    orgId,
    serviceContext: {
      supabase: context.serviceSupabase,
      orgId,
      userId: context.user.id,
      productTier: normalizeProductTier(orgResult.data?.product_tier),
    },
  }
}
