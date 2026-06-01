import "server-only"

import { recordAudit } from "@/lib/services/audit"
import { AI_SEARCH_ENABLED_FLAG_KEY } from "@/lib/services/ai-search-flags"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export interface OrgAiSearchAccess {
  orgId: string
  orgName: string
  enabled: boolean
}

function isFlagActive(flag: { enabled: boolean | null; expires_at: string | null } | undefined): boolean {
  // No explicit flag row → AI search defaults ON.
  if (!flag) return true
  if (flag.expires_at && new Date(flag.expires_at) <= new Date()) return true
  return flag.enabled !== false
}

// Per-org enablement of the master AI search switch, for the platform admin console.
export async function listOrgAiSearchAccess(): Promise<OrgAiSearchAccess[]> {
  const supabase = createServiceSupabaseClient()

  const [{ data: orgs, error: orgsError }, { data: flags, error: flagsError }] = await Promise.all([
    supabase.from("orgs").select("id, name").order("name", { ascending: true }),
    supabase.from("feature_flags").select("org_id, enabled, expires_at").eq("flag_key", AI_SEARCH_ENABLED_FLAG_KEY),
  ])

  if (orgsError) throw orgsError
  if (flagsError) throw flagsError

  const flagByOrg = new Map<string, { enabled: boolean | null; expires_at: string | null }>()
  for (const flag of flags ?? []) {
    flagByOrg.set(flag.org_id as string, {
      enabled: (flag.enabled as boolean | null) ?? null,
      expires_at: (flag.expires_at as string | null) ?? null,
    })
  }

  return (orgs ?? []).map((org: { id: string; name: string | null }) => ({
    orgId: org.id,
    orgName: org.name ?? "Untitled organization",
    enabled: isFlagActive(flagByOrg.get(org.id)),
  }))
}

export async function setOrgAiSearchAccess({
  orgId,
  enabled,
  actorId,
}: {
  orgId: string
  enabled: boolean
  actorId?: string
}): Promise<void> {
  const supabase = createServiceSupabaseClient()

  const { error } = await supabase.from("feature_flags").upsert(
    {
      org_id: orgId,
      flag_key: AI_SEARCH_ENABLED_FLAG_KEY,
      enabled,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "org_id,flag_key" },
  )

  if (error) {
    throw new Error(error.message ?? "Failed to update AI search access.")
  }

  await recordAudit({
    orgId,
    actorId,
    action: "update",
    entityType: "feature_flag",
    entityId: AI_SEARCH_ENABLED_FLAG_KEY,
    before: { enabled: !enabled },
    after: { enabled },
  })
}
