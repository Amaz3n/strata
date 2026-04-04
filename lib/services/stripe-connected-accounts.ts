import Stripe from "stripe"

import {
  createStripeAccountOnboardingLink,
  createStripeConnectedAccount,
  createStripeDashboardLoginLink,
  retrieveStripeConnectedAccount,
} from "@/lib/integrations/payments/stripe"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"

export type StripeConnectedAccountStatus = "pending" | "onboarding" | "restricted" | "active" | "disconnected" | "error"

export interface StripeConnectedAccount {
  id: string
  org_id: string
  stripe_account_id: string
  status: StripeConnectedAccountStatus
  charges_enabled: boolean
  payouts_enabled: boolean
  details_submitted: boolean
  country?: string | null
  default_currency?: string | null
  dashboard_type?: string | null
  requirement_collection?: string | null
  onboarding_started_at?: string | null
  onboarding_completed_at?: string | null
  disabled_reason?: string | null
  requirements_currently_due: string[]
  requirements_eventually_due: string[]
  metadata?: Record<string, any>
  created_at?: string
  updated_at?: string
}

const ISO_COUNTRY_CODE_RE = /^[A-Z]{2}$/

const COUNTRY_CODE_ALIASES: Record<string, string> = {
  AUSTRALIA: "AU",
  CANADA: "CA",
  GB: "GB",
  GREATBRITAIN: "GB",
  UK: "GB",
  UNITEDKINGDOM: "GB",
  UNITEDSTATES: "US",
  UNITEDSTATESOFAMERICA: "US",
  USA: "US",
}

const US_STATE_CODES = new Set([
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "FL",
  "GA",
  "HI",
  "IA",
  "ID",
  "IL",
  "IN",
  "KS",
  "KY",
  "LA",
  "MA",
  "MD",
  "ME",
  "MI",
  "MN",
  "MO",
  "MS",
  "MT",
  "NC",
  "ND",
  "NE",
  "NH",
  "NJ",
  "NM",
  "NV",
  "NY",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VA",
  "VT",
  "WA",
  "WI",
  "WV",
  "WY",
  "DC",
])

function mapConnection(row: any): StripeConnectedAccount {
  return {
    id: row.id,
    org_id: row.org_id,
    stripe_account_id: row.stripe_account_id,
    status: row.status ?? "pending",
    charges_enabled: Boolean(row.charges_enabled),
    payouts_enabled: Boolean(row.payouts_enabled),
    details_submitted: Boolean(row.details_submitted),
    country: row.country ?? null,
    default_currency: row.default_currency ?? null,
    dashboard_type: row.dashboard_type ?? null,
    requirement_collection: row.requirement_collection ?? null,
    onboarding_started_at: row.onboarding_started_at ?? null,
    onboarding_completed_at: row.onboarding_completed_at ?? null,
    disabled_reason: row.disabled_reason ?? null,
    requirements_currently_due: Array.isArray(row.requirements_currently_due) ? row.requirements_currently_due : [],
    requirements_eventually_due: Array.isArray(row.requirements_eventually_due) ? row.requirements_eventually_due : [],
    metadata: row.metadata ?? {},
    created_at: row.created_at ?? undefined,
    updated_at: row.updated_at ?? undefined,
  }
}

function deriveStatus(input: {
  existingStatus?: string | null
  charges_enabled: boolean
  payouts_enabled: boolean
  details_submitted: boolean
  disabled_reason?: string | null
}): StripeConnectedAccountStatus {
  if (input.charges_enabled && input.payouts_enabled) {
    return "active"
  }
  if (input.existingStatus === "disconnected") {
    return "disconnected"
  }
  if (input.disabled_reason || input.details_submitted) {
    return "restricted"
  }
  if (input.existingStatus === "onboarding") {
    return "onboarding"
  }
  return "pending"
}

function compactCountryValue(value: string) {
  return value.replace(/[^A-Za-z]/g, "").toUpperCase()
}

function normalizeCountryCode(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null

  const upper = trimmed.toUpperCase()
  if (ISO_COUNTRY_CODE_RE.test(upper)) {
    return upper
  }

  return COUNTRY_CODE_ALIASES[compactCountryValue(trimmed)] ?? null
}

function extractCountry(address: unknown): string {
  if (!address || typeof address !== "object") return "US"
  const candidate = address as Record<string, unknown>
  const values = [
    candidate.country,
    candidate.countryCode,
    candidate.country_code,
    candidate["address_country"],
  ]

  for (const value of values) {
    const normalized = normalizeCountryCode(value)
    if (normalized) {
      return normalized
    }
  }

  const state = typeof candidate.state === "string" ? candidate.state.trim().toUpperCase() : ""
  if (US_STATE_CODES.has(state)) {
    return "US"
  }

  return "US"
}

async function upsertStripeConnectedAccountRow(params: {
  orgId: string
  stripeAccountId: string
  createdBy?: string | null
  status?: StripeConnectedAccountStatus
  chargesEnabled: boolean
  payoutsEnabled: boolean
  detailsSubmitted: boolean
  country?: string | null
  defaultCurrency?: string | null
  dashboardType?: string | null
  requirementCollection?: string | null
  onboardingStartedAt?: string | null
  onboardingCompletedAt?: string | null
  disabledReason?: string | null
  requirementsCurrentlyDue?: string[]
  requirementsEventuallyDue?: string[]
  metadata?: Record<string, any>
}) {
  const supabase = createServiceSupabaseClient()
  const { data: existing } = await supabase
    .from("stripe_connected_accounts")
    .select("id, status, onboarding_started_at, onboarding_completed_at")
    .eq("org_id", params.orgId)
    .maybeSingle()

  const nextStatus =
    params.status ??
    deriveStatus({
      existingStatus: existing?.status ?? null,
      charges_enabled: params.chargesEnabled,
      payouts_enabled: params.payoutsEnabled,
      details_submitted: params.detailsSubmitted,
      disabled_reason: params.disabledReason,
    })

  const onboardingCompletedAt =
    params.onboardingCompletedAt ??
    (params.chargesEnabled && params.payoutsEnabled ? new Date().toISOString() : existing?.onboarding_completed_at ?? null)

  const payload = {
    org_id: params.orgId,
    stripe_account_id: params.stripeAccountId,
    status: nextStatus,
    charges_enabled: params.chargesEnabled,
    payouts_enabled: params.payoutsEnabled,
    details_submitted: params.detailsSubmitted,
    country: params.country ?? null,
    default_currency: params.defaultCurrency ?? null,
    dashboard_type: params.dashboardType ?? null,
    requirement_collection: params.requirementCollection ?? null,
    onboarding_started_at: params.onboardingStartedAt ?? existing?.onboarding_started_at ?? null,
    onboarding_completed_at: onboardingCompletedAt,
    disabled_reason: params.disabledReason ?? null,
    requirements_currently_due: params.requirementsCurrentlyDue ?? [],
    requirements_eventually_due: params.requirementsEventuallyDue ?? [],
    metadata: params.metadata ?? {},
    created_by: params.createdBy ?? null,
  }

  const { data, error } = await supabase
    .from("stripe_connected_accounts")
    .upsert(payload, { onConflict: "org_id" })
    .select("*")
    .single()

  if (error || !data) {
    throw new Error(`Failed to persist Stripe connected account: ${error?.message ?? "unknown error"}`)
  }

  return mapConnection(data)
}

function mapStripeRecordToConnection(stripeRecord: Awaited<ReturnType<typeof retrieveStripeConnectedAccount>>) {
  return {
    stripeAccountId: stripeRecord.stripe_account_id,
    status: stripeRecord.status as StripeConnectedAccountStatus,
    chargesEnabled: stripeRecord.charges_enabled,
    payoutsEnabled: stripeRecord.payouts_enabled,
    detailsSubmitted: stripeRecord.details_submitted,
    country: stripeRecord.country,
    defaultCurrency: stripeRecord.default_currency,
    dashboardType: stripeRecord.dashboard_type,
    requirementCollection: stripeRecord.requirement_collection,
    disabledReason: stripeRecord.disabled_reason,
    requirementsCurrentlyDue: stripeRecord.requirements_currently_due,
    requirementsEventuallyDue: stripeRecord.requirements_eventually_due,
  }
}

export function isStripeConnectedAccountReady(connection: StripeConnectedAccount | null | undefined) {
  return Boolean(connection?.charges_enabled && connection?.payouts_enabled)
}

export async function getStripeConnectedAccount(orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const { data, error } = await supabase
    .from("stripe_connected_accounts")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .maybeSingle()

  if (error || !data) return null
  return mapConnection(data)
}

export async function syncStripeConnectedAccount(orgId?: string) {
  const connection = await getStripeConnectedAccount(orgId)
  if (!connection) return null

  const stripeRecord = await retrieveStripeConnectedAccount(connection.stripe_account_id)
  return upsertStripeConnectedAccountRow({
    orgId: connection.org_id,
    ...mapStripeRecordToConnection(stripeRecord),
    onboardingStartedAt: connection.onboarding_started_at ?? null,
    onboardingCompletedAt:
      stripeRecord.charges_enabled && stripeRecord.payouts_enabled
        ? connection.onboarding_completed_at ?? new Date().toISOString()
        : connection.onboarding_completed_at ?? null,
    metadata: connection.metadata ?? {},
  })
}

export async function syncStripeConnectedAccountFromStripeAccount(account: Stripe.Account) {
  const supabase = createServiceSupabaseClient()
  const metadata = account.metadata ?? {}
  const { data: existing } = await supabase
    .from("stripe_connected_accounts")
    .select("org_id, onboarding_started_at, onboarding_completed_at, metadata")
    .eq("stripe_account_id", account.id)
    .maybeSingle()

  const orgId =
    existing?.org_id ??
    (typeof metadata.org_id === "string" && metadata.org_id.length > 0 ? metadata.org_id : null)

  if (!orgId) {
    return null
  }

  const stripeRecord = await retrieveStripeConnectedAccount(account.id)
  return upsertStripeConnectedAccountRow({
    orgId,
    ...mapStripeRecordToConnection(stripeRecord),
    onboardingStartedAt: existing?.onboarding_started_at ?? null,
    onboardingCompletedAt:
      stripeRecord.charges_enabled && stripeRecord.payouts_enabled
        ? existing?.onboarding_completed_at ?? new Date().toISOString()
        : existing?.onboarding_completed_at ?? null,
    metadata: existing?.metadata ?? {},
  })
}

export async function createOrGetStripeConnectedAccount(orgId?: string) {
  const existing = await getStripeConnectedAccount(orgId)
  if (existing) {
    return existing
  }

  const { orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const service = createServiceSupabaseClient()
  const { data: org } = await service
    .from("orgs")
    .select("name, billing_email, address")
    .eq("id", resolvedOrgId)
    .maybeSingle()

  if (!org) {
    throw new Error("Organization not found.")
  }

  const stripeRecord = await createStripeConnectedAccount({
    orgId: resolvedOrgId,
    email: org.billing_email ?? undefined,
    businessName: org.name ?? "Arc Organization",
    country: extractCountry(org.address),
  })

  return upsertStripeConnectedAccountRow({
    orgId: resolvedOrgId,
    createdBy: userId,
    ...mapStripeRecordToConnection(stripeRecord),
    status: "onboarding",
    onboardingStartedAt: new Date().toISOString(),
  })
}

export async function createStripeConnectedAccountOnboardingLink(orgId?: string) {
  const connection = await createOrGetStripeConnectedAccount(orgId)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://arcnaples.com"
  const refreshUrl = `${appUrl}/settings?tab=integrations&stripe=refresh`
  const returnUrl = `${appUrl}/settings?tab=integrations&stripe=return`

  await upsertStripeConnectedAccountRow({
    orgId: connection.org_id,
    stripeAccountId: connection.stripe_account_id,
    status: connection.status === "active" ? "active" : "onboarding",
    chargesEnabled: connection.charges_enabled,
    payoutsEnabled: connection.payouts_enabled,
    detailsSubmitted: connection.details_submitted,
    country: connection.country ?? null,
    defaultCurrency: connection.default_currency ?? null,
    dashboardType: connection.dashboard_type ?? null,
    requirementCollection: connection.requirement_collection ?? null,
    onboardingStartedAt: connection.onboarding_started_at ?? new Date().toISOString(),
    onboardingCompletedAt: connection.onboarding_completed_at ?? null,
    disabledReason: connection.disabled_reason ?? null,
    requirementsCurrentlyDue: connection.requirements_currently_due,
    requirementsEventuallyDue: connection.requirements_eventually_due,
    metadata: connection.metadata ?? {},
  })

  return createStripeAccountOnboardingLink({
    accountId: connection.stripe_account_id,
    refreshUrl,
    returnUrl,
  })
}

export async function createStripeConnectedAccountDashboardLoginLink(orgId?: string) {
  const connection = await syncStripeConnectedAccount(orgId)
  if (!connection) {
    throw new Error("Stripe payouts are not connected yet.")
  }
  return createStripeDashboardLoginLink(connection.stripe_account_id)
}

export async function requireReadyStripeConnectedAccount(orgId?: string) {
  const connection = await syncStripeConnectedAccount(orgId)
  if (!connection || !isStripeConnectedAccountReady(connection)) {
    throw new Error("Online payments are not configured for this organization yet.")
  }
  return connection
}
