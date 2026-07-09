import type { SupabaseClient } from "@supabase/supabase-js"

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://arcnaples.com"

/**
 * Every capability flag on portal_access_tokens. Token reuse matches on the FULL
 * set (wanted capabilities true, everything else false) so a scoped link never
 * silently widens. Add new portal capability columns here or reuse will break.
 */
const PORTAL_CAPABILITY_KEYS = [
  "can_view_schedule",
  "can_view_photos",
  "can_view_documents",
  "can_download_files",
  "can_view_daily_logs",
  "can_view_budget",
  "can_approve_change_orders",
  "can_submit_selections",
  "can_create_punch_items",
  "can_view_invoices",
  "can_pay_invoices",
  "can_view_rfis",
  "can_view_submittals",
  "can_respond_rfis",
  "can_submit_submittals",
  "can_view_commitments",
  "can_view_bills",
  "can_submit_invoices",
  "can_submit_time",
  "can_submit_expenses",
  "can_upload_compliance_docs",
  "can_view_warranty",
] as const

export type PortalCapabilityKey = (typeof PORTAL_CAPABILITY_KEYS)[number]

export interface EnsurePortalLinkArgs {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  portalType: "client" | "sub"
  contactId?: string | null
  companyId?: string | null
  createdBy?: string | null
  capabilities: Partial<Record<PortalCapabilityKey, boolean>>
  scopedRfiId?: string | null
  /** Where to send the recipient if token creation fails (internal fallback). */
  fallbackPath: string
}

function portalUrl(portalType: "client" | "sub", token: string) {
  return `${APP_URL}/${portalType === "client" ? "p" : "s"}/${token}`
}

/**
 * Finds an existing active token that matches the exact capability set (and RFI
 * scope) or mints a new least-privilege one, returning its portal URL.
 */
export async function ensurePortalLink({
  supabase,
  orgId,
  projectId,
  portalType,
  contactId,
  companyId,
  createdBy,
  capabilities,
  scopedRfiId,
  fallbackPath,
}: EnsurePortalLinkArgs): Promise<string> {
  const wanted: Record<string, boolean> = {}
  for (const key of PORTAL_CAPABILITY_KEYS) {
    wanted[key] = capabilities[key] === true
  }

  let query = supabase
    .from("portal_access_tokens")
    .select(`token, expires_at, scoped_rfi_id, ${PORTAL_CAPABILITY_KEYS.join(", ")}`)
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("portal_type", portalType)
    .is("revoked_at", null)
    .is("paused_at", null)
    .order("created_at", { ascending: false })

  query = contactId ? query.eq("contact_id", contactId) : query.is("contact_id", null)
  query = companyId ? query.eq("company_id", companyId) : query.is("company_id", null)

  const { data: candidates, error: candidatesError } = await query
  if (candidatesError) {
    console.warn("Failed to load existing portal tokens", candidatesError)
  }

  const now = Date.now()
  const existing = (candidates as Array<Record<string, unknown>> | null)?.find((candidate) => {
    const expiresAt = typeof candidate.expires_at === "string" ? Date.parse(candidate.expires_at) : NaN
    const notExpired = !candidate.expires_at || Number.isNaN(expiresAt) || expiresAt > now
    if (!notExpired) return false
    if ((candidate.scoped_rfi_id ?? null) !== (scopedRfiId ?? null)) return false
    return PORTAL_CAPABILITY_KEYS.every((key) => candidate[key] === wanted[key])
  })
  if (existing && typeof existing.token === "string") {
    return portalUrl(portalType, existing.token)
  }

  const { data: created, error } = await supabase
    .from("portal_access_tokens")
    .insert({
      org_id: orgId,
      project_id: projectId,
      portal_type: portalType,
      contact_id: contactId ?? null,
      company_id: companyId ?? null,
      created_by: createdBy ?? null,
      scoped_rfi_id: scopedRfiId ?? null,
      ...wanted,
    })
    .select("token")
    .single()

  if (error || !created?.token) {
    console.warn("Failed to create portal token", error)
    return `${APP_URL}${fallbackPath}`
  }

  return portalUrl(portalType, created.token)
}

export interface EmailPerson {
  id?: string
  email: string | null
  full_name?: string | null
}

export async function fetchUserEmail(supabase: SupabaseClient, userId: string): Promise<EmailPerson | null> {
  const { data, error } = await supabase.from("app_users").select("email, full_name").eq("id", userId).maybeSingle()
  if (error) {
    console.warn("Failed to fetch user email", error)
    return null
  }
  return data
}

export async function fetchContactEmail(supabase: SupabaseClient, contactId: string): Promise<EmailPerson | null> {
  const { data, error } = await supabase.from("contacts").select("email, full_name").eq("id", contactId).maybeSingle()
  if (error) {
    console.warn("Failed to fetch contact email", error)
    return null
  }
  return data
}

export async function fetchCompanyContacts(
  supabase: SupabaseClient,
  orgId: string,
  companyId: string,
): Promise<Array<{ id: string; email: string | null; full_name?: string | null }>> {
  const { data, error } = await supabase
    .from("contacts")
    .select("id, email, full_name")
    .eq("org_id", orgId)
    .eq("primary_company_id", companyId)
    .is("metadata->>archived_at", null)
    .not("email", "is", null)
    .limit(5)

  if (error) {
    console.warn("Failed to fetch company contacts", error)
    return []
  }
  return data ?? []
}
