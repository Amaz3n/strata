import "server-only"

import { createServiceSupabaseClient } from "@/lib/supabase/server"

type ServiceClient = ReturnType<typeof createServiceSupabaseClient>

export type LedgerAuthority = "external" | "arc"

/**
 * Which system owns an organization's general ledger.
 *
 * This is the single boundary the two-posture model rests on, so it fails
 * CLOSED: an unreadable `books_settings` row throws rather than assuming the
 * external system is authoritative. The earlier callers each swallowed that
 * error to "preserve existing provider behavior during the additive rollout" —
 * that shim is obsolete now that both Books migrations are applied, and what it
 * actually did was grant permission to push an Arc-authoritative org's data
 * into its external accounting system on a transient network blip.
 *
 * A MISSING row is not an error. An org that never enabled Arc Books genuinely
 * is external-authoritative, and that is the overwhelming majority.
 */
export async function resolveLedgerAuthority(orgId: string, supabase?: ServiceClient): Promise<LedgerAuthority> {
  const client = supabase ?? createServiceSupabaseClient()
  const { data, error } = await client
    .from("books_settings")
    .select("ledger_authority")
    .eq("org_id", orgId)
    .maybeSingle()
  if (error) {
    throw new Error(`Unable to resolve ledger authority for this organization: ${error.message}`)
  }
  return data?.ledger_authority === "arc" ? "arc" : "external"
}

/** True when the external accounting system still owns the ledger and may be written to. */
export async function isExternalLedgerAuthoritative(orgId: string, supabase?: ServiceClient) {
  return (await resolveLedgerAuthority(orgId, supabase)) === "external"
}
