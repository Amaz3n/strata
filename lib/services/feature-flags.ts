import type { SupabaseClient } from "@supabase/supabase-js"

type IsFeatureEnabledInput = {
  supabase: SupabaseClient<any, "public", any>
  orgId: string
  flagKey: string
  defaultEnabled?: boolean
}

/**
 * Rollout kill-switch for SOV progress billing (workstream 02): gates only the
 * VISIBILITY of the "progress" option in financial setup, never data access.
 * Default OFF; enabled per-org from /admin/features until a full monthly cycle
 * has passed in the QA org, then the flag is deleted.
 */
export const PROGRESS_BILLING_FLAG_KEY = "progress_billing_enabled"

export async function isProgressBillingEnabledForOrg(input: Omit<IsFeatureEnabledInput, "flagKey" | "defaultEnabled">) {
  return isFeatureEnabledForOrg({ ...input, flagKey: PROGRESS_BILLING_FLAG_KEY, defaultEnabled: false })
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
