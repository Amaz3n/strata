import type { SupabaseClient } from "@supabase/supabase-js"

type IsFeatureEnabledInput = {
  supabase: SupabaseClient<any, "public", any>
  orgId: string
  flagKey: string
  defaultEnabled?: boolean
}

export async function isFeatureEnabledForOrg(input: IsFeatureEnabledInput) {
  const { data, error } = await input.supabase
    .from("feature_flags")
    .select("enabled, expires_at")
    .eq("org_id", input.orgId)
    .eq("flag_key", input.flagKey)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error(`Failed to load feature flag ${input.flagKey}:`, error.message)
    return input.defaultEnabled ?? true
  }

  if (!data) {
    return input.defaultEnabled ?? true
  }

  if (data.expires_at && new Date(data.expires_at) <= new Date()) {
    return input.defaultEnabled ?? true
  }

  return data.enabled !== false
}
