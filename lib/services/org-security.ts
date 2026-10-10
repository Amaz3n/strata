import "server-only"

import { setOrgRequireMfaSchema, type SetOrgRequireMfaInput } from "@/lib/validation/org-security"
import { requireOrgContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export interface OrgSecurityPolicy {
  requireMfa: boolean
  updatedAt: string | null
}

const NO_POLICY: OrgSecurityPolicy = { requireMfa: false, updatedAt: null }

export async function getOrgSecurityPolicy(orgId?: string): Promise<OrgSecurityPolicy> {
  const context = await requireOrgContext(orgId)
  const { data, error } = await createServiceSupabaseClient()
    .from("org_security_policies")
    .select("require_mfa, updated_at")
    .eq("org_id", context.orgId)
    .maybeSingle()
  if (error) throw new Error(`Unable to load security settings: ${error.message}`)
  if (!data) return NO_POLICY
  return { requireMfa: data.require_mfa === true, updatedAt: (data.updated_at as string | null) ?? null }
}

/**
 * Turn the organization-wide two-factor requirement on or off.
 *
 * Enforcement lives in the proxy (web) and `requireMobileOrg` (mobile): a member
 * whose session is not aal2 is sent to enrollment or refused. The proxy caches
 * "no org requires it" for up to ten minutes per session, so an enabled policy
 * reaches already-open sessions within that interval.
 */
export async function setOrgRequireMfa(input: SetOrgRequireMfaInput, orgId?: string): Promise<OrgSecurityPolicy> {
  const { requireMfa } = setOrgRequireMfaSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "org.admin",
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    logDecision: true,
    resourceType: "org_security_policy",
    resourceId: context.orgId,
  })

  const service = createServiceSupabaseClient()
  const { data: existing, error: readError } = await service
    .from("org_security_policies")
    .select("org_id, require_mfa, updated_by, updated_at")
    .eq("org_id", context.orgId)
    .maybeSingle()
  if (readError) throw new Error(`Unable to load security settings: ${readError.message}`)
  if ((existing?.require_mfa === true) === requireMfa) {
    return { requireMfa, updatedAt: (existing?.updated_at as string | null) ?? null }
  }

  const { data, error } = await service
    .from("org_security_policies")
    .upsert({ org_id: context.orgId, require_mfa: requireMfa, updated_by: context.userId }, { onConflict: "org_id" })
    .select("org_id, require_mfa, updated_by, updated_at")
    .single()
  if (error || !data) throw new Error(`Unable to save security settings: ${error?.message ?? "no row returned"}`)

  await recordAudit({
    orgId: context.orgId,
    actorId: context.userId,
    action: existing ? "update" : "insert",
    entityType: "org_security_policy",
    entityId: context.orgId,
    before: existing ?? null,
    after: data,
  })
  await recordEvent({
    orgId: context.orgId,
    actorId: context.userId,
    eventType: "org_security_policy_updated",
    entityType: "org_security_policy",
    entityId: context.orgId,
    payload: { require_mfa: requireMfa },
  })

  return { requireMfa: data.require_mfa === true, updatedAt: (data.updated_at as string | null) ?? null }
}
