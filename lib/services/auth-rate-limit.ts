import "server-only"

import { headers } from "next/headers"

import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * Defense-in-depth throttle for unauthenticated auth surfaces: account lookup,
 * first-password-setup sends, PIN checks and portal account sign-in. Per-record
 * lockouts already exist; this bounds the attacker who rotates the record
 * (probing many emails, or many tokens in parallel) from one source.
 *
 * Backed by a table rather than memory because serverless instances do not
 * share process state.
 */

export type RateLimitAction =
  | "external_signin"
  | "external_claim"
  | "external_reset_request"
  | "password_reset_request"
  | "portal_pin"
  | "account_lookup"
  | "password_setup"
  | "lead_intake"
  | "agreement_milestone_report"

interface RateLimitRule {
  limit: number
  windowSeconds: number
}

const RULES: Record<RateLimitAction, RateLimitRule> = {
  external_signin: { limit: 10, windowSeconds: 15 * 60 },
  external_claim: { limit: 10, windowSeconds: 15 * 60 },
  external_reset_request: { limit: 5, windowSeconds: 60 * 60 },
  password_reset_request: { limit: 5, windowSeconds: 60 * 60 },
  portal_pin: { limit: 20, windowSeconds: 15 * 60 },
  account_lookup: { limit: 20, windowSeconds: 15 * 60 },
  password_setup: { limit: 5, windowSeconds: 60 * 60 },
  // Signed website lead deliveries, per source and sending IP. The signature is
  // the real gate; this bounds a flood of unsigned requests.
  lead_intake: { limit: 120, windowSeconds: 15 * 60 },
  // Signed lender/title milestone reports, per feed and sending IP, on the same terms.
  agreement_milestone_report: { limit: 120, windowSeconds: 15 * 60 },
}

export class RateLimitError extends Error {
  constructor(message = "Too many attempts. Try again in a few minutes.") {
    super(message)
    this.name = "RateLimitError"
  }
}

async function requestIdentifier(): Promise<string> {
  const headerList = await headers()
  const forwarded = headerList.get("x-forwarded-for")
  const ip = forwarded?.split(",")[0]?.trim() || headerList.get("x-real-ip")?.trim()
  return ip || "unknown"
}

/**
 * Records one attempt and throws when the caller is over budget. Never blocks
 * the request on infrastructure failure — a throttle that takes the login page
 * down with it is worse than the attack it prevents.
 */
export async function enforceAuthRateLimit(action: RateLimitAction, scope?: string): Promise<void> {
  const rule = RULES[action]
  const identifier = `${await requestIdentifier()}:${scope ?? "global"}`
  const windowStart = new Date(Math.floor(Date.now() / (rule.windowSeconds * 1000)) * rule.windowSeconds * 1000).toISOString()

  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.rpc("increment_auth_rate_limit", {
    action_input: action,
    identifier_input: identifier,
    window_start_input: windowStart,
  })

  if (error) {
    console.error("Auth rate limit check failed", error)
    return
  }

  if (typeof data === "number" && data > rule.limit) {
    throw new RateLimitError()
  }
}

/**
 * Bulk and expensive mutations, budgeted per organization: each one fans out
 * into many rows or a long background job, and every tenant shares the same
 * workers and database. The budget is the organization's, not the member's, so
 * fifty members cannot together starve the other tenants. Sized for the
 * first-builder load (3 divisions, 30 communities, 500 active homes, 50 users)
 * with room for an onboarding day; a refusal says how long to wait.
 */
type MutationRateLimitAction = "import_stage" | "import_commit" | "starts_release" | "books_export" | "document_export"

const MUTATION_RULES: Record<MutationRateLimitAction, RateLimitRule & { noun: string }> = {
  // An onboarding day stages and commits a few files per community (30 at first-builder size) several times over.
  import_stage: { limit: 300, windowSeconds: 60 * 60, noun: "import files staged" },
  import_commit: { limit: 120, windowSeconds: 60 * 60, noun: "import commits" },
  // Each release batch carries up to 50 houses.
  starts_release: { limit: 60, windowSeconds: 60 * 60, noun: "start release batches" },
  books_export: { limit: 12, windowSeconds: 60 * 60, noun: "Books archives requested" },
  document_export: { limit: 30, windowSeconds: 60 * 60, noun: "document exports requested" },
}

/** Records one bulk mutation for the organization and throws once it is over its hourly budget. Fails open, like the auth throttle. */
export async function enforceMutationRateLimit(action: MutationRateLimitAction, orgId: string): Promise<void> {
  const rule = MUTATION_RULES[action]
  const windowMs = rule.windowSeconds * 1000
  const windowStartMs = Math.floor(Date.now() / windowMs) * windowMs
  const { data, error } = await createServiceSupabaseClient().rpc("increment_auth_rate_limit", {
    action_input: `mutation:${action}`,
    identifier_input: `org:${orgId}`,
    window_start_input: new Date(windowStartMs).toISOString(),
  })
  if (error) {
    console.error("Mutation rate limit check failed", error)
    return
  }
  if (typeof data === "number" && data > rule.limit) {
    const minutes = Math.max(1, Math.ceil((windowStartMs + windowMs - Date.now()) / 60_000))
    throw new RateLimitError(`This organization has reached its limit of ${rule.limit} ${rule.noun} per hour. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`)
  }
}
